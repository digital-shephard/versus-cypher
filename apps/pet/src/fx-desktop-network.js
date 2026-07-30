const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const {
  FX_NATIVE_ETH_ADDRESS,
  FxCoordinationSession,
  FxDeterministicDealer,
  FxPhase8DealerGuard,
  FxPhase8ExposureJournal,
  FxPublicBroker,
  FxTradeJournal,
  FxWakuTransport,
  createFxRecoveryPacket,
  restoreFxRecoveryPacket,
  phase5LockId,
} = require("@versus/network");

const FX_PUBLIC_TESTNET_DEPLOYMENT_ID =
  "0x1edf9c4dca5cbcb8b1875f4ce950844237258367d51e5d02dc3de577b3088494";
const FX_PUBLIC_TESTNET_COORDINATION_DOMAIN =
  "0x6d2d3f9784460521d35605b450e5a46fc1c068df7724265c8f12fec7f1693b2c";

const FX_PUBLIC_WAKU_PEERS = Object.freeze([
  "/dns4/relay-a.versuscypher.com/tcp/443/wss/p2p/16Uiu2HAmCQArrt8ND7sTzPCg76YmQPab7HKjSrVZeyeTVZdQyPWy",
  "/dns4/relay-b.versuscypher.com/tcp/443/wss/p2p/16Uiu2HAkx96y18XpzAybpmi1zzdMQZFvsRPZfkku8R9T4KJFMr2P",
]);
const FX_V2_SOURCE_REFUND_SECONDS = 7_200;
const FX_V2_DESTINATION_REFUND_SECONDS = 600;
const FX_V2_MINIMUM_TIMEOUT_DELTA_SECONDS = 3_600;
const FX_RECOVERY_POLL_MS = 15_000;
const FX_BPS_SCALE = 10_000n;
const FX_V3_GAS_PRICE_BUFFER_BPS = 12_000n;
const FX_V3_EXECUTOR_FALLBACK_BASE_MS = 15_000;
const FX_V3_EXECUTOR_FALLBACK_JITTER_MS = 15_000;
// Rounded from the public compact-V3 measurements in docs/fx/V3_COST_MEASUREMENT_2026-07-30.md.
const FX_V3_GAS_UNITS = Object.freeze({
  "84532": Object.freeze({
    sourceClaim: 40_000n,
    destinationFund: 51_000n,
    destinationClaim: 60_000n,
  }),
  "421614": Object.freeze({
    sourceClaim: 85_000n,
    destinationFund: 61_000n,
    destinationClaim: 85_000n,
  }),
});
const FX_V3_FALLBACK_GAS_UNITS = Object.freeze({
  sourceClaim: 100_000n,
  destinationFund: 100_000n,
  destinationClaim: 100_000n,
});

class FxDesktopNetworkError extends Error {
  constructor(message, code = "FX_DESKTOP_NETWORK_ERROR") {
    super(message);
    this.name = "FxDesktopNetworkError";
    this.code = code;
  }
}

function dollarsToMicros(value) {
  const normalized = String(value).trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(normalized)) {
    throw new FxDesktopNetworkError(
      "USD policy value must use at most six decimal places",
      "INVALID_USD_POLICY"
    );
  }
  const [whole, fraction = ""] = normalized.split(".");
  return (
    BigInt(whole) * 1_000_000n +
    BigInt(`${fraction}000000`.slice(0, 6))
  ).toString();
}

function mergedPolicy(current, patch = {}) {
  return { ...(current || {}), ...(patch || {}) };
}

function ceilDiv(numerator, denominator) {
  return (numerator + denominator - 1n) / denominator;
}

function v3GasUnits(chainId, leg) {
  return (
    FX_V3_GAS_UNITS[String(chainId)] || FX_V3_FALLBACK_GAS_UNITS
  )[leg];
}

function v3BufferedGasPrice(feeData) {
  const currentGasPrice = BigInt(
    feeData?.gasPrice || feeData?.maxFeePerGas || 0
  );
  if (currentGasPrice <= 0n) return 0n;
  return ceilDiv(
    currentGasPrice * FX_V3_GAS_PRICE_BUFFER_BPS,
    FX_BPS_SCALE
  );
}

function v3ExecutorDelayMs({
  tradeId,
  preferredExecutor,
  localExecutor,
  baseDelayMs = FX_V3_EXECUTOR_FALLBACK_BASE_MS,
  jitterMs = FX_V3_EXECUTOR_FALLBACK_JITTER_MS,
}) {
  const preferred = String(preferredExecutor || "").toLowerCase();
  const local = String(localExecutor || "").toLowerCase();
  if (preferred && preferred === local) return 0;

  const base = Math.max(0, Number(baseDelayMs) || 0);
  const jitterRange = Math.max(0, Number(jitterMs) || 0);
  if (jitterRange === 0) return base;
  const digest = crypto
    .createHash("sha256")
    .update(`${String(tradeId || "").toLowerCase()}:${local}`)
    .digest();
  return base + (digest.readUInt32BE(0) % (jitterRange + 1));
}

function deadlineTimer(milliseconds, message, code) {
  let handle;
  const promise = new Promise((_, reject) => {
    handle = setTimeout(() => {
      const error = new FxDesktopNetworkError(message, code);
      reject(error);
    }, milliseconds);
    handle.unref?.();
  });
  return { promise, cancel: () => clearTimeout(handle) };
}

function openDeploymentJournal({
  dataDirectory,
  filePath,
  deploymentId,
  create,
}) {
  try {
    return create();
  } catch (error) {
    if (error?.code !== "DEPLOYMENT_MISMATCH") throw error;
    const archiveDirectory = path.join(
      dataDirectory,
      "deployment-archive",
      `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`
    );
    fs.mkdirSync(archiveDirectory, { recursive: true, mode: 0o700 });
    const archivedFiles = [];
    for (const suffix of ["", "-wal", "-shm"]) {
      const source = `${filePath}${suffix}`;
      if (!fs.existsSync(source)) continue;
      const destination = path.join(
        archiveDirectory,
        `${path.basename(filePath)}${suffix}`
      );
      fs.renameSync(source, destination);
      archivedFiles.push(path.basename(destination));
    }
    fs.writeFileSync(
      path.join(archiveDirectory, "archive.json"),
      `${JSON.stringify({
        version: 1,
        reason: "deployment_mismatch",
        currentDeploymentId: deploymentId,
        archivedAt: new Date().toISOString(),
        files: archivedFiles,
      }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" }
    );
    return create();
  }
}

class FxDesktopNetworkRuntime extends EventEmitter {
  constructor({
    dataDirectory,
    walletProvider,
    evm,
    deploymentId = FX_PUBLIC_TESTNET_DEPLOYMENT_ID,
    coordinationDomain = FX_PUBLIC_TESTNET_COORDINATION_DOMAIN,
    bootstrapPeers = FX_PUBLIC_WAKU_PEERS,
    now = () => Math.floor(Date.now() / 1000),
    brokerObservationWindowMs = 15_000,
    brokerQuoteSettleWindowMs = 1_250,
    dealerObservationWindowMs = 15_000,
    sessionFactory,
    nativeUsdPriceProvider,
    protocolVersion = 1,
    executorFallbackBaseMs = FX_V3_EXECUTOR_FALLBACK_BASE_MS,
    executorFallbackJitterMs = FX_V3_EXECUTOR_FALLBACK_JITTER_MS,
    wait = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {}) {
    super();
    if (!dataDirectory || typeof walletProvider !== "function" || !evm) {
      throw new TypeError("FX desktop network runtime is misconfigured");
    }
    this.dataDirectory = path.resolve(dataDirectory);
    this.walletProvider = walletProvider;
    this.evm = evm;
    this.deploymentId = deploymentId;
    this.coordinationDomain = coordinationDomain;
    this.bootstrapPeers = [...bootstrapPeers];
    this.now = now;
    this.brokerObservationWindowMs = Number(brokerObservationWindowMs);
    this.brokerQuoteSettleWindowMs = Number(brokerQuoteSettleWindowMs);
    this.dealerObservationWindowMs = Number(dealerObservationWindowMs);
    this.sessionFactory = sessionFactory;
    this.nativeUsdPriceProvider = nativeUsdPriceProvider;
    this.protocolVersion = Number(protocolVersion);
    this.executorFallbackBaseMs = Math.max(
      0,
      Number(executorFallbackBaseMs) || 0
    );
    this.executorFallbackJitterMs = Math.max(
      0,
      Number(executorFallbackJitterMs) || 0
    );
    this.wait = wait;
    if (![1, 2, 3].includes(this.protocolVersion)) {
      throw new TypeError("FX desktop protocol version is unsupported");
    }
    if (typeof this.wait !== "function") {
      throw new TypeError("FX desktop executor wait must be a function");
    }
    this.nativePrice = null;
    this.broker = null;
    this.brokerStart = null;
    this.brokerJournal = null;
    this.requesterSession = null;
    this.requesterStart = null;
    this.requesterJournal = null;
    this.relayerSession = null;
    this.relayerStart = null;
    this.relayerJournal = null;
    this.dealer = null;
    this.dealerSession = null;
    this.dealerJournal = null;
    this.exposureJournal = null;
    this.guard = null;
    this.dealerPolicy = null;
    this.dealerPositions = [];
    this.processing = new Map();
    this.relayerProcessing = new Map();
    this.inventoryCache = null;
    this.dealerRecoveries = [];
    this.lastDealerReconcileAt = 0;
    this.recoveryTimer = null;
    this.recoveryInFlight = null;
    this.localSessions = new Set();
    this.localSessionListeners = new Map();
    this.dealerSecretDirectory = path.join(
      this.dataDirectory,
      "dealer-secrets-v2"
    );
    fs.mkdirSync(this.dataDirectory, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.dealerSecretDirectory, { recursive: true, mode: 0o700 });
  }

  signer(role = "requester") {
    const wallet = this.walletProvider(role);
    if (!wallet?.privateKey) {
      throw new FxDesktopNetworkError(
        "local FX identity is unavailable",
        "WALLET_UNAVAILABLE"
      );
    }
    const { Wallet } = require("ethers");
    return new Wallet(wallet.privateKey);
  }

  dealerAddress() {
    return this.signer("dealer").address.toLowerCase();
  }

  setRpcUrl(chainId, rpcUrl) {
    return this.evm.setRpcUrl(chainId, rpcUrl);
  }

  async chainGasSnapshot(chains) {
    return Promise.all(
      chains.map(async (chain) => {
        const [dealer, requester] = await Promise.all([
          this.evm.nativeBalance(chain.chainId, "dealer"),
          this.evm.nativeBalance(chain.chainId, "requester"),
        ]);
        return {
          chainId: chain.chainId,
          dealer,
          requester,
        };
      })
    );
  }

  async withdrawInventory({
    chainId,
    token,
    destination,
    amountAtomic,
  }) {
    const result = await this.evm.transferToken({
      chainId,
      token,
      destination,
      amountAtomic,
      role: "dealer",
    });
    this.inventoryCache = null;
    this.emit("status", this.status());
    return result;
  }

  #registerLocalSession(session) {
    if (
      !session ||
      typeof session.on !== "function" ||
      this.localSessions.has(session)
    ) {
      return session;
    }
    const accepted = (envelope, metadata = {}) => {
      if (metadata.localFanout === true) return;
      for (const target of this.localSessions) {
        if (
          target === session ||
          target.started !== true ||
          typeof target.ingest !== "function"
        ) {
          continue;
        }
        target.ingest(envelope, {
          localFanout: true,
          sourceRole: session.role,
          history: metadata.history === true,
        });
      }
    };
    session.on("accepted", accepted);
    this.localSessions.add(session);
    this.localSessionListeners.set(session, accepted);
    return session;
  }

  #unregisterLocalSession(session) {
    const listener = this.localSessionListeners.get(session);
    if (listener && typeof session?.off === "function") {
      session.off("accepted", listener);
    }
    this.localSessionListeners.delete(session);
    this.localSessions.delete(session);
  }

  createSession(role, fileName) {
    if (typeof this.sessionFactory === "function") {
      const created = this.sessionFactory({
        role,
        fileName,
        signer: this.signer(role),
      });
      this.#registerLocalSession(created.session);
      return created;
    }
    const filePath = path.join(this.dataDirectory, fileName);
    const journal = openDeploymentJournal({
      dataDirectory: this.dataDirectory,
      filePath,
      deploymentId: this.deploymentId,
      create: () => new FxTradeJournal({
        filePath,
        deploymentId: this.deploymentId,
        now: this.now,
        minimumTimeoutDeltaSeconds: this.protocolVersion >= 2 ? 3_600 : 60,
      }),
    });
    const transport = new FxWakuTransport({
      deploymentId: this.deploymentId,
      coordinationDomain: this.coordinationDomain,
      bootstrapPeers: this.bootstrapPeers,
      storeHistoryMs: 15 * 60 * 1000,
      storeMessageLimit: 512,
      now: () => this.now() * 1000,
    });
    const session = new FxCoordinationSession({
      deploymentId: this.deploymentId,
      signer: this.signer(role),
      role,
      journal,
      transport,
      maxMessagesPerSenderPerMinute: 60,
      maxMessagesPerMinuteGlobal: 600,
      maxRfqsPerSenderPerMinute: 6,
      maxQuotesPerSenderPerMinute: 12,
      maxActiveRfqs: 32,
      now: this.now,
    });
    this.#registerLocalSession(session);
    return { session, journal };
  }

  async ensureBroker() {
    if (this.broker?.status?.().active) return this.broker;
    if (this.brokerStart) return this.brokerStart;
    this.brokerStart = (async () => {
      const staleBroker = this.broker;
      const staleJournal = this.brokerJournal;
      this.broker = null;
      this.brokerJournal = null;
      this.#unregisterLocalSession(staleBroker?.session);
      await staleBroker?.close?.().catch(() => {});
      staleJournal?.close?.();

      const created = this.createSession("broker", "desktop-broker.sqlite");
      const broker = new FxPublicBroker({
        session: created.session,
        signer: this.signer("broker"),
        brokerFeeAtomic: "0",
        observationWindowMs: this.brokerObservationWindowMs,
        quoteSettleWindowMs: this.brokerQuoteSettleWindowMs,
        now: this.now,
      });
      try {
        await broker.start();
        this.broker = broker;
        this.brokerJournal = created.journal;
        this.emit("status", this.status());
        return broker;
      } catch (error) {
        await broker.close().catch(() => {});
        created.journal?.close?.();
        throw error;
      }
    })();
    try {
      return await this.brokerStart;
    } finally {
      this.brokerStart = null;
    }
  }

  async queryRoutes({ rfq }) {
    const [broker] = await Promise.all([
      this.ensureBroker(),
      this.ensureRequesterSession(),
      this.ensureRelayerSession(),
    ]);
    const startedAt = Date.now();
    const proposal = await broker.requestRoute(rfq);
    this.ingestRequesterPackage(proposal);
    return {
      selected: proposal,
      proposals: [proposal],
      attempts: [{
        endpoint: "waku://self-route",
        ok: true,
        latencyMs: Date.now() - startedAt,
        proposal,
      }],
    };
  }

  async warmRequester() {
    await Promise.all([
      this.ensureBroker(),
      this.ensureRequesterSession(),
      this.ensureRelayerSession(),
    ]);
    return this.status();
  }

  async ensureRequesterSession() {
    if (this.requesterSession) return this.requesterSession;
    if (this.requesterStart) return this.requesterStart;
    this.requesterStart = (async () => {
      const staleSession = this.requesterSession;
      const staleJournal = this.requesterJournal;
      this.requesterSession = null;
      this.requesterJournal = null;
      await staleSession?.close?.().catch(() => {});
      staleJournal?.close?.();

      const created = this.createSession(
        "requester",
        "desktop-requester.sqlite"
      );
      this.requesterSession = created.session;
      this.requesterJournal = created.journal;
      try {
        await created.session.start();
        this.#startRecoveryLoop();
        this.emit("status", this.status());
        return this.requesterSession;
      } catch (error) {
        this.requesterSession = null;
        this.requesterJournal = null;
        await created.session.close?.().catch(() => {});
        created.journal?.close?.();
        throw error;
      }
    })();
    try {
      return await this.requesterStart;
    } finally {
      this.requesterStart = null;
    }
  }

  async ensureRelayerSession() {
    if (this.relayerSession) return this.relayerSession;
    if (this.relayerStart) return this.relayerStart;
    this.relayerStart = (async () => {
      const staleSession = this.relayerSession;
      const staleJournal = this.relayerJournal;
      this.relayerSession = null;
      this.relayerJournal = null;
      await staleSession?.close?.().catch(() => {});
      staleJournal?.close?.();

      const created = this.createSession(
        "relayer",
        "desktop-relayer.sqlite"
      );
      this.relayerSession = created.session;
      this.relayerJournal = created.journal;
      created.session.on("accepted", (envelope) => {
        if (
          this.protocolVersion === 2 &&
          envelope.type === "fx_claim" &&
          this.#claimSide(created.journal, envelope) === "source"
        ) {
          this.#scheduleRelayDestinationClaimV2(envelope).catch((error) => {
            this.emit("error", error);
          });
        } else if (
          this.protocolVersion === 3 &&
          envelope.type === "fx_reveal"
        ) {
          this.#scheduleRelayDestinationClaimV3(envelope).catch((error) => {
            this.emit("error", error);
          });
        }
      });
      try {
        await created.session.start();
        await this.#resumeRelayer();
        this.emit("status", this.status());
        return this.relayerSession;
      } catch (error) {
        this.relayerSession = null;
        this.relayerJournal = null;
        await created.session.close?.().catch(() => {});
        created.journal?.close?.();
        throw error;
      }
    })();
    try {
      return await this.relayerStart;
    } finally {
      this.relayerStart = null;
    }
  }

  #startRecoveryLoop() {
    if (this.recoveryTimer) return;
    const run = () => {
      this.reconcileAutomaticRecoveries().catch((error) => {
        this.emit("error", error);
      });
    };
    this.recoveryTimer = setInterval(run, FX_RECOVERY_POLL_MS);
    this.recoveryTimer.unref?.();
    queueMicrotask(run);
  }

  async reconcileAutomaticRecoveries() {
    if (this.recoveryInFlight) return this.recoveryInFlight;
    this.recoveryInFlight = (async () => {
      if (this.dealer) {
        try {
          await this.dealer.resume();
        } catch (error) {
          this.emit("error", new FxDesktopNetworkError(
            `dealer coordination transport is unavailable: ${error.message}`,
            "DEALER_TRANSPORT_UNAVAILABLE"
          ));
        }
      }
      await this.#reconcileRequesterRefunds();
      if (this.exposureJournal && this.dealerSession) {
        await this.reconcileDealerExposure({ force: true });
      }
      return this.status();
    })().finally(() => {
      this.recoveryInFlight = null;
    });
    return this.recoveryInFlight;
  }

  async #reconcileRequesterRefunds() {
    if (!this.requesterSession || !this.requesterJournal?.tradeIds) return;
    for (const tradeId of this.requesterJournal.tradeIds()) {
      const sourceLock = this.requesterJournal.findType(
        tradeId,
        "fx_lock_source"
      );
      if (!sourceLock) continue;
      const lock = await this.evm.readLock(
        sourceLock.payload.chainId,
        phase5LockId(tradeId, "source"),
        sourceLock.payload.token,
        sourceLock.payload.transactionHash
      );
      if (lock.state === 2) continue;
      if (lock.state === 3) {
        this.emit("trade", {
          tradeId,
          role: "requester",
          state: "refunded",
          refund: {
            eligible: true,
            eligibleAt: lock.timeout,
            chainId: lock.chainId,
            lockId: lock.lockId,
          },
        });
        continue;
      }
      if (lock.state !== 1) continue;
      const latest = await this.evm
        .provider(lock.chainId)
        .getBlock("latest");
      if (Number(latest.timestamp) < Number(lock.timeout)) continue;
      const operationKey = `requester-refund:${tradeId}`;
      if (this.processing.has(operationKey)) continue;
      const operation = this.#refundRequesterSource(
        tradeId,
        sourceLock
      ).finally(() => {
        this.processing.delete(operationKey);
      });
      this.processing.set(operationKey, operation);
      await operation;
    }
  }

  async #refundRequesterSource(tradeId, sourceLock) {
    const refunded = await this.evm.refundLock({
      chainId: sourceLock.payload.chainId,
      tradeId,
      side: "source",
      role: "requester",
      token: sourceLock.payload.token,
      fundingTransactionHash: sourceLock.payload.transactionHash,
    });
    const transactionHash =
      refunded.receipt?.transactionHash ||
      (await this.evm.findLockEvent({
        chainId: sourceLock.payload.chainId,
        tradeId,
        side: "source",
        eventName: "LockRefunded",
        token: sourceLock.payload.token,
        fundingTransactionHash: sourceLock.payload.transactionHash,
      })).transactionHash;
    const blockNumber =
      refunded.receipt?.blockNumber ||
      await this.#transactionBlock(sourceLock.payload.chainId, transactionHash);
    let refundMessage = this.#messageForLock(
      this.requesterJournal,
      tradeId,
      sourceLock.id,
      "fx_refund"
    );
    if (!refundMessage) {
      refundMessage = await this.requesterSession.publish({
        protocol: "versus-fx",
        version: sourceLock.version,
        type: "fx_refund",
        tradeId,
        createdAt: Math.max(this.now(), Number(sourceLock.payload.timeout)),
        expiresAt: this.now() + 30 * 24 * 60 * 60,
        payload: {
          lockMessageId: sourceLock.id,
          chainId: sourceLock.payload.chainId,
          transactionHash,
          blockNumber: String(blockNumber),
          beneficiary: sourceLock.payload.refundAddress,
        },
      });
    }
    this.emit("trade", {
      tradeId,
      role: "requester",
      state: "refunded",
      refund: {
        eligible: true,
        eligibleAt: sourceLock.payload.timeout,
        chainId: sourceLock.payload.chainId,
        lockId: phase5LockId(tradeId, "source"),
        transactionHash,
        messageId: refundMessage.id,
      },
    });
  }

  ingestRequesterPackage(proposal, acceptance) {
    const session = this.requesterSession;
    for (const envelope of [
      proposal.rfq,
      ...proposal.quotes,
      acceptance,
    ].filter(Boolean)) {
      const result = session.ingest(envelope, { desktopRecovery: true });
      if (!["accepted", "duplicate"].includes(result.status)) {
        throw new FxDesktopNetworkError(
          `requester journal rejected ${envelope.type}: ${result.error || result.status}`,
          "COORDINATION_REJECTED"
        );
      }
    }
  }

  async publishExisting(session, envelope) {
    await session.transport.publish(envelope);
    return envelope;
  }

  async waitFor(session, tradeId, type, {
    timeoutMs = 180_000,
    predicate = () => true,
  } = {}) {
    const snapshot =
      typeof session.journal.snapshot === "function"
        ? session.journal.snapshot(tradeId)
        : null;
    const existing = snapshot?.messages
      ?.filter((entry) => entry.type === type)
      .map((entry) => session.journal.message(entry.id))
      .find((entry) => entry && predicate(entry)) ||
      (
        typeof session.journal.findType === "function"
          ? session.journal.findType(tradeId, type)
          : null
      );
    if (existing && predicate(existing)) return existing;
    const timer = deadlineTimer(
      timeoutMs,
      `timed out waiting for ${type}`,
      "COORDINATION_TIMEOUT"
    );
    let listener;
    const awaited = new Promise((resolve) => {
      listener = (envelope) => {
        if (
          envelope.tradeId === tradeId &&
          envelope.type === type &&
          predicate(envelope)
        ) {
          resolve(envelope);
        }
      };
      session.on("accepted", listener);
    });
    try {
      return await Promise.race([awaited, timer.promise]);
    } finally {
      timer.cancel();
      session.off("accepted", listener);
    }
  }

  async reserveRequester({ acceptance }) {
    const session = await this.ensureRequesterSession();
    const result = session.ingest(acceptance, { desktopRecovery: true });
    if (!["accepted", "duplicate"].includes(result.status)) {
      throw new FxDesktopNetworkError(
        `requester journal rejected fx_accept: ${result.error || result.status}`,
        "COORDINATION_REJECTED"
      );
    }
    await this.publishExisting(session, acceptance);
    this.emit("trade", {
      tradeId: acceptance.tradeId,
      role: "requester",
      state: "accepted",
      fundingEligibleUntil: acceptance.expiresAt,
    });
    const remainingMs = Math.max(1, (acceptance.expiresAt - this.now()) * 1_000);
    const reserve = await this.waitFor(session, acceptance.tradeId, "fx_reserve", {
      timeoutMs: Math.min(remainingMs, 180_000),
      predicate: (message) => message.payload.acceptId === acceptance.id,
    });
    this.emit("trade", {
      tradeId: acceptance.tradeId,
      role: "requester",
      state: "reserved",
      fundingEligibleUntil: reserve.payload.reservationDeadline,
    });
    return reserve;
  }

  async cancelRequester({ acceptance, reserve }) {
    const session = await this.ensureRequesterSession();
    if (
      !acceptance ||
      !reserve ||
      reserve.type !== "fx_reserve" ||
      reserve.tradeId !== acceptance.tradeId ||
      reserve.payload?.acceptId !== acceptance.id
    ) {
      throw new FxDesktopNetworkError(
        "dealer reservation does not match the accepted quote",
        "RESERVATION_MISMATCH"
      );
    }
    const createdAt = this.now();
    const expiresAt = Math.min(
      Number(acceptance.expiresAt),
      createdAt + 60
    );
    if (expiresAt <= createdAt) {
      throw new FxDesktopNetworkError(
        "dealer reservation already expired",
        "RESERVATION_EXPIRED"
      );
    }
    const cancellation = await session.publish({
      protocol: "versus-fx",
      version: acceptance.version,
      type: "fx_cancel",
      tradeId: acceptance.tradeId,
      createdAt,
      expiresAt,
      payload: {
        acceptId: acceptance.id,
        reserveId: reserve.id,
        reason: "owner_cancelled",
      },
    });
    this.emit("trade", {
      tradeId: acceptance.tradeId,
      role: "requester",
      state: "cancelled",
    });
    return cancellation;
  }

  async executeRequester({
    proposal,
    acceptance,
    reserve,
    requester,
    destinationAddress,
    sourceRefundAddress,
    secret,
    secretHash,
  }) {
    if (acceptance?.version === 3) {
      return this.#executeRequesterV3({
        proposal,
        acceptance,
        reserve,
        requester,
        destinationAddress,
        sourceRefundAddress,
        secret,
        secretHash,
      });
    }
    if (acceptance?.version === 2) {
      return this.#executeRequesterV2({
        proposal,
        acceptance,
        reserve,
        requester,
        destinationAddress,
        sourceRefundAddress,
        secretHash,
      });
    }
    const session = await this.ensureRequesterSession();
    if (
      !reserve ||
      reserve.type !== "fx_reserve" ||
      reserve.tradeId !== acceptance.tradeId ||
      reserve.payload?.acceptId !== acceptance.id
    ) {
      throw new FxDesktopNetworkError(
        "dealer reservation does not match the accepted quote",
        "RESERVATION_MISMATCH"
      );
    }
    const route = proposal.route;
    const blocks = await Promise.all([
      this.evm.provider(route.inputChainId).getBlock("latest"),
      this.evm.provider(route.outputChainId).getBlock("latest"),
    ]);
    const calibratedNow = Math.max(...blocks.map((block) => Number(block.timestamp)));
    const sourceRefundTimestamp = calibratedNow + 7_200;
    this.emit("trade", {
      tradeId: acceptance.tradeId,
      role: "requester",
      state: "source_lock_pending",
      refundEligibleAt: sourceRefundTimestamp,
    });
    const source = await this.evm.fundLock({
      chainId: route.inputChainId,
      tradeId: acceptance.tradeId,
      side: "source",
      amountAtomic: route.totalInputAtomic,
      beneficiary: reserve.payload.dealerSourceClaimAddress,
      refundAddress: sourceRefundAddress,
      secretHash,
      refundTimestamp: sourceRefundTimestamp,
      role: "requester",
      token: route.inputToken,
    });
    const sourceReceipt = source.receipt;
    if (!sourceReceipt && source.lock.state !== 1) {
      throw new FxDesktopNetworkError("source lock was not funded", "SOURCE_LOCK_UNCONFIRMED");
    }
    const sourceTransactionHash =
      sourceReceipt?.transactionHash ||
      await this.#findFundTransaction(
        route.inputChainId,
        acceptance.tradeId,
        "source",
        route.inputToken
      );
    const sourceBlockNumber =
      sourceReceipt?.blockNumber ||
      await this.#transactionBlock(route.inputChainId, sourceTransactionHash);
    const sourceMessage = await session.publish({
      protocol: "versus-fx",
      version: 1,
      type: "fx_lock_source",
      tradeId: acceptance.tradeId,
      createdAt: this.now(),
      expiresAt: sourceRefundTimestamp,
      payload: {
        acceptId: acceptance.id,
        chainId: route.inputChainId,
        token: route.inputToken,
        amountAtomic: route.totalInputAtomic,
        lockAddress: this.evm.adapterAddress(
          route.inputChainId,
          route.inputToken
        ),
        beneficiary: reserve.payload.dealerSourceClaimAddress,
        refundAddress: sourceRefundAddress,
        secretHash,
        timeout: sourceRefundTimestamp,
        transactionHash: sourceTransactionHash,
        blockNumber: String(sourceBlockNumber),
      },
    });
    this.emit("trade", {
      tradeId: acceptance.tradeId,
      role: "requester",
      state: "source_lock_confirmed",
      transactionHash: sourceTransactionHash,
      refundEligibleAt: sourceRefundTimestamp,
    });
    const destinationMessage = await this.waitFor(
      session,
      acceptance.tradeId,
      "fx_lock_destination",
      {
        predicate: (message) => message.payload.acceptId === acceptance.id,
      }
    );
    const destinationObservation = await this.evm.verifyLockEnvelope({
      chainId: route.outputChainId,
      lockId: phase5LockId(acceptance.tradeId, "destination"),
      transactionHash: destinationMessage.payload.transactionHash,
      token: route.outputToken,
    });
    if (
      destinationObservation.confirmed !== true ||
      destinationObservation.amountAtomic !== route.outputAmountAtomic ||
      destinationObservation.beneficiary !== destinationAddress.toLowerCase() ||
      destinationObservation.secretHash !== secretHash.toLowerCase()
    ) {
      throw new FxDesktopNetworkError(
        "destination lock does not match the accepted route",
        "DESTINATION_MISMATCH"
      );
    }
    this.emit("trade", {
      tradeId: acceptance.tradeId,
      role: "requester",
      state: "destination_lock_confirmed",
      transactionHash: destinationMessage.payload.transactionHash,
      refundEligibleAt: destinationMessage.payload.timeout,
    });
    const claim = await this.evm.claimLock({
      chainId: route.outputChainId,
      tradeId: acceptance.tradeId,
      side: "destination",
      secret,
      role: "requester",
      token: route.outputToken,
      fundingTransactionHash: destinationMessage.payload.transactionHash,
    });
    const claimTransactionHash =
      claim.receipt?.transactionHash ||
      await this.#findClaimTransaction(
        route.outputChainId,
        acceptance.tradeId,
        "destination",
        route.outputToken
      );
    const claimBlockNumber =
      claim.receipt?.blockNumber ||
      await this.#transactionBlock(route.outputChainId, claimTransactionHash);
    await session.publish({
      protocol: "versus-fx",
      version: 1,
      type: "fx_claim",
      tradeId: acceptance.tradeId,
      createdAt: this.now(),
      expiresAt: this.now() + 30 * 24 * 60 * 60,
      payload: {
        lockMessageId: destinationMessage.id,
        chainId: route.outputChainId,
        transactionHash: claimTransactionHash,
        blockNumber: String(claimBlockNumber),
        secretHash,
        beneficiary: destinationAddress,
      },
    });
    this.emit("trade", {
      tradeId: acceptance.tradeId,
      role: "requester",
      state: "destination_claimed",
      transactionHash: claimTransactionHash,
    });
    return {
      tradeId: acceptance.tradeId,
      sourceLock: sourceMessage,
      destinationLock: destinationMessage,
      destinationClaim: {
        transactionHash: claimTransactionHash,
        blockNumber: claimBlockNumber,
      },
      destinationObservation: {
        confirmed: true,
        chainId: route.outputChainId,
        token: route.outputToken,
        amountAtomic: route.outputAmountAtomic,
        beneficiary: destinationAddress,
        transactionHash: claimTransactionHash,
        blockNumber: String(claimBlockNumber),
        confirmations: this.evm.configuration(route.outputChainId).requiredConfirmations,
      },
      requester,
      endpointPaymentAuthorized: false,
      endpointPaymentSubmitted: false,
    };
  }

  async #executeRequesterV2({
    proposal,
    acceptance,
    reserve,
    requester,
    destinationAddress,
    sourceRefundAddress,
    secretHash,
  }) {
    const session = await this.ensureRequesterSession();
    await this.ensureRelayerSession();
    if (
      !reserve ||
      reserve.type !== "fx_reserve" ||
      reserve.tradeId !== acceptance.tradeId ||
      reserve.payload?.acceptId !== acceptance.id
    ) {
      throw new FxDesktopNetworkError(
        "dealer reservation does not match the accepted quote",
        "RESERVATION_MISMATCH"
      );
    }
    const route = proposal.route;
    const quote = proposal.quotes.find(
      (candidate) => candidate.id === route.quoteId
    );
    if (!quote || quote.version !== 2 || quote.payload.secretHash !== secretHash) {
      throw new FxDesktopNetworkError(
        "V2 dealer secret commitment is unavailable",
        "SECRET_COMMITMENT_MISMATCH"
      );
    }
    await this.#assertDestinationExecutorSufficientV2(quote);
    const blocks = await Promise.all([
      this.evm.provider(route.inputChainId).getBlock("latest"),
      this.evm.provider(route.outputChainId).getBlock("latest"),
    ]);
    const calibratedNow = Math.max(
      ...blocks.map((block) => Number(block.timestamp))
    );
    const existingSourceMessage = this.requesterJournal.findType(
      acceptance.tradeId,
      "fx_lock_source"
    );
    const sourceRefundTimestamp =
      existingSourceMessage?.payload?.timeout ||
      calibratedNow + FX_V2_SOURCE_REFUND_SECONDS;
    this.emit("trade", {
      tradeId: acceptance.tradeId,
      role: "requester",
      state: "source_lock_pending",
      refundEligibleAt: sourceRefundTimestamp,
    });
    const source = await this.evm.fundLock({
      chainId: route.inputChainId,
      tradeId: acceptance.tradeId,
      side: "source",
      amountAtomic: route.totalInputAtomic,
      beneficiaryAmountAtomic: route.totalInputAtomic,
      executorAmountAtomic: "0",
      beneficiary: reserve.payload.dealerSourceClaimAddress,
      refundAddress: sourceRefundAddress,
      secretHash,
      refundTimestamp: sourceRefundTimestamp,
      role: "requester",
      token: route.inputToken,
    });
    const sourceTransactionHash =
      source.receipt?.transactionHash ||
      await this.#findFundTransaction(
        route.inputChainId,
        acceptance.tradeId,
        "source",
        route.inputToken
      );
    const sourceBlockNumber =
      source.receipt?.blockNumber ||
      await this.#transactionBlock(route.inputChainId, sourceTransactionHash);
    let sourceMessage = existingSourceMessage;
    if (!sourceMessage) {
      sourceMessage = await session.publish({
        protocol: "versus-fx",
        version: 2,
        type: "fx_lock_source",
        tradeId: acceptance.tradeId,
        createdAt: this.now(),
        expiresAt: sourceRefundTimestamp,
        payload: {
          acceptId: acceptance.id,
          chainId: route.inputChainId,
          token: route.inputToken,
          amountAtomic: route.totalInputAtomic,
          beneficiaryAmountAtomic: route.totalInputAtomic,
          executorAmountAtomic: "0",
          lockAddress: this.evm.adapterAddress(
            route.inputChainId,
            route.inputToken
          ),
          beneficiary: reserve.payload.dealerSourceClaimAddress,
          refundAddress: sourceRefundAddress,
          secretHash,
          timeout: sourceRefundTimestamp,
          transactionHash: sourceTransactionHash,
          blockNumber: String(sourceBlockNumber),
        },
      });
    }
    this.emit("trade", {
      tradeId: acceptance.tradeId,
      role: "requester",
      state: "source_lock_confirmed",
      transactionHash: sourceTransactionHash,
      refundEligibleAt: sourceRefundTimestamp,
    });
    this.emit("trade", {
      tradeId: acceptance.tradeId,
      role: "requester",
      state: "destination_lock_pending",
      refundEligibleAt: sourceRefundTimestamp,
    });
    const destinationMessage = await this.waitFor(
      session,
      acceptance.tradeId,
      "fx_lock_destination",
      {
        timeoutMs: 240_000,
        predicate: (message) => message.payload.acceptId === acceptance.id,
      }
    );
    const destinationObservation = await this.evm.verifyLockEnvelope({
      chainId: route.outputChainId,
      lockId: phase5LockId(acceptance.tradeId, "destination"),
      transactionHash: destinationMessage.payload.transactionHash,
      token: route.outputToken,
    });
    const expectedDestinationTotal = (
      BigInt(route.outputAmountAtomic) +
      BigInt(quote.payload.destinationExecutorAmountAtomic)
    ).toString();
    if (
      (
        destinationObservation.confirmed !== true &&
        destinationObservation.state !== 2
      ) ||
      destinationObservation.amountAtomic !== expectedDestinationTotal ||
      destinationObservation.beneficiaryAmountAtomic !== route.outputAmountAtomic ||
      destinationObservation.executorAmountAtomic !==
        quote.payload.destinationExecutorAmountAtomic ||
      destinationObservation.beneficiary !== destinationAddress.toLowerCase() ||
      destinationObservation.refundAddress !==
        reserve.payload.dealerDestinationRefundAddress.toLowerCase() ||
      Number(destinationObservation.timeout) !==
        Number(destinationMessage.payload.timeout) ||
      destinationObservation.secretHash !== secretHash.toLowerCase() ||
      sourceRefundTimestamp <
        Number(destinationMessage.payload.timeout) +
          FX_V2_MINIMUM_TIMEOUT_DELTA_SECONDS
    ) {
      throw new FxDesktopNetworkError(
        "destination lock does not match the accepted source-first V2 route",
        "DESTINATION_MISMATCH"
      );
    }
    this.emit("trade", {
      tradeId: acceptance.tradeId,
      role: "requester",
      state: "destination_lock_confirmed",
      transactionHash: destinationMessage.payload.transactionHash,
      refundEligibleAt: destinationMessage.payload.timeout,
    });
    const sourceClaim = await this.waitFor(
      session,
      acceptance.tradeId,
      "fx_claim",
      {
        timeoutMs: 240_000,
        predicate: (message) => message.payload.lockMessageId === sourceMessage.id,
      }
    );
    const destinationClaim = await this.waitFor(
      session,
      acceptance.tradeId,
      "fx_claim",
      {
        timeoutMs: 240_000,
        predicate: (message) =>
          message.payload.lockMessageId === destinationMessage.id,
      }
    );
    const finalDestination = await this.evm.readLock(
      route.outputChainId,
      phase5LockId(acceptance.tradeId, "destination"),
      route.outputToken
    );
    if (finalDestination.state !== 2) {
      throw new FxDesktopNetworkError(
        "destination claim message is not reflected on chain",
        "DESTINATION_UNCONFIRMED"
      );
    }
    const destinationReceipt = await this.#findClaimReceipt(
      route.outputChainId,
      acceptance.tradeId,
      "destination",
      route.outputToken
    );
    this.emit("trade", {
      tradeId: acceptance.tradeId,
      role: "requester",
      state: "complete",
      transactionHash: destinationReceipt.transactionHash,
    });
    return {
      tradeId: acceptance.tradeId,
      sourceLock: sourceMessage,
      destinationLock: destinationMessage,
      sourceClaim,
      destinationClaim,
      destinationObservation: {
        confirmed: true,
        chainId: route.outputChainId,
        token: route.outputToken,
        amountAtomic: route.outputAmountAtomic,
        beneficiary: destinationAddress,
        transactionHash: destinationReceipt.transactionHash,
        blockNumber: String(destinationReceipt.blockNumber),
        confirmations: destinationReceipt.confirmations,
      },
      requester,
      endpointPaymentAuthorized: false,
      endpointPaymentSubmitted: false,
    };
  }

  async #executeRequesterV3({
    proposal,
    acceptance,
    reserve,
    requester,
    destinationAddress,
    sourceRefundAddress,
    secret,
    secretHash,
  }) {
    const session = await this.ensureRequesterSession();
    await this.ensureRelayerSession();
    if (
      !reserve ||
      reserve.type !== "fx_reserve" ||
      reserve.version !== 3 ||
      reserve.tradeId !== acceptance.tradeId ||
      reserve.payload?.acceptId !== acceptance.id
    ) {
      throw new FxDesktopNetworkError(
        "dealer reservation does not match the accepted V3 quote",
        "RESERVATION_MISMATCH"
      );
    }
    const route = proposal.route;
    const quote = proposal.quotes.find(
      (candidate) => candidate.id === route.quoteId
    );
    if (
      !quote ||
      quote.version !== 3 ||
      acceptance.payload.secretHash !== secretHash
    ) {
      throw new FxDesktopNetworkError(
        "requester secret commitment does not match the accepted V3 quote",
        "SECRET_COMMITMENT_MISMATCH"
      );
    }
    const revealSecret = Buffer.isBuffer(secret)
      ? `0x${secret.toString("hex")}`
      : String(secret || "").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(revealSecret)) {
      throw new FxDesktopNetworkError(
        "durable requester settlement secret is unavailable",
        "SETTLEMENT_SECRET_UNAVAILABLE"
      );
    }
    await this.#assertDestinationExecutorSufficientV2(quote);
    const blocks = await Promise.all([
      this.evm.provider(route.inputChainId).getBlock("latest"),
      this.evm.provider(route.outputChainId).getBlock("latest"),
    ]);
    const calibratedNow = Math.max(
      ...blocks.map((block) => Number(block.timestamp))
    );
    const existingSourceMessage = this.requesterJournal.findType(
      acceptance.tradeId,
      "fx_lock_source"
    );
    const sourceRefundTimestamp =
      existingSourceMessage?.payload?.timeout ||
      calibratedNow + FX_V2_SOURCE_REFUND_SECONDS;
    this.emit("trade", {
      tradeId: acceptance.tradeId,
      role: "requester",
      state: "source_lock_pending",
      refundEligibleAt: sourceRefundTimestamp,
    });
    const source = await this.evm.fundLock({
      chainId: route.inputChainId,
      tradeId: acceptance.tradeId,
      side: "source",
      amountAtomic: route.totalInputAtomic,
      beneficiaryAmountAtomic: route.totalInputAtomic,
      executorAmountAtomic: "0",
      beneficiary: reserve.payload.dealerSourceClaimAddress,
      refundAddress: sourceRefundAddress,
      secretHash,
      refundTimestamp: sourceRefundTimestamp,
      role: "requester",
      token: route.inputToken,
    });
    const sourceTransactionHash =
      source.receipt?.transactionHash ||
      await this.#findFundTransaction(
        route.inputChainId,
        acceptance.tradeId,
        "source",
        route.inputToken,
        source.lock?.lockDigest
      );
    const sourceBlockNumber =
      source.receipt?.blockNumber ||
      await this.#transactionBlock(route.inputChainId, sourceTransactionHash);
    let sourceMessage = existingSourceMessage;
    if (!sourceMessage) {
      sourceMessage = await session.publish({
        protocol: "versus-fx",
        version: 3,
        type: "fx_lock_source",
        tradeId: acceptance.tradeId,
        createdAt: this.now(),
        expiresAt: sourceRefundTimestamp,
        payload: {
          acceptId: acceptance.id,
          chainId: route.inputChainId,
          token: route.inputToken,
          amountAtomic: route.totalInputAtomic,
          beneficiaryAmountAtomic: route.totalInputAtomic,
          executorAmountAtomic: "0",
          lockAddress: this.evm.adapterAddress(
            route.inputChainId,
            route.inputToken
          ),
          beneficiary: reserve.payload.dealerSourceClaimAddress,
          refundAddress: sourceRefundAddress,
          secretHash,
          timeout: sourceRefundTimestamp,
          transactionHash: sourceTransactionHash,
          blockNumber: String(sourceBlockNumber),
        },
      });
    }
    this.emit("trade", {
      tradeId: acceptance.tradeId,
      role: "requester",
      state: "source_lock_confirmed",
      transactionHash: sourceTransactionHash,
      refundEligibleAt: sourceRefundTimestamp,
    });
    const destinationMessage = await this.waitFor(
      session,
      acceptance.tradeId,
      "fx_lock_destination",
      {
        timeoutMs: 240_000,
        predicate: (message) => message.payload.acceptId === acceptance.id,
      }
    );
    const destinationObservation = await this.evm.verifyLockEnvelope({
      chainId: route.outputChainId,
      lockId: phase5LockId(acceptance.tradeId, "destination"),
      transactionHash: destinationMessage.payload.transactionHash,
      token: route.outputToken,
    });
    const expectedDestinationTotal = (
      BigInt(route.outputAmountAtomic) +
      BigInt(quote.payload.destinationExecutorAmountAtomic)
    ).toString();
    if (
      destinationObservation.confirmed !== true ||
      destinationObservation.amountAtomic !== expectedDestinationTotal ||
      destinationObservation.beneficiaryAmountAtomic !== route.outputAmountAtomic ||
      destinationObservation.executorAmountAtomic !==
        quote.payload.destinationExecutorAmountAtomic ||
      destinationObservation.beneficiary !== destinationAddress.toLowerCase() ||
      destinationObservation.refundAddress !==
        reserve.payload.dealerDestinationRefundAddress.toLowerCase() ||
      Number(destinationObservation.timeout) !==
        Number(destinationMessage.payload.timeout) ||
      destinationObservation.secretHash !== secretHash.toLowerCase() ||
      sourceRefundTimestamp <
        Number(destinationMessage.payload.timeout) +
          FX_V2_MINIMUM_TIMEOUT_DELTA_SECONDS
    ) {
      throw new FxDesktopNetworkError(
        "destination lock does not match the accepted V3 route",
        "DESTINATION_MISMATCH"
      );
    }
    this.emit("trade", {
      tradeId: acceptance.tradeId,
      role: "requester",
      state: "destination_lock_confirmed",
      transactionHash: destinationMessage.payload.transactionHash,
      refundEligibleAt: destinationMessage.payload.timeout,
    });
    let reveal = this.requesterJournal.findType(
      acceptance.tradeId,
      "fx_reveal"
    );
    if (!reveal) {
      reveal = await session.publish({
        protocol: "versus-fx",
        version: 3,
        type: "fx_reveal",
        tradeId: acceptance.tradeId,
        createdAt: this.now(),
        expiresAt: sourceRefundTimestamp,
        payload: {
          acceptId: acceptance.id,
          destinationLockMessageId: destinationMessage.id,
          secret: revealSecret,
          secretHash,
        },
      });
    } else {
      await this.publishExisting(session, reveal);
    }
    this.emit("trade", {
      tradeId: acceptance.tradeId,
      role: "requester",
      state: "secret_revealed",
      transactionHash: destinationMessage.payload.transactionHash,
    });
    await this.#ingestRelayerTrade(this.requesterJournal, acceptance.tradeId);
    const destinationClaim = await this.waitFor(
      session,
      acceptance.tradeId,
      "fx_claim",
      {
        timeoutMs: 240_000,
        predicate: (message) =>
          message.payload.lockMessageId === destinationMessage.id,
      }
    );
    const finalDestination = await this.evm.readLock(
      route.outputChainId,
      phase5LockId(acceptance.tradeId, "destination"),
      route.outputToken,
      destinationMessage.payload.transactionHash
    );
    if (
      finalDestination.state !== 2 ||
      finalDestination.beneficiaryAmountAtomic !== route.outputAmountAtomic ||
      finalDestination.beneficiary !== destinationAddress.toLowerCase()
    ) {
      throw new FxDesktopNetworkError(
        "destination claim is not reflected as the exact V3 output",
        "DESTINATION_UNCONFIRMED"
      );
    }
    const destinationReceipt = await this.#findClaimReceipt(
      route.outputChainId,
      acceptance.tradeId,
      "destination",
      route.outputToken,
      destinationMessage.payload.transactionHash
    );
    this.emit("trade", {
      tradeId: acceptance.tradeId,
      role: "requester",
      state: "funds_ready",
      transactionHash: destinationReceipt.transactionHash,
    });
    return {
      tradeId: acceptance.tradeId,
      sourceLock: sourceMessage,
      destinationLock: destinationMessage,
      reveal,
      destinationClaim,
      destinationObservation: {
        confirmed: true,
        chainId: route.outputChainId,
        token: route.outputToken,
        amountAtomic: route.outputAmountAtomic,
        beneficiary: destinationAddress,
        transactionHash: destinationReceipt.transactionHash,
        blockNumber: String(destinationReceipt.blockNumber),
        confirmations: destinationReceipt.confirmations,
      },
      requester,
      endpointPaymentAuthorized: false,
      endpointPaymentSubmitted: false,
    };
  }

  async reconcileRequester({ prepared, recoveryPassword }) {
    if (prepared?.acceptance?.version === 3) {
      return this.#reconcileRequesterV3(prepared, recoveryPassword);
    }
    if (prepared?.acceptance?.version === 2) {
      return this.#reconcileRequesterV2(prepared);
    }
    const route = prepared.proposal.route;
    const sourceId = phase5LockId(prepared.tradeId, "source");
    const destinationId = phase5LockId(prepared.tradeId, "destination");
    const [source, destination] = await Promise.all([
      this.evm.readLock(route.inputChainId, sourceId, route.inputToken),
      this.evm.readLock(route.outputChainId, destinationId, route.outputToken),
    ]);
    if (destination.state === 2) {
      const claim = await this.#findClaimReceipt(
        route.outputChainId,
        prepared.tradeId,
        "destination",
        route.outputToken
      );
      return {
        state: "funds_ready",
        receipt: {
          schema: "versus-fx-funds-ready",
          schemaVersion: 1,
          status: "funds_ready",
          tradeId: prepared.tradeId,
          proposalId: prepared.proposal.proposalId,
          requester: prepared.requester,
          destinationAddress: prepared.destinationAddress,
          outputChainId: prepared.outputChainId,
          outputToken: prepared.outputToken,
          requiredAmountAtomic: prepared.outputAmountAtomic,
          observedAmountAtomic: destination.amountAtomic,
          destinationTransactionHash: claim.transactionHash,
          destinationBlockNumber: String(claim.blockNumber),
          confirmations: claim.confirmations,
          confirmedAt: this.now(),
          endpointPaymentAuthorized: false,
          endpointPaymentSubmitted: false,
        },
      };
    }
    const latestSource = await this.evm.provider(route.inputChainId).getBlock("latest");
    if (source.state === 1 && Number(latestSource.timestamp) >= source.timeout) {
      return {
        state: "refund_wait",
        refund: {
          eligible: true,
          eligibleAt: source.timeout,
          chainId: route.inputChainId,
          lockId: sourceId,
        },
      };
    }
    if (source.state === 3) {
      return {
        state: "refunded",
        refund: {
          eligible: true,
          eligibleAt: source.timeout,
          chainId: route.inputChainId,
          lockId: sourceId,
        },
      };
    }
    if (destination.state === 1) {
      return {
        state: "destination_lock_confirmed",
        refund: {
          eligible: false,
          eligibleAt: source.timeout,
          chainId: route.inputChainId,
          lockId: sourceId,
        },
      };
    }
    if (
      source.state === 0 &&
      destination.state === 0 &&
      Number(prepared.acceptance?.expiresAt || 0) <= this.now()
    ) {
      return {
        state: "failed",
        lastFailure: {
          code: "QUOTE_EXPIRED_BEFORE_LOCK",
          message:
            "The accepted quote expired before a source lock was broadcast. Funds remain in the local FX wallet",
          at: new Date(this.now() * 1000).toISOString(),
        },
      };
    }
    if (source.state === 1) {
      return {
        state: "source_lock_confirmed",
        refund: {
          eligible: false,
          eligibleAt: source.timeout,
          chainId: route.inputChainId,
          lockId: sourceId,
        },
      };
    }
    return { state: "source_lock_pending" };
  }

  async #reconcileRequesterV3(prepared, recoveryPassword) {
    const session = await this.ensureRequesterSession();
    await this.ensureRelayerSession();
    const route = prepared.proposal.route;
    const quote = prepared.proposal.quotes.find(
      (candidate) => candidate.id === route.quoteId
    );
    const sourceId = phase5LockId(prepared.tradeId, "source");
    const destinationId = phase5LockId(prepared.tradeId, "destination");
    const sourceMessage = this.requesterJournal.findType(
      prepared.tradeId,
      "fx_lock_source"
    );
    const destinationMessage = this.requesterJournal.findType(
      prepared.tradeId,
      "fx_lock_destination"
    );
    const [source, destination] = await Promise.all([
      this.evm.readLock(
        route.inputChainId,
        sourceId,
        route.inputToken,
        sourceMessage?.payload?.transactionHash
      ),
      this.evm.readLock(
        route.outputChainId,
        destinationId,
        route.outputToken,
        destinationMessage?.payload?.transactionHash
      ),
    ]);
    if (destination.state === 2) {
      if (!destinationMessage || !quote) {
        throw new FxDesktopNetworkError(
          "confirmed V3 destination provenance is unavailable",
          "INCOMPLETE_RECOVERY"
        );
      }
      const expectedDestinationTotal = (
        BigInt(route.outputAmountAtomic) +
        BigInt(quote.payload.destinationExecutorAmountAtomic)
      ).toString();
      if (
        destination.amountAtomic !== expectedDestinationTotal ||
        destination.beneficiaryAmountAtomic !== route.outputAmountAtomic ||
        destination.executorAmountAtomic !==
          quote.payload.destinationExecutorAmountAtomic ||
        destination.beneficiary !==
          prepared.destinationAddress.toLowerCase() ||
        destination.refundAddress !==
          prepared.reservation.payload.dealerDestinationRefundAddress.toLowerCase() ||
        destination.secretHash !== prepared.secretHash.toLowerCase() ||
        Number(destination.timeout) !==
          Number(destinationMessage.payload.timeout)
      ) {
        throw new FxDesktopNetworkError(
          "settled destination does not match the accepted V3 route",
          "DESTINATION_MISMATCH"
        );
      }
      const claim = await this.#findClaimReceipt(
        route.outputChainId,
        prepared.tradeId,
        "destination",
        route.outputToken,
        destinationMessage.payload.transactionHash
      );
      return {
        state: "funds_ready",
        receipt: {
          schema: "versus-fx-funds-ready",
          schemaVersion: 1,
          status: "funds_ready",
          tradeId: prepared.tradeId,
          proposalId: prepared.proposal.proposalId,
          requester: prepared.requester,
          destinationAddress: prepared.destinationAddress,
          outputChainId: prepared.outputChainId,
          outputToken: prepared.outputToken,
          requiredAmountAtomic: prepared.outputAmountAtomic,
          observedAmountAtomic: destination.beneficiaryAmountAtomic,
          destinationTransactionHash: claim.transactionHash,
          destinationBlockNumber: String(claim.blockNumber),
          confirmations: claim.confirmations,
          confirmedAt: this.now(),
          endpointPaymentAuthorized: false,
          endpointPaymentSubmitted: false,
        },
      };
    }
    if (source.state === 3) {
      return {
        state: "refunded",
        refund: {
          eligible: true,
          eligibleAt: source.timeout,
          chainId: route.inputChainId,
          lockId: sourceId,
        },
      };
    }
    if (destination.state === 3) {
      const latestSource = await this.evm
        .provider(route.inputChainId)
        .getBlock("latest");
      return {
        state: "refund_wait",
        refund: {
          eligible:
            source.state === 1 &&
            Number(latestSource.timestamp) >= Number(source.timeout),
          eligibleAt: source.timeout,
          chainId: route.inputChainId,
          lockId: sourceId,
        },
        lastFailure: {
          code: "DEALER_DESTINATION_REFUNDED",
          message:
            "The destination lock expired; the requester source lock remains safely refundable",
          at: new Date(this.now() * 1000).toISOString(),
        },
      };
    }
    if (destination.state === 1) {
      const destinationLock = destinationMessage;
      if (!destinationLock || !quote) {
        return { state: "destination_lock_confirmed" };
      }
      const expectedDestinationTotal = (
        BigInt(route.outputAmountAtomic) +
        BigInt(quote.payload.destinationExecutorAmountAtomic)
      ).toString();
      if (
        destination.amountAtomic !== expectedDestinationTotal ||
        destination.beneficiaryAmountAtomic !== route.outputAmountAtomic ||
        destination.executorAmountAtomic !==
          quote.payload.destinationExecutorAmountAtomic ||
        destination.beneficiary !==
          prepared.destinationAddress.toLowerCase() ||
        destination.refundAddress !==
          prepared.reservation.payload.dealerDestinationRefundAddress.toLowerCase() ||
        destination.secretHash !== prepared.secretHash.toLowerCase() ||
        Number(destination.timeout) !==
          Number(destinationLock.payload.timeout) ||
        Number(source.timeout) <
          Number(destination.timeout) +
            FX_V2_MINIMUM_TIMEOUT_DELTA_SECONDS
      ) {
        throw new FxDesktopNetworkError(
          "recovered destination lock does not match the accepted V3 route",
          "DESTINATION_MISMATCH"
        );
      }
      const destinationBlock = await this.evm
        .provider(route.outputChainId)
        .getBlock("latest");
      if (Number(destinationBlock.timestamp) >= Number(destination.timeout)) {
        return {
          state: "refund_wait",
          refund: {
            eligible: false,
            eligibleAt: source.timeout,
            chainId: route.inputChainId,
            lockId: sourceId,
          },
        };
      }
      const recovery = restoreFxRecoveryPacket({
        filePath: prepared.recoveryFile,
        password: recoveryPassword,
        deploymentId: this.deploymentId,
        tradeId: prepared.tradeId,
      });
      const revealSecret = `0x${Buffer.from(recovery.secret).toString("hex")}`;
      if (recovery.secretHash !== prepared.secretHash) {
        throw new FxDesktopNetworkError(
          "recovered requester secret does not match the accepted V3 trade",
          "SECRET_COMMITMENT_MISMATCH"
        );
      }
      let reveal = this.requesterJournal.findType(
        prepared.tradeId,
        "fx_reveal"
      );
      if (!reveal) {
        reveal = await session.publish({
          protocol: "versus-fx",
          version: 3,
          type: "fx_reveal",
          tradeId: prepared.tradeId,
          createdAt: this.now(),
          expiresAt: source.timeout,
          payload: {
            acceptId: prepared.acceptance.id,
            destinationLockMessageId: destinationLock.id,
            secret: revealSecret,
            secretHash: prepared.secretHash,
          },
        });
      } else {
        await this.publishExisting(session, reveal);
      }
      await this.#ingestRelayerTrade(this.requesterJournal, prepared.tradeId);
      return {
        state: "secret_revealed",
        refund: {
          eligible: false,
          eligibleAt: source.timeout,
          chainId: route.inputChainId,
          lockId: sourceId,
        },
      };
    }
    if (source.state === 1) {
      const latestSource = await this.evm
        .provider(route.inputChainId)
        .getBlock("latest");
      return {
        state: Number(latestSource.timestamp) >= source.timeout
          ? "refund_wait"
          : "source_lock_confirmed",
        refund: {
          eligible: Number(latestSource.timestamp) >= source.timeout,
          eligibleAt: source.timeout,
          chainId: route.inputChainId,
          lockId: sourceId,
        },
      };
    }
    if (
      source.state === 0 &&
      Number(prepared.reservation?.payload?.reservationDeadline || 0) <=
        this.now()
    ) {
      return {
        state: "failed",
        lastFailure: {
          code: "FUNDING_WINDOW_EXPIRED",
          message:
            "The dealer reservation expired before a source lock was broadcast. Received source funds remain in the local FX wallet",
          at: new Date(this.now() * 1000).toISOString(),
        },
      };
    }
    return { state: "source_lock_pending" };
  }

  async #reconcileRequesterV2(prepared) {
    const route = prepared.proposal.route;
    const sourceId = phase5LockId(prepared.tradeId, "source");
    const destinationId = phase5LockId(prepared.tradeId, "destination");
    const [source, destination] = await Promise.all([
      this.evm.readLock(route.inputChainId, sourceId, route.inputToken),
      this.evm.readLock(route.outputChainId, destinationId, route.outputToken),
    ]);
    if (destination.state === 2) {
      const claim = await this.#findClaimReceipt(
        route.outputChainId,
        prepared.tradeId,
        "destination",
        route.outputToken
      );
      return {
        state: "funds_ready",
        receipt: {
          schema: "versus-fx-funds-ready",
          schemaVersion: 1,
          status: "funds_ready",
          tradeId: prepared.tradeId,
          proposalId: prepared.proposal.proposalId,
          requester: prepared.requester,
          destinationAddress: prepared.destinationAddress,
          outputChainId: prepared.outputChainId,
          outputToken: prepared.outputToken,
          requiredAmountAtomic: prepared.outputAmountAtomic,
          observedAmountAtomic: destination.beneficiaryAmountAtomic,
          destinationTransactionHash: claim.transactionHash,
          destinationBlockNumber: String(claim.blockNumber),
          confirmations: claim.confirmations,
          confirmedAt: this.now(),
          endpointPaymentAuthorized: false,
          endpointPaymentSubmitted: false,
        },
      };
    }
    if (source.state === 3) {
      return {
        state: "refunded",
        refund: {
          eligible: true,
          eligibleAt: source.timeout,
          chainId: route.inputChainId,
          lockId: sourceId,
        },
      };
    }
    if (source.state === 2) return { state: "source_claimed" };
    if (destination.state === 1) return {
      state: "destination_lock_confirmed",
      refund: {
        eligible: false,
        eligibleAt: destination.timeout,
        chainId: route.outputChainId,
        lockId: destinationId,
      },
    };
    if (destination.state === 3) {
      const latestSource = await this.evm
        .provider(route.inputChainId)
        .getBlock("latest");
      if (source.state === 1) {
        return {
          state: "refund_wait",
          refund: {
            eligible: Number(latestSource.timestamp) >= Number(source.timeout),
            eligibleAt: source.timeout,
            chainId: route.inputChainId,
            lockId: sourceId,
          },
          lastFailure: {
            code: "DEALER_DESTINATION_REFUNDED",
            message:
              "The destination lock expired; the requester source lock will be reclaimed automatically",
            at: new Date(this.now() * 1000).toISOString(),
          },
        };
      }
      return {
        state: "failed",
        lastFailure: {
          code: "DEALER_DESTINATION_REFUNDED",
          message: "The dealer destination lock expired before source funding",
          at: new Date(this.now() * 1000).toISOString(),
        },
      };
    }
    if (source.state === 1) return {
      state: "source_lock_confirmed",
      refund: {
        eligible: false,
        eligibleAt: source.timeout,
        chainId: route.inputChainId,
        lockId: sourceId,
      },
    };
    if (
      source.state === 0 &&
      destination.state === 0 &&
      Number(prepared.reservation?.payload?.reservationDeadline || 0) <=
        this.now()
    ) {
      return {
        state: "failed",
        lastFailure: {
          code: "FUNDING_WINDOW_EXPIRED",
          message:
            "The dealer reservation expired before a source lock was broadcast. Received source funds remain in the local FX wallet for the next quote",
          at: new Date(this.now() * 1000).toISOString(),
        },
      };
    }
    return { state: "source_lock_pending" };
  }

  async refundRequester({ prepared }) {
    const route = prepared.proposal.route;
    const sourceLock =
      prepared.acceptance?.version === 3
        ? this.requesterJournal.findType(prepared.tradeId, "fx_lock_source")
        : null;
    const refunded = await this.evm.refundLock({
      chainId: route.inputChainId,
      tradeId: prepared.tradeId,
      side: "source",
      role: "requester",
      token: route.inputToken,
      fundingTransactionHash: sourceLock?.payload?.transactionHash || null,
    });
    return {
      state: "refunded",
      refund: {
        eligible: true,
        eligibleAt: refunded.lock.timeout,
        chainId: route.inputChainId,
        lockId: refunded.lock.lockId,
        transactionHash: refunded.receipt?.transactionHash || null,
      },
    };
  }

  async armDealer({ policy, positions }) {
    if (this.dealer) return this.status().dealer;
    this.inventoryCache = null;
    this.dealerPolicy = { ...policy };
    this.dealerPositions = positions.filter((position) => position.enabled);
    const chainIds = [
      ...new Set(this.dealerPositions.map((position) => position.chainId)),
    ];
    await Promise.all(
      chainIds.map((chainId) => this.evm.preflight(chainId))
    );
    const created = this.createSession("dealer", "desktop-dealer.sqlite");
    this.dealerSession = created.session;
    this.dealerJournal = created.journal;
    const exposureFilePath = path.join(
      this.dataDirectory,
      "desktop-exposure.sqlite"
    );
    this.exposureJournal = openDeploymentJournal({
      dataDirectory: this.dataDirectory,
      filePath: exposureFilePath,
      deploymentId: this.deploymentId,
      create: () => new FxPhase8ExposureJournal({
        filePath: exposureFilePath,
        deploymentId: this.deploymentId,
        policy: this.#phase8Policy(),
        now: this.now,
      }),
    });
    const dealerAddress = (
      await this.signer("dealer").getAddress()
    ).toLowerCase();
    this.guard = new FxPhase8DealerGuard({
      journal: this.exposureJournal,
      dealerAddress,
      policy: this.#phase8Policy(),
      now: this.now,
      verifySourceLock: async ({ lockId, sourceLock }) =>
        this.evm.verifyLockEnvelope({
          chainId: sourceLock.payload.chainId,
          lockId,
          transactionHash: sourceLock.payload.transactionHash,
          token: sourceLock.payload.token,
        }),
      verifyDestinationLock: async ({ lockId, destinationLock }) =>
        this.evm.verifyLockEnvelope({
          chainId: destinationLock.payload.chainId,
          lockId,
          transactionHash: destinationLock.payload.transactionHash,
          token: destinationLock.payload.token,
        }),
      readDestinationLock: async ({ lockId, destinationObservation }) => {
        const lock = await this.evm.readLock(
          destinationObservation.chainId,
          lockId,
          destinationObservation.token,
          destinationObservation.transactionHash
        );
        return { exists: lock.state !== 0, ...lock };
      },
    });
    this.dealer = new FxDeterministicDealer({
      session: this.dealerSession,
      sourceClaimAddress: dealerAddress,
      destinationRefundAddress: dealerAddress,
      observationWindowMs: this.dealerObservationWindowMs,
      now: this.now,
      quotePolicy: (rfq) => this.#dealerQuote(rfq),
      protocolVersion: this.protocolVersion,
    });
    this.dealerSession.on("accepted", (envelope, metadata) => {
      this.#onDealerEnvelope(envelope, metadata).catch((error) => {
        this.emit("error", error);
      });
    });
    this.dealer.on("quoted", (quote) => {
      this.emit("trade", {
        tradeId: quote.tradeId,
        role: "dealer",
        state: "quoted",
        quote,
      });
    });
    this.dealer.on("reserved", (reserve) => {
      this.emit("trade", {
        tradeId: reserve.tradeId,
        role: "dealer",
        state: "accepted",
        reserve,
      });
      if (this.protocolVersion >= 2 && !this.processing.has(reserve.tradeId)) {
        const operation = this.#processReservationV2(reserve).finally(() => {
          this.processing.delete(reserve.tradeId);
        });
        this.processing.set(reserve.tradeId, operation);
        operation.catch((error) => this.emit("error", error));
      }
    });
    this.dealer.on("skipped", (rfq, reason) => {
      this.emit("trade", {
        tradeId: rfq.tradeId,
        role: "dealer",
        state: "quote_rejected",
        rejection: {
          code: reason?.reason || "policy_declined",
          detail: reason?.detail || null,
        },
      });
    });
    this.dealer.on("error", (error) => {
      this.emit("error", error);
    });
    await Promise.all([
      this.dealer.start(),
      this.ensureRelayerSession(),
    ]);
    this.#startRecoveryLoop();
    await this.reconcileDealerExposure({ force: true });
    this.emit("status", this.status());
    return this.status().dealer;
  }

  async inventorySnapshot(positions, { maximumAgeMs = 15_000 } = {}) {
    if (
      this.inventoryCache &&
      Date.now() - this.inventoryCache.at <= maximumAgeMs
    ) {
      return structuredClone(this.inventoryCache.positions);
    }
    const owner = (await this.signer("dealer").getAddress()).toLowerCase();
    const values = await Promise.all(
      positions.map(async (position) => {
        if (!position.enabled) return { id: position.id, address: owner };
        const availableAtomic = await this.evm.tokenBalance(
          position.chainId,
          position.assetAddress,
          owner
        );
        const assetKey = `${position.chainId}:${position.assetAddress}`;
        const activeTrades = this.exposureJournal?.activeTrades?.() || [];
        const reservedTrades = activeTrades.filter(
          (trade) => trade.assetKey === assetKey
        );
        const reservedAtomic = reservedTrades
          .reduce(
            (total, trade) =>
              total +
              BigInt(trade.package?.quote?.payload?.outputAmountAtomic || 0) +
              BigInt(
                trade.package?.quote?.payload
                  ?.destinationExecutorAmountAtomic || 0
              ),
            0n
          );
        const walletBalance = BigInt(availableAtomic);
        const gasReserve =
          position.assetAddress === FX_NATIVE_ETH_ADDRESS
            ? BigInt(
                this.evm.configuration?.(position.chainId)
                  ?.nativeGasReserveWei || 0
              )
            : 0n;
        const unreserved =
          walletBalance > reservedAtomic ? walletBalance - reservedAtomic : 0n;
        return {
          id: position.id,
          address: owner,
          availableAtomic: (
            unreserved > gasReserve
              ? unreserved - gasReserve
              : 0n
          ).toString(),
          reservedAtomic: reservedAtomic.toString(),
          activeLocks: reservedTrades.length,
        };
      })
    );
    this.inventoryCache = { at: Date.now(), positions: values };
    return structuredClone(values);
  }

  async updateDealer({ policy, positions }) {
    const wasArmed = Boolean(this.dealer);
    if (wasArmed) await this.disarmDealer();
    return this.armDealer({ policy, positions });
  }

  async disarmDealer() {
    const dealer = this.dealer;
    this.dealer = null;
    this.#unregisterLocalSession(this.dealerSession);
    if (dealer) await dealer.close();
    this.dealerJournal?.close?.();
    this.exposureJournal?.close?.();
    this.dealerSession = null;
    this.dealerJournal = null;
    this.exposureJournal = null;
    this.guard = null;
    this.inventoryCache = null;
    this.dealerRecoveries = [];
    this.lastDealerReconcileAt = 0;
    this.emit("status", this.status());
    return this.status().dealer;
  }

  async reconcileDealerExposure({ force = false, maximumAgeMs = 60_000 } = {}) {
    if (!this.exposureJournal || !this.dealerJournal) return [];
    if (
      !force &&
      Date.now() - this.lastDealerReconcileAt < maximumAgeMs
    ) {
      return structuredClone(this.dealerRecoveries);
    }
    this.lastDealerReconcileAt = Date.now();
    const recoveries = [];
    const chainHeads = new Map();
    for (const trade of this.exposureJournal.activeTrades()) {
      if (
        ![
          "destination_pending",
          "source_firm",
          "destination_locked",
          "destination_claimed",
        ].includes(trade.state)
      ) {
        continue;
      }
      const sourceLock = this.dealerJournal.findType(
        trade.tradeId,
        "fx_lock_source"
      );
      const destinationMessage = this.dealerJournal.findType(
        trade.tradeId,
        "fx_lock_destination"
      );
      if (
        ["destination_pending", "source_firm"].includes(trade.state) &&
        sourceLock &&
        !destinationMessage
      ) {
        const operationKey = trade.tradeId;
        if (!this.processing.has(operationKey)) {
          const operation = this.#processSourceLockV2(sourceLock).finally(() => {
            this.processing.delete(operationKey);
          });
          this.processing.set(operationKey, operation);
          await operation;
        }
        continue;
      }
      if (
        trade.state === "destination_pending" &&
        !sourceLock &&
        this.now() >= Number(trade.dealerDeadline)
      ) {
        this.exposureJournal.markTerminal(trade.tradeId, "cancelled");
        this.inventoryCache = null;
        this.emit("trade", {
          tradeId: trade.tradeId,
          role: "dealer",
          state: "cancelled",
          lastFailure: {
            code: "RESERVATION_EXPIRED_UNFUNDED",
            message:
              "Requester did not publish a source lock before the reservation expired",
          },
        });
        continue;
      }
      const lock = await this.evm.readLock(
        trade.package.quote.payload.outputChainId,
        trade.destinationLockId,
        trade.package.quote.payload.outputToken,
        destinationMessage?.payload?.transactionHash
      );
      if (
        lock.state === 2 &&
        ["destination_locked", "destination_claimed"].includes(trade.state)
      ) {
        const destinationLock =
          destinationMessage || trade.package.destinationLock;
        const destinationClaim = destinationLock
          ? this.#messageForLock(
              this.dealerJournal,
              trade.tradeId,
              destinationLock.id,
              "fx_claim"
            )
          : null;
        if (destinationLock && destinationClaim) {
          await this.#processDestinationClaim(
            destinationClaim,
            destinationLock
          );
        }
        continue;
      }
      if (lock.state === 3) {
        this.exposureJournal.markTerminal(trade.tradeId, "destination_refunded");
        this.emit("trade", {
          tradeId: trade.tradeId,
          role: "dealer",
          state: "refunded",
          refund: {
            eligible: true,
            eligibleAt: lock.timeout,
            chainId: lock.chainId,
            lockId: lock.lockId,
          },
        });
        continue;
      }
      if (lock.state === 1 && trade.state === "destination_pending") {
        const destinationLock =
          trade.package.destinationLock ||
          this.dealerJournal.findType(
            trade.tradeId,
            "fx_lock_destination"
          );
        if (destinationLock) {
          this.exposureJournal.markDestinationLockedV2(
            trade.tradeId,
            destinationLock
          );
        }
      }
      if (lock.state !== 1) continue;
      if (!chainHeads.has(lock.chainId)) {
        chainHeads.set(
          lock.chainId,
          await this.evm.provider(lock.chainId).getBlock("latest")
        );
      }
      const latest = chainHeads.get(lock.chainId);
      const eligible = Number(latest.timestamp) >= Number(lock.timeout);
      const sourceClaim =
        sourceLock &&
        this.#messageForLock(
          this.dealerJournal,
          trade.tradeId,
          sourceLock.id,
          "fx_claim"
        );
      if (this.protocolVersion === 3 && trade.state === "destination_locked") {
        const reveal = this.dealerJournal.findType(trade.tradeId, "fx_reveal");
        if (reveal) {
          await this.#ingestRelayerTrade(this.dealerJournal, trade.tradeId);
          await this.#scheduleRelayDestinationClaimV3(reveal);
          continue;
        }
      }
      if (
        this.protocolVersion === 2 &&
        trade.state === "destination_locked" &&
        sourceLock &&
        !sourceClaim &&
        !eligible
      ) {
        const operationKey = trade.tradeId;
        if (!this.processing.has(operationKey)) {
          const operation = this.#processSourceLockV2(sourceLock).finally(() => {
            this.processing.delete(operationKey);
          });
          this.processing.set(operationKey, operation);
          await operation;
        }
        continue;
      }
      const recovery = {
        tradeId: trade.tradeId,
        role: "dealer",
        state: "refund_wait",
        refund: {
          eligible,
          eligibleAt: lock.timeout,
          chainId: lock.chainId,
          lockId: lock.lockId,
        },
      };
      recoveries.push(recovery);
      this.emit("trade", recovery);
      if (eligible) {
        try {
          await this.refundDealerTrade(trade.tradeId);
          recoveries.pop();
        } catch (error) {
          if (error?.code !== "REFUND_IN_PROGRESS") {
            this.emit("error", error);
          }
        }
      }
    }
    this.dealerRecoveries = recoveries;
    this.emit("status", this.status());
    return structuredClone(recoveries);
  }

  async refundDealerTrade(tradeId) {
    tradeId = String(tradeId || "").toLowerCase();
    const operationKey = `dealer-refund:${tradeId}`;
    if (this.processing.has(operationKey)) {
      throw new FxDesktopNetworkError(
        "dealer refund is already being checked",
        "REFUND_IN_PROGRESS"
      );
    }
    const operation = this.#refundDealerTrade(tradeId).finally(() => {
      this.processing.delete(operationKey);
    });
    this.processing.set(operationKey, operation);
    return operation;
  }

  async #refundDealerTrade(tradeId) {
    if (!this.exposureJournal || !this.dealerJournal || !this.dealerSession) {
      throw new FxDesktopNetworkError(
        "dealer must be armed to recover a destination lock",
        "DEALER_INACTIVE"
      );
    }
    const trade = this.exposureJournal.trade(tradeId);
    if (!trade || trade.state !== "destination_locked") {
      throw new FxDesktopNetworkError(
        "dealer trade has no refundable destination lock",
        "REFUND_UNAVAILABLE"
      );
    }
    const destinationLock = this.dealerJournal.findType(
      tradeId,
      "fx_lock_destination"
    );
    if (!destinationLock) {
      throw new FxDesktopNetworkError(
        "verified destination lock message is unavailable",
        "INCOMPLETE_RECOVERY"
      );
    }
    const lock = await this.evm.readLock(
      destinationLock.payload.chainId,
      trade.destinationLockId,
      destinationLock.payload.token,
      destinationLock.payload.transactionHash
    );
    const latest = await this.evm.provider(lock.chainId).getBlock("latest");
    if (lock.state !== 1 || Number(latest.timestamp) < Number(lock.timeout)) {
      throw new FxDesktopNetworkError(
        "dealer destination refund is not unlocked yet",
        "REFUND_NOT_READY"
      );
    }
    const refunded = await this.evm.refundLock({
      chainId: lock.chainId,
      tradeId,
      side: "destination",
      role: "dealer",
      token: destinationLock.payload.token,
      fundingTransactionHash: destinationLock.payload.transactionHash,
    });
    this.inventoryCache = null;
    const txHash =
      refunded.receipt?.transactionHash ||
      (await this.evm.findLockEvent({
        chainId: lock.chainId,
        tradeId,
        side: "destination",
        eventName: "LockRefunded",
        token: destinationLock.payload.token,
        fundingTransactionHash: destinationLock.payload.transactionHash,
      })).transactionHash;
    const blockNumber =
      refunded.receipt?.blockNumber ||
      await this.#transactionBlock(lock.chainId, txHash);
    await this.dealerSession.publish({
      protocol: "versus-fx",
      version: this.protocolVersion,
      type: "fx_refund",
      tradeId,
      createdAt: this.now(),
      expiresAt: this.now() + 30 * 24 * 60 * 60,
      payload: {
        lockMessageId: destinationLock.id,
        chainId: lock.chainId,
        transactionHash: txHash,
        blockNumber: String(blockNumber),
        beneficiary: lock.refundAddress,
      },
    });
    this.exposureJournal.markTerminal(tradeId, "destination_refunded");
    this.dealerRecoveries = this.dealerRecoveries.filter(
      (candidate) => candidate.tradeId !== tradeId
    );
    const result = {
      tradeId,
      role: "dealer",
      state: "refunded",
      refund: {
        eligible: true,
        eligibleAt: lock.timeout,
        chainId: lock.chainId,
        lockId: lock.lockId,
        transactionHash: txHash,
      },
    };
    this.emit("trade", result);
    this.emit("status", this.status());
    return result;
  }

  #phase8Policy() {
    const policy = this.dealerPolicy || {};
    return {
      minimumTradeInputAtomic: dollarsToMicros(
        policy.minimumTradeUsd ?? 0.01
      ),
      maximumTradeInputAtomic: dollarsToMicros(policy.maximumTradeUsd || 50),
      maximumRequesterGasInputAtomic: dollarsToMicros(policy.maximumGasUsd || 5),
      maximumOverheadBps: Number(policy.maximumOverheadBps || 100),
      maximumActiveValueMicrosGlobal: dollarsToMicros(
        policy.maximumExposureUsd || 1_000
      ),
      maximumActiveValueMicrosPerRequester: dollarsToMicros(
        policy.maximumRequesterExposureUsd || 100
      ),
      maximumActiveValueMicrosPerAsset: dollarsToMicros(
        policy.maximumAssetExposureUsd || 500
      ),
    };
  }

  async #dealerQuote(rfq) {
    const destination = this.dealerPositions.find(
      (position) =>
        position.chainId === rfq.payload.outputChainId &&
        position.assetAddress === rfq.payload.outputToken
    );
    if (!destination) {
      return {
        quote: null,
        rejection: { code: "unsupported_destination" },
      };
    }
    const input = rfq.payload.inputOptions.find((candidate) =>
      this.dealerPositions.some(
        (position) =>
          position.chainId === candidate.chainId &&
          position.assetAddress === candidate.token
      )
    );
    if (!input || input.chainId === destination.chainId) {
      return {
        quote: null,
        rejection: { code: "unsupported_source_route" },
      };
    }
    const output = BigInt(rfq.payload.outputAmountAtomic);
    const usesNative =
      destination.assetAddress === FX_NATIVE_ETH_ADDRESS ||
      input.token === FX_NATIVE_ETH_ADDRESS;
    const nativePriceMicros = usesNative
      ? await this.#nativePriceMicros()
      : 1_000_000n;
    const outputValueMicros = this.#assetValueMicros(
      output,
      destination,
      nativePriceMicros
    );
    const minimum = BigInt(dollarsToMicros(this.dealerPolicy.minimumTradeUsd));
    const maximum = BigInt(dollarsToMicros(this.dealerPolicy.maximumTradeUsd));
    if (outputValueMicros < minimum || outputValueMicros > maximum) {
      return {
        quote: null,
        rejection: { code: "trade_outside_limits" },
      };
    }
    if (this.protocolVersion === 1) {
      const balance = BigInt(
        await this.evm.tokenBalance(
          destination.chainId,
          destination.assetAddress
        )
      );
      if (balance < output) return null;
      const spreadBps =
        Number(this.dealerPolicy.minimumSpreadBps) +
        Number(this.dealerPolicy.inventoryPremiumBps || 0);
      const inputValueMicros =
        ((outputValueMicros * BigInt(10_000 + spreadBps)) + 9_999n) /
        10_000n;
      const inputAmountAtomic = this.#assetAmountForMicros(
        inputValueMicros,
        input,
        nativePriceMicros
      );
      if (inputAmountAtomic > BigInt(input.maxInputAtomic)) return null;
      return {
        inputChainId: input.chainId,
        inputToken: input.token,
        inputAmountAtomic: inputAmountAtomic.toString(),
        referenceSource: usesNative
          ? "relay:hatch-exact-output"
          : "desktop:cohort:usdc-par",
        referencePriceMicros: nativePriceMicros.toString(),
        referenceTimestamp: this.now(),
        spreadBps,
        dealerSettlementCostAtomic: "0",
        estimatedCompletionSeconds: 45,
        adapterId: "evm-htlc-v1",
        adapterVersion: 1,
        sourceAdapterId:
          input.token === FX_NATIVE_ETH_ADDRESS
            ? "evm-native-htlc-v1"
            : "evm-htlc-v1",
        sourceAdapterVersion: 1,
        destinationAdapterId:
          destination.assetAddress === FX_NATIVE_ETH_ADDRESS
            ? "evm-native-htlc-v1"
            : "evm-htlc-v1",
        destinationAdapterVersion: 1,
      };
    }
    const referenceTimestamp = this.now();
    const destinationFeeData = await this.evm
      .provider(destination.chainId)
      .getFeeData();
    const destinationMaxFeePerGas =
      this.protocolVersion === 3
        ? v3BufferedGasPrice(destinationFeeData)
        : BigInt(
            destinationFeeData.maxFeePerGas ||
              destinationFeeData.gasPrice ||
              1
          ) * 2n;
    if (destinationMaxFeePerGas <= 0n) {
      throw new FxDesktopNetworkError(
        "destination gas price is unavailable",
        "EXECUTOR_GAS_UNAVAILABLE"
      );
    }
    const destinationClaimGasEstimate =
      this.protocolVersion === 3
        ? v3GasUnits(destination.chainId, "destinationClaim")
        : 160_000n;
    const destinationClaimGasWei =
      destinationClaimGasEstimate * destinationMaxFeePerGas;
    const destinationExecutorValueMicros =
      this.protocolVersion === 3
        ? ceilDiv(
            destinationClaimGasWei * nativePriceMicros,
            10n ** 18n
          )
        : (destinationClaimGasWei * nativePriceMicros) / 10n ** 18n +
          10_000n;
    const destinationExecutorAmount =
      destination.assetAddress === FX_NATIVE_ETH_ADDRESS
        ? this.protocolVersion === 3
          ? destinationClaimGasWei
          : destinationClaimGasWei +
            ceilDiv(10_000n * 10n ** 18n, nativePriceMicros)
        : destinationExecutorValueMicros;
    const destinationLiability = output + destinationExecutorAmount;
    const balance = BigInt(
      await this.evm.tokenBalance(destination.chainId, destination.assetAddress)
    );
    const reserved = (this.exposureJournal?.activeTrades?.() || [])
      .filter(
        (trade) =>
          trade.assetKey ===
          `${destination.chainId}:${destination.assetAddress}`
      )
      .reduce(
        (total, trade) =>
          total +
          BigInt(trade.package?.quote?.payload?.outputAmountAtomic || 0) +
          BigInt(
            trade.package?.quote?.payload
              ?.destinationExecutorAmountAtomic || 0
          ),
        0n
      );
    const configuration = this.evm.configuration(destination.chainId);
    const gasReserve =
      destination.assetAddress === FX_NATIVE_ETH_ADDRESS
        ? BigInt(configuration.nativeGasReserveWei || 0)
        : 0n;
    const unreserved = balance > reserved ? balance - reserved : 0n;
    const available = unreserved > gasReserve ? unreserved - gasReserve : 0n;
    if (available < destinationLiability) {
      return {
        quote: null,
        rejection: { code: "insufficient_destination_inventory" },
      };
    }
    const spreadBps =
      Number(this.dealerPolicy.minimumSpreadBps) +
      Number(this.dealerPolicy.inventoryPremiumBps || 0);
    const dealerPrincipalAtomic = this.#assetAmountForMicros(
      outputValueMicros,
      input,
      nativePriceMicros
    );
    const dealerSpreadAtomic =
      (dealerPrincipalAtomic * BigInt(spreadBps) + 9_999n) / 10_000n;
    const sourceFeeData = await this.evm.provider(input.chainId).getFeeData();
    const sourceMaxFeePerGas =
      this.protocolVersion === 3
        ? v3BufferedGasPrice(sourceFeeData)
        : BigInt(
            sourceFeeData.maxFeePerGas || sourceFeeData.gasPrice || 1
          ) * 2n;
    if (sourceMaxFeePerGas <= 0n) {
      throw new FxDesktopNetworkError(
        "source gas price is unavailable",
        "DEALER_GAS_UNAVAILABLE"
      );
    }
    const dealerGasWei =
      this.protocolVersion === 3
        ? v3GasUnits(input.chainId, "sourceClaim") * sourceMaxFeePerGas +
          v3GasUnits(destination.chainId, "destinationFund") *
            destinationMaxFeePerGas
        : 360_000n * sourceMaxFeePerGas +
          240_000n * destinationMaxFeePerGas;
    const dealerOperatingValueMicros =
      (this.protocolVersion === 3
        ? ceilDiv(dealerGasWei * nativePriceMicros, 10n ** 18n)
        : (dealerGasWei * nativePriceMicros) / 10n ** 18n) +
      destinationExecutorValueMicros;
    const dealerOperatingCostAtomic = this.#assetAmountForMicros(
      dealerOperatingValueMicros,
      input,
      nativePriceMicros
    );
    const inputAmountAtomic =
      dealerPrincipalAtomic + dealerSpreadAtomic + dealerOperatingCostAtomic;
    if (inputAmountAtomic > BigInt(input.maxInputAtomic)) {
      return {
        quote: null,
        rejection: { code: "requester_max_input_exceeded" },
      };
    }
    const adapterVersion = this.protocolVersion;
    const quote = {
      inputChainId: input.chainId,
      inputToken: input.token,
      inputAmountAtomic: inputAmountAtomic.toString(),
      referenceSource: usesNative
        ? "relay:hatch-exact-output"
        : "desktop:cohort:usdc-par",
      referencePriceMicros: nativePriceMicros.toString(),
      referenceTimestamp,
      spreadBps,
      dealerSettlementCostAtomic: dealerOperatingCostAtomic.toString(),
      estimatedCompletionSeconds: 60,
      adapterId: `evm-htlc-v${adapterVersion}`,
      adapterVersion,
      sourceAdapterId:
        input.token === FX_NATIVE_ETH_ADDRESS
          ? `evm-native-htlc-v${adapterVersion}`
          : `evm-htlc-v${adapterVersion}`,
      sourceAdapterVersion: adapterVersion,
      destinationAdapterId:
        destination.assetAddress === FX_NATIVE_ETH_ADDRESS
          ? `evm-native-htlc-v${adapterVersion}`
          : `evm-htlc-v${adapterVersion}`,
      destinationAdapterVersion: adapterVersion,
      dealerPrincipalAtomic: dealerPrincipalAtomic.toString(),
      dealerSpreadAtomic: dealerSpreadAtomic.toString(),
      dealerOperatingCostAtomic: dealerOperatingCostAtomic.toString(),
      destinationExecutorAmountAtomic: destinationExecutorAmount.toString(),
      destinationClaimGasEstimate: destinationClaimGasEstimate.toString(),
      destinationMaxFeePerGas: destinationMaxFeePerGas.toString(),
      gasPriceSource: `rpc:eip155:${destination.chainId}`,
      gasPriceTimestamp: referenceTimestamp,
    };
    if (this.protocolVersion === 2) {
      quote.secretHash = this.#dealerSecret(rfq.tradeId).secretHash;
    }
    return quote;
  }

  #dealerSecret(tradeId) {
    const recoveryFile = path.join(
      this.dealerSecretDirectory,
      `${String(tradeId).slice(2)}.recovery.json`
    );
    const password = this.signer("dealer").privateKey;
    if (fs.existsSync(recoveryFile)) {
      return {
        recoveryFile,
        ...restoreFxRecoveryPacket({
          filePath: recoveryFile,
          password,
          deploymentId: this.deploymentId,
          tradeId,
        }),
      };
    }
    return createFxRecoveryPacket({
      filePath: recoveryFile,
      password,
      deploymentId: this.deploymentId,
      tradeId,
      createdAt: this.now(),
      secret: crypto.randomBytes(32),
      metadata: {
        purpose: "dealer-owned-v2-settlement-secret",
        protocolVersion: 2,
      },
    });
  }

  async #nativePriceMicros() {
    if (
      this.nativePrice &&
      Date.now() - this.nativePrice.at <= 180_000
    ) {
      return this.nativePrice.value;
    }
    if (typeof this.nativeUsdPriceProvider !== "function") {
      throw new FxDesktopNetworkError(
        "fresh ETH/USD reference is unavailable",
        "STALE_PRICE"
      );
    }
    const value = BigInt(await this.nativeUsdPriceProvider());
    if (value <= 0n) {
      throw new FxDesktopNetworkError(
        "fresh ETH/USD reference is unavailable",
        "STALE_PRICE"
      );
    }
    this.nativePrice = { value, at: Date.now() };
    return value;
  }

  async #assertDestinationExecutorSufficientV2(quote) {
    const provider = this.evm.provider(quote.payload.outputChainId);
    const feeData = await provider.getFeeData();
    const currentMaxFeePerGas =
      this.protocolVersion === 3
        ? BigInt(feeData.gasPrice || feeData.maxFeePerGas || 0)
        : BigInt(feeData.maxFeePerGas || feeData.gasPrice || 0);
    if (currentMaxFeePerGas <= 0n) {
      throw new FxDesktopNetworkError(
        "destination gas price is unavailable",
        "EXECUTOR_GAS_UNAVAILABLE"
      );
    }
    const requiredNative = BigInt(
      quote.payload.destinationClaimGasEstimate
    ) * currentMaxFeePerGas;
    let requiredExecutor = requiredNative;
    if (quote.payload.outputToken !== FX_NATIVE_ETH_ADDRESS) {
      const configuration = this.evm.configuration(
        quote.payload.outputChainId
      );
      const decimals = Number(configuration.tokenDecimals);
      if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) {
        throw new FxDesktopNetworkError(
          "destination token decimals are unavailable",
          "EXECUTOR_GAS_UNAVAILABLE"
        );
      }
      const nativePriceMicros = await this.#nativePriceMicros();
      const requiredMicros =
        (
          requiredNative * nativePriceMicros +
          10n ** 18n -
          1n
        ) / 10n ** 18n;
      requiredExecutor =
        decimals >= 6
          ? requiredMicros * 10n ** BigInt(decimals - 6)
          : (
              requiredMicros +
              10n ** BigInt(6 - decimals) -
              1n
            ) / 10n ** BigInt(6 - decimals);
    }
    if (
      BigInt(quote.payload.destinationExecutorAmountAtomic) <
      requiredExecutor
    ) {
      throw new FxDesktopNetworkError(
        "destination executor bounty no longer covers current gas",
        "EXECUTOR_BOUNTY_UNDERFUNDED"
      );
    }
  }

  #assetValueMicros(amount, position, nativePriceMicros) {
    return position.assetAddress === FX_NATIVE_ETH_ADDRESS
      ? (amount * nativePriceMicros) / 10n ** 18n
      : amount;
  }

  #assetAmountForMicros(valueMicros, option, nativePriceMicros) {
    return option.token === FX_NATIVE_ETH_ADDRESS
      ? ((valueMicros * 10n ** 18n) + nativePriceMicros - 1n) /
          nativePriceMicros
      : valueMicros;
  }

  async #onDealerEnvelope(envelope) {
    if (!this.guard || !this.dealerSession) return;
    if (
      this.protocolVersion >= 2 &&
      envelope.type === "fx_reserve" &&
      envelope.sender === this.dealerSession.address
    ) {
      if (this.processing.has(envelope.tradeId)) return;
      const operation = this.#processReservationV2(envelope).finally(() => {
        this.processing.delete(envelope.tradeId);
      });
      this.processing.set(envelope.tradeId, operation);
      await operation;
      return;
    }
    if (envelope.type === "fx_lock_source") {
      const preceding = this.processing.get(envelope.tradeId);
      if (preceding) await preceding;
      const operation = (
          this.protocolVersion >= 2
          ? this.#processSourceLockV2(envelope)
          : this.#processSourceLock(envelope)
      ).finally(() => {
        this.processing.delete(envelope.tradeId);
      });
      this.processing.set(envelope.tradeId, operation);
      await operation;
      return;
    }
    if (
      [1, 3].includes(this.protocolVersion) &&
      envelope.type === "fx_claim"
    ) {
      const destinationLock = this.dealerJournal.findType(
        envelope.tradeId,
        "fx_lock_destination"
      );
      if (
        destinationLock &&
        envelope.payload.lockMessageId === destinationLock.id
      ) {
        await this.#processDestinationClaim(envelope, destinationLock);
      }
    }
  }

  async #processReservationV2(reserve) {
    const tradeId = reserve.tradeId;
    const quote = this.dealerJournal.findType(tradeId, "fx_quote");
    const accept = this.dealerJournal.findType(tradeId, "fx_accept");
    if (
      !quote ||
      !accept ||
      quote.version !== this.protocolVersion ||
      accept.version !== this.protocolVersion
    ) {
      throw new FxDesktopNetworkError(
        "dealer reservation package is incomplete",
        "INCOMPLETE_RESERVATION_PACKAGE"
      );
    }
    if (this.protocolVersion === 2) {
      const recovery = this.#dealerSecret(tradeId);
      if (
        quote.payload.secretHash !== recovery.secretHash ||
        accept.payload.secretHash !== recovery.secretHash
      ) {
        throw new FxDesktopNetworkError(
          "durable dealer secret does not match the accepted quote",
          "SECRET_COMMITMENT_MISMATCH"
        );
      }
    }
    const beneficiaryAmount = BigInt(quote.payload.outputAmountAtomic);
    const executorAmount = BigInt(
      quote.payload.destinationExecutorAmountAtomic
    );
    const amount = beneficiaryAmount + executorAmount;
    this.exposureJournal.reserveDestinationV2({
      rfq: this.dealerJournal.findType(tradeId, "fx_rfq"),
      quote,
      accept,
      reserve,
      expectedSourceLockId: phase5LockId(tradeId, "source"),
      expectedDestinationLockId: phase5LockId(tradeId, "destination"),
      exposureValueMicros: this.#assetValueMicros(
        beneficiaryAmount,
        {
          assetAddress: quote.payload.outputToken,
        },
        BigInt(quote.payload.referencePriceMicros)
      ).toString(),
      economics: {
        beneficiaryAmountAtomic: beneficiaryAmount.toString(),
        executorAmountAtomic: executorAmount.toString(),
        totalDestinationLiabilityAtomic: amount.toString(),
      },
    });
    this.emit("trade", {
      tradeId,
      role: "dealer",
      state: "reserved",
      fundingEligibleUntil: reserve.payload.reservationDeadline,
    });
    return this.exposureJournal.trade(tradeId);
  }

  async #processSourceLockV2(sourceLock) {
    const tradeId = sourceLock.tradeId;
    const quote = this.dealerJournal.findType(tradeId, "fx_quote");
    const accept = this.dealerJournal.findType(tradeId, "fx_accept");
    const reserve = this.dealerJournal.findType(tradeId, "fx_reserve");
    if (!quote || !accept || !reserve) {
      throw new FxDesktopNetworkError(
        "V2 source package is incomplete",
        "INCOMPLETE_SOURCE_PACKAGE"
      );
    }
    const sourceObservation = await this.evm.verifyLockEnvelope({
      chainId: sourceLock.payload.chainId,
      lockId: phase5LockId(tradeId, "source"),
      transactionHash: sourceLock.payload.transactionHash,
      token: sourceLock.payload.token,
    });
    if (
      (
        sourceObservation.confirmed !== true &&
        sourceObservation.state !== 2
      ) ||
      sourceObservation.amountAtomic !== accept.payload.totalInputAtomic ||
      sourceObservation.beneficiaryAmountAtomic !==
        accept.payload.totalInputAtomic ||
      sourceObservation.executorAmountAtomic !== "0" ||
      sourceObservation.beneficiary !==
        reserve.payload.dealerSourceClaimAddress.toLowerCase() ||
      sourceObservation.refundAddress !==
        accept.payload.sourceRefundAddress.toLowerCase() ||
      Number(sourceObservation.timeout) !== sourceLock.payload.timeout ||
      sourceObservation.secretHash !== accept.payload.secretHash
    ) {
      throw new FxDesktopNetworkError(
        "V2 source lock is not firm or does not match the accepted route",
        "SOURCE_LOCK_MISMATCH"
      );
    }
    const sourceBlockTimestamp = Number(
      sourceObservation.blockTimestamp ||
      (await this.evm
        .provider(sourceLock.payload.chainId)
        .getBlock("latest")).timestamp
    );
    if (sourceBlockTimestamp > Number(reserve.payload.reservationDeadline)) {
      throw new FxDesktopNetworkError(
        "V2 source lock arrived after the dealer reservation expired",
        "SOURCE_LOCK_LATE"
      );
    }
    const outputBlock = await this.evm
      .provider(quote.payload.outputChainId)
      .getBlock("latest");
    const existingExposure = this.exposureJournal.trade(tradeId);
    const destinationRefundTimestamp =
      existingExposure?.destinationRefundTimestamp > 0
        ? existingExposure.destinationRefundTimestamp
        : Number(outputBlock.timestamp) +
          FX_V2_DESTINATION_REFUND_SECONDS;
    if (
      Number(sourceLock.payload.timeout) <
      destinationRefundTimestamp +
        FX_V2_MINIMUM_TIMEOUT_DELTA_SECONDS
    ) {
      throw new FxDesktopNetworkError(
        "V2 source lock leaves no safe destination refund window",
        "UNSAFE_TIMEOUT_ORDER"
      );
    }
    if (
      ["destination_pending", "source_firm"].includes(
        existingExposure?.state
      )
    ) {
      this.exposureJournal.firmSourceV2(
        tradeId,
        sourceLock,
        destinationRefundTimestamp
      );
    } else if (existingExposure?.state !== "destination_locked") {
      throw new FxDesktopNetworkError(
        "V2 source lock has no recoverable dealer exposure",
        "SOURCE_LOCK_UNAVAILABLE"
      );
    }
    const recovery =
      this.protocolVersion === 2 ? this.#dealerSecret(tradeId) : null;
    const settlementSecretHash =
      this.protocolVersion === 2
        ? recovery.secretHash
        : accept.payload.secretHash;
    const beneficiaryAmount = BigInt(quote.payload.outputAmountAtomic);
    const executorAmount = BigInt(
      quote.payload.destinationExecutorAmountAtomic
    );
    const destinationAmount = beneficiaryAmount + executorAmount;
    this.emit("trade", {
      tradeId,
      role: "dealer",
      state: "source_lock_confirmed",
      transactionHash: sourceLock.payload.transactionHash,
      refundEligibleAt: sourceLock.payload.timeout,
    });
    const funded = await this.evm.fundLock({
      chainId: quote.payload.outputChainId,
      tradeId,
      side: "destination",
      amountAtomic: destinationAmount.toString(),
      beneficiaryAmountAtomic: beneficiaryAmount.toString(),
      executorAmountAtomic: executorAmount.toString(),
      beneficiary: accept.payload.destinationClaimAddress,
      refundAddress: reserve.payload.dealerDestinationRefundAddress,
      secretHash: settlementSecretHash,
      refundTimestamp: destinationRefundTimestamp,
      role: "dealer",
      token: quote.payload.outputToken,
    });
    this.inventoryCache = null;
    const destinationTransactionHash =
      funded.receipt?.transactionHash ||
      await this.#findFundTransaction(
        quote.payload.outputChainId,
        tradeId,
        "destination",
        quote.payload.outputToken,
        funded.lock?.lockDigest
      );
    const destinationBlockNumber =
      funded.receipt?.blockNumber ||
      await this.#transactionBlock(
        quote.payload.outputChainId,
        destinationTransactionHash
      );
    let destinationLock = this.dealerJournal.findType(
      tradeId,
      "fx_lock_destination"
    );
    if (!destinationLock) {
      destinationLock = await this.dealerSession.publish({
        protocol: "versus-fx",
        version: this.protocolVersion,
        type: "fx_lock_destination",
        tradeId,
        createdAt: this.now(),
        expiresAt: destinationRefundTimestamp,
        payload: {
          acceptId: accept.id,
          chainId: quote.payload.outputChainId,
          token: quote.payload.outputToken,
          amountAtomic: destinationAmount.toString(),
          beneficiaryAmountAtomic: beneficiaryAmount.toString(),
          executorAmountAtomic: executorAmount.toString(),
          lockAddress: this.evm.adapterAddress(
            quote.payload.outputChainId,
            quote.payload.outputToken
          ),
          beneficiary: accept.payload.destinationClaimAddress,
          refundAddress: reserve.payload.dealerDestinationRefundAddress,
          secretHash: settlementSecretHash,
          timeout: destinationRefundTimestamp,
          transactionHash: destinationTransactionHash,
          blockNumber: String(destinationBlockNumber),
        },
      });
    }
    const destinationObservation = await this.evm.verifyLockEnvelope({
      chainId: quote.payload.outputChainId,
      lockId: phase5LockId(tradeId, "destination"),
      transactionHash: destinationLock.payload.transactionHash,
      token: quote.payload.outputToken,
    });
    if (
      destinationObservation.confirmed !== true ||
      destinationObservation.amountAtomic !== destinationAmount.toString() ||
      destinationObservation.beneficiaryAmountAtomic !==
        beneficiaryAmount.toString() ||
      destinationObservation.executorAmountAtomic !== executorAmount.toString() ||
      destinationObservation.beneficiary !==
        accept.payload.destinationClaimAddress.toLowerCase() ||
      destinationObservation.refundAddress !==
        reserve.payload.dealerDestinationRefundAddress.toLowerCase() ||
      Number(destinationObservation.timeout) !== destinationRefundTimestamp ||
      destinationObservation.secretHash !== settlementSecretHash
    ) {
      throw new FxDesktopNetworkError(
        "V2 destination lock failed independent verification",
        "DESTINATION_LOCK_MISMATCH"
      );
    }
    this.exposureJournal.markDestinationLockedV2(tradeId, destinationLock);
    this.emit("trade", {
      tradeId,
      role: "dealer",
      state: "destination_lock_confirmed",
      transactionHash: destinationTransactionHash,
      refundEligibleAt: destinationRefundTimestamp,
    });
    await this.#ingestRelayerTrade(this.dealerJournal, tradeId);
    if (this.protocolVersion === 3) {
      return destinationLock;
    }
    const claimed = await this.evm.claimLock({
      chainId: quote.payload.inputChainId,
      tradeId,
      side: "source",
      secret: `0x${Buffer.from(recovery.secret).toString("hex")}`,
      role: "dealer",
      token: quote.payload.inputToken,
    });
    this.inventoryCache = null;
    const transactionHash =
      claimed.receipt?.transactionHash ||
      await this.#findClaimTransaction(
        quote.payload.inputChainId,
        tradeId,
        "source",
        quote.payload.inputToken
      );
    const blockNumber =
      claimed.receipt?.blockNumber ||
      await this.#transactionBlock(quote.payload.inputChainId, transactionHash);
    let claimMessage = this.#messageForLock(
      this.dealerJournal,
      tradeId,
      sourceLock.id,
      "fx_claim"
    );
    if (!claimMessage) {
      claimMessage = await this.dealerSession.publish({
        protocol: "versus-fx",
        version: 2,
        type: "fx_claim",
        tradeId,
        createdAt: this.now(),
        expiresAt: this.now() + 30 * 24 * 60 * 60,
        payload: {
          lockMessageId: sourceLock.id,
          chainId: quote.payload.inputChainId,
          transactionHash,
          blockNumber: String(blockNumber),
          secretHash: accept.payload.secretHash,
          beneficiary: sourceLock.payload.beneficiary,
        },
      });
    }
    this.emit("trade", {
      tradeId,
      role: "dealer",
      state: "source_claimed",
      transactionHash,
    });
    await this.#ingestRelayerTrade(this.dealerJournal, tradeId);
    await this.#scheduleRelayDestinationClaimV2(claimMessage);
    return claimMessage;
  }

  #messageForLock(journal, tradeId, lockMessageId, type) {
    if (
      typeof journal?.snapshot !== "function" ||
      typeof journal?.message !== "function"
    ) {
      return null;
    }
    return journal
      .snapshot(tradeId)
      ?.messages?.filter((entry) => entry.type === type)
      .map((entry) => journal.message(entry.id))
      .find((entry) => entry?.payload?.lockMessageId === lockMessageId) || null;
  }

  #claimSide(journal, claimMessage) {
    const lock = journal.message(claimMessage?.payload?.lockMessageId);
    if (lock?.type === "fx_lock_source") return "source";
    if (lock?.type === "fx_lock_destination") return "destination";
    return null;
  }

  async #ingestRelayerTrade(sourceJournal, tradeId) {
    if (!this.relayerSession || !this.relayerJournal) return;
    const snapshot = sourceJournal?.snapshot?.(tradeId);
    for (const entry of snapshot?.messages || []) {
      const envelope = sourceJournal.message(entry.id);
      if (!envelope) continue;
      const result = this.relayerSession.ingest(envelope, {
        desktopRecovery: true,
        localDealerMirror: true,
      });
      if (!["accepted", "duplicate", "pending"].includes(result.status)) {
        throw new FxDesktopNetworkError(
          `relayer journal rejected ${envelope.type}: ${result.error || result.status}`,
          "RELAYER_JOURNAL_REJECTED"
        );
      }
    }
    this.relayerSession.retryPending?.();
  }

  async #resumeRelayer() {
    if (!this.relayerJournal?.tradeIds) return;
    for (const tradeId of this.relayerJournal.tradeIds()) {
      const snapshot = this.relayerJournal.snapshot(tradeId);
      if (
        this.protocolVersion === 2 &&
        ["source_claimed", "source_locked"].includes(snapshot?.settlementState)
      ) {
        const sourceLock = this.relayerJournal.findType(
          tradeId,
          "fx_lock_source"
        );
        const sourceClaim = sourceLock
          ? this.#messageForLock(
              this.relayerJournal,
              tradeId,
              sourceLock.id,
              "fx_claim"
            )
          : null;
        if (sourceClaim) {
          await this.#scheduleRelayDestinationClaimV2(sourceClaim);
        }
      } else if (
        this.protocolVersion === 3 &&
        ["secret_revealed", "destination_claimed"].includes(
          snapshot?.settlementState
        )
      ) {
        const reveal = this.relayerJournal.findType(tradeId, "fx_reveal");
        if (reveal) {
          await this.#scheduleRelayDestinationClaimV3(reveal);
        }
      }
    }
  }

  async #scheduleRelayDestinationClaimV2(sourceClaim) {
    const tradeId = sourceClaim.tradeId;
    if (this.relayerProcessing.has(tradeId)) {
      return this.relayerProcessing.get(tradeId);
    }
    const operation = this.#relayDestinationClaimV2(sourceClaim).finally(() => {
      this.relayerProcessing.delete(tradeId);
    });
    this.relayerProcessing.set(tradeId, operation);
    return operation;
  }

  async #relayDestinationClaimV2(sourceClaim) {
    const journal = this.relayerJournal;
    const destinationLock = journal.findType(
      sourceClaim.tradeId,
      "fx_lock_destination"
    );
    const sourceLock = journal.message(sourceClaim.payload.lockMessageId);
    if (!destinationLock || sourceLock?.type !== "fx_lock_source") return null;
    if (
      this.#messageForLock(
        journal,
        sourceClaim.tradeId,
        destinationLock.id,
        "fx_claim"
      )
    ) {
      return null;
    }
    const lock = await this.evm.readLock(
      destinationLock.payload.chainId,
      phase5LockId(sourceClaim.tradeId, "destination"),
      destinationLock.payload.token
    );
    if (lock.state !== 1) return null;
    const secret = await this.evm.extractClaimSecret({
      chainId: sourceLock.payload.chainId,
      tradeId: sourceClaim.tradeId,
      side: "source",
      transactionHash: sourceClaim.payload.transactionHash,
      token: sourceLock.payload.token,
    });
    const claimed = await this.evm.claimLock({
      chainId: destinationLock.payload.chainId,
      tradeId: sourceClaim.tradeId,
      side: "destination",
      secret,
      // The dealer wallet is already gas-funded. The V2 destination lock pays
      // its permissionless executor bounty to this exact transaction sender.
      role: "dealer",
      token: destinationLock.payload.token,
    });
    const transactionHash =
      claimed.receipt?.transactionHash ||
      await this.#findClaimTransaction(
        destinationLock.payload.chainId,
        sourceClaim.tradeId,
        "destination",
        destinationLock.payload.token
      );
    const blockNumber =
      claimed.receipt?.blockNumber ||
      await this.#transactionBlock(
        destinationLock.payload.chainId,
        transactionHash
      );
    const destinationClaim = await this.relayerSession.publish({
      protocol: "versus-fx",
      version: 2,
      type: "fx_claim",
      tradeId: sourceClaim.tradeId,
      createdAt: this.now(),
      expiresAt: this.now() + 30 * 24 * 60 * 60,
      payload: {
        lockMessageId: destinationLock.id,
        chainId: destinationLock.payload.chainId,
        transactionHash,
        blockNumber: String(blockNumber),
        secretHash: destinationLock.payload.secretHash,
        beneficiary: destinationLock.payload.beneficiary,
      },
    });
    if (this.exposureJournal?.trade(sourceClaim.tradeId)) {
      this.exposureJournal.markTerminal(
        sourceClaim.tradeId,
        "completed",
        destinationClaim.id
      );
    }
    const accept = journal.findType(sourceClaim.tradeId, "fx_accept");
    await this.relayerSession.publish({
      protocol: "versus-fx",
      version: 2,
      type: "fx_complete",
      tradeId: sourceClaim.tradeId,
      createdAt: this.now(),
      expiresAt: this.now() + 30 * 24 * 60 * 60,
      payload: {
        acceptId: accept.id,
        sourceClaimMessageId: sourceClaim.id,
        destinationClaimMessageId: destinationClaim.id,
      },
    });
    this.emit("trade", {
      tradeId: sourceClaim.tradeId,
      role: "relayer",
      state: "complete",
      transactionHash,
    });
    return destinationClaim;
  }

  async #scheduleRelayDestinationClaimV3(reveal) {
    const tradeId = reveal.tradeId;
    if (this.relayerProcessing.has(tradeId)) {
      return this.relayerProcessing.get(tradeId);
    }
    const operation = this.#relayDestinationClaimV3(reveal).finally(() => {
      this.relayerProcessing.delete(tradeId);
    });
    this.relayerProcessing.set(tradeId, operation);
    return operation;
  }

  async #relayDestinationClaimV3(reveal) {
    const journal = this.relayerJournal;
    const destinationLock = journal.message(
      reveal.payload.destinationLockMessageId
    );
    const sourceLock = journal.findType(reveal.tradeId, "fx_lock_source");
    const quote = journal.findType(reveal.tradeId, "fx_quote");
    const accept = journal.findType(reveal.tradeId, "fx_accept");
    const reserve = journal.findType(reveal.tradeId, "fx_reserve");
    if (
      destinationLock?.type !== "fx_lock_destination" ||
      !sourceLock ||
      !quote ||
      !accept ||
      !reserve ||
      reveal.payload.secretHash !== destinationLock.payload.secretHash
    ) {
      return null;
    }
    const existingClaim = this.#messageForLock(
      journal,
      reveal.tradeId,
      destinationLock.id,
      "fx_claim"
    );
    if (existingClaim) return existingClaim;
    const executorDelayMs = v3ExecutorDelayMs({
      tradeId: reveal.tradeId,
      preferredExecutor: quote.sender,
      localExecutor: this.dealerAddress(),
      baseDelayMs: this.executorFallbackBaseMs,
      jitterMs: this.executorFallbackJitterMs,
    });
    if (executorDelayMs > 0) {
      this.emit("trade", {
        tradeId: reveal.tradeId,
        role: "relayer",
        state: "executor_fallback_wait",
        delayMs: executorDelayMs,
      });
      await this.wait(executorDelayMs);
      const preferredClaim = this.#messageForLock(
        journal,
        reveal.tradeId,
        destinationLock.id,
        "fx_claim"
      );
      if (preferredClaim) return preferredClaim;
    }
    const destinationObservation = await this.evm.verifyLockEnvelope({
      chainId: destinationLock.payload.chainId,
      lockId: phase5LockId(reveal.tradeId, "destination"),
      transactionHash: destinationLock.payload.transactionHash,
      token: destinationLock.payload.token,
    });
    const expectedDestinationTotal = (
      BigInt(accept.payload.outputAmountAtomic) +
      BigInt(quote.payload.destinationExecutorAmountAtomic)
    ).toString();
    if (
      (
        destinationObservation.confirmed !== true &&
        destinationObservation.state !== 2
      ) ||
      destinationObservation.amountAtomic !== expectedDestinationTotal ||
      destinationObservation.beneficiaryAmountAtomic !==
        accept.payload.outputAmountAtomic ||
      destinationObservation.executorAmountAtomic !==
        quote.payload.destinationExecutorAmountAtomic ||
      destinationObservation.beneficiary !==
        accept.payload.destinationClaimAddress.toLowerCase() ||
      destinationObservation.refundAddress !==
        reserve.payload.dealerDestinationRefundAddress.toLowerCase() ||
      Number(destinationObservation.timeout) !==
        Number(destinationLock.payload.timeout) ||
      destinationObservation.secretHash !== reveal.payload.secretHash ||
      Number(sourceLock.payload.timeout) <
        Number(destinationLock.payload.timeout) +
          FX_V2_MINIMUM_TIMEOUT_DELTA_SECONDS
    ) {
      throw new FxDesktopNetworkError(
        "V3 executor rejected a mismatched destination lock",
        "DESTINATION_LOCK_MISMATCH"
      );
    }
    const latest = await this.evm
      .provider(destinationLock.payload.chainId)
      .getBlock("latest");
    if (
      destinationObservation.state === 1 &&
      Number(latest.timestamp) >= Number(destinationLock.payload.timeout)
    ) {
      throw new FxDesktopNetworkError(
        "V3 destination lock expired before execution",
        "DESTINATION_LOCK_EXPIRED"
      );
    }
    let transactionHash;
    let blockNumber;
    if (destinationObservation.state === 2) {
      const receipt = await this.#findClaimReceipt(
        destinationLock.payload.chainId,
        reveal.tradeId,
        "destination",
        destinationLock.payload.token,
        destinationLock.payload.transactionHash
      );
      transactionHash = receipt.transactionHash;
      blockNumber = receipt.blockNumber;
    } else {
      try {
        const claimed = await this.evm.claimLock({
          chainId: destinationLock.payload.chainId,
          tradeId: reveal.tradeId,
          side: "destination",
          secret: reveal.payload.secret,
          role: "dealer",
          token: destinationLock.payload.token,
          fundingTransactionHash: destinationLock.payload.transactionHash,
        });
        transactionHash =
          claimed.receipt?.transactionHash ||
          await this.#findClaimTransaction(
            destinationLock.payload.chainId,
            reveal.tradeId,
            "destination",
            destinationLock.payload.token,
            destinationLock.payload.transactionHash
          );
        blockNumber =
          claimed.receipt?.blockNumber ||
          await this.#transactionBlock(
            destinationLock.payload.chainId,
            transactionHash
          );
      } catch (error) {
        const observed = await this.evm.readLock(
          destinationLock.payload.chainId,
          phase5LockId(reveal.tradeId, "destination"),
          destinationLock.payload.token,
          destinationLock.payload.transactionHash
        );
        if (observed.state !== 2) throw error;
        const receipt = await this.#findClaimReceipt(
          destinationLock.payload.chainId,
          reveal.tradeId,
          "destination",
          destinationLock.payload.token,
          destinationLock.payload.transactionHash
        );
        transactionHash = receipt.transactionHash;
        blockNumber = receipt.blockNumber;
      }
    }
    let destinationClaim;
    try {
      destinationClaim = await this.relayerSession.publish({
        protocol: "versus-fx",
        version: 3,
        type: "fx_claim",
        tradeId: reveal.tradeId,
        createdAt: this.now(),
        expiresAt: this.now() + 30 * 24 * 60 * 60,
        payload: {
          lockMessageId: destinationLock.id,
          chainId: destinationLock.payload.chainId,
          transactionHash,
          blockNumber: String(blockNumber),
          secretHash: destinationLock.payload.secretHash,
          beneficiary: destinationLock.payload.beneficiary,
        },
      });
    } catch (error) {
      if (error?.code !== "ACTION_REPLAY") throw error;
      destinationClaim = this.#messageForLock(
        journal,
        reveal.tradeId,
        destinationLock.id,
        "fx_claim"
      );
      if (!destinationClaim) throw error;
    }
    this.emit("trade", {
      tradeId: reveal.tradeId,
      role: "relayer",
      state: "destination_claimed",
      transactionHash,
    });
    return destinationClaim;
  }

  async #processSourceLock(sourceLock) {
    const tradeId = sourceLock.tradeId;
    const rfq = this.dealerJournal.findType(tradeId, "fx_rfq");
    const quote = this.dealerJournal.findType(tradeId, "fx_quote");
    const accept = this.dealerJournal.findType(tradeId, "fx_accept");
    const reserve = this.dealerJournal.findType(tradeId, "fx_reserve");
    if (!rfq || !quote || !accept || !reserve) {
      throw new FxDesktopNetworkError(
        "dealer source package is incomplete",
        "INCOMPLETE_SOURCE_PACKAGE"
      );
    }
    const firm = await this.guard.firmSource({
      rfq,
      quote,
      accept,
      reserve,
      sourceLock,
      referenceInputAtomic: quote.payload.inputAmountAtomic,
      exposureValueMicros: this.#assetValueMicros(
        BigInt(quote.payload.outputAmountAtomic),
        {
          assetAddress: quote.payload.outputToken,
        },
        BigInt(quote.payload.referencePriceMicros)
      ).toString(),
      requesterGasInputAtomic: "0",
    });
    this.emit("trade", {
      tradeId,
      role: "dealer",
      state: "source_lock_confirmed",
      refundEligibleAt: firm.destinationPlan.refundTimestamp,
    });
    const funded = await this.evm.fundLock({
      chainId: firm.destinationPlan.chainId,
      tradeId,
      side: "destination",
      amountAtomic: firm.destinationPlan.amountAtomic,
      beneficiary: firm.destinationPlan.beneficiary,
      refundAddress: firm.destinationPlan.refundAddress,
      secretHash: firm.destinationPlan.secretHash,
      refundTimestamp: firm.destinationPlan.refundTimestamp,
      role: "dealer",
      token: firm.destinationPlan.token,
    });
    this.inventoryCache = null;
    const txHash =
      funded.receipt?.transactionHash ||
      await this.#findFundTransaction(
        firm.destinationPlan.chainId,
        tradeId,
        "destination",
        firm.destinationPlan.token
      );
    const blockNumber =
      funded.receipt?.blockNumber ||
      await this.#transactionBlock(firm.destinationPlan.chainId, txHash);
    const destinationLock = await this.dealerSession.publish({
      protocol: "versus-fx",
      version: 1,
      type: "fx_lock_destination",
      tradeId,
      createdAt: this.now(),
      expiresAt: firm.destinationPlan.refundTimestamp,
      payload: {
        acceptId: accept.id,
        chainId: firm.destinationPlan.chainId,
        token: firm.destinationPlan.token,
        amountAtomic: firm.destinationPlan.amountAtomic,
        lockAddress: this.evm.adapterAddress(
          firm.destinationPlan.chainId,
          firm.destinationPlan.token
        ),
        beneficiary: firm.destinationPlan.beneficiary,
        refundAddress: firm.destinationPlan.refundAddress,
        secretHash: firm.destinationPlan.secretHash,
        timeout: firm.destinationPlan.refundTimestamp,
        transactionHash: txHash,
        blockNumber: String(blockNumber),
      },
    });
    await this.guard.confirmDestinationLock(destinationLock);
    this.emit("trade", {
      tradeId,
      role: "dealer",
      state: "destination_lock_confirmed",
      transactionHash: txHash,
      refundEligibleAt: firm.destinationPlan.refundTimestamp,
    });
  }

  async #processDestinationClaim(claimMessage, destinationLock) {
    const tradeId = claimMessage.tradeId;
    const trade = this.exposureJournal.trade(tradeId);
    if (
      !trade ||
      !["destination_locked", "destination_claimed"].includes(trade.state)
    ) {
      return;
    }
    const secret = await this.evm.extractClaimSecret({
      chainId: destinationLock.payload.chainId,
      tradeId,
      side: "destination",
      transactionHash: claimMessage.payload.transactionHash,
      token: destinationLock.payload.token,
    });
    if (trade.state === "destination_locked") {
      this.guard.markDestinationClaimed(tradeId);
    }
    const sourceLock = this.dealerJournal.findType(tradeId, "fx_lock_source");
    const sourceObservation = await this.evm.readLock(
      sourceLock.payload.chainId,
      phase5LockId(tradeId, "source"),
      sourceLock.payload.token,
      sourceLock.payload.transactionHash
    );
    let txHash;
    let blockNumber;
    if (sourceObservation.state === 2) {
      const receipt = await this.#findClaimReceipt(
        sourceLock.payload.chainId,
        tradeId,
        "source",
        sourceLock.payload.token,
        sourceLock.payload.transactionHash
      );
      txHash = receipt.transactionHash;
      blockNumber = receipt.blockNumber;
    } else {
      try {
        const claimed = await this.evm.claimLock({
          chainId: sourceLock.payload.chainId,
          tradeId,
          side: "source",
          secret,
          role: "dealer",
          token: sourceLock.payload.token,
          fundingTransactionHash: sourceLock.payload.transactionHash,
        });
        this.inventoryCache = null;
        txHash =
          claimed.receipt?.transactionHash ||
          await this.#findClaimTransaction(
            sourceLock.payload.chainId,
            tradeId,
            "source",
            sourceLock.payload.token,
            sourceLock.payload.transactionHash
          );
        blockNumber =
          claimed.receipt?.blockNumber ||
          await this.#transactionBlock(sourceLock.payload.chainId, txHash);
      } catch (error) {
        const observed = await this.evm.readLock(
          sourceLock.payload.chainId,
          phase5LockId(tradeId, "source"),
          sourceLock.payload.token,
          sourceLock.payload.transactionHash
        );
        if (observed.state !== 2) throw error;
        const receipt = await this.#findClaimReceipt(
          sourceLock.payload.chainId,
          tradeId,
          "source",
          sourceLock.payload.token,
          sourceLock.payload.transactionHash
        );
        txHash = receipt.transactionHash;
        blockNumber = receipt.blockNumber;
      }
    }
    let sourceClaim = this.#messageForLock(
      this.dealerJournal,
      tradeId,
      sourceLock.id,
      "fx_claim"
    );
    if (!sourceClaim) {
      sourceClaim = await this.dealerSession.publish({
        protocol: "versus-fx",
        version: this.protocolVersion,
        type: "fx_claim",
        tradeId,
        createdAt: this.now(),
        expiresAt: this.now() + 30 * 24 * 60 * 60,
        payload: {
          lockMessageId: sourceLock.id,
          chainId: sourceLock.payload.chainId,
          transactionHash: txHash,
          blockNumber: String(blockNumber),
          secretHash: sourceLock.payload.secretHash,
          beneficiary: sourceLock.payload.beneficiary,
        },
      });
    }
    this.guard.markCompleted(tradeId, sourceClaim);
    const destinationClaim = this.#messageForLock(
      this.dealerJournal,
      tradeId,
      destinationLock.id,
      "fx_claim"
    );
    if (destinationClaim) {
      await this.dealerSession.publish({
        protocol: "versus-fx",
        version: this.protocolVersion,
        type: "fx_complete",
        tradeId,
        createdAt: this.now(),
        expiresAt: this.now() + 30 * 24 * 60 * 60,
        payload: {
          acceptId: trade.package.accept.id,
          sourceClaimMessageId: sourceClaim.id,
          destinationClaimMessageId: destinationClaim.id,
        },
      });
    }
    this.emit("trade", {
      tradeId,
      role: "dealer",
      state: "complete",
      transactionHash: txHash,
    });
  }

  async #transactionBlock(chainId, hash) {
    const receipt = await this.evm.provider(chainId).getTransactionReceipt(hash);
    if (!receipt) {
      throw new FxDesktopNetworkError(
        "transaction receipt is unavailable",
        "TRANSACTION_UNCONFIRMED"
      );
    }
    return Number(receipt.blockNumber);
  }

  async #findFundTransaction(
    chainId,
    tradeId,
    side,
    token = null,
    expectedLockDigest = null
  ) {
    const receipt = await this.evm.findLockEvent({
      chainId,
      tradeId,
      side,
      eventName: "LockFunded",
      token,
      expectedLockDigest,
    });
    return receipt.transactionHash;
  }

  async #findClaimTransaction(
    chainId,
    tradeId,
    side,
    token = null,
    fundingTransactionHash = null
  ) {
    const receipt = await this.#findClaimReceipt(
      chainId,
      tradeId,
      side,
      token,
      fundingTransactionHash
    );
    return receipt.transactionHash;
  }

  async #findClaimReceipt(
    chainId,
    tradeId,
    side,
    token = null,
    fundingTransactionHash = null
  ) {
    return this.evm.findLockEvent({
      chainId,
      tradeId,
      side,
      eventName: "LockClaimed",
      token,
      fundingTransactionHash,
    });
  }

  status() {
    const dealerTransport =
      this.dealerSession?.status?.().transport || null;
    return {
      deploymentId: this.deploymentId,
      broker: this.broker?.status?.() || {
        active: false,
        mode: "self-route",
      },
      requester: this.requesterSession?.status?.() || { active: false },
      relayer: this.relayerSession?.status?.() || { active: false },
      dealer: {
        configured: true,
        active: Boolean(this.dealer),
        ...(this.dealer?.status?.() || {}),
        transport: dealerTransport,
        exposure: this.exposureJournal?.exposureSummary?.() || {
          count: 0,
          exposureValueMicros: "0",
        },
        recoveries: structuredClone(this.dealerRecoveries),
      },
    };
  }

  async close() {
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    await Promise.allSettled([
      this.broker?.close?.(),
      this.requesterSession?.close?.(),
      this.relayerSession?.close?.(),
      this.dealer?.close?.(),
    ]);
    for (const session of [...this.localSessions]) {
      this.#unregisterLocalSession(session);
    }
    this.brokerJournal?.close?.();
    this.requesterJournal?.close?.();
    this.relayerJournal?.close?.();
    this.dealerJournal?.close?.();
    this.exposureJournal?.close?.();
  }
}

module.exports = {
  FX_PUBLIC_TESTNET_COORDINATION_DOMAIN,
  FX_PUBLIC_TESTNET_DEPLOYMENT_ID,
  FX_PUBLIC_WAKU_PEERS,
  FxDesktopNetworkError,
  FxDesktopNetworkRuntime,
  dollarsToMicros,
  mergedPolicy,
  v3ExecutorDelayMs,
};
