const fs = require("node:fs");
const path = require("node:path");
const {
  Wallet,
  getAddress,
  keccak256,
  toUtf8Bytes,
} = require("ethers");
const {
  assembleFxEnvelope,
  canonicalJson,
  canonicalFxMessage,
  selectSingleDealerRoute,
} = require("./fx-protocol");
const {
  createFxRecoveryPacket,
  restoreFxRecoveryPacket,
} = require("./fx-recovery");

const ROLE_BY_ACTOR = Object.freeze({
  requester: "requester",
  dealer: "dealer",
  broker: "broker",
  relayer: "relayer",
});
const TYPE_ROLE = Object.freeze({
  fx_rfq: "requester",
  fx_quote: "dealer",
  fx_accept: "requester",
  fx_reserve: "dealer",
  fx_lock_source: "requester",
  fx_lock_destination: "dealer",
  fx_claim: "relayer",
  fx_refund: "relayer",
  fx_complete: "relayer",
  fx_default: "requester",
  fx_dispute: "dealer",
});
const TTL_BY_TYPE = Object.freeze({
  fx_rfq: 50,
  fx_quote: 40,
  fx_accept: 300,
  fx_reserve: 300,
  fx_lock_source: 86400,
  fx_lock_destination: 86400,
  fx_claim: 86400,
  fx_refund: 86400,
  fx_complete: 86400,
  fx_default: 86400,
  fx_dispute: 86400,
});

class FxSimulationError extends Error {
  constructor(message, code = "FX_SIMULATION_ERROR") {
    super(message);
    this.name = "FxSimulationError";
    this.code = code;
  }
}

function deterministicHash(...parts) {
  return keccak256(toUtf8Bytes(parts.join(":")));
}

function deterministicAddress(...parts) {
  return getAddress(`0x${deterministicHash(...parts).slice(-40)}`).toLowerCase();
}

function deterministicWallet(seed, role) {
  return new Wallet(deterministicHash("versus-fx-simulator", seed, role));
}

function assetKey(chainId, token) {
  return `${BigInt(chainId)}:${getAddress(token).toLowerCase()}`;
}

class VirtualLedger {
  constructor(initialBalances = {}) {
    this.balances = new Map();
    for (const [owner, assets] of Object.entries(initialBalances)) {
      for (const [asset, amount] of Object.entries(assets)) {
        this.set(owner, asset, amount);
      }
    }
  }

  get(owner, asset) {
    return BigInt(this.balances.get(`${owner}:${asset}`) || 0n);
  }

  set(owner, asset, amount) {
    amount = BigInt(amount);
    if (amount < 0n) throw new FxSimulationError("balance cannot be negative");
    this.balances.set(`${owner}:${asset}`, amount);
  }

  transfer(from, to, asset, amount) {
    amount = BigInt(amount);
    if (amount < 1n || this.get(from, asset) < amount) {
      throw new FxSimulationError("virtual inventory is insufficient", "NO_INVENTORY");
    }
    this.set(from, asset, this.get(from, asset) - amount);
    this.set(to, asset, this.get(to, asset) + amount);
  }

  snapshot() {
    return Object.fromEntries(
      [...this.balances.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, value.toString()])
    );
  }

  restore(snapshot) {
    this.balances = new Map(
      Object.entries(snapshot || {}).map(([key, value]) => [key, BigInt(value)])
    );
  }
}

class VirtualChain {
  constructor({ ledger, seed, confirmationsRequired = 2 }) {
    this.ledger = ledger;
    this.seed = seed;
    this.confirmationsRequired = confirmationsRequired;
    this.heights = new Map();
    this.locks = new Map();
  }

  height(chainId) {
    return Number(this.heights.get(String(chainId)) || 1000);
  }

  mine(chainId, blocks = 1) {
    const next = this.height(chainId) + Number(blocks);
    this.heights.set(String(chainId), next);
    return next;
  }

  fund({
    id,
    chainId,
    token,
    amountAtomic,
    funder,
    beneficiary,
    refundAddress,
    secretHash,
    timeout,
    adapterId,
    adapterVersion,
  }) {
    if (this.locks.has(id)) {
      throw new FxSimulationError("virtual lock already exists", "LOCK_REPLAY");
    }
    const asset = assetKey(chainId, token);
    const escrow = `escrow:${id}`;
    this.ledger.transfer(funder, escrow, asset, amountAtomic);
    const blockNumber = this.mine(chainId);
    const lock = {
      id,
      chainId: BigInt(chainId).toString(),
      token: getAddress(token).toLowerCase(),
      amountAtomic: BigInt(amountAtomic).toString(),
      funder,
      beneficiary: getAddress(beneficiary).toLowerCase(),
      refundAddress: getAddress(refundAddress).toLowerCase(),
      secretHash,
      timeout,
      adapterId,
      adapterVersion,
      blockNumber,
      transactionHash: deterministicHash(this.seed, "fund", id),
      escrow,
      status: "funded",
    };
    this.locks.set(id, lock);
    return { ...lock };
  }

  confirmations(lockId) {
    const lock = this.locks.get(lockId);
    if (!lock) return 0;
    return this.height(lock.chainId) - lock.blockNumber + 1;
  }

  verify(lockId, expected) {
    const lock = this.locks.get(lockId);
    if (!lock || lock.status !== "funded") {
      throw new FxSimulationError("virtual lock is unavailable", "BAD_LOCK");
    }
    if (this.confirmations(lockId) < this.confirmationsRequired) {
      throw new FxSimulationError("virtual lock is not confirmed", "UNCONFIRMED_LOCK");
    }
    for (const [key, value] of Object.entries(expected)) {
      if (String(lock[key]).toLowerCase() !== String(value).toLowerCase()) {
        throw new FxSimulationError(
          `virtual lock ${key} does not match`,
          "MALFORMED_LOCK"
        );
      }
    }
    return { ...lock };
  }

  validateLockSpec(candidate, expected) {
    const normalized = {
      chainId: BigInt(candidate.chainId).toString(),
      token: getAddress(candidate.token).toLowerCase(),
      amountAtomic: BigInt(candidate.amountAtomic).toString(),
      beneficiary: getAddress(candidate.beneficiary).toLowerCase(),
      refundAddress: getAddress(candidate.refundAddress).toLowerCase(),
      secretHash: String(candidate.secretHash).toLowerCase(),
      adapterId: String(candidate.adapterId),
      adapterVersion: Number(candidate.adapterVersion),
      timeout: Number(candidate.timeout),
    };
    for (const [key, value] of Object.entries(expected)) {
      if (String(normalized[key]).toLowerCase() !== String(value).toLowerCase()) {
        throw new FxSimulationError(
          `virtual lock ${key} does not match`,
          "MALFORMED_LOCK"
        );
      }
    }
    return normalized;
  }

  claim(lockId, { secret, beneficiary }) {
    const lock = this.verify(lockId, { beneficiary });
    if (keccak256(secret) !== lock.secretHash) {
      throw new FxSimulationError("secret does not open virtual lock", "WRONG_SECRET");
    }
    this.ledger.transfer(
      lock.escrow,
      lock.beneficiary,
      assetKey(lock.chainId, lock.token),
      lock.amountAtomic
    );
    lock.status = "claimed";
    lock.claimTransactionHash = deterministicHash(this.seed, "claim", lockId);
    lock.claimBlockNumber = this.mine(lock.chainId);
    this.locks.set(lockId, lock);
    return { ...lock };
  }

  refund(lockId, { at, refundAddress }) {
    const lock = this.verify(lockId, { refundAddress });
    if (at < lock.timeout) {
      throw new FxSimulationError("virtual refund is too early", "EARLY_REFUND");
    }
    this.ledger.transfer(
      lock.escrow,
      lock.refundAddress,
      assetKey(lock.chainId, lock.token),
      lock.amountAtomic
    );
    lock.status = "refunded";
    lock.refundTransactionHash = deterministicHash(this.seed, "refund", lockId);
    lock.refundBlockNumber = this.mine(lock.chainId);
    this.locks.set(lockId, lock);
    return { ...lock };
  }

  snapshot() {
    return {
      heights: Object.fromEntries(
        [...this.heights.entries()].sort(([left], [right]) =>
          left.localeCompare(right)
        )
      ),
      locks: Object.fromEntries(
        [...this.locks.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([id, lock]) => [id, { ...lock }])
      ),
    };
  }

  restore(snapshot) {
    this.heights = new Map(Object.entries(snapshot?.heights || {}));
    this.locks = new Map(
      Object.entries(snapshot?.locks || {}).map(([id, lock]) => [
        id,
        { ...lock },
      ])
    );
  }
}

class FxDeterministicSimulator {
  constructor({
    seed,
    journal,
    recoveryDirectory,
    startTime = 1_800_100_000,
    confirmationsRequired = 2,
    protocolVersion = 1,
    gitCommit = "working-tree",
    sourceChainId = "8453",
    destinationChainId = "42161",
    sourceToken = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    destinationToken = "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    stateFile,
  } = {}) {
    if (!seed || !journal || !recoveryDirectory) {
      throw new TypeError("simulator requires seed, journal, and recoveryDirectory");
    }
    this.seed = String(seed);
    this.journal = journal;
    this.recoveryDirectory = path.resolve(recoveryDirectory);
    this.stateFile = path.resolve(
      stateFile || path.join(this.recoveryDirectory, "simulator-state.json")
    );
    this.time = startTime;
    this.protocolVersion = protocolVersion;
    this.gitCommit = gitCommit;
    this.sourceChainId = BigInt(sourceChainId).toString();
    this.destinationChainId = BigInt(destinationChainId).toString();
    this.sourceToken = getAddress(sourceToken).toLowerCase();
    this.destinationToken = getAddress(destinationToken).toLowerCase();
    this.actors = Object.fromEntries(
      Object.keys(ROLE_BY_ACTOR).map((role) => [
        role,
        deterministicWallet(this.seed, role),
      ])
    );
    this.events = [];
    this.monotonicMs = 0;
    const sourceAsset = assetKey(this.sourceChainId, this.sourceToken);
    const destinationAsset = assetKey(this.destinationChainId, this.destinationToken);
    this.ledger = new VirtualLedger({
      [this.actors.requester.address.toLowerCase()]: { [sourceAsset]: "1000000" },
      [this.actors.dealer.address.toLowerCase()]: { [destinationAsset]: "1000000" },
      [this.actors.broker.address.toLowerCase()]: { [sourceAsset]: "0" },
      [this.actors.relayer.address.toLowerCase()]: {
        [sourceAsset]: "0",
        [destinationAsset]: "0",
      },
    });
    this.chain = new VirtualChain({
      ledger: this.ledger,
      seed: this.seed,
      confirmationsRequired,
    });
    this.trades = new Map();
    if (fs.existsSync(this.stateFile)) {
      this.loadCheckpoint();
      this.reconcileCheckpoint();
    } else {
      this.checkpoint();
    }
  }

  actor(role) {
    const actor = this.actors[role];
    if (!actor) throw new FxSimulationError(`unknown actor ${role}`);
    return actor;
  }

  tick(seconds = 1) {
    this.time += Number(seconds);
    this.monotonicMs += Number(seconds) * 1000;
    return this.time;
  }

  checkpoint() {
    const safeTrades = Object.fromEntries(
      [...this.trades.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([tradeId, trade]) => [
          tradeId,
          {
            ...trade,
            recovery: trade.recovery
              ? {
                  filePath: trade.recovery.filePath,
                  secretHash: trade.recovery.secretHash,
                }
              : null,
          },
        ])
    );
    const checkpoint = {
      schema: "versus-fx-simulator-checkpoint",
      version: 1,
      seed: this.seed,
      deploymentId: this.journal.deploymentId,
      time: this.time,
      monotonicMs: this.monotonicMs,
      ledger: this.ledger.snapshot(),
      chain: this.chain.snapshot(),
      trades: safeTrades,
      events: this.events,
    };
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.stateFile}.${process.pid}.tmp`;
    const descriptor = fs.openSync(temporary, "w", 0o600);
    try {
      fs.writeFileSync(descriptor, `${canonicalJson(checkpoint)}\n`, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, this.stateFile);
    try { fs.chmodSync(this.stateFile, 0o600); } catch (_) {}
    return checkpoint;
  }

  loadCheckpoint() {
    let checkpoint;
    try {
      checkpoint = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
    } catch (error) {
      throw new FxSimulationError(
        `simulator checkpoint cannot be read: ${error.message}`,
        "CORRUPT_CHECKPOINT"
      );
    }
    if (
      checkpoint.schema !== "versus-fx-simulator-checkpoint" ||
      checkpoint.version !== 1 ||
      checkpoint.seed !== this.seed ||
      checkpoint.deploymentId !== this.journal.deploymentId
    ) {
      throw new FxSimulationError(
        "simulator checkpoint belongs to another run",
        "CHECKPOINT_MISMATCH"
      );
    }
    this.time = Number(checkpoint.time);
    this.monotonicMs = Number(checkpoint.monotonicMs);
    this.ledger.restore(checkpoint.ledger);
    this.chain.restore(checkpoint.chain);
    this.trades = new Map(Object.entries(checkpoint.trades || {}));
    this.events = Array.isArray(checkpoint.events) ? checkpoint.events : [];
    return checkpoint;
  }

  reconcileCheckpoint() {
    let recovered = 0;
    for (const trade of this.trades.values()) {
      const pending = Object.values(trade.messages || {}).filter(
        (message) => message?.id && !this.journal.message(message.id)
      );
      let lastPending = pending.length + 1;
      while (pending.length > 0 && pending.length < lastPending) {
        lastPending = pending.length;
        for (let index = pending.length - 1; index >= 0; index -= 1) {
          try {
            this.journal.apply(pending[index], {
              now: this.time,
              temporal: false,
            });
            pending.splice(index, 1);
            recovered += 1;
          } catch (error) {
            if (
              ![
                "UNKNOWN_TRADE",
                "MISSING_REFERENCE",
                "INVALID_STATE",
                "INVALID_STATE_TRANSITION",
                "BAD_EVIDENCE",
              ].includes(error.code)
            ) {
              throw error;
            }
          }
        }
      }
      if (pending.length > 0) {
        throw new FxSimulationError(
          "checkpoint messages cannot be reconciled with the journal",
          "CHECKPOINT_DIVERGENCE"
        );
      }
    }
    if (recovered > 0) {
      this.record("restart_reconciled", { recoveredMessages: recovered });
      this.checkpoint();
    }
    return recovered;
  }

  sequence(role, tradeId) {
    return this.journal.reserveSequence(
      tradeId,
      this.actor(role).address.toLowerCase()
    );
  }

  async signed(type, tradeId, payload, { actor = TYPE_ROLE[type], at = this.time } = {}) {
    const wallet = this.actor(actor);
    const input = {
      protocol: "versus-fx",
      version: this.protocolVersion,
      deploymentId: this.journal.deploymentId,
      type,
      tradeId,
      sender: wallet.address,
      role: ROLE_BY_ACTOR[actor],
      sequence: this.sequence(actor, tradeId),
      createdAt: at,
      expiresAt: at + TTL_BY_TYPE[type],
      payload,
    };
    const signature = await wallet.signMessage(canonicalFxMessage(input));
    return assembleFxEnvelope(input, signature);
  }

  record(type, details = {}) {
    const event = {
      index: this.events.length,
      seed: this.seed,
      protocolVersion: this.protocolVersion,
      gitCommit: this.gitCommit,
      monotonicMs: this.monotonicMs,
      wallTime: this.time,
      type,
      ...details,
    };
    if ("secret" in event || "privateKey" in event) {
      throw new FxSimulationError("scientific event attempted to record secret material");
    }
    this.events.push(event);
    return event;
  }

  deliver(message, actor = "network") {
    this.checkpoint();
    const result = this.journal.apply(message, { now: this.time, temporal: false });
    this.record("message", {
      actor,
      tradeId: message.tradeId,
      messageType: message.type,
      messageId: message.id,
      admission: result.status,
      settlementState: result.snapshot?.settlementState,
      caseState: result.snapshot?.caseState,
      stateHash: result.snapshot?.stateHash,
    });
    this.checkpoint();
    return result;
  }

  inventory(role, chainId, token) {
    return this.ledger
      .get(this.actor(role).address.toLowerCase(), assetKey(chainId, token))
      .toString();
  }

  newTrade(label = `trade-${this.trades.size + 1}`) {
    const tradeId = deterministicHash(this.seed, label);
    if (this.trades.has(tradeId)) {
      throw new FxSimulationError("deterministic trade already exists");
    }
    const trade = { tradeId, messages: {}, locks: {}, route: null, recovery: null };
    this.trades.set(tradeId, trade);
    this.checkpoint();
    return trade;
  }

  async openRfq(trade, {
    outputAmountAtomic = "100000",
    maxInputAtomic = "105000",
    quotePolicy = "lowest_all_in",
  } = {}) {
    if (trade.messages.rfq) {
      this.deliver(trade.messages.rfq, "requester");
      return trade.messages.rfq;
    }
    const message = await this.signed("fx_rfq", trade.tradeId, {
      outputChainId: this.destinationChainId,
      outputToken: this.destinationToken,
      outputAmountAtomic,
      inputOptions: [{
        chainId: this.sourceChainId,
        token: this.sourceToken,
        maxInputAtomic,
      }],
      quoteDeadline: this.time + 40,
      settlementDeadline: this.time + 3600,
      quotePolicy,
      x402Commitment: null,
    });
    trade.messages.rfq = message;
    this.deliver(message, "requester");
    return message;
  }

  async quote(trade, {
    inputAmountAtomic = "101000",
    spreadBps = 25,
    settlementCostAtomic = "750",
    estimatedCompletionSeconds = 30,
    referenceTimestamp = this.time,
    messageKey = "quote",
  } = {}) {
    if (trade.messages[messageKey]) {
      this.deliver(trade.messages[messageKey], "dealer");
      return trade.messages[messageKey];
    }
    const rfq = trade.messages.rfq;
    if (!rfq) throw new FxSimulationError("trade has no RFQ");
    if (
      BigInt(this.inventory("dealer", this.destinationChainId, this.destinationToken)) <
      BigInt(rfq.payload.outputAmountAtomic)
    ) {
      throw new FxSimulationError("dealer cannot quote beyond inventory", "NO_INVENTORY");
    }
    const message = await this.signed("fx_quote", trade.tradeId, {
      rfqId: rfq.id,
      inputChainId: this.sourceChainId,
      inputToken: this.sourceToken,
      inputAmountAtomic,
      outputChainId: this.destinationChainId,
      outputToken: this.destinationToken,
      outputAmountAtomic: rfq.payload.outputAmountAtomic,
      quoteType: "fixed_exact_output",
      referenceSource: "simulated:stablecoin-parity",
      referencePriceMicros: "1000000",
      referenceTimestamp,
      spreadBps,
      dealerSettlementCostAtomic: settlementCostAtomic,
      estimatedCompletionSeconds,
      adapterId: "sim-htlc-v1",
      adapterVersion: 1,
    });
    trade.messages[messageKey] = message;
    this.deliver(message, "dealer");
    return message;
  }

  async accept(trade, {
    brokerFeeAtomic = "250",
    password = "phase-two-simulator-password",
  } = {}) {
    if (trade.messages.accept) {
      this.deliver(trade.messages.accept, "requester");
      return trade.messages.accept;
    }
    const { rfq, quote } = trade.messages;
    const route = selectSingleDealerRoute(
      rfq,
      [{ quote, brokerFeeAtomic }],
      { now: this.time }
    );
    const recoveryPath = path.join(
      this.recoveryDirectory,
      `${trade.tradeId.slice(2)}.recovery.json`
    );
    const deterministicSecret = Buffer.from(
      deterministicHash(this.seed, trade.tradeId, "secret").slice(2),
      "hex"
    );
    const recovery = createFxRecoveryPacket({
      filePath: recoveryPath,
      password,
      deploymentId: this.journal.deploymentId,
      tradeId: trade.tradeId,
      createdAt: this.time,
      secret: deterministicSecret,
      metadata: { simulatorSeed: this.seed },
    });
    trade.recovery = {
      filePath: recovery.filePath,
      secretHash: recovery.secretHash,
    };
    this.record("recovery_persisted", {
      actor: "requester",
      tradeId: trade.tradeId,
      secretHash: trade.recovery.secretHash,
      packetPath: path.basename(recoveryPath),
    });
    const message = await this.signed("fx_accept", trade.tradeId, {
      rfqId: rfq.id,
      quoteId: quote.id,
      routeId: route.routeId,
      dealerInputAmountAtomic: quote.payload.inputAmountAtomic,
      brokerFeeAtomic,
      totalInputAtomic: route.totalInputAtomic,
      outputAmountAtomic: quote.payload.outputAmountAtomic,
      secretHash: trade.recovery.secretHash,
      sourceRefundAddress: this.actor("requester").address,
      destinationClaimAddress: this.actor("requester").address,
      sourceAdapterId: "sim-htlc-v1",
      sourceAdapterVersion: 1,
      destinationAdapterId: "sim-htlc-v1",
      destinationAdapterVersion: 1,
    });
    trade.route = route;
    trade.messages.accept = message;
    this.deliver(message, "requester");
    return message;
  }

  async reserve(trade, { reservationSeconds = 240 } = {}) {
    if (trade.messages.reserve) {
      this.deliver(trade.messages.reserve, "dealer");
      return trade.messages.reserve;
    }
    const message = await this.signed("fx_reserve", trade.tradeId, {
      acceptId: trade.messages.accept.id,
      quoteId: trade.messages.quote.id,
      dealerSourceClaimAddress: this.actor("dealer").address,
      dealerDestinationRefundAddress: this.actor("dealer").address,
      reservationDeadline: this.time + reservationSeconds,
    });
    trade.messages.reserve = message;
    this.deliver(message, "dealer");
    return message;
  }

  async fundSource(trade, { timeoutSeconds = 3600, mutate = {} } = {}) {
    if (!trade.recovery || !fs.existsSync(trade.recovery.filePath)) {
      throw new FxSimulationError(
        "secret recovery must be durable before source funding",
        "RECOVERY_NOT_DURABLE"
      );
    }
    const lockId = deterministicHash(this.seed, trade.tradeId, "source-lock");
    const intended = {
      id: lockId,
      chainId: this.sourceChainId,
      token: this.sourceToken,
      amountAtomic: trade.route.totalInputAtomic,
      funder: this.actor("requester").address.toLowerCase(),
      beneficiary: this.actor("dealer").address,
      refundAddress: this.actor("requester").address,
      secretHash: trade.recovery.secretHash,
      timeout: this.time + timeoutSeconds,
      adapterId: "sim-htlc-v1",
      adapterVersion: 1,
      ...mutate,
    };
    this.chain.validateLockSpec(intended, {
      chainId: this.sourceChainId,
      token: this.sourceToken,
      amountAtomic: trade.route.totalInputAtomic,
      beneficiary: this.actor("dealer").address,
      refundAddress: this.actor("requester").address,
      secretHash: trade.recovery.secretHash,
      adapterId: "sim-htlc-v1",
      adapterVersion: 1,
      timeout: this.time + timeoutSeconds,
    });
    let lock = this.chain.locks.get(lockId);
    if (!lock) {
      lock = this.chain.fund(intended);
    }
    const missingConfirmations =
      this.chain.confirmationsRequired - this.chain.confirmations(lockId);
    if (missingConfirmations > 0) {
      this.chain.mine(lock.chainId, missingConfirmations);
    }
    lock = this.chain.verify(lockId, {
      chainId: this.sourceChainId,
      token: this.sourceToken,
      amountAtomic: trade.route.totalInputAtomic,
      beneficiary: this.actor("dealer").address,
      refundAddress: this.actor("requester").address,
      secretHash: trade.recovery.secretHash,
      adapterId: "sim-htlc-v1",
      adapterVersion: 1,
      timeout: this.time + timeoutSeconds,
    });
    trade.locks.source = lock;
    this.checkpoint();
    let message = trade.messages.sourceLock;
    if (!message) {
      message = await this.signed("fx_lock_source", trade.tradeId, {
      acceptId: trade.messages.accept.id,
      chainId: lock.chainId,
      token: lock.token,
      amountAtomic: lock.amountAtomic,
      lockAddress: deterministicAddress(this.seed, trade.tradeId, "source-adapter"),
      beneficiary: lock.beneficiary,
      refundAddress: lock.refundAddress,
      secretHash: lock.secretHash,
      timeout: lock.timeout,
      transactionHash: lock.transactionHash,
      blockNumber: String(lock.blockNumber),
      });
      trade.messages.sourceLock = message;
      this.checkpoint();
    }
    this.record("lock_confirmed", {
      actor: "relayer",
      tradeId: trade.tradeId,
      side: "source",
      transactionHash: lock.transactionHash,
      blockNumber: lock.blockNumber,
      confirmations: this.chain.confirmations(lockId),
    });
    this.deliver(message, "requester");
    return message;
  }

  async fundDestination(trade, { timeoutSeconds = 1800, mutate = {} } = {}) {
    const lockId = deterministicHash(this.seed, trade.tradeId, "destination-lock");
    const intended = {
      id: lockId,
      chainId: this.destinationChainId,
      token: this.destinationToken,
      amountAtomic: trade.messages.quote.payload.outputAmountAtomic,
      funder: this.actor("dealer").address.toLowerCase(),
      beneficiary: this.actor("requester").address,
      refundAddress: this.actor("dealer").address,
      secretHash: trade.recovery.secretHash,
      timeout: this.time + timeoutSeconds,
      adapterId: "sim-htlc-v1",
      adapterVersion: 1,
      ...mutate,
    };
    if (
      Number(trade.locks.source.timeout) <
      Number(intended.timeout) + this.journal.minimumTimeoutDeltaSeconds
    ) {
      throw new FxSimulationError(
        "destination timeout does not leave a safe source refund window",
        "MALFORMED_LOCK"
      );
    }
    this.chain.validateLockSpec(intended, {
      chainId: this.destinationChainId,
      token: this.destinationToken,
      amountAtomic: trade.messages.quote.payload.outputAmountAtomic,
      beneficiary: this.actor("requester").address,
      refundAddress: this.actor("dealer").address,
      secretHash: trade.recovery.secretHash,
      adapterId: "sim-htlc-v1",
      adapterVersion: 1,
      timeout: this.time + timeoutSeconds,
    });
    let lock = this.chain.locks.get(lockId);
    if (!lock) {
      lock = this.chain.fund(intended);
    }
    const missingConfirmations =
      this.chain.confirmationsRequired - this.chain.confirmations(lockId);
    if (missingConfirmations > 0) {
      this.chain.mine(lock.chainId, missingConfirmations);
    }
    lock = this.chain.verify(lockId, {
      chainId: this.destinationChainId,
      token: this.destinationToken,
      amountAtomic: trade.messages.quote.payload.outputAmountAtomic,
      beneficiary: this.actor("requester").address,
      refundAddress: this.actor("dealer").address,
      secretHash: trade.recovery.secretHash,
      adapterId: "sim-htlc-v1",
      adapterVersion: 1,
    });
    trade.locks.destination = lock;
    this.checkpoint();
    let message = trade.messages.destinationLock;
    if (!message) {
      message = await this.signed("fx_lock_destination", trade.tradeId, {
      acceptId: trade.messages.accept.id,
      chainId: lock.chainId,
      token: lock.token,
      amountAtomic: lock.amountAtomic,
      lockAddress: deterministicAddress(
        this.seed,
        trade.tradeId,
        "destination-adapter"
      ),
      beneficiary: lock.beneficiary,
      refundAddress: lock.refundAddress,
      secretHash: lock.secretHash,
      timeout: lock.timeout,
      transactionHash: lock.transactionHash,
      blockNumber: String(lock.blockNumber),
      });
      trade.messages.destinationLock = message;
      this.checkpoint();
    }
    this.record("lock_confirmed", {
      actor: "relayer",
      tradeId: trade.tradeId,
      side: "destination",
      transactionHash: lock.transactionHash,
      blockNumber: lock.blockNumber,
      confirmations: this.chain.confirmations(lockId),
    });
    this.deliver(message, "dealer");
    return message;
  }

  restoreSecret(trade, password = "phase-two-simulator-password") {
    return restoreFxRecoveryPacket({
      filePath: trade.recovery.filePath,
      password,
      deploymentId: this.journal.deploymentId,
      tradeId: trade.tradeId,
    }).secret;
  }

  async claimDestination(trade) {
    let lock = this.chain.locks.get(trade.locks.destination.id);
    if (lock.status === "funded") {
      const secret = this.restoreSecret(trade);
      lock = this.chain.claim(trade.locks.destination.id, {
        secret,
        beneficiary: this.actor("requester").address,
      });
      trade.locks.destination = lock;
      this.checkpoint();
    }
    if (lock.status !== "claimed") {
      throw new FxSimulationError("destination lock cannot be claimed", "BAD_LOCK");
    }
    let message = trade.messages.destinationClaim;
    if (!message) {
      message = await this.signed("fx_claim", trade.tradeId, {
        lockMessageId: trade.messages.destinationLock.id,
        chainId: lock.chainId,
        transactionHash: lock.claimTransactionHash,
        blockNumber: String(lock.claimBlockNumber),
        secretHash: lock.secretHash,
        beneficiary: lock.beneficiary,
      });
      trade.messages.destinationClaim = message;
      this.checkpoint();
    }
    this.deliver(message, "relayer");
    return message;
  }

  async claimSource(trade) {
    let lock = this.chain.locks.get(trade.locks.source.id);
    if (lock.status === "funded") {
      const secret = this.restoreSecret(trade);
      lock = this.chain.claim(trade.locks.source.id, {
        secret,
        beneficiary: this.actor("dealer").address,
      });
      trade.locks.source = lock;
      this.checkpoint();
    }
    if (lock.status !== "claimed") {
      throw new FxSimulationError("source lock cannot be claimed", "BAD_LOCK");
    }
    const sourceAsset = assetKey(this.sourceChainId, this.sourceToken);
    if (
      !trade.brokerFeeMoved &&
      BigInt(trade.route.brokerFeeAtomic) > 0n
    ) {
      this.ledger.transfer(
        this.actor("dealer").address.toLowerCase(),
        this.actor("broker").address.toLowerCase(),
        sourceAsset,
        trade.route.brokerFeeAtomic
      );
      this.record("fee_moved", {
        actor: "broker",
        tradeId: trade.tradeId,
        asset: sourceAsset,
        amountAtomic: trade.route.brokerFeeAtomic,
      });
      trade.brokerFeeMoved = true;
      this.checkpoint();
    }
    let message = trade.messages.sourceClaim;
    if (!message) {
      message = await this.signed("fx_claim", trade.tradeId, {
        lockMessageId: trade.messages.sourceLock.id,
        chainId: lock.chainId,
        transactionHash: lock.claimTransactionHash,
        blockNumber: String(lock.claimBlockNumber),
        secretHash: lock.secretHash,
        beneficiary: lock.beneficiary,
      });
      trade.messages.sourceClaim = message;
      this.checkpoint();
    }
    this.deliver(message, "relayer");
    return message;
  }

  async complete(trade) {
    let message = trade.messages.complete;
    if (!message) {
      message = await this.signed("fx_complete", trade.tradeId, {
        acceptId: trade.messages.accept.id,
        sourceClaimMessageId: trade.messages.sourceClaim.id,
        destinationClaimMessageId: trade.messages.destinationClaim.id,
      });
      trade.messages.complete = message;
      this.checkpoint();
    }
    this.deliver(message, "relayer");
    return message;
  }

  async refundDestination(trade) {
    this.time = Math.max(this.time, trade.locks.destination.timeout);
    let lock = this.chain.locks.get(trade.locks.destination.id);
    if (lock.status === "funded") {
      lock = this.chain.refund(trade.locks.destination.id, {
        at: this.time,
        refundAddress: this.actor("dealer").address,
      });
      trade.locks.destination = lock;
      this.checkpoint();
    }
    if (lock.status !== "refunded") {
      throw new FxSimulationError("destination lock cannot be refunded", "BAD_LOCK");
    }
    let message = trade.messages.destinationRefund;
    if (!message) {
      message = await this.signed("fx_refund", trade.tradeId, {
        lockMessageId: trade.messages.destinationLock.id,
        chainId: lock.chainId,
        transactionHash: lock.refundTransactionHash,
        blockNumber: String(lock.refundBlockNumber),
        beneficiary: lock.refundAddress,
      });
      trade.messages.destinationRefund = message;
      this.checkpoint();
    }
    this.deliver(message, "relayer");
    return message;
  }

  async refundSource(trade) {
    this.time = Math.max(this.time, trade.locks.source.timeout);
    let lock = this.chain.locks.get(trade.locks.source.id);
    if (lock.status === "funded") {
      lock = this.chain.refund(trade.locks.source.id, {
        at: this.time,
        refundAddress: this.actor("requester").address,
      });
      trade.locks.source = lock;
      this.checkpoint();
    }
    if (lock.status !== "refunded") {
      throw new FxSimulationError("source lock cannot be refunded", "BAD_LOCK");
    }
    let message = trade.messages.sourceRefund;
    if (!message) {
      message = await this.signed("fx_refund", trade.tradeId, {
        lockMessageId: trade.messages.sourceLock.id,
        chainId: lock.chainId,
        transactionHash: lock.refundTransactionHash,
        blockNumber: String(lock.refundBlockNumber),
        beneficiary: lock.refundAddress,
      });
      trade.messages.sourceRefund = message;
      this.checkpoint();
    }
    this.deliver(message, "relayer");
    return message;
  }

  report(scenario) {
    const report = {
      schema: "versus-fx-simulation-report",
      version: 1,
      seed: this.seed,
      scenario,
      protocolVersion: this.protocolVersion,
      gitCommit: this.gitCommit,
      finalTime: this.time,
      actors: Object.fromEntries(
        Object.entries(this.actors).map(([role, wallet]) => [
          role,
          wallet.address.toLowerCase(),
        ])
      ),
      inventory: this.ledger.snapshot(),
      trades: [...this.trades.values()].map((trade) =>
        this.journal.snapshot(trade.tradeId)
      ),
      metrics: {
        events: this.events.length,
        messages: this.events.filter((event) => event.type === "message").length,
        locks: this.events.filter((event) => event.type === "lock_confirmed").length,
        feesMovedAtomic: this.events
          .filter((event) => event.type === "fee_moved")
          .reduce((sum, event) => sum + BigInt(event.amountAtomic), 0n)
          .toString(),
      },
      events: this.events,
    };
    report.reportHash = deterministicHash(canonicalJson(report));
    return report;
  }
}

module.exports = {
  FxDeterministicSimulator,
  FxSimulationError,
  VirtualChain,
  VirtualLedger,
  assetKey,
  deterministicAddress,
  deterministicHash,
  deterministicWallet,
};
