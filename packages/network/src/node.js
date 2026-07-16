const { EventEmitter } = require("events");
const {
  ARTIFACT_REFERENCE_PATTERN,
  ArtifactStore,
  MISSION_MANIFEST_VERSION,
  OUTCOME_MANIFEST_VERSION,
  normalizeArtifactReference,
  normalizeMissionManifest,
  normalizeOutcomeManifest,
  verifyOutcomePostcardArtifact,
  verifyMissionPostcardArtifact,
} = require("./artifact-store");
const { CoalitionEngine } = require("./coalition");
const { StanceClusterAnalyzer } = require("./cluster");
const { DenyAllCypherVerifier } = require("./eligibility");
const { RatePolicy } = require("./rate-policy");
const { PostcardStore } = require("./store");
const { TrustGraph } = require("./trust");
const { SIGNAL_INK_PENNIES, SIGNAL_TYPES, verifyPostcard } = require("./protocol");
const { PaymentProofStore } = require("./payment-proof-store");
const { OutcomeLedger } = require("./outcome-ledger");
const {
  SIGNAL_SETTLEMENT_KIND,
  SIGNAL_SETTLEMENT_VERSION,
  normalizeSignalSettlement,
  verifySignalSettlementPostcard,
} = require("./signal-batch");
const {
  MISSION_SPONSORSHIP_KIND,
  normalizeMissionSponsorship,
  verifyMissionSponsorshipPostcard,
} = require("./sponsorship");
const { verifyPeerProof } = require("./peer-proof");
const { TcpMeshTransport } = require("./tcp-transport");

class NetworkPolicyError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "NetworkPolicyError";
    this.code = code;
  }
}

class VersusNode extends EventEmitter {
  constructor({
    identity,
    transport = new TcpMeshTransport(),
    store = new PostcardStore(),
    trust = new TrustGraph(),
    ratePolicy = new RatePolicy(),
    artifactStore = new ArtifactStore(),
    outcomeFilePath = null,
    now = () => Math.floor(Date.now() / 1000),
    handshakeTimeoutMs = 3000,
    syncInventoryLimit = 128,
    syncRequestLimit = 64,
    artifactRequestLimit = 8,
    eligibilityVerifier = new DenyAllCypherVerifier(),
    economicVerifier = null,
    requirePaidSignals = economicVerifier !== null,
    paymentProofStore = null,
    paymentProofFilePath = null,
  }) {
    super();
    if (!identity) throw new TypeError("identity is required");
    this.identity = identity;
    this.transport = transport;
    this.store = store;
    this.trust = trust;
    this.ratePolicy = ratePolicy;
    this.artifactStore = artifactStore;
    this.now = now;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.syncInventoryLimit = syncInventoryLimit;
    this.syncRequestLimit = syncRequestLimit;
    this.artifactRequestLimit = artifactRequestLimit;
    this.eligibilityVerifier = eligibilityVerifier;
    this.economicVerifier = economicVerifier;
    this.requirePaidSignals = Boolean(requirePaidSignals);
    this.paymentProofs = paymentProofStore || new PaymentProofStore({ filePath: paymentProofFilePath });
    this.peers = new Map();
    this.handshakes = new Map();
    this.readyPeers = new Set();
    this.inboundQueues = new Map();
    this.coalition = new CoalitionEngine({ store: this.store, trust: this.trust });
    this.outcomes = new OutcomeLedger({
      store: this.store,
      trust: this.trust,
      artifactStore: this.artifactStore,
      filePath: outcomeFilePath,
    });
    this.ratePolicy.seed(this.store.list({ limit: 100_000 }));
    this.nextLocalSequence = this.store.nextSequence(this.identity.address);
    this.localEligibility = null;
    this.wantedArtifacts = new Set();

    this.transport.on("postcard", (postcard, socket, paymentProof = null) => {
      const queueKey = this.transport.connectionless ? this.transport : socket;
      this.enqueueInbound(queueKey, async () => {
        if (!this.transport.connectionless && !this.readyPeers.has(socket)) {
          this.emit(
            "rejected",
            new NetworkPolicyError("unauthenticated peer sent a postcard", "UNAUTHENTICATED_PEER"),
            postcard
          );
          return;
        }
        try {
          await this.accept(postcard, {
            source: socket?.history ? "sync" : "peer",
            relaySocket: socket,
            paymentProof,
          });
        } catch (error) {
          this.emit("rejected", error, postcard);
        }
      });
    });
    this.transport.on("artifact", (artifact, socket) => {
      const queueKey = this.transport.connectionless ? this.transport : socket;
      this.enqueueInbound(queueKey, async () => {
        if (!this.transport.connectionless && !this.readyPeers.has(socket)) {
          this.emit(
            "artifactRejected",
            new NetworkPolicyError("unauthenticated peer sent an artifact", "UNAUTHENTICATED_PEER"),
            artifact
          );
          return;
        }
        try {
          await this.acceptArtifact(artifact?.reference, artifact?.value, {
            source: socket?.history ? "sync" : "peer",
          });
        } catch (error) {
          this.emit("artifactRejected", error, artifact);
        }
      });
    });
    this.transport.on("peerHello", (challenge, socket) => {
      this.answerPeerChallenge(challenge, socket).catch((error) => {
        this.emit("peerError", error, socket);
        socket.destroy();
      });
    });
    this.transport.on("control", (control, data, socket) => {
      this.enqueueInbound(socket, async () => {
        try {
          await this.handleControl(control, data, socket);
        } catch (error) {
          this.emit("peerError", error, socket);
          socket.destroy();
        }
      });
    });
    this.transport.on("peerDisconnect", (socket) => {
      const peer = this.peers.get(socket);
      this.peers.delete(socket);
      this.handshakes.delete(socket);
      this.readyPeers.delete(socket);
      this.inboundQueues.delete(socket);
      if (peer) this.emit("peerDisconnect", peer);
    });
    this.transport.on("peerError", (error, socket) => this.emit("peerError", error, socket));
  }

  async listen(options) {
    await this.assertLocalEligibility();
    return this.transport.listen(options);
  }

  async assertLocalEligibility() {
    const eligibility = await this.eligibilityVerifier.verify({
      address: this.identity.address,
      cypherId: this.identity.cypherId,
    });
    if (!eligibility.eligible) {
      throw new NetworkPolicyError(
        `local wallet is not the current owner of a registered Cypher: ${eligibility.reason}`,
        "INELIGIBLE_LOCAL_CYPHER"
      );
    }
    this.localEligibility = eligibility;
    return eligibility;
  }

  enqueueInbound(socket, task) {
    const previous = this.inboundQueues.get(socket) || Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    this.inboundQueues.set(socket, next);
    return next;
  }

  async connect(url) {
    await this.assertLocalEligibility();
    if (this.transport.connectionless) return this.transport.connect(url);
    const socket = await this.transport.connect(url);
    if (this.readyPeers.has(socket)) return this.peers.get(socket);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        socket.destroy();
        reject(new NetworkPolicyError("peer handshake timed out", "HANDSHAKE_TIMEOUT"));
      }, this.handshakeTimeoutMs);
      const onReady = (peer, authenticatedSocket) => {
        if (authenticatedSocket !== socket) return;
        cleanup();
        resolve(peer);
      };
      const onDisconnect = () => {
        cleanup();
        reject(new NetworkPolicyError("peer disconnected during handshake", "HANDSHAKE_DISCONNECT"));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off("peerReady", onReady);
        socket.off("close", onDisconnect);
      };
      this.on("peerReady", onReady);
      socket.once("close", onDisconnect);
    });
  }

  async answerPeerChallenge(challenge, socket) {
    const proof = await this.identity.createPeerProof(challenge, this.now());
    this.transport.sendControl(socket, "identity", proof);
    const handshake = this.handshakes.get(socket) || {};
    handshake.proofSent = true;
    this.handshakes.set(socket, handshake);
    this.finishHandshake(socket);
  }

  finishHandshake(socket) {
    const handshake = this.handshakes.get(socket);
    if (!handshake?.proofSent || !this.peers.has(socket) || handshake.readySent) return;
    handshake.readySent = true;
    this.transport.sendControl(socket, "ready", null);
    this.sendInventory(socket);
  }

  async handleControl(control, data, socket) {
    if (control === "identity") {
      const challenge = this.transport.localChallenge(socket);
      const proof = verifyPeerProof(data, { challenge, now: this.now() });
      const eligibility = await this.eligibilityVerifier.verify({
        address: proof.address,
        cypherId: proof.cypherId,
      });
      if (!eligibility.eligible) {
        throw new NetworkPolicyError(
          `peer is not the current owner of a registered Cypher: ${eligibility.reason}`,
          "INELIGIBLE_CYPHER"
        );
      }
      const existing = this.peers.get(socket);
      if (existing && existing.address !== proof.address) {
        throw new NetworkPolicyError("peer changed identity on an open socket", "PEER_IDENTITY_CHANGED");
      }
      this.peers.set(socket, proof);
      const handshake = this.handshakes.get(socket) || {};
      handshake.proofReceived = true;
      this.handshakes.set(socket, handshake);
      this.emit("peerAuthenticated", proof, socket);
      this.finishHandshake(socket);
      return;
    }

    if (control === "ready") {
      const handshake = this.handshakes.get(socket);
      if (!this.peers.has(socket) || !handshake?.proofSent) {
        throw new NetworkPolicyError("peer became ready before identity exchange", "EARLY_READY");
      }
      if (!this.readyPeers.has(socket)) {
        this.readyPeers.add(socket);
        this.emit("peerReady", this.peers.get(socket), socket);
      }
      return;
    }

    if (!this.readyPeers.has(socket)) {
      throw new NetworkPolicyError("unauthenticated peer sent a control frame", "UNAUTHENTICATED_PEER");
    }

    if (control === "inventory") {
      if (!data || !Array.isArray(data.ids) || data.ids.length > this.syncInventoryLimit) {
        throw new NetworkPolicyError("peer inventory is invalid", "BAD_INVENTORY");
      }
      const missing = data.ids
        .filter((id) => typeof id === "string" && /^0x[0-9a-f]{64}$/.test(id))
        .filter((id) => !this.store.has(id))
        .slice(0, this.syncRequestLimit);
      if (missing.length) this.transport.sendControl(socket, "request", { ids: missing });
      return;
    }

    if (control === "request") {
      if (!data || !Array.isArray(data.ids) || data.ids.length > this.syncRequestLimit) {
        throw new NetworkPolicyError("peer history request is invalid", "BAD_HISTORY_REQUEST");
      }
      for (const id of data.ids) {
        if (typeof id !== "string" || !/^0x[0-9a-f]{64}$/.test(id)) continue;
        const postcard = this.store.get(id);
        if (postcard) {
          this.transport.sendControl(socket, "history", {
            postcard,
            paymentProof: this.paymentProofs.get(postcard.id),
          });
        }
      }
      return;
    }

    if (control === "history") {
      const postcard = data?.postcard || data;
      await this.accept(postcard, {
        source: "sync",
        relaySocket: socket,
        paymentProof: data?.paymentProof || null,
      });
      return;
    }

    if (control === "artifact_request") {
      if (!data || !Array.isArray(data.references) || data.references.length > this.artifactRequestLimit) {
        throw new NetworkPolicyError("peer artifact request is invalid", "BAD_ARTIFACT_REQUEST");
      }
      for (const reference of data.references) {
        if (!ARTIFACT_REFERENCE_PATTERN.test(String(reference))) continue;
        const value = this.artifactStore.get(reference);
        if (value) this.transport.sendControl(socket, "artifact", { reference, value });
      }
      return;
    }

    if (control === "artifact") {
      if (!data || typeof data !== "object") {
        throw new NetworkPolicyError("peer artifact response is invalid", "BAD_ARTIFACT_RESPONSE");
      }
      await this.acceptArtifact(data.reference, data.value, { source: "sync" });
      return;
    }

    throw new NetworkPolicyError(`unsupported peer control ${control}`, "UNSUPPORTED_CONTROL");
  }

  sendInventory(socket) {
    this.transport.sendControl(socket, "inventory", {
      ids: this.store.ids({ limit: this.syncInventoryLimit }),
    });
  }

  async publish({
    type,
    launchId,
    body,
    replyTo = null,
    artifact = null,
    amountMicros = null,
    lifetimeSeconds = 24 * 60 * 60,
  }) {
    const postcard = await this.prepare({
      type,
      launchId,
      body,
      replyTo,
      artifact,
      amountMicros,
      lifetimeSeconds,
    });
    await this.accept(postcard, { source: "local" });
    return postcard;
  }

  async prepare({
    type,
    launchId,
    body,
    replyTo = null,
    artifact = null,
    amountMicros = null,
    lifetimeSeconds = 24 * 60 * 60,
    createdAt = null,
  }) {
    createdAt = createdAt ?? this.now();
    const sequence = Math.max(
      this.nextLocalSequence,
      this.store.nextSequence(this.identity.address)
    );
    this.nextLocalSequence = sequence + 1;
    return this.identity.signPostcard({
      type,
      launchId,
      sequence,
      createdAt,
      expiresAt: createdAt + lifetimeSeconds,
      body,
      replyTo,
      artifact,
      amountMicros,
    });
  }

  reserveLocalSequence(sequence) {
    sequence = Number(sequence);
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new TypeError("local postcard sequence must be a non-negative safe integer");
    }
    this.nextLocalSequence = Math.max(this.nextLocalSequence, sequence + 1);
    return this.nextLocalSequence;
  }

  async publishPaid(postcard, paymentProof) {
    const result = await this.accept(postcard, { source: "local", paymentProof });
    if (result.duplicate) {
      await this.transport.broadcast(postcard, { paymentProof });
    }
    if (postcard.artifact && typeof this.transport.broadcastArtifact === "function") {
      const artifact = this.artifactStore.get(postcard.artifact);
      if (artifact) await this.transport.broadcastArtifact(postcard.artifact, artifact);
    }
    return postcard;
  }

  async stagePaid(postcard, paymentProof) {
    const result = await this.accept(postcard, { source: "staged", paymentProof });
    return result.postcard;
  }

  async publishMission({
    launchId,
    body,
    replyTo,
    manifest,
    lifetimeSeconds = 24 * 60 * 60,
  }) {
    const prepared = await this.prepareMission({ launchId, body, replyTo, manifest, lifetimeSeconds });
    await this.accept(prepared, { source: "local" });
    if (typeof this.transport.broadcastArtifact === "function") {
      await this.transport.broadcastArtifact(prepared.artifact, this.artifactStore.get(prepared.artifact));
    }
    return prepared;
  }

  async prepareMission({ launchId, body, replyTo, manifest, lifetimeSeconds = 24 * 60 * 60, createdAt = null }) {
    const parent = this.store.get(replyTo);
    if (!parent || parent.type !== "proposal" || parent.launchId !== String(launchId)) {
      throw new NetworkPolicyError(
        "mission must directly reference a proposal in the active launch",
        "BAD_MISSION_PARENT"
      );
    }
    createdAt = createdAt ?? this.now();
    const normalized = normalizeMissionManifest({
      ...manifest,
      kind: "versus-mission",
      version: MISSION_MANIFEST_VERSION,
      launchId: String(launchId),
      author: this.identity.address,
      createdAt,
      expiresAt: manifest?.expiresAt ?? createdAt + lifetimeSeconds,
    });
    const reference = this.artifactStore.put(normalized);
    return this.prepare({
      type: "mission",
      launchId,
      body,
      replyTo,
      artifact: reference,
      amountMicros: normalized.budgetMicros === "0" ? null : normalized.budgetMicros,
      lifetimeSeconds,
      createdAt,
    });
  }

  async publishOutcome({ launchId, body, missionId, manifest, lifetimeSeconds = 24 * 60 * 60 }) {
    const prepared = await this.prepareOutcome({ launchId, body, missionId, manifest, lifetimeSeconds });
    await this.accept(prepared, { source: "local" });
    if (typeof this.transport.broadcastArtifact === "function") {
      await this.transport.broadcastArtifact(prepared.artifact, this.artifactStore.get(prepared.artifact));
    }
    return prepared;
  }

  async prepareOutcome({ launchId, body, missionId, manifest, lifetimeSeconds = 24 * 60 * 60, createdAt = null }) {
    const mission = this.store.get(missionId);
    if (!mission || mission.type !== "mission" || mission.launchId !== String(launchId)) {
      throw new NetworkPolicyError(
        "outcome must directly reference a mission in the active launch",
        "BAD_OUTCOME_MISSION"
      );
    }
    const completedAt = createdAt ?? this.now();
    const normalized = normalizeOutcomeManifest({
      ...manifest,
      kind: "versus-outcome",
      version: OUTCOME_MANIFEST_VERSION,
      launchId: String(launchId),
      missionId: mission.id,
      reporter: this.identity.address,
      completedAt,
    });
    const reference = this.artifactStore.put(normalized);
    return this.prepare({
      type: "outcome",
      launchId,
      body,
      replyTo: mission.id,
      artifact: reference,
      lifetimeSeconds,
      createdAt: completedAt,
    });
  }

  async publishSignalSettlement(record, { lifetimeSeconds = 7 * 24 * 60 * 60 } = {}) {
    if (!record || record.status !== "confirmed") {
      throw new NetworkPolicyError("signal settlement record is not confirmed", "UNCONFIRMED_SIGNAL_BATCH");
    }
    const settlement = normalizeSignalSettlement({
      kind: SIGNAL_SETTLEMENT_KIND,
      version: SIGNAL_SETTLEMENT_VERSION,
      batch: record.batch,
      transactionHash: record.transactionHash,
      blockNumber: record.blockNumber,
    });
    const reference = this.artifactStore.put(settlement);
    const postcard = await this.publish({
      type: "receipt",
      launchId: settlement.batch.launchId,
      body: `settled ${settlement.batch.signalCount} durable signals on base`,
      artifact: reference,
      lifetimeSeconds,
    });
    if (typeof this.transport.broadcastArtifact === "function") {
      try {
        await this.transport.broadcastArtifact(reference, settlement);
      } catch (error) {
        this.emit("artifactError", error, reference);
      }
    }
    return postcard;
  }

  async publishMissionSponsorship(input, { lifetimeSeconds = 7 * 24 * 60 * 60 } = {}) {
    const sponsorship = normalizeMissionSponsorship(input);
    if (
      sponsorship.sponsor !== this.identity.address ||
      sponsorship.sponsorAgentId !== this.identity.cypherId
    ) {
      throw new NetworkPolicyError(
        "mission sponsorship does not belong to the local Cypher",
        "FOREIGN_MISSION_SPONSORSHIP"
      );
    }
    const mission = this.store.get(sponsorship.missionId);
    if (!mission || mission.type !== "mission" || mission.launchId !== sponsorship.launchId) {
      throw new NetworkPolicyError("mission sponsorship target is unknown", "UNKNOWN_MISSION");
    }
    const reference = this.artifactStore.put(sponsorship);
    const postcard = await this.publish({
      type: "receipt",
      launchId: sponsorship.launchId,
      body: `sponsored mission with ${sponsorship.amountMicros} usdc micros`,
      artifact: reference,
      lifetimeSeconds,
    });
    if (typeof this.transport.broadcastArtifact === "function") {
      try {
        await this.transport.broadcastArtifact(reference, sponsorship);
      } catch (error) {
        this.emit("artifactError", error, reference);
      }
    }
    return postcard;
  }

  async accept(postcard, { source = "peer", relaySocket = null, paymentProof = null } = {}) {
    const verified = verifyPostcard(postcard, { now: this.now() });
    if (typeof this.transport.validatePostcard === "function") {
      this.transport.validatePostcard(verified);
    }
    if (this.store.has(verified.id)) return { accepted: false, duplicate: true, postcard: verified };
    const paidSignal = SIGNAL_TYPES.includes(verified.type) && this.requirePaidSignals;
    const eligibility = await this.eligibilityVerifier.verify({
      address: verified.author,
      cypherId: verified.cypherId,
      // The settled signal buys voice for this postcard. Ownership is still
      // checked here, and the exact on-chain payment is verified below.
      voiceDay: paidSignal ? null : verified.voiceDay,
    });
    if (!eligibility.eligible) {
      throw new NetworkPolicyError(
        `postcard author is not the current owner of a registered Cypher: ${eligibility.reason}`,
        "INELIGIBLE_CYPHER"
      );
    }
    let verifiedPayment = null;
    if (paidSignal) {
      verifiedPayment = await this.verifyPostcardPayment(verified, paymentProof);
    }
    const sequenceId = this.store.idForSequence(verified.author, verified.sequence);
    if (sequenceId && sequenceId !== verified.id) {
      throw new NetworkPolicyError(
        "author signed conflicting postcards with the same sequence",
        "SEQUENCE_EQUIVOCATION"
      );
    }
    if (this.trust.isBlocked(verified.author)) {
      throw new NetworkPolicyError("postcard author is locally blocked", "BLOCKED_AUTHOR");
    }
    if (
      ARTIFACT_REFERENCE_PATTERN.test(String(verified.artifact)) &&
      this.artifactStore.has(verified.artifact)
    ) {
      this.validateArtifactForPostcard(verified, this.artifactStore.get(verified.artifact));
    }

    const multiplier = this.trust.attentionWeight(verified.author);
    const allowance = this.ratePolicy.consume(verified, multiplier, {
      ignoreMinute: source === "sync",
    });
    this.store.add(verified);
    if (verifiedPayment) this.paymentProofs.set(verified.id, verifiedPayment);
    this.trackArtifact(verified, relaySocket);
    if (source === "local" || !this.transport.handlesPropagation) {
      await this.transport.broadcast(verified, {
        except: relaySocket,
        paymentProof: verifiedPayment,
      });
    }
    this.emit("postcard", verified, { source, allowance });
    return { accepted: true, duplicate: false, postcard: verified, allowance };
  }

  async verifyPostcardPayment(postcard, value) {
    if (!value) throw new NetworkPolicyError("paid postcard is missing its Base proof", "MISSING_PAYMENT_PROOF");
    const settlement = normalizeSignalSettlement(value);
    const signal = settlement.batch.signals.find((entry) => entry.id === postcard.id);
    if (
      !signal || signal.type !== postcard.type || signal.inkPennies !== SIGNAL_INK_PENNIES[postcard.type] ||
      settlement.batch.author !== postcard.author || settlement.batch.agentId !== postcard.cypherId ||
      settlement.batch.launchId !== postcard.launchId
    ) {
      throw new NetworkPolicyError("Base proof does not pay for this exact postcard", "WRONG_PAYMENT_PROOF");
    }
    if (!this.economicVerifier) {
      throw new NetworkPolicyError("paid postcard verification is unavailable", "PAYMENT_VERIFIER_UNAVAILABLE");
    }
    try {
      await this.economicVerifier.verifySignalSettlement(settlement);
    } catch (error) {
      throw new NetworkPolicyError(`Base payment proof failed: ${error.message}`, "INVALID_PAYMENT_PROOF");
    }
    return settlement;
  }

  trackArtifact(postcard, relaySocket = null) {
    const reference = postcard.artifact;
    if (!ARTIFACT_REFERENCE_PATTERN.test(String(reference))) return;
    if (this.artifactStore.has(reference)) return;
    this.wantedArtifacts.add(reference);
    if (!this.transport.connectionless && relaySocket && typeof this.transport.sendControl === "function") {
      this.transport.sendControl(relaySocket, "artifact_request", { references: [reference] });
    }
    this.emit("artifactWanted", reference, postcard);
  }

  validateArtifactForPostcard(postcard, value) {
    if (postcard.type === "mission") return verifyMissionPostcardArtifact(postcard, value);
    if (postcard.type === "outcome") {
      return verifyOutcomePostcardArtifact(postcard, this.store.get(postcard.replyTo), value);
    }
    if (value?.kind === SIGNAL_SETTLEMENT_KIND) {
      return verifySignalSettlementPostcard(postcard, value);
    }
    if (value?.kind === MISSION_SPONSORSHIP_KIND) {
      return verifyMissionSponsorshipPostcard(postcard, value);
    }
    return value;
  }

  async acceptArtifact(reference, value, { source = "peer" } = {}) {
    normalizeArtifactReference(reference);
    if (!this.wantedArtifacts.has(reference)) {
      return { accepted: false, wanted: false, reference };
    }
    const references = this.store
      .list({ limit: 100_000 })
      .filter((postcard) => postcard.artifact === reference);
    if (references.length < 1) {
      this.wantedArtifacts.delete(reference);
      return { accepted: false, wanted: false, reference };
    }
    for (const postcard of references) this.validateArtifactForPostcard(postcard, value);
    this.artifactStore.import(reference, value);
    this.wantedArtifacts.delete(reference);
    const result = { accepted: true, wanted: true, reference, value, source };
    this.emit("artifact", result);
    return result;
  }

  async close() {
    return this.transport.close();
  }

  get peerCount() {
    if (this.transport.connectionless) return this.transport.peerCount;
    return this.readyPeers.size;
  }

  peerList() {
    if (this.transport.connectionless) return this.transport.peerList?.() || [];
    return Array.from(this.readyPeers).map((socket) => {
      const peer = this.peers.get(socket);
      return {
        address: peer.address,
        cypherId: peer.cypherId,
        authenticatedAt: peer.createdAt,
      };
    });
  }

  coalitionView(launchId) {
    return this.coalition.view(launchId);
  }

  clusterView() {
    return new StanceClusterAnalyzer({ store: this.store, trust: this.trust }).view();
  }

  assessOutcome(input) {
    return this.outcomes.assess(input);
  }

  recordVerifiedEconomicProof(result) {
    if (!result?.verified) {
      throw new NetworkPolicyError("economic proof is not verified", "UNVERIFIED_ECONOMIC_PROOF");
    }
    if (result.kind !== "sponsorship") return { applied: false, kind: result.kind };
    const sponsorship = result.sponsorship;
    const source = `sponsorship:${sponsorship.chainId}:${sponsorship.escrowId}`;
    if (result.escrowState === 2) {
      this.trust.removeContribution(source);
      return { applied: false, removed: true, source, score: 0 };
    }
    const score = result.escrowState === 1 ? 4 : 1;
    this.trust.setContribution(source, sponsorship.sponsor, { sponsorship: score });
    return { applied: true, source, score, address: sponsorship.sponsor };
  }
}

module.exports = { NetworkPolicyError, VersusNode };
