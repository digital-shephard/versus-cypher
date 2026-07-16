const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Contract, JsonRpcProvider, Wallet } = require("ethers");
const {
  ArtifactStore,
  CypherAgentRuntime,
  ContractEconomicVerifier,
  ContractCypherVerifier,
  CypherLocalDatabase,
  CypherIdentity,
  RatePolicy,
  SignalSettlementQueue,
  TcpMeshTransport,
  TrustGraph,
  VersusNode,
  WakuPostcardTransport,
} = require("@versus/network");
const { createAgentBrain, loadAgentBrainConfig, publicBrainConfig } = require("./brain");
const { ReferralDriveSlot, referralDriveThought } = require("./referral-drive-slot");
const { referralCodeFor } = require("./referrals");
const { ThoughtQueue } = require("./thought-queue");
const { BASE_CHAIN_ID, createBaseProvider } = require("./base-rpc");

const CURRENT_CLASS_ABI = ["function currentClassId() view returns (uint256)"];
const DEFAULT_WAKU_BOOTSTRAP_PEERS = [
  "/dns4/relay-a.versuscypher.com/tcp/443/wss/p2p/16Uiu2HAmCQArrt8ND7sTzPCg76YmQPab7HKjSrVZeyeTVZdQyPWy",
  "/dns4/relay-b.versuscypher.com/tcp/443/wss/p2p/16Uiu2HAkx96y18XpzAybpmi1zzdMQZFvsRPZfkku8R9T4KJFMr2P",
];

class NetworkEligibilityConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "NetworkEligibilityConfigurationError";
    this.code = "CYPHER_REGISTRY_NOT_CONFIGURED";
  }
}

function parsePeerUrls(value = "") {
  return String(value)
    .split(",")
    .map((peer) => peer.trim())
    .filter(Boolean);
}

function parseAddresses(value = []) {
  const entries = Array.isArray(value) ? value : String(value || "").split(",");
  return entries.map((address) => String(address).trim()).filter(Boolean);
}

class PetNetworkService {
  constructor({
    privateKey,
    agentId,
    dataDir,
    eligibilityVerifier,
    host = "127.0.0.1",
    port = 0,
    peers = [],
    transport = new TcpMeshTransport(),
    launchResolver = null,
    launchPollMs = 60_000,
    signalSettlement = null,
    economicVerifier = null,
    agentBrain = null,
    agentConfig = null,
    beforeAgentTick = null,
    onAgentAction = null,
    agentContextProvider = null,
    now = null,
  }) {
    if (!privateKey) throw new TypeError("privateKey is required");
    if (!agentId) throw new TypeError("agentId is required");
    if (!dataDir) throw new TypeError("dataDir is required");
    if (!eligibilityVerifier) throw new TypeError("eligibilityVerifier is required");
    if (launchResolver !== null && typeof launchResolver !== "function") {
      throw new TypeError("launchResolver must be a function");
    }
    if (!Number.isInteger(launchPollMs) || launchPollMs < 100 || launchPollMs > 24 * 60 * 60 * 1000) {
      throw new RangeError("launchPollMs must be between 100 and 86400000");
    }

    const identity = new CypherIdentity({ signer: new Wallet(privateKey), cypherId: agentId });
    this.localDatabase = new CypherLocalDatabase({ filePath: path.join(dataDir, "cypher.sqlite") });
    this.storageMigration = this.localDatabase.importLegacyNdjson(path.join(dataDir, "postcards.ndjson"));
    this.node = new VersusNode({
      identity,
      store: this.localDatabase,
      artifactStore: new ArtifactStore({ directory: path.join(dataDir, "artifacts") }),
      outcomeFilePath: path.join(dataDir, "outcomes.json"),
      trust: new TrustGraph({ filePath: path.join(dataDir, "trust.json") }),
      ratePolicy: new RatePolicy(),
      eligibilityVerifier,
      transport,
      economicVerifier,
      requirePaidSignals: economicVerifier !== null,
      paymentProofFilePath: path.join(dataDir, "payment-proofs.ndjson"),
      ...(now ? { now } : {}),
    });
    this.host = host;
    this.port = Number(port);
    this.seedPeers = Array.from(new Set(peers));
    this.listenAddress = null;
    this.peerErrors = [];
    this.started = false;
    this.launchResolver = launchResolver;
    this.launchPollMs = launchPollMs;
    this.launchTimer = null;
    this.maintenanceTimer = null;
    this.signalQueue = signalSettlement
      ? new SignalSettlementQueue({
          store: this.node.store,
          chainId: signalSettlement.chainId,
          arena: signalSettlement.arena,
          agentId,
          author: this.node.identity.address,
          filePath: path.join(dataDir, "signal-settlements.json"),
        })
      : null;
    for (const record of this.signalQueue?.list() || []) {
      for (const postcard of record.postcards || []) {
        this.node.reserveLocalSequence(postcard.sequence);
      }
    }
    this.economicVerifier = economicVerifier;
    this.thoughts = new ThoughtQueue({ filePath: path.join(dataDir, "thoughts.json") });
    this.referralDrive = new ReferralDriveSlot({ filePath: path.join(dataDir, "referral-drive.json") });
    const resolvedAgentConfig = agentBrain
      ? agentConfig || { mode: "custom", model: "owner supplied", autostart: false, tickIntervalMs: 86_400_000 }
      : null;
    this.agentConfig = publicBrainConfig(resolvedAgentConfig);
    this.agentAutomatic = Boolean(agentBrain && resolvedAgentConfig.autostart);
    this.agentState = {
      status: agentBrain ? "sleeping" : "off",
      lastResult: null,
      lastTickAt: null,
      lastError: null,
    };
    this.agentRuntime = agentBrain
      ? new CypherAgentRuntime({
          node: this.node,
          brain: agentBrain,
          statePath: path.join(dataDir, "agent-runtime.json"),
          launchIdResolver: () => this.node.transport.launchId,
          tickIntervalMs: resolvedAgentConfig.tickIntervalMs,
          beforeTick: beforeAgentTick,
          contextProvider: async () => ({
            ...(agentContextProvider ? await agentContextProvider() : {}),
            localMemory: this.localMemoryContext(),
          }),
          actionSink: onAgentAction ? (postcard) => onAgentAction(postcard, this) : null,
        })
      : null;
    this.agentRuntime?.on("action", () => {
      this.agentState.status = "listening";
    });
    this.agentRuntime?.on("thought", (thought, context) => {
      this.thoughts.enqueue(thought, { launchId: context.launch.id });
    });
    this.agentRuntime?.on("brainError", (error) => {
      this.agentState.status = "error";
      this.agentState.lastError = error.message;
    });

    this.node.on("peerError", (error) => this.recordPeerError(error));
    this.node.on("rejected", (error) => {
      if (error?.code !== "BLOCKED_AUTHOR") this.recordPeerError(error);
    });
  }

  recordPeerError(error) {
    this.peerErrors.push({ message: error?.message || String(error), at: Date.now() });
    this.peerErrors = this.peerErrors.slice(-10);
  }

  localMemoryContext() {
    this.refreshPeerAffinities();
    return {
      version: 1,
      derivedMemoryIsNotAuthority: true,
      likedPeers: this.localDatabase.listPeers({ limit: 9, includeBlocked: false })
        .filter((peer) => peer.address !== this.node.identity.address)
        .slice(0, 8)
        .map((peer) => ({
        address: peer.address,
        cypherId: peer.cypherId,
        ownerPinned: peer.explicitPin,
        affinity: peer.affinity,
        reasons: peer.affinityReasons,
        provenance: peer.provenance.slice(-8),
        })),
      memories: this.localDatabase.listMemories({ limit: 12 }).map((memory) => ({
        id: memory.id,
        kind: memory.kind,
        subjectType: memory.subjectType,
        subjectId: memory.subjectId,
        statement: memory.statement,
        sources: memory.sources,
        confidence: memory.confidence,
        untrustedSources: memory.untrustedSources,
      })),
    };
  }

  refreshPeerAffinities() {
    for (const peer of this.localDatabase.listPeers({ limit: 500, includeBlocked: true })) {
      if (peer.address === this.node.identity.address) continue;
      const dimensions = ["prediction", "execution", "stewardship", "integrity"];
      const values = dimensions.map((dimension) => this.node.trust.score(peer.address, dimension));
      const affinity = Math.max(
        -100,
        Math.min(100, Math.round(values.reduce((sum, value) => sum + value, 0) / values.length))
      );
      const reasons = dimensions
        .map((dimension, index) => ({ dimension, value: values[index] }))
        .filter(({ value }) => value !== 0)
        .map(({ dimension, value }) => `${dimension} ${value > 0 ? "+" : ""}${value}`);
      if (peer.affinity !== affinity || JSON.stringify(peer.affinityReasons) !== JSON.stringify(reasons)) {
        this.localDatabase.setPeerAffinity(peer.address, affinity, {
          reasons,
          provenance: peer.provenance,
        });
      }
    }
  }

  runLocalMaintenance() {
    const expiredMemories = this.localDatabase.expireMemories();
    const pruned = this.localDatabase.prune();
    return { expiredMemories, pruned, stats: this.localDatabase.stats() };
  }

  listPeerRelationships(query = {}) {
    return this.localDatabase.listPeers(query);
  }

  setPeerPreference(address, preference) {
    return this.localDatabase.setPeerPreference(address, preference);
  }

  setPeerAffinity(address, affinity, evidence) {
    return this.localDatabase.setPeerAffinity(address, affinity, evidence);
  }

  putMemory(memory) {
    return this.localDatabase.putMemory(memory);
  }

  listMemories(query = {}) {
    return this.localDatabase.listMemories(query);
  }

  exportLocalArchive() {
    return {
      localMemory: this.localDatabase.exportArchive(),
      trust: this.node.trust.toJSON(),
      thoughts: this.thoughts.items.map((item) => ({ ...item })),
      artifacts: this.node.artifactStore.entries(),
      paymentProofs: this.node.paymentProofs.entries(),
      outcomes: this.node.outcomes.list(),
    };
  }

  importLocalArchive(archive, { replace = false } = {}) {
    if (!archive?.localMemory) throw new Error("Cypher archive has no local memory");
    const result = this.localDatabase.importArchive(archive.localMemory, { replace });
    if (replace) {
      this.node.trust.peers.clear();
      this.node.trust.contributions.clear();
      this.node.trust.save();
      this.node.artifactStore.clear();
      this.node.paymentProofs.clear();
      for (const assessment of this.node.outcomes.list()) this.node.outcomes.remove(assessment.outcomeId);
    }
    if (archive.trust && typeof archive.trust === "object") {
      for (const [address, profile] of Object.entries(archive.trust.peers || {})) {
        for (const [dimension, score] of Object.entries(profile.scores || {})) {
          this.node.trust.setScore(address, dimension, score);
        }
        this.setBlocked(address, profile.blocked);
      }
      for (const [source, contribution] of Object.entries(archive.trust.contributions || {})) {
        this.node.trust.setContribution(source, contribution.address, contribution.scores);
      }
    }
    if (Array.isArray(archive.thoughts)) {
      this.thoughts.items = archive.thoughts.slice(-this.thoughts.maxItems);
      this.thoughts.save();
    }
    let artifacts = 0;
    for (const entry of archive.artifacts || []) {
      this.node.artifactStore.import(entry.reference, entry.value);
      artifacts += 1;
    }
    const paymentProofs = this.node.paymentProofs.import(archive.paymentProofs || []);
    let outcomes = 0;
    for (const assessment of archive.outcomes || []) {
      this.node.outcomes.assess(assessment);
      outcomes += 1;
    }
    return { ...result, artifacts, paymentProofs, outcomes };
  }

  async start() {
    if (this.started) return this.status();
    this.listenAddress = await this.node.listen({ host: this.host, port: this.port });
    this.started = true;
    for (const peer of this.seedPeers) {
      try {
        await this.node.connect(peer);
      } catch (error) {
        this.recordPeerError(error);
      }
    }
    if (this.launchResolver && typeof this.node.transport.switchLaunch === "function") {
      try {
        await this.refreshLaunch();
      } catch (error) {
        this.recordPeerError(error);
      }
      this.launchTimer = setInterval(() => {
        this.refreshLaunch().catch((error) => this.recordPeerError(error));
      }, this.launchPollMs);
      this.launchTimer.unref?.();
    }
    if (this.agentRuntime && this.agentAutomatic) this.agentState.status = "listening";
    this.runLocalMaintenance();
    this.maintenanceTimer = setInterval(() => {
      try { this.runLocalMaintenance(); } catch (error) { this.recordPeerError(error); }
    }, 60 * 60_000);
    this.maintenanceTimer.unref?.();
    return this.status();
  }

  async refreshLaunch() {
    if (!this.launchResolver || typeof this.node.transport.switchLaunch !== "function") {
      return { changed: false, launchId: this.node.transport.launchId || null };
    }
    const launchId = BigInt(await this.launchResolver()).toString();
    const result = await this.node.transport.switchLaunch(launchId);
    if (result.changed && this.listenAddress) {
      this.listenAddress = {
        ...this.listenAddress,
        contentTopic: result.contentTopic,
      };
    }
    return result;
  }

  async catchUpRain() {
    const transport = this.node.transport;
    if (!this.started || typeof transport?.catchUpRain !== "function") {
      return { attempted: false, received: 0 };
    }
    return transport.catchUpRain();
  }

  async connect(peerUrl) {
    await this.node.connect(peerUrl);
    return this.status();
  }

  async publish(input) {
    if (!this.started) throw new Error("network service has not started");
    return this.node.publish(input);
  }

  async prepare(input) {
    if (!this.started) throw new Error("network service has not started");
    return this.node.prepare(input);
  }

  list(query = {}) {
    return this.node.store.list(query);
  }

  coalitionView(launchId) {
    const view = this.node.coalitionView(launchId);
    const slot = this.referralDrive.sync(view.currentReferralDrive, {
      referralCode: referralCodeFor(this.node.identity.cypherId),
      launchId,
    });
    if (slot.changed && slot.current) {
      this.thoughts.enqueue(referralDriveThought(slot.current), {
        launchId,
        actionType: "referral_drive",
        slotKey: "referral-drive",
      });
    } else if (slot.changed) {
      this.thoughts.clearSlot("referral-drive");
    }
    return { ...view, currentReferralDrive: slot.current };
  }

  clusterView() {
    return this.node.clusterView();
  }

  localNeighborhood(limit = 8) {
    const launchId = this.node.transport.launchId || null;
    const own = this.node.identity.address;
    const postcards = this.node.store.list({ ...(launchId ? { launchId } : {}), limit: 500 });
    const clusters = new Map();
    for (const cluster of this.node.clusterView()) {
      for (const address of cluster.members) clusters.set(address, cluster.id);
    }
    const peers = new Map();
    for (const postcard of postcards) {
      if (postcard.author === own || this.node.trust.isBlocked(postcard.author)) continue;
      const record = peers.get(postcard.author) || {
        address: postcard.author,
        cypherId: postcard.cypherId,
        messages: 0,
        lastSeen: 0,
        stance: "neutral",
      };
      record.messages += 1;
      record.lastSeen = Math.max(record.lastSeen, postcard.createdAt);
      if (postcard.type === "endorsement") record.stance = "support";
      if (postcard.type === "critique") record.stance = "dissent";
      peers.set(postcard.author, record);
    }
    return Array.from(peers.values())
      .sort((left, right) => right.lastSeen - left.lastSeen || right.messages - left.messages)
      .slice(0, Math.max(1, Math.min(8, Number(limit))))
      .map((peer) => {
        const digest = crypto.createHash("sha256").update(peer.address).digest();
        const angle = (digest.readUInt16BE(0) / 65535) * Math.PI * 2;
        const attention = this.node.trust.attentionWeight(peer.address);
        const distance = Math.max(34, 67 - Math.min(18, peer.messages * 3) - (attention - 1) * 10);
        return {
          ...peer,
          x: Number((90 + Math.cos(angle) * distance).toFixed(2)),
          y: Number((57 + Math.sin(angle) * distance * 0.68).toFixed(2)),
          radius: Number(Math.max(3.5, Math.min(7.5, 4.5 * attention)).toFixed(2)),
          attention: Number(attention.toFixed(2)),
          clusterId: clusters.get(peer.address) || null,
        };
      });
  }

  publishMission(input) {
    if (!this.started) throw new Error("network service has not started");
    return this.node.publishMission(input);
  }

  prepareMission(input) {
    if (!this.started) throw new Error("network service has not started");
    return this.node.prepareMission(input);
  }

  publishOutcome(input) {
    if (!this.started) throw new Error("network service has not started");
    return this.node.publishOutcome(input);
  }

  prepareOutcome(input) {
    if (!this.started) throw new Error("network service has not started");
    return this.node.prepareOutcome(input);
  }

  assessOutcome(input) {
    return this.node.assessOutcome(input);
  }

  listOutcomeAssessments() {
    return this.node.outcomes.list();
  }

  getArtifact(reference) {
    return this.node.artifactStore.get(reference);
  }

  prepareSignalBatch(launchId, limit) {
    if (!this.signalQueue) throw new Error("signal settlement is not configured");
    return this.signalQueue.prepare(launchId, limit);
  }

  prepareSignalPostcards(postcards, launchId = null) {
    if (!this.signalQueue) throw new Error("signal settlement is not configured");
    launchId = String(launchId || postcards?.[0]?.launchId || "0");
    return this.signalQueue.preparePostcards(postcards, launchId);
  }

  markSignalBatchSubmitted(root, transactionHash) {
    if (!this.signalQueue) throw new Error("signal settlement is not configured");
    return this.signalQueue.markSubmitted(root, transactionHash);
  }

  confirmSignalBatch(root, receipt) {
    if (!this.signalQueue) throw new Error("signal settlement is not configured");
    return this.signalQueue.confirm(root, receipt);
  }

  failSignalBatch(root, reason) {
    if (!this.signalQueue) throw new Error("signal settlement is not configured");
    return this.signalQueue.fail(root, reason);
  }

  listSignalBatches() {
    return this.signalQueue ? this.signalQueue.list() : [];
  }

  submittedSignalBatches() {
    return this.signalQueue ? this.signalQueue.submitted() : [];
  }

  unpublishedSignalBatches() {
    return this.signalQueue ? this.signalQueue.unpublishedConfirmed() : [];
  }

  agentStatus() {
    return { ...this.agentConfig, ...this.agentState, unseenThoughts: this.thoughts.unseenCount() };
  }

  nextThought() {
    return this.thoughts.next();
  }

  markThoughtShowing(id) {
    return this.thoughts.markShowing(id);
  }

  markThoughtSeen(id) {
    return this.thoughts.markSeen(id);
  }

  async runAgentTick() {
    if (!this.agentRuntime) throw new Error("no owner supplied Cypher brain is configured");
    this.agentState.status = "thinking";
    this.agentState.lastError = null;
    try {
      const result = await this.agentRuntime.runTick({ force: true });
      this.agentState.lastResult = result.status;
      this.agentState.lastTickAt = Date.now();
      this.agentState.status = this.agentAutomatic ? "listening" : "sleeping";
      if (result.error) this.agentState.lastError = result.error.message;
      return { result, status: this.agentStatus() };
    } catch (error) {
      this.agentState.status = "error";
      this.agentState.lastError = error.message;
      throw error;
    }
  }

  async runDailyAgentTick(dailyCycle) {
    if (!this.agentRuntime) return { status: "brain_off" };
    if (!this.agentAutomatic) return { status: "brain_off" };
    this.agentState.status = "thinking";
    this.agentState.lastError = null;
    try {
      const result = await this.agentRuntime.runTick({ daily: true, dailyCycle });
      this.agentState.lastResult = result.status;
      this.agentState.lastTickAt = Date.now();
      this.agentState.status = this.agentAutomatic ? "listening" : "sleeping";
      if (result.error) this.agentState.lastError = result.error.message;
      return result;
    } catch (error) {
      this.agentState.status = "error";
      this.agentState.lastError = error.message;
      throw error;
    }
  }

  async startAgent() {
    if (!this.agentRuntime) throw new Error("no owner supplied Cypher brain is configured");
    this.agentAutomatic = true;
    this.agentState.status = "listening";
    return this.agentStatus();
  }

  stopAgent() {
    this.agentAutomatic = false;
    this.agentRuntime?.stop();
    if (this.agentRuntime) this.agentState.status = "sleeping";
    return this.agentStatus();
  }

  publishSignalSettlement(record) {
    return this.node.publishSignalSettlement(record);
  }

  async publishPaidBatch(record) {
    if (!record || record.status !== "confirmed") throw new Error("signal batch is not confirmed");
    const paymentProof = {
      kind: "versus-signal-settlement",
      version: 1,
      batch: record.batch,
      transactionHash: record.transactionHash,
      blockNumber: record.blockNumber,
    };
    const published = [];
    for (const postcard of record.postcards || []) {
      if (record.publishedIds?.includes(postcard.id)) continue;
      published.push(await this.node.publishPaid(postcard, paymentProof));
      record = this.signalQueue.markPublished(record.batch.root, postcard.id);
    }
    return published;
  }

  async stagePaidBatch(record) {
    if (!record || record.status !== "confirmed") throw new Error("signal batch is not confirmed");
    const paymentProof = {
      kind: "versus-signal-settlement",
      version: 1,
      batch: record.batch,
      transactionHash: record.transactionHash,
      blockNumber: record.blockNumber,
    };
    const staged = [];
    for (const postcard of record.postcards || []) {
      staged.push(await this.node.stagePaid(postcard, paymentProof));
    }
    return staged;
  }

  publishMissionSponsorship(input) {
    return this.node.publishMissionSponsorship(input);
  }

  missionForSponsorship(missionId) {
    const mission = this.node.store.get(missionId);
    if (!mission || mission.type !== "mission") throw new Error("mission postcard is unknown");
    const manifest = mission.artifact ? this.node.artifactStore.get(mission.artifact) : null;
    if (!manifest) throw new Error("mission manifest is unavailable");
    return {
      missionId: mission.id,
      launchId: mission.launchId,
      recipientAgentId: mission.cypherId,
      declaredBudgetMicros: manifest.budgetMicros,
      manifest,
    };
  }

  async verifyEconomicProof(reference) {
    if (!this.economicVerifier) throw new Error("economic proof verification is not configured");
    const value = this.getArtifact(reference);
    if (!value) throw new Error("economic proof artifact is unavailable");
    if (value.kind === "versus-signal-settlement") {
      return this.economicVerifier.verifySignalSettlement(value);
    }
    if (value.kind === "versus-mission-sponsorship") {
      const result = await this.economicVerifier.verifyMissionSponsorship(value);
      return { ...result, reputation: this.node.recordVerifiedEconomicProof(result) };
    }
    throw new Error("artifact is not an economic proof");
  }

  setBlocked(address, blocked) {
    const result = this.node.trust.setBlocked(address, blocked);
    if (this.localDatabase.peerProfile(address)) {
      this.localDatabase.setPeerPreference(address, { blocked });
    }
    return result;
  }

  setTrustScore(address, dimension, score) {
    return this.node.trust.setScore(address, dimension, score);
  }

  status() {
    return {
      active: this.started,
      address: this.node.identity.address,
      cypherId: this.node.identity.cypherId,
      listen: this.listenAddress,
      peerCount: this.node.peerCount,
      peers: this.node.peerList(),
      neighborhood: this.localNeighborhood(),
      postcardCount: this.node.store.size,
      launchId: this.node.transport.launchId || null,
      contentTopic: this.node.transport.contentTopic || null,
      historySync: this.node.transport.lastHistorySync || null,
      transportStatus: typeof this.node.transport.status === "function"
        ? this.node.transport.status()
        : null,
      artifactCount: this.node.artifactStore.size,
      outcomeAssessmentCount: this.node.outcomes.list().length,
      signalBatchCount: this.signalQueue?.list().length || 0,
      agent: this.agentStatus(),
      peerErrors: [...this.peerErrors],
      localDatabase: this.localDatabase.stats(),
      storageMigration: this.storageMigration,
    };
  }

  async close() {
    this.started = false;
    this.agentRuntime?.stop();
    if (this.launchTimer) clearInterval(this.launchTimer);
    this.launchTimer = null;
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
    await this.node.close();
    this.localDatabase.close();
  }
}

function createContractEligibilityVerifier(env = process.env) {
  return loadCypherRegistryConfig(env).eligibilityVerifier;
}

function loadCypherRegistryConfig(env = process.env) {
  const rpcUrl = env.VERSUS_RPC_URL;
  const deploymentPath = env.VERSUS_DEPLOYMENT;
  if (!deploymentPath) {
    throw new NetworkEligibilityConfigurationError(
      "VERSUS_DEPLOYMENT is required before the agent network can accept messages"
    );
  }
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  const contractAddress = deployment.contracts?.agents;
  const arenaAddress = deployment.contracts?.arena;
  if (!deployment.chainId || !contractAddress || !arenaAddress) {
    throw new NetworkEligibilityConfigurationError(
      "deployment must contain chainId and the AgentNFT and Arena contract addresses"
    );
  }
  const cacheTtlMs = Number(env.VERSUS_CYPHER_OWNER_CACHE_MS || 0);
  if (!Number.isFinite(cacheTtlMs) || cacheTtlMs < 0 || cacheTtlMs > 60_000) {
    throw new RangeError("VERSUS_CYPHER_OWNER_CACHE_MS must be between 0 and 60000");
  }
  let provider;
  if (Number(deployment.chainId) === BASE_CHAIN_ID) {
    provider = createBaseProvider(env);
  } else {
    if (!rpcUrl) {
      throw new NetworkEligibilityConfigurationError("non-Base deployments require VERSUS_RPC_URL");
    }
    provider = new JsonRpcProvider(rpcUrl, Number(deployment.chainId), { staticNetwork: true });
  }
  const eligibilityVerifier = new ContractCypherVerifier({
    provider,
    contractAddress,
    arenaAddress,
    expectedChainId: deployment.chainId,
    cacheTtlMs,
  });
  return { deployment, provider, eligibilityVerifier };
}

async function createPetNetworkService({
  privateKey,
  agentId,
  dataDir,
  env = process.env,
  eligibilityVerifier = null,
  transport = null,
  launchResolver = null,
  launchPollMs = null,
  signalSettlement = null,
  economicVerifier = null,
  agentBrain = undefined,
  agentConfig = undefined,
  beforeAgentTick = null,
  onAgentAction = null,
  agentContextProvider = null,
  now = null,
  transportNow = null,
}) {
  const port = Number(env.VERSUS_P2P_PORT || 0);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError("VERSUS_P2P_PORT must be an integer between 0 and 65535");
  }
  let registryConfig = null;
  if (!eligibilityVerifier) {
    registryConfig = loadCypherRegistryConfig(env);
    eligibilityVerifier = registryConfig.eligibilityVerifier;
  }

  if (!transport) {
    const transportName = String(env.VERSUS_P2P_TRANSPORT || (registryConfig ? "waku" : "tcp")).toLowerCase();
    if (transportName === "tcp") {
      transport = new TcpMeshTransport();
    } else if (transportName === "waku") {
      if (!registryConfig) {
        throw new NetworkEligibilityConfigurationError(
          "Waku transport requires the configured Base deployment"
        );
      }
      const { deployment, provider } = registryConfig;
      const syndicateAddress = deployment.contracts?.syndicate;
      if (!syndicateAddress) {
        throw new NetworkEligibilityConfigurationError(
          "deployment must contain the SyndicateEngine contract address"
        );
      }
      const syndicate = new Contract(syndicateAddress, CURRENT_CLASS_ABI, provider);
      if (env.VERSUS_WAKU_LAUNCH_ID) {
        launchResolver = null;
      } else {
        launchResolver = async () => (await syndicate.currentClassId()).toString();
      }
      const launchId = env.VERSUS_WAKU_LAUNCH_ID
        ? BigInt(env.VERSUS_WAKU_LAUNCH_ID).toString()
        : await launchResolver();
      const trustedRainAttestors = parseAddresses(
        env.VERSUS_RAIN_ATTESTORS || deployment.rainAttestors || []
      );
      transport = new WakuPostcardTransport({
        chainId: deployment.chainId,
        contractAddress: deployment.contracts.agents,
        ...(trustedRainAttestors.length ? {
          arenaAddress: deployment.contracts.arena,
          trustedRainAttestors,
        } : {}),
        launchId,
        bootstrapPeers: env.VERSUS_WAKU_BOOTSTRAP_PEERS === ""
          ? []
          : parsePeerUrls(env.VERSUS_WAKU_BOOTSTRAP_PEERS || DEFAULT_WAKU_BOOTSTRAP_PEERS.join(",")),
        peerTimeoutMs: Number(env.VERSUS_WAKU_TIMEOUT_MS || 20_000),
        minimumPeerCount: Number(env.VERSUS_WAKU_MINIMUM_PEERS || 1),
        enableStore: env.VERSUS_WAKU_STORE !== "0",
        storeHistoryMs: Number(env.VERSUS_WAKU_STORE_HISTORY_MS || 24 * 60 * 60 * 1000),
        storeMessageLimit: Number(env.VERSUS_WAKU_STORE_MESSAGE_LIMIT || 256),
        storePageSize: Number(env.VERSUS_WAKU_STORE_PAGE_SIZE || 64),
        ...(transportNow ? { now: transportNow } : {}),
      });
    } else {
      throw new RangeError("VERSUS_P2P_TRANSPORT must be tcp or waku");
    }
  }

  if (!signalSettlement && registryConfig?.deployment?.contracts?.arena) {
    signalSettlement = {
      chainId: registryConfig.deployment.chainId,
      arena: registryConfig.deployment.contracts.arena,
    };
  }
  if (!economicVerifier && registryConfig?.deployment?.contracts?.arena) {
    economicVerifier = new ContractEconomicVerifier({
      provider: registryConfig.provider,
      chainId: registryConfig.deployment.chainId,
      arena: registryConfig.deployment.contracts.arena,
      missionEscrow: registryConfig.deployment.contracts.missionEscrow,
    });
  }
  if (agentConfig === undefined) agentConfig = loadAgentBrainConfig(env);
  if (agentBrain === undefined) {
    agentBrain = createAgentBrain(agentConfig);
  }

  return new PetNetworkService({
    privateKey,
    agentId,
    dataDir,
    eligibilityVerifier,
    transport,
    host: env.VERSUS_P2P_HOST || "127.0.0.1",
    port,
    peers: parsePeerUrls(env.VERSUS_P2P_PEERS),
    launchResolver,
    launchPollMs: launchPollMs ?? Number(env.VERSUS_WAKU_LAUNCH_POLL_MS || 60_000),
    signalSettlement,
    economicVerifier,
    agentBrain,
    agentConfig,
    beforeAgentTick,
    onAgentAction,
    agentContextProvider,
    now,
  });
}

module.exports = {
  DEFAULT_WAKU_BOOTSTRAP_PEERS,
  NetworkEligibilityConfigurationError,
  PetNetworkService,
  createContractEligibilityVerifier,
  loadCypherRegistryConfig,
  loadAgentBrainConfig,
  createPetNetworkService,
  parsePeerUrls,
};
