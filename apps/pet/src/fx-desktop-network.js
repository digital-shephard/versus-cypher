const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const {
  FxCoordinationSession,
  FxDeterministicDealer,
  FxPhase8DealerGuard,
  FxPhase8ExposureJournal,
  FxPublicBroker,
  FxTradeJournal,
  FxWakuTransport,
  phase5LockId,
} = require("@versus/network");

const FX_PUBLIC_TESTNET_DEPLOYMENT_ID =
  "0xd0935aa32dc4d37e33180ac9409c993b7bf39749ff375df4da033bd106c0983e";

const FX_PUBLIC_WAKU_PEERS = Object.freeze([
  "/dns4/relay-a.versuscypher.com/tcp/443/wss/p2p/16Uiu2HAmCQArrt8ND7sTzPCg76YmQPab7HKjSrVZeyeTVZdQyPWy",
  "/dns4/relay-b.versuscypher.com/tcp/443/wss/p2p/16Uiu2HAkx96y18XpzAybpmi1zzdMQZFvsRPZfkku8R9T4KJFMr2P",
]);

class FxDesktopNetworkError extends Error {
  constructor(message, code = "FX_DESKTOP_NETWORK_ERROR") {
    super(message);
    this.name = "FxDesktopNetworkError";
    this.code = code;
  }
}

function dollarsToMicros(value) {
  return (BigInt(Number(value)) * 1_000_000n).toString();
}

function mergedPolicy(current, patch = {}) {
  return { ...(current || {}), ...(patch || {}) };
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

class FxDesktopNetworkRuntime extends EventEmitter {
  constructor({
    dataDirectory,
    walletProvider,
    evm,
    deploymentId = FX_PUBLIC_TESTNET_DEPLOYMENT_ID,
    bootstrapPeers = FX_PUBLIC_WAKU_PEERS,
    now = () => Math.floor(Date.now() / 1000),
    brokerObservationWindowMs = 15_000,
    sessionFactory,
  } = {}) {
    super();
    if (!dataDirectory || typeof walletProvider !== "function" || !evm) {
      throw new TypeError("FX desktop network runtime is misconfigured");
    }
    this.dataDirectory = path.resolve(dataDirectory);
    this.walletProvider = walletProvider;
    this.evm = evm;
    this.deploymentId = deploymentId;
    this.bootstrapPeers = [...bootstrapPeers];
    this.now = now;
    this.brokerObservationWindowMs = Number(brokerObservationWindowMs);
    this.sessionFactory = sessionFactory;
    this.broker = null;
    this.brokerJournal = null;
    this.requesterSession = null;
    this.requesterJournal = null;
    this.dealer = null;
    this.dealerSession = null;
    this.dealerJournal = null;
    this.exposureJournal = null;
    this.guard = null;
    this.dealerPolicy = null;
    this.dealerPositions = [];
    this.processing = new Map();
    this.inventoryCache = null;
    this.dealerRecoveries = [];
    this.lastDealerReconcileAt = 0;
    fs.mkdirSync(this.dataDirectory, { recursive: true, mode: 0o700 });
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

  createSession(role, fileName) {
    if (typeof this.sessionFactory === "function") {
      return this.sessionFactory({ role, fileName, signer: this.signer(role) });
    }
    const journal = new FxTradeJournal({
      filePath: path.join(this.dataDirectory, fileName),
      deploymentId: this.deploymentId,
      now: this.now,
    });
    const transport = new FxWakuTransport({
      deploymentId: this.deploymentId,
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
    return { session, journal };
  }

  async ensureBroker() {
    if (this.broker) return this.broker;
    const created = this.createSession("broker", "desktop-broker.sqlite");
    this.brokerJournal = created.journal;
    this.broker = new FxPublicBroker({
      session: created.session,
      signer: this.signer("broker"),
      brokerFeeAtomic: "0",
      observationWindowMs: this.brokerObservationWindowMs,
      now: this.now,
    });
    await this.broker.start();
    this.emit("status", this.status());
    return this.broker;
  }

  async queryRoutes({ rfq }) {
    const [broker] = await Promise.all([
      this.ensureBroker(),
      this.ensureRequesterSession(),
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

  async ensureRequesterSession() {
    if (this.requesterSession) return this.requesterSession;
    const created = this.createSession("requester", "desktop-requester.sqlite");
    this.requesterSession = created.session;
    this.requesterJournal = created.journal;
    await this.requesterSession.start();
    this.emit("status", this.status());
    return this.requesterSession;
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
    const existing = session.journal.findType(tradeId, type);
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
      version: 1,
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
    });
    const sourceReceipt = source.receipt;
    if (!sourceReceipt && source.lock.state !== 1) {
      throw new FxDesktopNetworkError("source lock was not funded", "SOURCE_LOCK_UNCONFIRMED");
    }
    const sourceTransactionHash =
      sourceReceipt?.transactionHash ||
      await this.#findFundTransaction(route.inputChainId, acceptance.tradeId, "source");
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
        lockAddress: this.evm.configuration(route.inputChainId).adapterAddress,
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
    });
    const claimTransactionHash =
      claim.receipt?.transactionHash ||
      await this.#findClaimTransaction(
        route.outputChainId,
        acceptance.tradeId,
        "destination"
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

  async reconcileRequester({ prepared }) {
    const route = prepared.proposal.route;
    const sourceId = phase5LockId(prepared.tradeId, "source");
    const destinationId = phase5LockId(prepared.tradeId, "destination");
    const [source, destination] = await Promise.all([
      this.evm.readLock(route.inputChainId, sourceId),
      this.evm.readLock(route.outputChainId, destinationId),
    ]);
    if (destination.state === 2) {
      const claim = await this.#findClaimReceipt(
        route.outputChainId,
        prepared.tradeId,
        "destination"
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

  async refundRequester({ prepared }) {
    const route = prepared.proposal.route;
    const refunded = await this.evm.refundLock({
      chainId: route.inputChainId,
      tradeId: prepared.tradeId,
      side: "source",
      role: "requester",
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
    for (const position of this.dealerPositions) {
      await this.evm.preflight(position.chainId);
    }
    const created = this.createSession("dealer", "desktop-dealer.sqlite");
    this.dealerSession = created.session;
    this.dealerJournal = created.journal;
    this.exposureJournal = new FxPhase8ExposureJournal({
      filePath: path.join(this.dataDirectory, "desktop-exposure.sqlite"),
      deploymentId: this.deploymentId,
      policy: this.#phase8Policy(),
      now: this.now,
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
        }),
      verifyDestinationLock: async ({ lockId, destinationLock }) =>
        this.evm.verifyLockEnvelope({
          chainId: destinationLock.payload.chainId,
          lockId,
          transactionHash: destinationLock.payload.transactionHash,
        }),
      readDestinationLock: async ({ lockId, destinationObservation }) => {
        const lock = await this.evm.readLock(
          destinationObservation.chainId,
          lockId
        );
        return { exists: lock.state !== 0, ...lock };
      },
    });
    this.dealer = new FxDeterministicDealer({
      session: this.dealerSession,
      sourceClaimAddress: dealerAddress,
      destinationRefundAddress: dealerAddress,
      observationWindowMs: 15_000,
      now: this.now,
      quotePolicy: (rfq) => this.#dealerQuote(rfq),
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
    });
    this.dealer.on("error", (error) => {
      this.emit("error", error);
    });
    await this.dealer.start();
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
        const exposure = this.exposureJournal?.exposureSummary?.().byAsset?.[
          `${position.chainId}:${position.assetAddress}`
        ];
        const reservedAtomic = BigInt(
          exposure?.exposureValueMicros || "0"
        );
        const walletBalance = BigInt(availableAtomic);
        return {
          id: position.id,
          address: owner,
          availableAtomic: (
            walletBalance > reservedAtomic
              ? walletBalance - reservedAtomic
              : 0n
          ).toString(),
          reservedAtomic: reservedAtomic.toString(),
          activeLocks: Number(exposure?.count || 0),
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
      if (trade.state !== "destination_locked") continue;
      const lock = await this.evm.readLock(
        trade.package.quote.payload.outputChainId,
        trade.destinationLockId
      );
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
      if (lock.state !== 1) continue;
      if (!chainHeads.has(lock.chainId)) {
        chainHeads.set(
          lock.chainId,
          await this.evm.provider(lock.chainId).getBlock("latest")
        );
      }
      const latest = chainHeads.get(lock.chainId);
      const eligible = Number(latest.timestamp) >= Number(lock.timeout);
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
      trade.destinationLockId
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
    });
    this.inventoryCache = null;
    const txHash =
      refunded.receipt?.transactionHash ||
      (await this.evm.findLockEvent({
        chainId: lock.chainId,
        tradeId,
        side: "destination",
        eventName: "LockRefunded",
      })).transactionHash;
    const blockNumber =
      refunded.receipt?.blockNumber ||
      await this.#transactionBlock(lock.chainId, txHash);
    await this.dealerSession.publish({
      protocol: "versus-fx",
      version: 1,
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
      minimumTradeInputAtomic: dollarsToMicros(policy.minimumTradeUsd || 1),
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
    if (!destination) return null;
    const input = rfq.payload.inputOptions.find((candidate) =>
      this.dealerPositions.some(
        (position) =>
          position.chainId === candidate.chainId &&
          position.assetAddress === candidate.token
      )
    );
    if (!input || input.chainId === destination.chainId) return null;
    const output = BigInt(rfq.payload.outputAmountAtomic);
    const minimum = BigInt(dollarsToMicros(this.dealerPolicy.minimumTradeUsd));
    const maximum = BigInt(dollarsToMicros(this.dealerPolicy.maximumTradeUsd));
    if (output < minimum || output > maximum) return null;
    const balance = BigInt(
      await this.evm.tokenBalance(destination.chainId, destination.assetAddress)
    );
    const reserved = BigInt(
      this.exposureJournal?.exposureSummary?.().byAsset?.[
        `${destination.chainId}:${destination.assetAddress}`
      ]?.exposureValueMicros || "0"
    );
    const available = balance > reserved ? balance - reserved : 0n;
    if (available < output) return null;
    const spreadBps =
      Number(this.dealerPolicy.minimumSpreadBps) +
      Number(this.dealerPolicy.inventoryPremiumBps || 0);
    const inputAmountAtomic =
      ((output * BigInt(10_000 + spreadBps)) + 9_999n) / 10_000n;
    if (inputAmountAtomic > BigInt(input.maxInputAtomic)) return null;
    return {
      inputChainId: input.chainId,
      inputToken: input.token,
      inputAmountAtomic: inputAmountAtomic.toString(),
      referenceSource: "desktop:cohort:usdc-par",
      referencePriceMicros: "1000000",
      referenceTimestamp: this.now(),
      spreadBps,
      dealerSettlementCostAtomic: "0",
      estimatedCompletionSeconds: 45,
      adapterId: "evm-htlc-v1",
      adapterVersion: 1,
    };
  }

  async #onDealerEnvelope(envelope) {
    if (!this.guard || !this.dealerSession) return;
    if (envelope.type === "fx_lock_source") {
      if (this.processing.has(envelope.tradeId)) return;
      const operation = this.#processSourceLock(envelope).finally(() => {
        this.processing.delete(envelope.tradeId);
      });
      this.processing.set(envelope.tradeId, operation);
      await operation;
      return;
    }
    if (envelope.type === "fx_claim") {
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
      exposureValueMicros: quote.payload.outputAmountAtomic,
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
    });
    this.inventoryCache = null;
    const txHash =
      funded.receipt?.transactionHash ||
      await this.#findFundTransaction(
        firm.destinationPlan.chainId,
        tradeId,
        "destination"
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
        lockAddress: this.evm.configuration(
          firm.destinationPlan.chainId
        ).adapterAddress,
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
    if (!trade || trade.state !== "destination_locked") return;
    const secret = await this.evm.extractClaimSecret({
      chainId: destinationLock.payload.chainId,
      tradeId,
      side: "destination",
      transactionHash: claimMessage.payload.transactionHash,
    });
    this.guard.markDestinationClaimed(tradeId);
    const sourceLock = this.dealerJournal.findType(tradeId, "fx_lock_source");
    const claimed = await this.evm.claimLock({
      chainId: sourceLock.payload.chainId,
      tradeId,
      side: "source",
      secret,
      role: "dealer",
    });
    this.inventoryCache = null;
    const txHash =
      claimed.receipt?.transactionHash ||
      await this.#findClaimTransaction(
        sourceLock.payload.chainId,
        tradeId,
        "source"
      );
    const blockNumber =
      claimed.receipt?.blockNumber ||
      await this.#transactionBlock(sourceLock.payload.chainId, txHash);
    const sourceClaim = await this.dealerSession.publish({
      protocol: "versus-fx",
      version: 1,
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
    this.guard.markCompleted(tradeId, sourceClaim);
    const destinationClaim = this.dealerJournal.findType(
      tradeId,
      "fx_claim"
    );
    if (destinationClaim) {
      await this.dealerSession.publish({
        protocol: "versus-fx",
        version: 1,
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

  async #findFundTransaction(chainId, tradeId, side) {
    const receipt = await this.evm.findLockEvent({
      chainId,
      tradeId,
      side,
      eventName: "LockFunded",
    });
    return receipt.transactionHash;
  }

  async #findClaimTransaction(chainId, tradeId, side) {
    const receipt = await this.#findClaimReceipt(chainId, tradeId, side);
    return receipt.transactionHash;
  }

  async #findClaimReceipt(chainId, tradeId, side) {
    return this.evm.findLockEvent({
      chainId,
      tradeId,
      side,
      eventName: "LockClaimed",
    });
  }

  status() {
    return {
      deploymentId: this.deploymentId,
      broker: this.broker?.status?.() || {
        active: false,
        mode: "self-route",
      },
      requester: this.requesterSession?.status?.() || { active: false },
      dealer: {
        configured: true,
        active: Boolean(this.dealer),
        ...(this.dealer?.status?.() || {}),
        exposure: this.exposureJournal?.exposureSummary?.() || {
          count: 0,
          exposureValueMicros: "0",
        },
        recoveries: structuredClone(this.dealerRecoveries),
      },
    };
  }

  async close() {
    await Promise.allSettled([
      this.broker?.close?.(),
      this.requesterSession?.close?.(),
      this.dealer?.close?.(),
    ]);
    this.brokerJournal?.close?.();
    this.requesterJournal?.close?.();
    this.dealerJournal?.close?.();
    this.exposureJournal?.close?.();
  }
}

module.exports = {
  FX_PUBLIC_TESTNET_DEPLOYMENT_ID,
  FX_PUBLIC_WAKU_PEERS,
  FxDesktopNetworkError,
  FxDesktopNetworkRuntime,
  dollarsToMicros,
  mergedPolicy,
};
