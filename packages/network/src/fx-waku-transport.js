const { EventEmitter } = require("node:events");
const { verifyFxEnvelope } = require("./fx-protocol");
const { verifyPhase8EvidenceAttestation } = require("./fx-phase8-policy");

const FX_WAKU_TOPIC_VERSION = 1;
const DEFAULT_FX_WAKU_SHARD_COUNT = 4;
const DEFAULT_FX_STORE_HISTORY_MS = 15 * 60 * 1000;
const DEFAULT_FX_STORE_MESSAGE_LIMIT = 512;
const DEFAULT_FX_RECONNECT_POLL_MS = 15_000;
const DEFAULT_FX_RECONNECT_BACKOFF_MAX_MS = 120_000;
const DEFAULT_WAKU_CLUSTER_ID = 66;
const DEFAULT_WAKU_SHARD_COUNT = 8;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;

function normalizeDeploymentId(value) {
  const deploymentId = String(value || "").toLowerCase();
  if (!HASH_PATTERN.test(deploymentId)) {
    throw new TypeError("deploymentId must be a lowercase bytes32 hash");
  }
  return deploymentId;
}

function normalizeFxShardCount(value) {
  const shardCount = Number(value);
  if (!Number.isInteger(shardCount) || shardCount < 1 || shardCount > 16) {
    throw new RangeError("FX Waku shard count must be between 1 and 16");
  }
  return shardCount;
}

function fxTradeShard(tradeId, shardCount = DEFAULT_FX_WAKU_SHARD_COUNT) {
  shardCount = normalizeFxShardCount(shardCount);
  const normalized = String(tradeId || "").toLowerCase();
  if (!HASH_PATTERN.test(normalized)) throw new TypeError("tradeId must be a lowercase bytes32 hash");
  return Number(BigInt(normalized) % BigInt(shardCount));
}

function createFxContentTopics({
  deploymentId,
  coordinationDomain = deploymentId,
  shardCount = DEFAULT_FX_WAKU_SHARD_COUNT,
} = {}) {
  deploymentId = normalizeDeploymentId(deploymentId);
  coordinationDomain = normalizeDeploymentId(coordinationDomain);
  shardCount = normalizeFxShardCount(shardCount);
  const scope = coordinationDomain.slice(2);
  return Object.freeze({
    discovery: `/versus-fx/${FX_WAKU_TOPIC_VERSION}/rfq-${scope}/json`,
    coordination: Object.freeze(Array.from(
      { length: shardCount },
      (_, index) => `/versus-fx/${FX_WAKU_TOPIC_VERSION}/trade-${scope}-${index}/json`
    )),
    evidence: Object.freeze(Array.from(
      { length: shardCount },
      (_, index) => `/versus-fx/${FX_WAKU_TOPIC_VERSION}/evidence-${scope}-${index}/json`
    )),
  });
}

class FxWakuTransport extends EventEmitter {
  constructor({
    deploymentId,
    coordinationDomain = deploymentId,
    bootstrapPeers = [],
    defaultBootstrap = bootstrapPeers.length === 0,
    shardCount = DEFAULT_FX_WAKU_SHARD_COUNT,
    clusterId = DEFAULT_WAKU_CLUSTER_ID,
    numShardsInCluster = DEFAULT_WAKU_SHARD_COUNT,
    peerTimeoutMs = 20_000,
    minimumPeerCount = 1,
    maxPayloadBytes = 32_768,
    enableStore = true,
    storeHistoryMs = DEFAULT_FX_STORE_HISTORY_MS,
    storeMessageLimit = DEFAULT_FX_STORE_MESSAGE_LIMIT,
    storePageSize = 64,
    reconnectPollMs = DEFAULT_FX_RECONNECT_POLL_MS,
    reconnectBackoffMaxMs = DEFAULT_FX_RECONNECT_BACKOFF_MAX_MS,
    sdkLoader = () => import("@waku/sdk"),
    nodeFactory = null,
    now = () => Date.now(),
  } = {}) {
    super();
    this.deploymentId = normalizeDeploymentId(deploymentId);
    this.coordinationDomain = normalizeDeploymentId(coordinationDomain);
    this.shardCount = normalizeFxShardCount(shardCount);
    this.topics = createFxContentTopics({
      deploymentId: this.deploymentId,
      coordinationDomain: this.coordinationDomain,
      shardCount: this.shardCount,
    });
    this.bootstrapPeers = [...bootstrapPeers];
    this.defaultBootstrap = Boolean(defaultBootstrap);
    this.clusterId = Number(clusterId);
    this.numShardsInCluster = Number(numShardsInCluster);
    this.peerTimeoutMs = Number(peerTimeoutMs);
    this.minimumPeerCount = Number(minimumPeerCount);
    this.maxPayloadBytes = Number(maxPayloadBytes);
    this.enableStore = Boolean(enableStore);
    this.storeHistoryMs = Number(storeHistoryMs);
    this.storeMessageLimit = Number(storeMessageLimit);
    this.storePageSize = Number(storePageSize);
    this.reconnectPollMs = Number(reconnectPollMs);
    this.reconnectBackoffMaxMs = Number(reconnectBackoffMaxMs);
    if (!Number.isInteger(this.reconnectPollMs) || this.reconnectPollMs < 10) {
      throw new RangeError("reconnectPollMs must be at least 10 milliseconds");
    }
    if (
      !Number.isInteger(this.reconnectBackoffMaxMs) ||
      this.reconnectBackoffMaxMs < this.reconnectPollMs
    ) {
      throw new RangeError("reconnectBackoffMaxMs must be at least reconnectPollMs");
    }
    this.sdkLoader = sdkLoader;
    this.nodeFactory = nodeFactory;
    this.now = now;
    this.node = null;
    this.encoders = new Map();
    this.decoders = new Map();
    this.started = false;
    this.state = "offline";
    this.error = null;
    this.protocolCounts = { lightPush: 0, filter: 0, store: 0, relay: 0 };
    this.connectedPeers = [];
    this.historySync = null;
    this.reconnectInFlight = null;
    this.reconnectWatchdogTimer = null;
    this.reconnectWatchdogInFlight = null;
    this.reconnectDesired = false;
    this.reconnectFailures = 0;
    this.nextReconnectAt = 0;
  }

  status() {
    return {
      transport: "waku",
      lane: "fx",
      state: this.state,
      error: this.error,
      deploymentId: this.deploymentId,
      coordinationDomain: this.coordinationDomain,
      topics: this.topics,
      peerCount: this.connectedPeers.length,
      protocolCounts: { ...this.protocolCounts },
      historySync: this.historySync,
      reconnect: {
        active: Boolean(this.reconnectWatchdogTimer),
        failures: this.reconnectFailures,
        nextAttemptAt: this.nextReconnectAt || null,
      },
    };
  }

  resetReconnectBackoff() {
    this.reconnectFailures = 0;
    this.nextReconnectAt = 0;
  }

  recordReconnectFailure() {
    this.reconnectFailures += 1;
    const delay = Math.min(
      this.reconnectPollMs * (2 ** Math.min(this.reconnectFailures - 1, 8)),
      this.reconnectBackoffMaxMs
    );
    this.nextReconnectAt = Date.now() + delay;
  }

  startReconnectWatchdog() {
    if (this.reconnectWatchdogTimer || !this.reconnectDesired) return;
    this.reconnectWatchdogTimer = setInterval(() => {
      this.runReconnectWatchdog().catch((error) => {
        this.error = error.message;
      });
    }, this.reconnectPollMs);
    this.reconnectWatchdogTimer.unref?.();
  }

  stopReconnectWatchdog() {
    if (this.reconnectWatchdogTimer) clearInterval(this.reconnectWatchdogTimer);
    this.reconnectWatchdogTimer = null;
    this.reconnectWatchdogInFlight = null;
    this.resetReconnectBackoff();
  }

  async runReconnectWatchdog() {
    if (!this.reconnectDesired || this.reconnectWatchdogInFlight) {
      return this.reconnectWatchdogInFlight;
    }
    if (Date.now() < this.nextReconnectAt) return null;
    this.reconnectWatchdogInFlight = (async () => {
      try {
        if (this.started && this.node) {
          await this.refreshPeerDiagnostics();
          if (
            this.protocolCounts.lightPush >= this.minimumPeerCount &&
            this.protocolCounts.filter >= this.minimumPeerCount
          ) {
            this.resetReconnectBackoff();
            return { restarted: false, status: this.status() };
          }
        }
        this.setState("reconnecting");
        const result = await this.ensureConnected({ force: true, watchdog: true });
        this.resetReconnectBackoff();
        return result;
      } catch (error) {
        this.recordReconnectFailure();
        this.setState("offline", error.message);
        return { restarted: false, error: error.message, status: this.status() };
      }
    })().finally(() => {
      this.reconnectWatchdogInFlight = null;
    });
    return this.reconnectWatchdogInFlight;
  }

  setState(state, error = null) {
    const changed = this.state !== state || this.error !== (error ? String(error) : null);
    this.state = state;
    this.error = error ? String(error) : null;
    if (changed) this.emit("state", this.status());
  }

  async refreshPeerDiagnostics() {
    const peers = await this.node.getConnectedPeers();
    this.connectedPeers = peers.map((peer) => ({
      id: peer?.id?.toString?.() || String(peer?.id || "unknown"),
      protocols: Array.from(peer?.protocols || [], String),
    }));
    const count = (needle) => this.connectedPeers.filter((peer) =>
      peer.protocols.some((protocol) => protocol.toLowerCase().includes(needle))
    ).length;
    this.protocolCounts = {
      lightPush: count("lightpush"),
      filter: count("filter"),
      store: count("store"),
      relay: count("relay"),
    };
    if (
      this.protocolCounts.lightPush < this.minimumPeerCount ||
      this.protocolCounts.filter < this.minimumPeerCount
    ) {
      this.setState("reconnecting");
    } else if (!this.enableStore || this.protocolCounts.store < 1 || this.historySync?.error) {
      this.setState("degraded_store", this.historySync?.error || null);
    } else if (this.historySync?.completedAt) {
      this.setState("caught_up");
    } else {
      this.setState("ready");
    }
    return this.status();
  }

  async start({ reconnect = false } = {}) {
    if (!reconnect) this.reconnectDesired = true;
    if (reconnect && !this.reconnectDesired) return this.status();
    if (this.started) return this.status();
    this.setState("reconnecting");
    try {
      const sdk = await this.sdkLoader();
      const createNode = this.nodeFactory || sdk.createLightNode;
      this.node = await createNode({
        autoStart: true,
        defaultBootstrap: this.defaultBootstrap,
        bootstrapPeers: this.bootstrapPeers,
        userAgent: "versus-fx/0.1",
        networkConfig: {
          clusterId: this.clusterId,
          numShardsInCluster: this.numShardsInCluster,
        },
      });
      await this.node.waitForPeers([sdk.Protocols.LightPush, sdk.Protocols.Filter], this.peerTimeoutMs);
      await this.refreshPeerDiagnostics();
      if (
        this.protocolCounts.lightPush < this.minimumPeerCount ||
        this.protocolCounts.filter < this.minimumPeerCount
      ) {
        throw new Error("FX Waku transport did not find the required peers");
      }
      for (const topic of [
        this.topics.discovery,
        ...this.topics.coordination,
        ...this.topics.evidence,
      ]) {
        const encoder = this.node.createEncoder({ contentTopic: topic, ephemeral: false });
        const decoder = this.node.createDecoder({ contentTopic: topic });
        const subscribed = await this.node.filter.subscribe(decoder, (message) => {
          this.onMessage(message, { topic, history: false });
        });
        if (!subscribed) throw new Error(`FX Waku Filter rejected ${topic}`);
        this.encoders.set(topic, encoder);
        this.decoders.set(topic, decoder);
      }
      this.started = true;
      this.resetReconnectBackoff();
      this.startReconnectWatchdog();
      this.setState("ready");
      this.historyCatchUp = this.catchUp();
      return this.status();
    } catch (error) {
      // A failed Filter subscription can happen after the node has connected and
      // some topics are already active. Tear that partial node down before a
      // caller retries so stale subscriptions do not consume relay capacity or
      // deliver duplicate messages into the replacement transport.
      await this.close({ preserveReconnect: true }).catch(() => {});
      this.setState("offline", error.message);
      throw error;
    }
  }

  topicFor(envelope) {
    if (envelope.type === "fx_rfq") return this.topics.discovery;
    return this.topics.coordination[fxTradeShard(envelope.tradeId, this.shardCount)];
  }

  topicForEvidence(evidence) {
    return this.topics.evidence[
      fxTradeShard(evidence.tradeId, this.shardCount)
    ];
  }

  onMessage(message, { topic, history }) {
    try {
      const payload = message?.payload;
      if (!(payload instanceof Uint8Array)) throw new Error("FX Waku message has no byte payload");
      if (payload.byteLength > this.maxPayloadBytes) throw new Error("FX Waku payload is too large");
      const decoded = JSON.parse(new TextDecoder().decode(payload));
      if (this.topics.evidence.includes(topic)) {
        const evidence = verifyPhase8EvidenceAttestation(decoded);
        if (evidence.deploymentId !== this.deploymentId) {
          throw new Error("FX evidence belongs to another deployment");
        }
        if (this.topicForEvidence(evidence) !== topic) {
          throw new Error("FX evidence used the wrong topic");
        }
        this.emit("evidence", evidence, {
          topic,
          history: Boolean(history),
          hash: message.hashStr || null,
        });
        return true;
      }
      const envelope = verifyFxEnvelope(
        decoded,
        { now: Math.floor(this.now() / 1000) }
      );
      if (envelope.deploymentId !== this.deploymentId) {
        throw new Error("FX Waku message belongs to another deployment");
      }
      if (this.topicFor(envelope) !== topic) throw new Error("FX Waku message used the wrong topic");
      this.emit("envelope", envelope, {
        topic,
        history: Boolean(history),
        hash: message.hashStr || null,
      });
      return true;
    } catch (error) {
      this.emit("rejected", error, { topic, history: Boolean(history) });
      return false;
    }
  }

  async publish(envelope) {
    await this.start();
    const verified = verifyFxEnvelope(envelope, {
      now: Math.floor(this.now() / 1000),
    });
    if (verified.deploymentId !== this.deploymentId) {
      throw new Error("FX envelope belongs to another deployment");
    }
    const topic = this.topicFor(verified);
    const payload = new TextEncoder().encode(JSON.stringify(verified));
    if (payload.byteLength > this.maxPayloadBytes) throw new Error("FX Waku payload is too large");
    const result = await this.node.lightPush.send(
      this.encoders.get(topic),
      { payload, timestamp: new Date(this.now()) },
      { autoRetry: false }
    );
    if (!result?.successes?.length) {
      const reason = result?.failures?.map((failure) => failure.error).join(", ") || "no relay accepted it";
      throw new Error(`FX Waku LightPush failed: ${reason}`);
    }
    this.emit("published", {
      id: verified.id,
      type: verified.type,
      tradeId: verified.tradeId,
      topic,
      successCount: result.successes.length,
    });
    return { envelope: verified, topic, result };
  }

  async publishEvidence(input) {
    await this.start();
    const evidence = verifyPhase8EvidenceAttestation(input);
    if (evidence.deploymentId !== this.deploymentId) {
      throw new Error("FX evidence belongs to another deployment");
    }
    const topic = this.topicForEvidence(evidence);
    const payload = new TextEncoder().encode(JSON.stringify(input));
    if (payload.byteLength > this.maxPayloadBytes) {
      throw new Error("FX Waku evidence payload is too large");
    }
    const result = await this.node.lightPush.send(
      this.encoders.get(topic),
      { payload, timestamp: new Date(this.now()) },
      { autoRetry: false }
    );
    if (!result?.successes?.length) {
      const reason =
        result?.failures?.map((failure) => failure.error).join(", ") ||
        "no relay accepted it";
      throw new Error(`FX Waku evidence LightPush failed: ${reason}`);
    }
    this.emit("evidencePublished", {
      evidenceId: evidence.evidenceId,
      schema: evidence.schema,
      tradeId: evidence.tradeId,
      topic,
      successCount: result.successes.length,
    });
    return { evidence, topic, result };
  }

  async catchUp() {
    if (!this.enableStore || !this.node?.store?.queryWithOrderedCallback) {
      this.historySync = { attempted: false, received: 0, error: "Waku Store is unavailable" };
      this.setState("degraded_store", this.historySync.error);
      return this.historySync;
    }
    const timeEnd = new Date(this.now());
    const timeStart = new Date(timeEnd.getTime() - this.storeHistoryMs);
    let received = 0;
    try {
      for (const [topic, decoder] of this.decoders.entries()) {
        if (received >= this.storeMessageLimit) break;
        await this.node.store.queryWithOrderedCallback(
          [decoder],
          (message) => {
            if (received >= this.storeMessageLimit) return true;
            received += 1;
            this.onMessage(message, { topic, history: true });
            return received >= this.storeMessageLimit;
          },
          {
            timeStart,
            timeEnd,
            paginationForward: true,
            paginationLimit: Math.min(this.storePageSize, this.storeMessageLimit - received),
            includeData: true,
          }
        );
      }
      this.historySync = { attempted: true, received, completedAt: this.now() };
      await this.refreshPeerDiagnostics();
      this.emit("historySynced", this.historySync);
      return this.historySync;
    } catch (error) {
      this.historySync = { attempted: true, received, failedAt: this.now(), error: error.message };
      this.setState("degraded_store", error.message);
      return this.historySync;
    }
  }

  async ensureConnected({ force = false, watchdog = false } = {}) {
    if (!watchdog) this.reconnectDesired = true;
    if (this.reconnectInFlight) return this.reconnectInFlight;
    this.reconnectInFlight = (async () => {
      if (!force && this.started && this.node) {
        try {
          await this.refreshPeerDiagnostics();
          if (
            this.protocolCounts.lightPush >= this.minimumPeerCount &&
            this.protocolCounts.filter >= this.minimumPeerCount
          ) {
            this.historyCatchUp = this.catchUp();
            return { restarted: false, status: this.status() };
          }
        } catch (_) {}
      }
      await this.close({ preserveReconnect: true });
      if (!this.reconnectDesired) return { restarted: false, status: this.status() };
      await this.start({ reconnect: true });
      return { restarted: true, status: this.status() };
    })().finally(() => {
      this.reconnectInFlight = null;
    });
    return this.reconnectInFlight;
  }

  async close({ preserveReconnect = false } = {}) {
    if (!preserveReconnect) {
      this.reconnectDesired = false;
      this.stopReconnectWatchdog();
    }
    if (!this.node) {
      this.started = false;
      this.setState("offline");
      return;
    }
    for (const decoder of this.decoders.values()) {
      await this.node.filter.unsubscribe(decoder).catch(() => false);
    }
    await this.node.stop();
    this.node = null;
    this.encoders.clear();
    this.decoders.clear();
    this.started = false;
    this.connectedPeers = [];
    this.protocolCounts = { lightPush: 0, filter: 0, store: 0, relay: 0 };
    this.setState("offline");
  }
}

module.exports = {
  DEFAULT_FX_RECONNECT_BACKOFF_MAX_MS,
  DEFAULT_FX_RECONNECT_POLL_MS,
  DEFAULT_FX_STORE_HISTORY_MS,
  DEFAULT_FX_STORE_MESSAGE_LIMIT,
  DEFAULT_FX_WAKU_SHARD_COUNT,
  FX_WAKU_TOPIC_VERSION,
  FxWakuTransport,
  createFxContentTopics,
  fxTradeShard,
  normalizeDeploymentId,
};
