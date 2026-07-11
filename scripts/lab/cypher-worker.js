const path = require("node:path");
const { createHash } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { JsonRpcProvider } = require("../../apps/pet/node_modules/ethers");
const {
  ContractCypherVerifier,
  ContractEconomicVerifier,
  TcpMeshTransport,
  WakuPostcardTransport,
} = require("../../packages/network/src");
const { createPetNetworkService } = require("../../apps/pet/src/network");
const { createChainRainService } = require("../../apps/pet/src/chain");
const { createHttpAgentBrain } = require("../../apps/pet/src/brain");

let service = null;
let config = null;
let clockSeconds = null;

function send(value) {
  if (process.send) process.send(value);
}

function event(type, detail = {}) {
  send({ kind: "event", at: Date.now(), worker: config?.name || "unconfigured", type, detail });
}

const MIXED_BRAIN_PROMPT_VERSION = "mixed-coalition-v1";

function proposalFrom(context, text) {
  return context.newPostcards.find((postcard) =>
    postcard.type === "proposal" && postcard.body.includes(text)
  ) || context.workingSet.messages.find((message) =>
    message.type === "proposal" && message.body.includes(text)
  ) || null;
}

function mixedBrainDecision(profile, context) {
  const verified = proposalFrom(context, "verified contract");
  const mystery = proposalFrom(context, "mystery symbols");
  const memories = context.localState?.localMemory?.memories || [];
  const preference = memories.map((memory) => memory.statement).join(" ").toLowerCase();

  if (profile === "memory-guided") {
    if (preference.includes("mystery") && mystery) {
      return {
        thought: "my local memory favors a playful mystery while keeping the action bounded",
        action: {
          type: "endorsement",
          body: "support the mystery symbols as a distinct daily ritual",
          replyTo: mystery.id,
        },
      };
    }
    if (verified) {
      return {
        thought: "my local memory favors public verification over ambiguous presentation",
        action: {
          type: "endorsement",
          body: "support the verified poster as a clear public reference",
          replyTo: verified.id,
        },
      };
    }
  }
  if (profile === "risk-auditor" && mystery) {
    return {
      thought: "the mystery direction hides the reference people need to verify",
      action: {
        type: "critique",
        body: "mystery symbols should not replace a verifiable public reference",
        replyTo: mystery.id,
      },
    };
  }
  if (profile === "originality-auditor" && verified) {
    return {
      thought: "the verified poster is useful but risks becoming generic and forgettable",
      action: {
        type: "critique",
        body: "the verified poster needs a more distinctive daily identity",
        replyTo: verified.id,
      },
    };
  }
  if (profile === "verification-questioner" && verified) {
    return {
      thought: "the proposal needs one concrete rule for how verification is displayed",
      action: {
        type: "question",
        body: "which verification detail stays consistent across every daily poster",
        replyTo: verified.id,
      },
    };
  }
  if (profile === "mystery-questioner" && mystery) {
    return {
      thought: "the playful direction needs a boundary that keeps it understandable",
      action: {
        type: "question",
        body: "how will mystery symbols remain recognizable across daily launches",
        replyTo: mystery.id,
      },
    };
  }
  if (profile === "bridge-builder" && verified) {
    return {
      thought: "the verified direction can carry a distinctive ritual without losing clarity",
      action: {
        type: "endorsement",
        body: "support verification while giving each poster a distinct visual ritual",
        replyTo: verified.id,
      },
    };
  }
  if (profile === "quiet-observer") {
    return {
      thought: "both directions already have enough voices so another penny adds little",
      action: null,
    };
  }
  return { thought: "the local graph has no new action worth paying for", action: null };
}

function deterministicBrain(role) {
  let proposed = false;
  let critiqued = false;
  return async (context) => {
    const started = performance.now();
    const profile = config?.brainProfile || role;
    const serializedContext = JSON.stringify(context);
    const contextHash = `sha256:${createHash("sha256").update(serializedContext).digest("hex")}`;
    event("brain_context", {
      launchId: context.launch.id,
      newPostcards: context.newPostcards.map((postcard) => postcard.id),
      workingSetCount: context.workingSet.includedCount,
      memoryCount: context.localState?.localMemory?.memories?.length || 0,
      promptTemplateVersion: MIXED_BRAIN_PROMPT_VERSION,
      model: config?.brainModel || `deterministic-${profile}`,
      profile,
      contextHash,
      boundedInput: context,
    });
    let decision;
    if (role === "proposer" && !proposed) {
      proposed = true;
      decision = {
        thought: "a bounded local ritual gives the network something concrete to test",
        action: {
          type: "proposal",
          body: "build one public signal garden for the current launch",
          replyTo: null,
        },
      };
    } else if (role === "critic" && !critiqued) {
      const proposal = context.newPostcards.find((postcard) => postcard.type === "proposal");
      if (proposal) {
        critiqued = true;
        decision = {
          thought: "the proposal needs a measurable first step before endorsement",
          action: {
            type: "critique",
            body: "define one measurable signal before expanding the garden",
            replyTo: proposal.id,
          },
        };
      }
    }
    if (!decision) decision = mixedBrainDecision(profile, context);
    event("brain_decision", {
      launchId: context.launch.id,
      promptTemplateVersion: MIXED_BRAIN_PROMPT_VERSION,
      model: config?.brainModel || `deterministic-${profile}`,
      profile,
      contextHash,
      rawOutput: decision,
      normalizedDecision: decision,
      latencyMs: Number((performance.now() - started).toFixed(3)),
    });
    return decision;
  };
}

function httpBrain() {
  const model = String(config.brainModel || "");
  if (!model) throw new Error("brainModel is required for an HTTP lab brain");
  const brain = createHttpAgentBrain({
    mode: "http",
    endpoint: config.brainEndpoint || "https://openrouter.ai/api/v1/chat/completions",
    model,
    apiKey: String(config.brainApiKey || ""),
    timeoutMs: Number(config.brainTimeoutMs || 120_000),
    temperature: Number(config.brainTemperature ?? 0),
    maxTokens: Number(config.brainMaxTokens || 384),
    seed: Number(config.brainSeed || 41),
    reasoningEffort: config.brainReasoningEffort || "low",
    responseFormat: { type: "json_object" },
  }, {
    onInvocation: (invocation) => {
      const context = invocation.request?.context || null;
      const contextHash = context
        ? `sha256:${createHash("sha256").update(JSON.stringify(context)).digest("hex")}`
        : null;
      event("brain_decision", {
        promptTemplateVersion: MIXED_BRAIN_PROMPT_VERSION,
        profile: config.brainProfile || "frontier-http",
        contextHash,
        ...invocation,
      });
    },
  });
  return async (context) => {
    const serializedContext = JSON.stringify(context);
    event("brain_context", {
      launchId: context.launch.id,
      newPostcards: context.newPostcards.map((postcard) => postcard.id),
      workingSetCount: context.workingSet.includedCount,
      memoryCount: context.localState?.localMemory?.memories?.length || 0,
      promptTemplateVersion: MIXED_BRAIN_PROMPT_VERSION,
      model,
      profile: config.brainProfile || "frontier-http",
      contextHash: `sha256:${createHash("sha256").update(serializedContext).digest("hex")}`,
      boundedInput: context,
    });
    return brain(context);
  };
}

async function settlePostcard(postcard, { publish = true } = {}) {
  const record = service.prepareSignalPostcards([postcard], postcard.launchId);
  event("settlement_prepared", { root: record.batch.root, postcardId: postcard.id, pennies: record.batch.inkPennies });
  let submittedHash = null;
  let receipt;
  try {
    receipt = await config.chainService.settleSignalBatchFromRunway({
      privateKey: config.privateKey,
      agentId: config.agentId,
      batch: record.batch,
      onSubmitted: async (hash) => {
        submittedHash = hash;
        service.markSignalBatchSubmitted(record.batch.root, hash);
        event("settlement_submitted", { root: record.batch.root, transactionHash: hash });
      },
    });
  } catch (error) {
    if (!submittedHash || error?.receipt?.status === 0) service.failSignalBatch(record.batch.root, error.message);
    event("settlement_failed", { root: record.batch.root, postcardId: postcard.id, submitted: Boolean(submittedHash), message: error.message });
    throw error;
  }
  const confirmed = service.confirmSignalBatch(record.batch.root, {
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
  });
  let completed;
  let deliveryPending = false;
  let deliveryError = null;
  if (publish) {
    try {
      completed = await service.publishPaidBatch(confirmed);
    } catch (error) {
      completed = [];
      deliveryPending = true;
      deliveryError = error.message;
      event("postcard_delivery_pending", {
        postcardId: postcard.id,
        transactionHash: receipt.hash,
        message: error.message,
      });
    }
  } else {
    completed = await service.stagePaidBatch(confirmed);
  }
  event(publish ? "postcard_published" : "postcard_staged", {
    postcardId: postcard.id,
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed?.toString() || null,
    published: publish ? completed.length : 0,
    staged: publish ? 0 : completed.length,
    deliveryPending,
    deliveryError,
  });
  return { postcard, root: record.batch.root, receipt, record: confirmed, deliveryPending, deliveryError };
}

async function settleAndPublish(postcard) {
  return settlePostcard(postcard, { publish: true });
}

async function start(input) {
  config = { ...input };
  clockSeconds = Number(config.nowSeconds || Math.floor(Date.now() / 1000));
  const provider = new JsonRpcProvider(config.rpcUrl, config.chainId, { staticNetwork: true });
  config.chainService = createChainRainService({
    rpcUrl: config.rpcUrl,
    deployment: config.deployment,
    env: { VERSUS_RPC_URL: config.rpcUrl },
  }, { provider });
  const verifier = new ContractCypherVerifier({
    provider,
    contractAddress: config.deployment.contracts.agents,
    arenaAddress: config.deployment.contracts.arena,
    expectedChainId: config.chainId,
    cacheTtlMs: 0,
  });
  const economicVerifier = new ContractEconomicVerifier({
    provider,
    chainId: config.chainId,
    arena: config.deployment.contracts.arena,
    missionEscrow: config.deployment.contracts.missionEscrow,
  });
  const transport = config.transport === "waku"
    ? new WakuPostcardTransport({
        chainId: config.chainId,
        contractAddress: config.deployment.contracts.agents,
        launchId: config.launchId,
        topicScope: config.wakuTopicScope || "",
        bootstrapPeers: config.wakuBootstrapPeers || [],
        defaultBootstrap: !(config.wakuBootstrapPeers || []).length,
        clusterId: Number(config.wakuClusterId || 1),
        numShardsInCluster: Number(config.wakuShardCount || 8),
        peerTimeoutMs: Number(config.peerTimeoutMs || 45_000),
        minimumPeerCount: Number(config.wakuMinimumPeerCount || 1),
        enableStore: true,
        storeHistoryMs: Number(config.storeHistoryMs || 24 * 60 * 60 * 1000),
        storeMessageLimit: Number(config.storeMessageLimit || 256),
        storePageSize: Number(config.storePageSize || 64),
        allowInsecureWebSockets: Boolean(config.wakuAllowInsecureWebSockets),
      })
    : new TcpMeshTransport();
  transport.launchId = String(config.launchId);
  const agentBrain = config.brainKind === "http" ? httpBrain() : deterministicBrain(config.role);
  service = await createPetNetworkService({
    privateKey: config.privateKey,
    agentId: config.agentId,
    dataDir: path.resolve(config.dataDir),
    eligibilityVerifier: verifier,
    transport,
    signalSettlement: {
      chainId: config.chainId,
      arena: config.deployment.contracts.arena,
    },
    economicVerifier,
    agentBrain,
    agentConfig: {
      mode: config.brainKind === "http" ? "http-lab" : "deterministic-lab",
      model: config.brainModel || `deterministic-${config.brainProfile || config.role}`,
      autostart: false,
      tickIntervalMs: 86_400_000,
    },
    beforeAgentTick: async () => ({ status: "voice_preconfirmed" }),
    onAgentAction: settleAndPublish,
    now: () => clockSeconds,
  });
  service.node.on("postcard", (postcard, meta) => {
    event("postcard_accepted", { postcardId: postcard.id, author: postcard.author, type: postcard.type, source: meta.source });
  });
  service.node.on("rejected", (error, postcard) => {
    event("postcard_rejected", { postcardId: postcard?.id || null, code: error.code || null, message: error.message });
  });
  service.agentRuntime?.on("decisionRejected", (error, decision) => {
    event("agent_decision_rejected", {
      code: error.code || null,
      message: error.message,
      decision,
    });
  });
  transport.on("published", (detail) => event("waku_published", detail));
  transport.on("protocolFallback", (detail) => event("waku_protocol_fallback", detail));
  transport.on("historySynced", (detail) => event("waku_history_synced", detail));
  const status = await service.start();
  event("started", { address: status.address, cypherId: status.cypherId, listen: status.listen });
  return status;
}

async function command(name, payload = {}) {
  if (name === "start") return start(payload);
  if (!service) throw new Error("worker is not started");
  if (name === "connect") return service.connect(payload.url);
  if (name === "tick") return service.runDailyAgentTick();
  if (name === "think") return service.runAgentTick();
  if (name === "sendSignal") {
    const postcard = await service.prepare({
      type: payload.type || "observation",
      launchId: String(config.launchId),
      body: String(payload.body),
    });
    await settleAndPublish(postcard);
    return postcard;
  }
  if (name === "preparePaidSignal") {
    const postcard = await service.prepare({
      type: payload.type || "observation",
      launchId: String(config.launchId),
      body: String(payload.body),
    });
    const settled = await settlePostcard(postcard, { publish: false });
    return {
      postcard,
      root: settled.root,
      transactionHash: settled.receipt.hash,
      blockNumber: settled.receipt.blockNumber,
    };
  }
  if (name === "publishPending") {
    const records = service.unpublishedSignalBatches();
    const published = [];
    for (const record of records) {
      published.push(...await service.publishPaidBatch(record));
    }
    event("pending_postcards_published", { count: published.length, postcardIds: published.map((postcard) => postcard.id) });
    return { count: published.length, postcardIds: published.map((postcard) => postcard.id) };
  }
  if (name === "publishStaged") {
    const record = service.unpublishedSignalBatches().find((candidate) =>
      candidate.postcards?.some((postcard) => postcard.id === payload.postcardId)
    );
    if (!record) throw new Error("staged postcard is unavailable");
    const published = await service.publishPaidBatch(record);
    event("staged_postcard_published", { postcardId: payload.postcardId, count: published.length });
    return { count: published.length, postcardIds: published.map((postcard) => postcard.id) };
  }
  if (name === "rebroadcast") {
    const postcard = service.node.store.get(payload.postcardId);
    if (!postcard) throw new Error("postcard is unavailable for rebroadcast");
    const paymentProof = service.node.paymentProofs.get(postcard.id);
    if (!paymentProof) throw new Error("postcard payment proof is unavailable for rebroadcast");
    await service.node.transport.broadcast(postcard, { paymentProof });
    event("postcard_rebroadcast", { postcardId: postcard.id });
    return { postcardId: postcard.id };
  }
  if (name === "broadcastUnpaid") {
    const postcard = await service.prepare({
      type: "observation",
      launchId: String(config.launchId),
      body: String(payload.body),
    });
    await service.node.transport.broadcast(postcard);
    event("unpaid_postcard_broadcast", { postcardId: postcard.id });
    return postcard;
  }
  if (name === "history") {
    const result = await service.node.transport.storeCatchUp;
    return { result, status: service.status() };
  }
  if (name === "list") return service.list(payload.query || {});
  if (name === "status") return service.status();
  if (name === "memory") return service.localMemoryContext();
  if (name === "seedLocalState") {
    const applied = { trustScores: 0, blocked: 0, preferences: 0, memories: 0 };
    for (const entry of payload.trustScores || []) {
      for (const [dimension, score] of Object.entries(entry.scores || {})) {
        service.setTrustScore(entry.address, dimension, score);
        applied.trustScores += 1;
      }
    }
    for (const entry of payload.blocked || []) {
      service.setBlocked(entry.address, entry.blocked !== false);
      applied.blocked += 1;
    }
    for (const entry of payload.preferences || []) {
      service.setPeerPreference(entry.address, {
        explicitPin: entry.explicitPin,
        muted: entry.muted,
        blocked: entry.blocked,
      });
      applied.preferences += 1;
    }
    for (const memory of payload.memories || []) {
      service.putMemory(memory);
      applied.memories += 1;
    }
    event("local_state_seeded", applied);
    return { applied, localMemory: service.localMemoryContext() };
  }
  if (name === "view") {
    const launchId = String(config.launchId);
    return {
      launchId,
      coalition: service.coalitionView(launchId),
      clusters: service.clusterView(),
      neighborhood: service.localNeighborhood(8),
      localMemory: service.localMemoryContext(),
      trust: service.node.trust.toJSON(),
      database: service.status().localDatabase,
    };
  }
  if (name === "resources") {
    return {
      pid: process.pid,
      memory: process.memoryUsage(),
      cpu: process.resourceUsage(),
    };
  }
  if (name === "setNow") {
    const next = Number(payload.nowSeconds);
    if (!Number.isSafeInteger(next) || next < 1) throw new RangeError("nowSeconds must be a unix timestamp");
    clockSeconds = next;
    return { nowSeconds: clockSeconds, utcDay: Math.floor(clockSeconds / 86_400) };
  }
  if (name === "close") {
    await service.close();
    service = null;
    return { closed: true };
  }
  throw new Error(`unknown worker command ${name}`);
}

process.on("message", async (message) => {
  if (!message || message.kind !== "command") return;
  try {
    const result = await command(message.command, message.payload);
    send({ kind: "response", id: message.id, ok: true, result });
  } catch (error) {
    event("worker_error", { command: message.command, code: error.code || null, message: error.message });
    send({ kind: "response", id: message.id, ok: false, error: { code: error.code || null, message: error.message, stack: error.stack } });
  }
});

process.on("uncaughtException", (error) => {
  event("uncaught_exception", { message: error.message });
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  event("unhandled_rejection", { message: error?.message || String(error) });
  process.exit(1);
});
