const { EventEmitter } = require("node:events");
const {
  assembleFxEnvelope,
  canonicalFxMessage,
  normalizeFxMessage,
  verifyFxEnvelope,
} = require("./fx-protocol");

const DEPENDENCY_ERRORS = new Set([
  "UNKNOWN_TRADE",
  "MISSING_REFERENCE",
  "INVALID_STATE_TRANSITION",
]);

async function signFxMessage(input, signer) {
  const sender = await signer.getAddress();
  const normalized = normalizeFxMessage({ ...input, sender });
  const signature = await signer.signMessage(canonicalFxMessage(normalized));
  return assembleFxEnvelope(normalized, signature);
}

class SlidingWindowLimit {
  constructor({
    windowMs = 60_000,
    maximum = 60,
    maximumKeys = 4_096,
    now = () => Date.now(),
  } = {}) {
    this.windowMs = windowMs;
    this.maximum = maximum;
    this.maximumKeys = maximumKeys;
    this.now = now;
    this.entries = new Map();
  }

  accept(key) {
    const cutoff = this.now() - this.windowMs;
    const recent = (this.entries.get(key) || []).filter((value) => value > cutoff);
    if (recent.length >= this.maximum) {
      this.entries.set(key, recent);
      return false;
    }
    if (!this.entries.has(key) && this.entries.size >= this.maximumKeys) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
    recent.push(this.now());
    this.entries.delete(key);
    this.entries.set(key, recent);
    return true;
  }
}

class FxCoordinationSession extends EventEmitter {
  constructor({
    deploymentId,
    signer,
    role,
    journal,
    transport,
    now = () => Math.floor(Date.now() / 1000),
    maxMessagesPerSenderPerMinute = 60,
    maxMessagesPerMinuteGlobal = 600,
    maxRfqsPerSenderPerMinute = 6,
    maxActiveRfqs = 32,
    maxPendingMessages = 256,
    maxSeenMessages = 10_000,
  } = {}) {
    super();
    if (!signer) throw new TypeError("FX coordination signer is required");
    if (!["requester", "dealer", "broker", "relayer"].includes(role)) {
      throw new TypeError("FX coordination role is unsupported");
    }
    if (!journal || !transport) throw new TypeError("FX journal and transport are required");
    this.deploymentId = String(deploymentId).toLowerCase();
    this.signer = signer;
    this.role = role;
    this.journal = journal;
    this.transport = transport;
    this.now = now;
    this.maxActiveRfqs = Number(maxActiveRfqs);
    this.maxPendingMessages = Number(maxPendingMessages);
    this.maxSeenMessages = Number(maxSeenMessages);
    this.pending = new Map();
    this.activeRfqs = new Map();
    this.seen = new Set();
    this.seenOrder = [];
    this.globalLimit = new SlidingWindowLimit({
      maximum: maxMessagesPerMinuteGlobal,
    });
    this.allLimit = new SlidingWindowLimit({
      maximum: maxMessagesPerSenderPerMinute,
    });
    this.rfqLimit = new SlidingWindowLimit({
      maximum: maxRfqsPerSenderPerMinute,
    });
    this.started = false;
    this.address = null;
    this.boundEnvelope = (envelope, metadata) => this.ingest(envelope, metadata);
    this.boundRejected = (error, metadata) => this.emit("rejected", error, metadata);
  }

  async start() {
    if (this.started) return this.status();
    this.address = (await this.signer.getAddress()).toLowerCase();
    this.transport.on("envelope", this.boundEnvelope);
    this.transport.on("rejected", this.boundRejected);
    await this.transport.start();
    if (this.transport.historyCatchUp) await this.transport.historyCatchUp;
    this.started = true;
    return this.status();
  }

  status() {
    return {
      active: this.started,
      role: this.role,
      address: this.address,
      deploymentId: this.deploymentId,
      pending: this.pending.size,
      activeRfqs: this.activeRfqs.size,
      transport: this.transport.status?.() || null,
    };
  }

  pruneActiveRfqs() {
    const now = this.now();
    for (const [tradeId, expiresAt] of this.activeRfqs.entries()) {
      if (expiresAt < now) this.activeRfqs.delete(tradeId);
    }
  }

  admission(envelope, { history = false } = {}) {
    const verified = verifyFxEnvelope(envelope, { now: this.now() });
    if (verified.deploymentId !== this.deploymentId) {
      const error = new Error("FX envelope belongs to another deployment");
      error.code = "DEPLOYMENT_MISMATCH";
      throw error;
    }
    if (this.seen.has(verified.id)) return { duplicate: true, envelope: verified };
    if (!history && !this.globalLimit.accept("global")) {
      const error = new Error("FX global message rate exceeded");
      error.code = "FX_GLOBAL_RATE_LIMIT";
      throw error;
    }
    if (!history && !this.allLimit.accept(verified.sender)) {
      const error = new Error("FX sender message rate exceeded");
      error.code = "FX_RATE_LIMIT";
      throw error;
    }
    if (
      !history &&
      verified.type === "fx_rfq" &&
      !this.rfqLimit.accept(verified.sender)
    ) {
      const error = new Error("FX sender RFQ rate exceeded");
      error.code = "FX_RFQ_RATE_LIMIT";
      throw error;
    }
    this.pruneActiveRfqs();
    if (
      verified.type === "fx_rfq" &&
      !this.activeRfqs.has(verified.tradeId) &&
      this.activeRfqs.size >= this.maxActiveRfqs
    ) {
      const error = new Error("FX active RFQ capacity reached");
      error.code = "FX_ACTIVE_RFQ_LIMIT";
      throw error;
    }
    return { duplicate: false, envelope: verified };
  }

  ingest(envelope, metadata = {}) {
    try {
      const admitted = this.admission(envelope, metadata);
      if (admitted.duplicate) return { status: "duplicate" };
      const result = this.journal.apply(admitted.envelope, {
        now: this.now(),
        temporal: true,
      });
      this.remember(admitted.envelope.id);
      if (
        admitted.envelope.type === "fx_rfq" &&
        admitted.envelope.expiresAt >= this.now()
      ) {
        this.activeRfqs.set(admitted.envelope.tradeId, admitted.envelope.expiresAt);
      }
      if (result.status === "duplicate" && !metadata.history) {
        this.emit("duplicate", admitted.envelope, metadata);
        return result;
      }
      this.emit("accepted", admitted.envelope, { ...metadata, result });
      this.retryPending();
      return result;
    } catch (error) {
      if (
        DEPENDENCY_ERRORS.has(error.code) &&
        envelope?.id &&
        this.pending.size < this.maxPendingMessages
      ) {
        this.pending.set(envelope.id, { envelope, metadata });
        this.emit("pending", envelope, { ...metadata, error });
        return { status: "pending", error: error.code };
      }
      this.emit("rejected", error, metadata, envelope);
      return { status: "rejected", error: error.code || error.message };
    }
  }

  retryPending() {
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, entry] of [...this.pending.entries()]) {
        try {
          const result = this.journal.apply(entry.envelope, {
            now: this.now(),
            temporal: true,
          });
          this.pending.delete(id);
          this.remember(id);
          this.emit("accepted", entry.envelope, {
            ...entry.metadata,
            recoveredDependency: true,
            result,
          });
          changed = true;
        } catch (error) {
          if (!DEPENDENCY_ERRORS.has(error.code)) {
            this.pending.delete(id);
            this.emit("rejected", error, entry.metadata, entry.envelope);
          }
        }
      }
    }
  }

  remember(id) {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.seenOrder.push(id);
    while (this.seenOrder.length > this.maxSeenMessages) {
      this.seen.delete(this.seenOrder.shift());
    }
  }

  async publish(input) {
    const tradeId = String(input.tradeId || "").toLowerCase();
    const sequence = this.journal.reserveSequence(
      tradeId,
      this.address || (await this.signer.getAddress()).toLowerCase()
    );
    const envelope = await signFxMessage({
      ...input,
      deploymentId: this.deploymentId,
      role: this.role,
      sequence,
    }, this.signer);
    const local = this.ingest(envelope, { local: true });
    if (local.status === "rejected" || local.status === "pending") {
      throw new Error(`local FX message was not accepted: ${local.error || local.status}`);
    }
    await this.transport.publish(envelope);
    return envelope;
  }

  async resume() {
    const result = await this.transport.ensureConnected();
    if (this.transport.historyCatchUp) await this.transport.historyCatchUp;
    this.retryPending();
    return result;
  }

  async close() {
    this.started = false;
    this.transport.off("envelope", this.boundEnvelope);
    this.transport.off("rejected", this.boundRejected);
    await this.transport.close();
  }
}

module.exports = {
  FxCoordinationSession,
  SlidingWindowLimit,
  signFxMessage,
};
