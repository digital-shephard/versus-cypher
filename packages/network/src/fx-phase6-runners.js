const { EventEmitter } = require("node:events");
const { randomBytes, hexlify } = require("ethers");
const {
  FX_V2_VERSION,
  selectSingleDealerRoute,
} = require("./fx-protocol");

function bytes32(value = null) {
  return value || hexlify(randomBytes(32));
}

class FxDeterministicDealer extends EventEmitter {
  constructor({
    session,
    quotePolicy,
    sourceClaimAddress,
    destinationRefundAddress,
    observationWindowMs = 15_000,
    now = () => Math.floor(Date.now() / 1000),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    protocolVersion = 1,
  } = {}) {
    super();
    if (!session || session.role !== "dealer") {
      throw new TypeError("deterministic dealer requires a dealer coordination session");
    }
    if (typeof quotePolicy !== "function") {
      throw new TypeError("deterministic dealer requires a quote policy");
    }
    this.session = session;
    this.quotePolicy = quotePolicy;
    this.sourceClaimAddress = sourceClaimAddress;
    this.destinationRefundAddress = destinationRefundAddress;
    this.observationWindowMs = Number(observationWindowMs);
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.protocolVersion = Number(protocolVersion);
    if (![1, FX_V2_VERSION].includes(this.protocolVersion)) {
      throw new TypeError("deterministic dealer protocol version is unsupported");
    }
    this.pendingRfqs = new Map();
    this.quotes = new Map();
    this.historicalRfqs = new Map();
    this.historicalAccepts = new Map();
    this.boundAccepted = (envelope, metadata) => {
      this.onEnvelope(envelope, metadata).catch((error) => this.emit("error", error));
    };
  }

  async start() {
    this.session.on("accepted", this.boundAccepted);
    await this.session.start();
    await this.reconcileHistory();
    return this.status();
  }

  status() {
    return {
      active: this.session.started,
      pendingRfqs: this.pendingRfqs.size,
      quotes: this.quotes.size,
      observationWindowMs: this.observationWindowMs,
    };
  }

  async onEnvelope(envelope, metadata = {}) {
    if (metadata.history) {
      if (envelope.type === "fx_rfq") this.historicalRfqs.set(envelope.tradeId, envelope);
      if (envelope.type === "fx_accept") this.historicalAccepts.set(envelope.tradeId, envelope);
      if (envelope.type === "fx_quote" && envelope.sender === this.session.address) {
        this.quotes.set(envelope.tradeId, envelope);
      }
      if (envelope.type === "fx_cancel") {
        this.quotes.delete(envelope.tradeId);
        this.historicalAccepts.delete(envelope.tradeId);
      }
      return;
    }
    if (envelope.type === "fx_rfq") {
      if (this.pendingRfqs.has(envelope.id) || this.quotes.has(envelope.tradeId)) return;
      const timer = this.setTimer(() => {
        this.pendingRfqs.delete(envelope.id);
        this.quote(envelope).catch((error) => this.emit("error", error));
      }, this.observationWindowMs);
      timer.unref?.();
      this.pendingRfqs.set(envelope.id, timer);
      return;
    }
    if (
      envelope.type === "fx_quote" &&
      envelope.sender === this.session.address
    ) {
      this.quotes.set(envelope.tradeId, envelope);
      return;
    }
    if (envelope.type === "fx_cancel") {
      this.quotes.delete(envelope.tradeId);
      this.historicalAccepts.delete(envelope.tradeId);
      this.emit("cancelled", envelope, metadata);
      return;
    }
    if (envelope.type !== "fx_accept") return;
    const quote = this.quotes.get(envelope.tradeId);
    if (!quote || envelope.payload.quoteId !== quote.id) return;
    const createdAt = this.now();
    const expiresAt = Math.min(envelope.expiresAt, createdAt + 10 * 60);
    const reserve = await this.session.publish({
      protocol: "versus-fx",
      version: this.protocolVersion,
      type: "fx_reserve",
      tradeId: envelope.tradeId,
      createdAt,
      expiresAt,
      payload: {
        acceptId: envelope.id,
        quoteId: quote.id,
        dealerSourceClaimAddress: this.sourceClaimAddress,
        dealerDestinationRefundAddress: this.destinationRefundAddress,
        reservationDeadline: expiresAt,
      },
    });
    this.emit("reserved", reserve, { accept: envelope, quote });
  }

  async reconcileHistory() {
    for (const rfq of this.historicalRfqs.values()) {
      const snapshot = this.session.journal.snapshot(rfq.tradeId);
      if (
        rfq.payload.quoteDeadline >= this.now() &&
        snapshot?.settlementState === "rfq_open" &&
        !this.quotes.has(rfq.tradeId)
      ) {
        await this.onEnvelope(rfq, { recoveredFromStore: true });
      }
    }
    for (const accept of this.historicalAccepts.values()) {
      if (
        accept.expiresAt >= this.now() &&
        !this.session.journal.findType(accept.tradeId, "fx_reserve")
      ) {
        await this.onEnvelope(accept, { recoveredFromStore: true });
      }
    }
    this.historicalRfqs.clear();
    this.historicalAccepts.clear();
  }

  async resume() {
    const result = await this.session.resume();
    await this.reconcileHistory();
    return result;
  }

  async quote(rfq) {
    if (this.now() > rfq.payload.quoteDeadline) {
      this.emit("skipped", rfq, { reason: "quote_deadline_elapsed" });
      return null;
    }
    if (
      this.session.journal.snapshot(rfq.tradeId)?.settlementState !== "rfq_open"
    ) {
      this.emit("skipped", rfq, { reason: "rfq_no_longer_open" });
      return null;
    }
    const decision = await this.quotePolicy(rfq);
    const payload =
      decision &&
      typeof decision === "object" &&
      Object.prototype.hasOwnProperty.call(decision, "quote")
        ? decision.quote
        : decision;
    const rejection =
      decision &&
      typeof decision === "object" &&
      Object.prototype.hasOwnProperty.call(decision, "rejection")
        ? decision.rejection
        : null;
    if (!payload) {
      this.emit("skipped", rfq, {
        reason: rejection?.code || "policy_declined",
        detail: rejection?.detail || null,
      });
      return null;
    }
    const createdAt = this.now();
    const expiresAt = Math.min(
      rfq.payload.quoteDeadline,
      createdAt + (this.protocolVersion === FX_V2_VERSION ? 120 : 60)
    );
    if (expiresAt <= createdAt) return null;
    const quote = await this.session.publish({
      protocol: "versus-fx",
      version: this.protocolVersion,
      type: "fx_quote",
      tradeId: rfq.tradeId,
      createdAt,
      expiresAt,
      payload: {
        ...payload,
        rfqId: rfq.id,
        outputChainId: rfq.payload.outputChainId,
        outputToken: rfq.payload.outputToken,
        outputAmountAtomic: rfq.payload.outputAmountAtomic,
        quoteType: "fixed_exact_output",
      },
    });
    this.quotes.set(rfq.tradeId, quote);
    this.emit("quoted", quote, { rfq });
    return quote;
  }

  async close() {
    this.session.off("accepted", this.boundAccepted);
    for (const timer of this.pendingRfqs.values()) this.clearTimer(timer);
    this.pendingRfqs.clear();
    await this.session.close();
  }
}

class FxRequesterBroker extends EventEmitter {
  constructor({
    session,
    observationWindowMs = 15_000,
    now = () => Math.floor(Date.now() / 1000),
  } = {}) {
    super();
    if (!session || session.role !== "requester") {
      throw new TypeError("requester broker requires a requester coordination session");
    }
    this.session = session;
    this.observationWindowMs = Number(observationWindowMs);
    this.now = now;
    this.rfqs = new Map();
    this.quotes = new Map();
    this.boundAccepted = (envelope, metadata) => this.onEnvelope(envelope, metadata);
  }

  async start() {
    this.session.on("accepted", this.boundAccepted);
    await this.session.start();
    return this.status();
  }

  status() {
    return {
      active: this.session.started,
      rfqs: this.rfqs.size,
      quotedTrades: this.quotes.size,
      observationWindowMs: this.observationWindowMs,
    };
  }

  onEnvelope(envelope, metadata) {
    if (envelope.type === "fx_rfq" && envelope.sender === this.session.address) {
      this.rfqs.set(envelope.tradeId, envelope);
    }
    if (envelope.type === "fx_quote") {
      const rfq = this.rfqs.get(envelope.tradeId);
      if (!rfq || envelope.payload.rfqId !== rfq.id) return;
      const entries = this.quotes.get(envelope.tradeId) || [];
      if (!entries.some((candidate) => candidate.quote.id === envelope.id)) {
        entries.push({ quote: envelope, brokerFeeAtomic: "0" });
        this.quotes.set(envelope.tradeId, entries);
        this.emit("quote", envelope, metadata);
      }
    }
    if (envelope.type === "fx_reserve") this.emit("reserved", envelope, metadata);
    if (envelope.type === "fx_cancel") this.emit("cancelled", envelope, metadata);
  }

  async openRfq({
    tradeId = bytes32(),
    payload,
    lifetimeSeconds = 60,
  }) {
    const createdAt = this.now();
    const expiresAt = createdAt + Math.min(60, Number(lifetimeSeconds));
    const rfq = await this.session.publish({
      protocol: "versus-fx",
      version: 1,
      type: "fx_rfq",
      tradeId,
      createdAt,
      expiresAt,
      payload: {
        ...payload,
        quoteDeadline: payload.quoteDeadline || expiresAt,
      },
    });
    this.rfqs.set(rfq.tradeId, rfq);
    return rfq;
  }

  selectRoute(tradeId, { policy, brokerFeeAtomic = "0" } = {}) {
    const rfq = this.rfqs.get(tradeId);
    if (!rfq) throw new Error("FX RFQ is unknown");
    const candidates = (this.quotes.get(tradeId) || []).map((candidate) => ({
      ...candidate,
      brokerFeeAtomic,
    }));
    return selectSingleDealerRoute(rfq, candidates, {
      now: this.now(),
      policy: policy || rfq.payload.quotePolicy,
    });
  }

  async accept({
    tradeId,
    route,
    secretHash,
    sourceRefundAddress,
    destinationClaimAddress,
  }) {
    const rfq = this.rfqs.get(tradeId);
    if (!rfq) throw new Error("FX RFQ is unknown");
    const createdAt = this.now();
    const expiresAt = Math.min(rfq.payload.settlementDeadline, createdAt + 10 * 60);
    const accept = await this.session.publish({
      protocol: "versus-fx",
      version: 1,
      type: "fx_accept",
      tradeId,
      createdAt,
      expiresAt,
      payload: {
        rfqId: rfq.id,
        quoteId: route.quoteId,
        routeId: route.routeId,
        dealerInputAmountAtomic: (
          BigInt(route.totalInputAtomic) - BigInt(route.brokerFeeAtomic)
        ).toString(),
        brokerFeeAtomic: route.brokerFeeAtomic,
        totalInputAtomic: route.totalInputAtomic,
        outputAmountAtomic: route.outputAmountAtomic,
        secretHash,
        sourceRefundAddress,
        destinationClaimAddress,
        sourceAdapterId: "evm-htlc-v1",
        sourceAdapterVersion: 1,
        destinationAdapterId: "evm-htlc-v1",
        destinationAdapterVersion: 1,
      },
    });
    this.emit("acceptedRoute", accept, { route, rfq });
    return accept;
  }

  async resume() {
    return this.session.resume();
  }

  async close() {
    this.session.off("accepted", this.boundAccepted);
    await this.session.close();
  }
}

module.exports = {
  FxDeterministicDealer,
  FxRequesterBroker,
  bytes32,
};
