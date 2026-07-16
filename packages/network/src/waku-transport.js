const { EventEmitter } = require("events");
const { getAddress, isAddress } = require("ethers");
const { createRainContentTopic, verifyRainBatch } = require("./rain-protocol");

const WAKU_TOPIC_VERSION = 1;
const DEFAULT_WAKU_CLUSTER_ID = 66;
const DEFAULT_WAKU_SHARD_COUNT = 8;
const DEFAULT_WAKU_STORE_HISTORY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WAKU_STORE_MESSAGE_LIMIT = 256;
const DEFAULT_WAKU_STORE_PAGE_SIZE = 64;
const WAKU_ARTIFACT_KIND = "versus-artifact";
const WAKU_ARTIFACT_VERSION = 1;

class WakuTopicError extends Error {
  constructor(message) {
    super(message);
    this.name = "WakuTopicError";
    this.code = "WRONG_LAUNCH_TOPIC";
  }
}

function normalizeLaunchId(value) {
  const launch = String(value);
  if (!/^\d{1,78}$/.test(launch)) throw new TypeError("launchId must be an unsigned integer");
  return BigInt(launch).toString();
}

function normalizeTopicScope(value = "") {
  const scope = String(value || "");
  if (scope && !/^[a-z0-9-]{1,32}$/.test(scope)) {
    throw new TypeError("topic scope must contain 1 to 32 lowercase letters numbers or hyphens");
  }
  return scope;
}

function createVersusContentTopic({ chainId, contractAddress, launchId, topicScope = "" }) {
  const chain = String(chainId);
  const launch = normalizeLaunchId(launchId);
  if (!/^\d{1,20}$/.test(chain)) throw new TypeError("chainId must be an unsigned integer");
  if (typeof contractAddress !== "string" || !isAddress(contractAddress)) {
    throw new TypeError("contractAddress must be an ethereum address");
  }
  const contract = getAddress(contractAddress).slice(2).toLowerCase();
  const scope = normalizeTopicScope(topicScope);
  return `/versus/${WAKU_TOPIC_VERSION}/postcards-${chain}-${contract}-${launch}${scope ? `-${scope}` : ""}/json`;
}

class WakuPostcardTransport extends EventEmitter {
  constructor({
    chainId,
    contractAddress,
    arenaAddress = null,
    trustedRainAttestors = [],
    launchId,
    topicScope = "",
    bootstrapPeers = [],
    defaultBootstrap = bootstrapPeers.length === 0,
    clusterId = DEFAULT_WAKU_CLUSTER_ID,
    numShardsInCluster = DEFAULT_WAKU_SHARD_COUNT,
    peerTimeoutMs = 20_000,
    minimumPeerCount = 1,
    maxPayloadBytes = 16_384,
    enableStore = true,
    storeHistoryMs = DEFAULT_WAKU_STORE_HISTORY_MS,
    storeMessageLimit = DEFAULT_WAKU_STORE_MESSAGE_LIMIT,
    storePageSize = DEFAULT_WAKU_STORE_PAGE_SIZE,
    sdkLoader = () => import("@waku/sdk"),
    nodeFactory = null,
    allowInsecureWebSockets = false,
    now = () => Date.now(),
  }) {
    super();
    if (!Number.isInteger(storeHistoryMs) || storeHistoryMs < 0) {
      throw new RangeError("storeHistoryMs must be a nonnegative integer");
    }
    if (!Number.isInteger(storeMessageLimit) || storeMessageLimit < 1 || storeMessageLimit > 10_000) {
      throw new RangeError("storeMessageLimit must be between 1 and 10000");
    }
    if (!Number.isInteger(storePageSize) || storePageSize < 1 || storePageSize > storeMessageLimit) {
      throw new RangeError("storePageSize must be between 1 and storeMessageLimit");
    }
    if (!Number.isInteger(minimumPeerCount) || minimumPeerCount < 1 || minimumPeerCount > 32) {
      throw new RangeError("minimumPeerCount must be between 1 and 32");
    }
    this.connectionless = true;
    this.handlesPropagation = true;
    this.chainId = String(chainId);
    this.contractAddress = getAddress(contractAddress);
    this.arenaAddress = arenaAddress ? getAddress(arenaAddress) : null;
    this.trustedRainAttestors = Array.from(trustedRainAttestors, getAddress);
    if ((this.arenaAddress === null) !== (this.trustedRainAttestors.length === 0)) {
      throw new TypeError("Arena address and trusted rain attestors must be configured together");
    }
    this.launchId = normalizeLaunchId(launchId);
    this.topicScope = normalizeTopicScope(topicScope);
    this.contentTopic = createVersusContentTopic({
      chainId: this.chainId,
      contractAddress: this.contractAddress,
      launchId: this.launchId,
      topicScope: this.topicScope,
    });
    this.rainContentTopic = this.arenaAddress
      ? createRainContentTopic({ chainId: this.chainId, arenaAddress: this.arenaAddress })
      : null;
    this.bootstrapPeers = [...bootstrapPeers];
    this.defaultBootstrap = defaultBootstrap;
    this.clusterId = clusterId;
    this.numShardsInCluster = numShardsInCluster;
    this.peerTimeoutMs = peerTimeoutMs;
    this.minimumPeerCount = minimumPeerCount;
    this.maxPayloadBytes = maxPayloadBytes;
    this.enableStore = Boolean(enableStore);
    this.storeHistoryMs = storeHistoryMs;
    this.storeMessageLimit = storeMessageLimit;
    this.storePageSize = storePageSize;
    this.sdkLoader = sdkLoader;
    this.nodeFactory = nodeFactory;
    this.allowInsecureWebSockets = Boolean(allowInsecureWebSockets);
    this.now = now;
    this.node = null;
    this.encoder = null;
    this.decoder = null;
    this.rainDecoder = null;
    this.subscription = null;
    this.rainSubscription = null;
    this.started = false;
    this.connectedPeerCount = 0;
    this.connectedPeers = [];
    this.protocolCounts = { lightPush: 0, filter: 0, store: 0, relay: 0 };
    this.storeCatchUp = null;
    this.launchSwitch = Promise.resolve();
    this.lastHistorySync = null;
    this.connectionState = "offline";
    this.connectionStateChangedAt = Date.now();
    this.connectionError = null;
    this.peerRefreshTimer = null;
    this.onPeerTopologyChange = () => {
      this.setConnectionState("reconnecting");
      clearTimeout(this.peerRefreshTimer);
      this.peerRefreshTimer = setTimeout(() => {
        this.refreshPeerDiagnostics().catch((error) => {
          this.connectionError = error.message;
          this.setConnectionState("reconnecting");
        });
      }, 150);
      this.peerRefreshTimer.unref?.();
    };
  }

  setConnectionState(state, error = null) {
    const changed = this.connectionState !== state;
    if (changed) this.connectionStateChangedAt = Date.now();
    this.connectionState = state;
    this.connectionError = error ? String(error) : null;
    if (changed) this.emit("state", this.status());
    return state;
  }

  classifyConnectionState() {
    if (!this.started) return this.connectionState === "reconnecting" ? "reconnecting" : "offline";
    if (this.protocolCounts.lightPush < 1 || this.protocolCounts.filter < 1) return "reconnecting";
    if (!this.enableStore || this.protocolCounts.store < 1 || this.lastHistorySync?.error) return "degraded_store";
    if (this.lastHistorySync?.completedAt) return "caught_up";
    return "reconnecting";
  }

  status() {
    return {
      transport: "waku",
      state: this.connectionState,
      changedAt: this.connectionStateChangedAt,
      health: this.node?.health ? String(this.node.health) : null,
      peerCount: this.connectedPeerCount,
      protocolCounts: { ...this.protocolCounts },
      storeEnabled: this.enableStore,
      historySync: this.lastHistorySync,
      error: this.connectionError,
    };
  }

  async listen() {
    await this.start();
    return {
      transport: "waku",
      contentTopic: this.contentTopic,
      peerCount: this.connectedPeerCount,
      peers: this.connectedPeers,
      protocolCounts: this.protocolCounts,
    };
  }

  async refreshPeerDiagnostics() {
    const peers = await this.node.getConnectedPeers();
    this.connectedPeers = peers.map((peer) => {
      const protocols = Array.from(peer?.protocols || [], (value) => String(value)).sort();
      return {
        id: peer?.id?.toString?.() || String(peer?.id || "unknown"),
        protocols: protocols.filter((protocol) => protocol.includes("waku")),
      };
    });
    this.connectedPeerCount = this.connectedPeers.length;
    const count = (needle) => this.connectedPeers.filter((peer) =>
      peer.protocols.some((protocol) => protocol.toLowerCase().includes(needle))
    ).length;
    this.protocolCounts = {
      lightPush: count("lightpush"),
      filter: count("filter"),
      store: count("store"),
      relay: count("relay"),
    };
    this.setConnectionState(this.classifyConnectionState(), this.lastHistorySync?.error || null);
    return { peerCount: this.connectedPeerCount, peers: this.connectedPeers, protocolCounts: this.protocolCounts };
  }

  async start() {
    if (this.started) return;
    this.setConnectionState("reconnecting");
    try {
      const sdk = await this.sdkLoader();
      const createNode = this.nodeFactory || sdk.createLightNode;
      this.node = await createNode({
        autoStart: true,
        defaultBootstrap: this.defaultBootstrap,
        bootstrapPeers: this.bootstrapPeers,
        userAgent: "versus-network/0.1",
        networkConfig: {
          clusterId: this.clusterId,
          numShardsInCluster: this.numShardsInCluster,
        },
        ...(this.allowInsecureWebSockets ? {
          libp2p: { filterMultiaddrs: false },
        } : {}),
      });
      this.node.libp2p?.addEventListener?.("peer:connect", this.onPeerTopologyChange);
      this.node.libp2p?.addEventListener?.("peer:identify", this.onPeerTopologyChange);
      this.node.libp2p?.addEventListener?.("peer:disconnect", this.onPeerTopologyChange);
      await this.node.waitForPeers([sdk.Protocols.LightPush, sdk.Protocols.Filter], this.peerTimeoutMs);
      const peerDeadline = Date.now() + this.peerTimeoutMs;
      while (true) {
        await this.refreshPeerDiagnostics();
        if (
          this.protocolCounts.lightPush >= this.minimumPeerCount &&
          this.protocolCounts.filter >= this.minimumPeerCount
        ) break;
        if (Date.now() >= peerDeadline) {
          throw new Error(`Waku needs ${this.minimumPeerCount} LightPush and Filter peers but found ${this.protocolCounts.lightPush}/${this.protocolCounts.filter}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      this.encoder = this.node.createEncoder({ contentTopic: this.contentTopic, ephemeral: false });
      this.decoder = this.node.createDecoder({ contentTopic: this.contentTopic });
      this.rainDecoder = this.rainContentTopic
        ? this.node.createDecoder({ contentTopic: this.rainContentTopic })
        : null;
      const subscribedContentTopic = this.contentTopic;
      const subscribedLaunchId = this.launchId;
      const subscribed = await this.node.filter.subscribe(this.decoder, (message) => {
        this.onMessage(message, {
          contentTopic: subscribedContentTopic,
          launchId: subscribedLaunchId,
        });
      });
      if (!subscribed) throw new Error("Waku Filter subscription was rejected");
      this.subscription = true;
      if (this.rainDecoder) {
        const rainSubscribed = await this.node.filter.subscribe(this.rainDecoder, (message) => {
          this.onRainMessage(message, { contentTopic: this.rainContentTopic });
        });
        if (!rainSubscribed) throw new Error("Waku verified rain subscription was rejected");
        this.rainSubscription = true;
      }
      this.started = true;
      this.setConnectionState(this.classifyConnectionState());
      this.emit("ready", { contentTopic: this.contentTopic, peerCount: this.connectedPeerCount });
      this.storeCatchUp = this.catchUp();
      if (this.rainDecoder) this.rainStoreCatchUp = this.catchUpRain();
    } catch (error) {
      this.setConnectionState("offline", error.message);
      throw error;
    }
  }

  onRainMessage(message, { history = false, contentTopic = this.rainContentTopic } = {}) {
    try {
      if (!this.rainContentTopic || contentTopic !== this.rainContentTopic) return false;
      const payload = message?.payload;
      if (!(payload instanceof Uint8Array)) throw new Error("Waku rain message has no byte payload");
      if (payload.byteLength > this.maxPayloadBytes) throw new Error("Waku rain payload is too large");
      const envelope = JSON.parse(new TextDecoder().decode(payload));
      const verified = verifyRainBatch(envelope, {
        chainId: this.chainId,
        arenaAddress: this.arenaAddress,
        trustedAttestors: this.trustedRainAttestors,
      });
      this.emit("rainBatch", verified, {
        transport: "waku",
        hash: message.hashStr || null,
        contentTopic,
        history,
      });
      return true;
    } catch (error) {
      this.emit("rainRejected", error);
      return false;
    }
  }

  onMessage(message, { history = false, contentTopic = this.contentTopic, launchId = this.launchId } = {}) {
    try {
      if (launchId !== this.launchId || contentTopic !== this.contentTopic) return false;
      const payload = message?.payload;
      if (!(payload instanceof Uint8Array)) throw new Error("Waku message has no byte payload");
      if (payload.byteLength > this.maxPayloadBytes) throw new Error("Waku postcard payload is too large");
      let postcard = JSON.parse(new TextDecoder().decode(payload));
      if (postcard?.kind === WAKU_ARTIFACT_KIND) {
        if (
          postcard.version !== WAKU_ARTIFACT_VERSION ||
          String(postcard.launchId) !== this.launchId ||
          typeof postcard.reference !== "string" ||
          !/^versus:sha256:[0-9a-f]{64}$/.test(postcard.reference)
        ) {
          throw new Error("Waku artifact envelope is invalid");
        }
        this.emit(
          "artifact",
          { reference: postcard.reference, value: postcard.value },
          {
            transport: "waku",
            hash: message.hashStr || null,
            contentTopic,
            history,
          }
        );
        return true;
      }
      const paidEnvelope = postcard?.kind === "versus-paid-postcard" && Number(postcard.version) === 1;
      const paymentProof = paidEnvelope ? postcard.paymentProof : null;
      if (paidEnvelope) postcard = postcard.postcard;
      this.validatePostcard(postcard);
      this.emit("postcard", postcard, {
        transport: "waku",
        hash: message.hashStr || null,
        contentTopic,
        history,
      }, paymentProof);
      return true;
    } catch (error) {
      this.emit("peerError", error, null);
      return false;
    }
  }

  validatePostcard(postcard) {
    if (String(postcard?.launchId) !== this.launchId) {
      throw new WakuTopicError(
        `postcard launch ${postcard?.launchId ?? "missing"} does not match Waku topic launch ${this.launchId}`
      );
    }
    return true;
  }

  async broadcast(postcard, { paymentProof = null } = {}) {
    await this.start();
    await this.launchSwitch;
    this.validatePostcard(postcard);
    return this.push(paymentProof ? {
      kind: "versus-paid-postcard",
      version: 1,
      postcard,
      paymentProof,
    } : postcard);
  }

  async broadcastArtifact(reference, value) {
    await this.start();
    await this.launchSwitch;
    if (typeof reference !== "string" || !/^versus:sha256:[0-9a-f]{64}$/.test(reference)) {
      throw new TypeError("artifact reference must use versus sha256");
    }
    return this.push({
      kind: WAKU_ARTIFACT_KIND,
      version: WAKU_ARTIFACT_VERSION,
      launchId: this.launchId,
      reference,
      value,
    });
  }

  async push(value) {
    const startedAt = Date.now();
    const payload = new TextEncoder().encode(JSON.stringify(value));
    if (payload.byteLength > this.maxPayloadBytes) throw new RangeError("Waku postcard payload is too large");
    const message = {
      payload,
      timestamp: new Date(this.now()),
    };
    let protocol = "v3";
    let result = await this.node.lightPush.send(this.encoder, message, { autoRetry: false });
    const v3Rejected = result?.successes?.length === 0 &&
      result?.failures?.length > 0 &&
      result.failures.every((failure) => failure.error === "Remote peer rejected");
    const hasLegacyPeer = this.connectedPeers.some((peer) =>
      peer.protocols.some((candidate) => candidate.includes("/vac/waku/lightpush/2."))
    );
    if (v3Rejected && hasLegacyPeer) {
      const legacyResult = await this.node.lightPush.send(this.encoder, message, {
        autoRetry: false,
        useLegacy: true,
      });
      this.emit("protocolFallback", {
        from: "v3",
        to: "v2",
        v3FailureCount: result.failures.length,
        v2SuccessCount: legacyResult?.successes?.length || 0,
        v2FailureCount: legacyResult?.failures?.length || 0,
      });
      result = legacyResult;
      protocol = "v2";
    }
    if (!result || !Array.isArray(result.successes) || result.successes.length === 0) {
      const reason = result?.failures?.map((failure) => failure.error).join(", ") || "no relay accepted it";
      throw new Error(`Waku LightPush failed: ${reason}`);
    }
    this.emit("published", {
      postcardId: value?.postcard?.id || value?.id || null,
      startedAt,
      completedAt: Date.now(),
      protocol,
      successCount: result.successes.length,
      failureCount: Array.isArray(result.failures) ? result.failures.length : 0,
    });
    return result;
  }

  async catchUp() {
    if (!this.enableStore || this.storeHistoryMs === 0 || !this.node?.store?.queryWithOrderedCallback) {
      const result = { attempted: false, received: 0, error: "Waku Store is unavailable" };
      this.lastHistorySync = result;
      this.setConnectionState("degraded_store", result.error);
      return result;
    }
    const launchId = this.launchId;
    const contentTopic = this.contentTopic;
    const decoder = this.decoder;
    const timeEnd = new Date(this.now());
    const timeStart = new Date(timeEnd.getTime() - this.storeHistoryMs);
    let received = 0;
    try {
      await this.node.store.queryWithOrderedCallback(
        [decoder],
        (message) => {
          if (launchId !== this.launchId || contentTopic !== this.contentTopic) return true;
          if (received >= this.storeMessageLimit) return true;
          received += 1;
          this.onMessage(message, { history: true, contentTopic, launchId });
          return received >= this.storeMessageLimit;
        },
        {
          timeStart,
          timeEnd,
          paginationForward: true,
          paginationLimit: this.storePageSize,
          includeData: true,
        }
      );
      this.lastHistorySync = { launchId, contentTopic, received, completedAt: Date.now() };
      this.setConnectionState(this.classifyConnectionState());
      this.emit("historySynced", this.lastHistorySync);
      return { attempted: true, received };
    } catch (error) {
      const result = { launchId, contentTopic, received, failedAt: Date.now(), error: error.message };
      this.lastHistorySync = result;
      this.setConnectionState("degraded_store", error.message);
      this.emit("peerError", error, null);
      return result;
    }
  }

  async catchUpRain() {
    if (!this.enableStore || !this.rainDecoder || !this.node?.store?.queryWithOrderedCallback) {
      return { attempted: false, received: 0, error: "Waku verified rain Store is unavailable" };
    }
    const decoder = this.rainDecoder;
    const contentTopic = this.rainContentTopic;
    const timeEnd = new Date(this.now());
    const timeStart = new Date(timeEnd.getTime() - this.storeHistoryMs);
    let received = 0;
    try {
      await this.node.store.queryWithOrderedCallback(
        [decoder],
        (message) => {
          if (received >= this.storeMessageLimit) return true;
          received += 1;
          this.onRainMessage(message, { history: true, contentTopic });
          return received >= this.storeMessageLimit;
        },
        { timeStart, timeEnd, paginationForward: true, paginationLimit: this.storePageSize, includeData: true }
      );
      return { attempted: true, received };
    } catch (error) {
      this.emit("rainRejected", error);
      return { attempted: true, received, error: error.message };
    }
  }

  switchLaunch(launchId) {
    const nextLaunchId = normalizeLaunchId(launchId);
    const operation = this.launchSwitch.catch(() => {}).then(() => this.applyLaunch(nextLaunchId));
    this.launchSwitch = operation;
    return operation;
  }

  async applyLaunch(nextLaunchId) {
    if (nextLaunchId === this.launchId) {
      return { changed: false, launchId: this.launchId, contentTopic: this.contentTopic };
    }
    const nextContentTopic = createVersusContentTopic({
      chainId: this.chainId,
      contractAddress: this.contractAddress,
      launchId: nextLaunchId,
      topicScope: this.topicScope,
    });
    if (!this.started) {
      this.launchId = nextLaunchId;
      this.contentTopic = nextContentTopic;
      return { changed: true, launchId: this.launchId, contentTopic: this.contentTopic };
    }

    const previousDecoder = this.decoder;
    const nextEncoder = this.node.createEncoder({ contentTopic: nextContentTopic, ephemeral: false });
    const nextDecoder = this.node.createDecoder({ contentTopic: nextContentTopic });
    const subscribed = await this.node.filter.subscribe(nextDecoder, (message) => {
      this.onMessage(message, { contentTopic: nextContentTopic, launchId: nextLaunchId });
    });
    if (!subscribed) throw new Error("Waku Filter launch rollover subscription was rejected");

    this.launchId = nextLaunchId;
    this.contentTopic = nextContentTopic;
    this.encoder = nextEncoder;
    this.decoder = nextDecoder;
    if (previousDecoder) {
      await this.node.filter.unsubscribe(previousDecoder).catch((error) => {
        this.emit("peerError", error, null);
      });
    }
    this.storeCatchUp = this.catchUp();
    const result = { changed: true, launchId: this.launchId, contentTopic: this.contentTopic };
    this.emit("launchChanged", result);
    return result;
  }

  async connect(peer) {
    await this.start();
    await this.node.dial(peer);
    await this.refreshPeerDiagnostics();
    return { transport: "waku", peer, peerCount: this.connectedPeerCount };
  }

  get peerCount() {
    return this.connectedPeerCount;
  }

  peerList() {
    return this.connectedPeers;
  }

  async close() {
    await this.launchSwitch.catch(() => {});
    if (!this.node) return;
    clearTimeout(this.peerRefreshTimer);
    this.peerRefreshTimer = null;
    this.node.libp2p?.removeEventListener?.("peer:connect", this.onPeerTopologyChange);
    this.node.libp2p?.removeEventListener?.("peer:identify", this.onPeerTopologyChange);
    this.node.libp2p?.removeEventListener?.("peer:disconnect", this.onPeerTopologyChange);
    if (this.subscription && this.decoder) {
      await this.node.filter.unsubscribe(this.decoder).catch(() => false);
    }
    if (this.rainSubscription && this.rainDecoder) {
      await this.node.filter.unsubscribe(this.rainDecoder).catch(() => false);
    }
    await this.node.stop();
    this.started = false;
    this.subscription = null;
    this.rainSubscription = null;
    this.node = null;
    this.connectedPeerCount = 0;
    this.connectedPeers = [];
    this.protocolCounts = { lightPush: 0, filter: 0, store: 0, relay: 0 };
    this.rainDecoder = null;
    this.storeCatchUp = null;
    this.setConnectionState("offline");
  }
}

module.exports = {
  DEFAULT_WAKU_STORE_HISTORY_MS,
  DEFAULT_WAKU_STORE_MESSAGE_LIMIT,
  DEFAULT_WAKU_STORE_PAGE_SIZE,
  DEFAULT_WAKU_CLUSTER_ID,
  DEFAULT_WAKU_SHARD_COUNT,
  WAKU_TOPIC_VERSION,
  WAKU_ARTIFACT_KIND,
  WAKU_ARTIFACT_VERSION,
  WakuPostcardTransport,
  WakuTopicError,
  createVersusContentTopic,
  normalizeLaunchId,
  normalizeTopicScope,
};
