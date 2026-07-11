#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { fork, spawn } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const {
  Contract,
  JsonRpcProvider,
  Wallet,
} = require("../../apps/pet/node_modules/ethers");
const { createChainRainService } = require("../../apps/pet/src/chain");
const { SIGNAL_INK_PENNIES } = require("../../packages/network/src");

const ROOT = path.resolve(__dirname, "..", "..");
const VERSUS = path.join(ROOT, "versus");
const WORKER = path.join(__dirname, "cypher-worker.js");
const WAKU_CLUSTER = path.join(__dirname, "waku-cluster.js");
const CLUSTER_STATE = path.join(ROOT, "research", "waku-lab", "cluster.json");
const HARDHAT_CLI = path.join(VERSUS, "node_modules", "hardhat", "internal", "cli", "cli.js");
const RUN_ROOT = path.join(ROOT, "research", "coalition-runs");
const HARDHAT_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const MODEL_MODE = process.argv.includes("--models");
const FIXTURE_MODE = process.argv.includes("--fixture-models");
const HTTP_MODE = MODEL_MODE || FIXTURE_MODE;
const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_FRONTIER_MODELS = [
  "openai/gpt-5.6-luna",
  "anthropic/claude-sonnet-5",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-luna",
  "anthropic/claude-sonnet-5",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-sol",
];
const USDC_ABI = ["function mint(address to,uint256 amount)"];
const ARENA_ABI = ["function runway(uint256 agentId) view returns (uint256)"];
const TREASURY_ABI = [
  "function tickets(uint256 agentId) view returns (uint256)",
  "function totalTickets() view returns (uint256)",
];
const SYNDICATE_ABI = [
  "function currentClassId() view returns (uint256)",
  "function getClass(uint256 classId) view returns (uint256 totalCommitted,uint32 participantCount,uint32 openedDay,bool graduated)",
];
const TRUST_DIMENSIONS = [
  "taste", "prediction", "criticism", "execution", "sponsorship", "stewardship", "integrity",
];
const PROPOSALS = Object.freeze({
  verified: "publish one daily pixel poster with verified contract",
  mystery: "use rotating mystery symbols without contract details",
});
const STRATEGIES = Object.freeze([
  { name: "mystery-curator", brainProfile: "memory-guided", bias: "mystery", preference: "favor a recognizable mystery symbol that changes with every launch" },
  { name: "verification-curator", brainProfile: "memory-guided", bias: "verified", preference: "favor public verification and a consistent contract reference" },
  { name: "risk-auditor", brainProfile: "risk-auditor", bias: "verified", preference: "challenge directions that make the official reference harder to verify" },
  { name: "originality-auditor", brainProfile: "originality-auditor", bias: "mystery", preference: "challenge generic presentation and favor a distinct cultural identity" },
  { name: "verification-questioner", brainProfile: "verification-questioner", bias: "neutral", preference: "ask for one concrete repeatable verification rule before support" },
  { name: "mystery-builder", brainProfile: "memory-guided", bias: "mystery", preference: "favor mystery symbols as the memorable daily ritual" },
  { name: "bridge-builder", brainProfile: "bridge-builder", bias: "verified", preference: "combine clear verification with a distinct visual ritual" },
  { name: "quiet-observer", brainProfile: "quiet-observer", bias: "critical", preference: "stay silent when existing voices already cover the useful disagreement" },
]);

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) { return JSON.stringify(stableValue(value)); }

function hashValue(value) {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function sourceRevision() {
  const hash = createHash("sha256");
  for (const file of [
    __filename,
    WORKER,
    path.join(ROOT, "apps", "pet", "src", "brain.js"),
    path.join(ROOT, "apps", "pet", "src", "network.js"),
    path.join(ROOT, "packages", "network", "src", "agent-runtime.js"),
    path.join(ROOT, "packages", "network", "src", "coalition.js"),
    path.join(ROOT, "packages", "network", "src", "context-compact.js"),
  ]) hash.update(fs.readFileSync(file));
  return `sha256:${hash.digest("hex").slice(0, 16)}`;
}

function redactLogChunk(chunk) {
  return String(chunk).replace(/(Private Key:\s*)0x[0-9a-f]{64}/gi, "$1[redacted-known-dev-key]");
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function spawnLogged(command, args, { cwd, env, logPath }) {
  const stream = fs.createWriteStream(logPath, { flags: "a" });
  const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true });
  child.stdout.on("data", (chunk) => stream.write(redactLogChunk(chunk)));
  child.stderr.on("data", (chunk) => stream.write(redactLogChunk(chunk)));
  child.on("exit", (code, signal) => stream.write(`\nprocess exit code=${code} signal=${signal}\n`));
  return child;
}

async function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, shell: false, windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0
      ? resolve(output)
      : reject(new Error(`${command} exited ${code}\n${output}`)));
  });
}

async function waitForRpc(provider, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { await provider.getBlockNumber(); return; } catch (error) { lastError = error; }
    await delay(250);
  }
  throw new Error(`Hardhat RPC did not become ready: ${lastError?.message || "timeout"}`);
}

async function waitFor(predicate, timeoutMs = 60_000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await predicate();
    if (value) return value;
    await delay(intervalMs);
  }
  throw new Error("condition timed out");
}

async function recordTransaction(record, label, transactionPromise, detail = {}) {
  const transaction = await transactionPromise;
  const receipt = await transaction.wait();
  record("chain_transaction", {
    label,
    hash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    status: Number(receipt.status),
    ...detail,
  });
  return receipt;
}

function recordReceipt(record, label, receipt, detail = {}) {
  record("chain_transaction", {
    label,
    hash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed?.toString() || null,
    status: Number(receipt.status),
    ...detail,
  });
}

class WorkerClient {
  constructor(name, runDir, record) {
    this.name = name;
    this.nextId = 1;
    this.pending = new Map();
    this.child = fork(WORKER, [], { cwd: ROOT, silent: true, env: { ...process.env } });
    const log = fs.createWriteStream(path.join(runDir, `${name}.log`), { flags: "a" });
    this.child.stdout.pipe(log);
    this.child.stderr.pipe(log);
    this.child.on("message", (message) => {
      if (message?.kind === "event") {
        record(message.type, { worker: message.worker, ...message.detail }, message.at);
        return;
      }
      if (message?.kind !== "response") return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(Object.assign(new Error(message.error.message), {
        code: message.error.code,
        stack: message.error.stack,
      }));
    });
    this.child.on("exit", (code) => {
      for (const { reject } of this.pending.values()) reject(new Error(`${name} worker exited ${code}`));
      this.pending.clear();
    });
  }

  request(command, payload = {}, timeoutMs = 30_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name} ${command} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.child.send({ kind: "command", id, command, payload });
    });
  }

  async close() {
    try { await this.request("close", {}, 8_000); } catch (_) {}
    if (this.child.connected) this.child.disconnect();
    if (!this.child.killed) this.child.kill();
  }
}

function modelList() {
  const configured = String(process.env.VERSUS_COALITION_MODELS || "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  const values = configured.length ? configured : DEFAULT_FRONTIER_MODELS;
  if (values.length < 1 || values.length > 8) throw new Error("VERSUS_COALITION_MODELS must contain 1 to 8 models");
  return Array.from({ length: 8 }, (_, index) => values[index % values.length]);
}

async function modelPriceSnapshot(models) {
  if (FIXTURE_MODE) {
    return Array.from(new Set(models)).map((model) => ({
      id: model,
      canonicalSlug: model,
      name: model,
      contextLength: 16_384,
      pricing: { prompt: "0.000001", completion: "0.000002" },
      supportedParameters: ["max_tokens", "reasoning", "response_format", "seed", "temperature"],
      observedAt: new Date().toISOString(),
      syntheticFixture: true,
    }));
  }
  if (!MODEL_MODE) return [];
  const response = await fetch("https://openrouter.ai/api/v1/models");
  if (!response.ok) throw new Error(`OpenRouter model catalog returned HTTP ${response.status}`);
  const payload = await response.json();
  const byId = new Map((payload.data || []).map((entry) => [entry.id, entry]));
  return Array.from(new Set(models)).map((model) => {
    const entry = byId.get(model);
    if (!entry) throw new Error(`OpenRouter model is unavailable: ${model}`);
    return {
      id: entry.id,
      canonicalSlug: entry.canonical_slug || null,
      name: entry.name || entry.id,
      contextLength: entry.context_length || null,
      pricing: entry.pricing || null,
      supportedParameters: entry.supported_parameters || [],
      observedAt: new Date().toISOString(),
    };
  });
}

function fixtureDecision(model, context) {
  const verified = context.newPostcards.find((postcard) => postcard.type === "proposal" && postcard.body.includes("verified contract"));
  const mystery = context.newPostcards.find((postcard) => postcard.type === "proposal" && postcard.body.includes("mystery symbols"));
  const preference = (context.localState?.localMemory?.memories || [])
    .map((memory) => memory.statement)
    .join(" ")
    .toLowerCase();
  if (model.includes("risk-auditor") && mystery) return {
    thought: "the mystery direction needs a visible verification boundary",
    action: { type: "critique", body: "mystery symbols should not replace a verifiable public reference", replyTo: mystery.id },
  };
  if (model.includes("originality-auditor") && verified) return {
    thought: "the verified poster needs a stronger identity to remain memorable",
    action: { type: "critique", body: "the verified poster needs a more distinctive daily identity", replyTo: verified.id },
  };
  if (model.includes("verification-questioner") && verified) return {
    thought: "one repeatable verification detail would make the proposal testable",
    action: { type: "question", body: "which verification detail stays consistent across every daily poster", replyTo: verified.id },
  };
  if (model.includes("bridge-builder") && verified) return {
    thought: "clarity and a distinct ritual can reinforce each other",
    action: { type: "endorsement", body: "support verification while giving each poster a distinct visual ritual", replyTo: verified.id },
  };
  if (model.includes("quiet-observer")) return {
    thought: "the active positions already cover the useful disagreement",
    action: null,
  };
  if (preference.includes("mystery") && mystery) return {
    thought: "my local preference favors the mystery direction as a daily ritual",
    action: { type: "endorsement", body: "support the mystery symbols as a distinct daily ritual", replyTo: mystery.id },
  };
  if (verified) return {
    thought: "my local preference favors a stable public verification reference",
    action: { type: "endorsement", body: "support the verified poster as a clear public reference", replyTo: verified.id },
  };
  return { thought: "there is no useful paid response in this bounded context", action: null };
}

async function startModelFixture(port, record) {
  const server = http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const userMessage = payload.messages?.findLast?.((message) => message.role === "user") ||
          [...(payload.messages || [])].reverse().find((message) => message.role === "user");
        const context = JSON.parse(userMessage?.content || "{}");
        const decision = fixtureDecision(String(payload.model || "fixture"), context);
        const rawOutput = JSON.stringify(decision);
        const promptTokens = Math.ceil(Buffer.byteLength(JSON.stringify(payload.messages || []), "utf8") / 4);
        const completionTokens = Math.ceil(Buffer.byteLength(rawOutput, "utf8") / 4);
        const cost = promptTokens * 0.000001 + completionTokens * 0.000002;
        record("model_fixture_request", {
          model: payload.model,
          promptTokens,
          completionTokens,
          responseFormat: payload.response_format || null,
          reasoning: payload.reasoning || null,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: `fixture-${randomUUID()}`,
          model: payload.model,
          choices: [{ message: { role: "assistant", content: rawOutput }, finish_reason: "stop" }],
          usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens, cost },
        }));
      } catch (error) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: error.message }));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

function trustScores(bias, addresses) {
  const aPositive = new Set([1, 2, 6, 7]);
  const bPositive = new Set([0, 3, 4, 5]);
  const supporters = new Set([0, 1, 5, 6]);
  const critics = new Set([2, 3]);
  return addresses.map((address, index) => {
    let score = 0;
    if (bias === "verified") score = aPositive.has(index) ? 90 : -80;
    if (bias === "mystery") score = bPositive.has(index) ? 90 : -80;
    if (bias === "critical") {
      if (supporters.has(index)) score = -80;
      if (critics.has(index)) score = 90;
    }
    return {
      address,
      scores: Object.fromEntries(TRUST_DIMENSIONS.map((dimension) => [dimension, score])),
    };
  });
}

function semanticView(view) {
  return {
    launchId: view.launchId,
    coalition: view.coalition,
    clusters: view.clusters,
    neighborhood: view.neighborhood,
    localMemory: view.localMemory,
    trust: view.trust,
  };
}

function proposalLabel(id, proposalIds) {
  if (id === proposalIds.verified) return "verified";
  if (id === proposalIds.mystery) return "mystery";
  return id || "none";
}

function outcomeSignature(view, proposalIds) {
  const proposals = view.coalition.proposals.map((proposal) =>
    `${proposalLabel(proposal.id, proposalIds)}:${proposal.status}:${proposal.supporters.length}:${proposal.detractors.length}`
  ).sort();
  return `${proposalLabel(view.coalition.leadingProposalId, proposalIds)}|${proposals.join("|")}`;
}

function estimateModelCost(events, prices) {
  const byId = new Map(prices.map((price) => [price.id, price]));
  let exactUsd = 0;
  let estimatedUsd = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  for (const entry of events.filter((event) => event.type === "brain_decision")) {
    const usage = entry.detail.response?.usage || null;
    if (!usage) continue;
    const input = Number(usage.prompt_tokens || 0);
    const output = Number(usage.completion_tokens || 0);
    const exact = Number(usage.cost || 0);
    promptTokens += input;
    completionTokens += output;
    exactUsd += exact;
    const price = byId.get(entry.detail.model)?.pricing;
    estimatedUsd += input * Number(price?.prompt || 0) + output * Number(price?.completion || 0);
  }
  return {
    promptTokens,
    completionTokens,
    exactUsd: Number(exactUsd.toFixed(8)),
    catalogEstimatedUsd: Number(estimatedUsd.toFixed(8)),
  };
}

async function main() {
  if (MODEL_MODE && FIXTURE_MODE) throw new Error("choose either --models or --fixture-models");
  const models = MODEL_MODE
    ? modelList()
    : STRATEGIES.map((strategy) => `${FIXTURE_MODE ? "fixture" : "deterministic"}-${strategy.brainProfile}`);
  const apiKey = MODEL_MODE ? String(process.env.OPENROUTER_API_KEY || "") : "";
  if (MODEL_MODE && !apiKey) throw new Error("set OPENROUTER_API_KEY in the process environment for --models");
  const prices = await modelPriceSnapshot(models);
  const startedAt = Date.now();
  const modeSlug = MODEL_MODE ? "frontier" : FIXTURE_MODE ? "http-fixture" : "control";
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-coalition-${modeSlug}-${randomUUID().slice(0, 8)}`;
  const runDir = path.join(RUN_ROOT, runId);
  const viewsDir = path.join(runDir, "views");
  fs.mkdirSync(viewsDir, { recursive: true });
  const eventRecords = [];
  const eventStream = fs.createWriteStream(path.join(runDir, "events.jsonl"), { flags: "a" });
  const record = (type, detail = {}, at = Date.now()) => {
    const entry = { runId, at, type, detail };
    eventRecords.push(entry);
    eventStream.write(`${JSON.stringify(entry)}\n`);
  };
  const revision = sourceRevision();
  const port = await freePort();
  const modelPort = FIXTURE_MODE ? await freePort() : null;
  const rpcUrl = `http://127.0.0.1:${port}`;
  const deploymentPath = path.join(runDir, "deployment.json");
  let hardhat = null;
  let clusterStarted = false;
  let modelServer = null;
  let workers = [];

  try {
    if (FIXTURE_MODE) {
      modelServer = await startModelFixture(modelPort, record);
      record("model_fixture_ready", { endpoint: `http://127.0.0.1:${modelPort}/v1/chat/completions` });
    }
    const clusterOutput = await runProcess(process.execPath, [WAKU_CLUSTER, "up"], { cwd: ROOT, env: { ...process.env } });
    fs.writeFileSync(path.join(runDir, "waku-cluster-up.log"), clusterOutput, "utf8");
    clusterStarted = true;
    const cluster = JSON.parse(fs.readFileSync(CLUSTER_STATE, "utf8"));
    record("waku_cluster_ready", {
      image: cluster.image,
      clusterId: cluster.clusterId,
      nodes: cluster.nodes.map((node) => ({ name: node.name, peerId: node.peerId })),
      connectedPeers: cluster.connectedPeers,
    });

    hardhat = spawnLogged(process.execPath, [HARDHAT_CLI, "node", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: VERSUS,
      env: { ...process.env },
      logPath: path.join(runDir, "hardhat.log"),
    });
    const provider = new JsonRpcProvider(rpcUrl, 31337, { staticNetwork: true });
    await waitForRpc(provider);
    record("rpc_ready", { blockNumber: await provider.getBlockNumber() });

    const deployOutput = await runProcess(process.execPath, [HARDHAT_CLI, "run", "scripts/deploy.js", "--network", "localhost"], {
      cwd: VERSUS,
      env: { ...process.env, LOCAL_RPC_URL: rpcUrl, VERSUS_DEPLOYMENT_OUT: deploymentPath },
    });
    fs.writeFileSync(path.join(runDir, "deploy.log"), deployOutput, "utf8");
    const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
    record("contracts_deployed", { contracts: deployment.contracts });

    // The preflight provider may still cache the deployer's pre-deployment nonce.
    const fundingProvider = new JsonRpcProvider(rpcUrl, 31337, { staticNetwork: true });
    await fundingProvider.getBlockNumber();
    const deployer = new Wallet(HARDHAT_PRIVATE_KEY, fundingProvider);
    let deployerNonce = Number(BigInt(await fundingProvider.send("eth_getTransactionCount", [deployer.address, "latest"])));
    const usdc = new Contract(deployment.contracts.usdc, USDC_ABI, deployer);
    const wallets = Array.from({ length: 8 }, () => Wallet.createRandom().connect(provider));
    for (let index = 0; index < wallets.length; index += 1) {
      const name = `cypher-${index + 1}`;
      const wallet = wallets[index];
      await recordTransaction(record, "fund_test_wallet", deployer.sendTransaction({
        to: wallet.address,
        value: 1_000_000_000_000_000_000n,
        nonce: deployerNonce++,
      }), { worker: name });
      await recordTransaction(record, "mint_mock_usdc", usdc.mint(wallet.address, 10_000_000n, {
        nonce: deployerNonce++,
      }), { worker: name });
      const chain = createChainRainService({ rpcUrl, deployment, env: { VERSUS_RPC_URL: rpcUrl } }, {
        provider: new JsonRpcProvider(rpcUrl, 31337, { staticNetwork: true }),
      });
      const hatch = await chain.hatchWithRunway({
        privateKey: wallet.privateKey,
        cypherId: (index % 8) + 1,
        runwayAmount: 7_000_000n,
      });
      record("chain_transaction", {
        label: "hatch_cypher",
        hash: hatch.hatchHash,
        blockNumber: hatch.blockNumber,
        gasUsed: hatch.gasUsed.toString(),
        status: 1,
        worker: name,
        agentId: index + 1,
        productionAdapter: true,
      });
      const commitChain = createChainRainService({
        rpcUrl,
        deployment,
        env: { VERSUS_RPC_URL: rpcUrl },
      });
      const commit = await commitChain.commitDaily({ privateKey: wallet.privateKey, agentId: index + 1 });
      recordReceipt(record, "commit_daily_voice", commit, {
        worker: name,
        agentId: index + 1,
        productionAdapter: true,
      });
    }

    const syndicate = new Contract(deployment.contracts.syndicate, SYNDICATE_ABI, provider);
    const launchId = (await syndicate.currentClassId()).toString();
    const nowSeconds = Number((await provider.getBlock("latest")).timestamp);
    const topicScope = `coalition-${createHash("sha256").update(runId).digest("hex").slice(0, 16)}`;
    const workerInputs = STRATEGIES.map((strategy, index) => ({
      name: `cypher-${index + 1}`,
      role: strategy.brainProfile,
      brainKind: HTTP_MODE ? "http" : "deterministic",
      brainProfile: HTTP_MODE ? (FIXTURE_MODE ? "provider-fixture" : "frontier-http") : strategy.brainProfile,
      brainModel: models[index],
      ...(HTTP_MODE ? {
        brainEndpoint: FIXTURE_MODE ? `http://127.0.0.1:${modelPort}/v1/chat/completions` : OPENROUTER_ENDPOINT,
        brainApiKey: MODEL_MODE ? apiKey : "",
        brainTimeoutMs: 120_000,
        brainTemperature: 0,
        brainMaxTokens: 180,
        brainReasoningEffort: "low",
      } : {}),
      privateKey: wallets[index].privateKey,
      agentId: index + 1,
      dataDir: path.join(runDir, `cypher-${index + 1}`),
      rpcUrl,
      chainId: 31337,
      deployment,
      launchId,
      nowSeconds,
      transport: "waku",
      wakuTopicScope: topicScope,
      wakuBootstrapPeers: [cluster.bootstrapPeers[index % cluster.bootstrapPeers.length]],
      wakuClusterId: cluster.clusterId,
      wakuShardCount: cluster.numShardsInCluster,
      wakuMinimumPeerCount: 1,
      wakuAllowInsecureWebSockets: true,
      peerTimeoutMs: 90_000,
      storeHistoryMs: 60 * 60 * 1000,
    }));
    const manifest = {
      version: 1,
      runId,
      seed: randomUUID(),
      codeRevision: revision,
      startedAt: new Date(startedAt).toISOString(),
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      scenario: "eight-cypher-paid-coalition-with-local-trust-divergence",
      mode: MODEL_MODE
        ? "frontier-model-cohort"
        : FIXTURE_MODE
          ? "openai-compatible-provider-fixture"
          : "deterministic-reproducibility-control",
      chain: { kind: "hardhat", chainId: 31337 },
      waku: {
        image: cluster.image,
        clusterId: cluster.clusterId,
        nodePeerIds: cluster.nodes.map((node) => node.peerId),
        topicScope,
      },
      agents: STRATEGIES.map((strategy, index) => ({
        name: `cypher-${index + 1}`,
        agentId: index + 1,
        address: wallets[index].address,
        strategy: strategy.name,
        localBias: strategy.bias,
        model: models[index],
      })),
      modelCatalog: prices,
      syntheticModelResponses: FIXTURE_MODE,
      secretsRecorded: false,
    };
    fs.writeFileSync(path.join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    workers = STRATEGIES.map((_, index) => new WorkerClient(`cypher-${index + 1}`, runDir, record));
    await Promise.all(workers.map((worker, index) => worker.request("start", workerInputs[index], 150_000)));
    record("workers_ready", { count: workers.length });

    const proposalVerified = await workers[7].request("sendSignal", { type: "proposal", body: PROPOSALS.verified }, 120_000);
    const proposalMystery = await workers[4].request("sendSignal", { type: "proposal", body: PROPOSALS.mystery }, 120_000);
    const proposalIds = { verified: proposalVerified.id, mystery: proposalMystery.id };
    await waitFor(async () => {
      const histories = await Promise.all(workers.map((worker) => worker.request("list", { query: { launchId, limit: 50 } })));
      return histories.every((history) => proposalVerified.id && proposalMystery.id &&
        history.some((postcard) => postcard.id === proposalVerified.id) &&
        history.some((postcard) => postcard.id === proposalMystery.id));
    }, 90_000);
    record("seed_proposals_converged", proposalIds);

    const addresses = wallets.map((wallet) => wallet.address);
    await Promise.all(workers.map((worker, index) => {
      const strategy = STRATEGIES[index];
      const sourceId = strategy.preference.includes("mystery") ? proposalMystery.id : proposalVerified.id;
      return worker.request("seedLocalState", {
        trustScores: trustScores(strategy.bias, addresses),
        memories: [{
          kind: "owner-preference",
          subjectType: "launch",
          subjectId: launchId,
          statement: strategy.preference,
          sources: [sourceId],
          confidence: 100,
          confidenceReasons: ["owner seeded coalition laboratory preference"],
          status: "active",
          pinned: true,
          untrustedSources: false,
        }],
      }, 30_000);
    }));
    record("local_views_seeded", {
      strategies: STRATEGIES.map((strategy, index) => ({ worker: `cypher-${index + 1}`, ...strategy })),
    });

    const thinkResults = await Promise.all(workers.map((worker) => worker.request("think", {}, 180_000)));
    const published = thinkResults.filter((result) => result.result?.status === "published");
    const silences = thinkResults.filter((result) => result.result?.status === "idle");
    const rejected = thinkResults.filter((result) => result.result?.status === "rejected");
    const brainErrors = thinkResults.filter((result) => result.result?.status === "brain_error");
    const actionTypes = Array.from(new Set(published.map((result) => result.result.postcard.type))).sort();
    const expectedHistoryCount = 2 + published.length;
    record("thinking_round_complete", {
      results: thinkResults.map((result, index) => ({
        worker: `cypher-${index + 1}`,
        status: result.result?.status || null,
        postcardId: result.result?.postcard?.id || null,
        type: result.result?.postcard?.type || null,
      })),
      published: published.length,
      silences: silences.length,
      rejected: rejected.length,
      brainErrors: brainErrors.length,
      actionTypes,
    });

    const histories = await waitFor(async () => {
      const values = await Promise.all(workers.map((worker) => worker.request("list", { query: { launchId, limit: 100 } })));
      return values.every((history) => history.length === expectedHistoryCount) ? values : null;
    }, 120_000);
    const expectedIds = histories[0].map((postcard) => postcard.id).sort();
    const exactHistories = histories.every((history) =>
      JSON.stringify(history.map((postcard) => postcard.id).sort()) === JSON.stringify(expectedIds)
    );
    record("histories_converged", { expectedHistoryCount, exactHistories, postcardIds: expectedIds });

    await Promise.all(workers.map((worker) => worker.request("view")));
    const preRestartViews = [];
    const repeatedHashes = [];
    for (let capture = 0; capture < 3; capture += 1) {
      const started = performance.now();
      const values = await Promise.all(workers.map((worker) => worker.request("view")));
      record("view_capture", { phase: "before-restart", capture, latencyMs: Number((performance.now() - started).toFixed(3)) });
      for (let index = 0; index < values.length; index += 1) {
        if (capture === 0) preRestartViews[index] = values[index];
        if (!repeatedHashes[index]) repeatedHashes[index] = [];
        repeatedHashes[index].push(hashValue(semanticView(values[index])));
      }
    }
    const deterministicInProcess = repeatedHashes.every((hashes) => new Set(hashes).size === 1);
    const preHashes = preRestartViews.map((view) => hashValue(semanticView(view)));
    const signatures = preRestartViews.map((view) => outcomeSignature(view, proposalIds));
    const uniqueSignatures = new Set(signatures).size;
    for (let index = 0; index < preRestartViews.length; index += 1) {
      fs.writeFileSync(path.join(viewsDir, `cypher-${index + 1}-before.json`), `${JSON.stringify(preRestartViews[index], null, 2)}\n`, "utf8");
    }

    const resources = await Promise.all(workers.map((worker) => worker.request("resources")));
    await Promise.all(workers.map((worker) => worker.close()));
    workers = STRATEGIES.map((_, index) => new WorkerClient(`cypher-${index + 1}-restart`, runDir, record));
    await Promise.all(workers.map((worker, index) => worker.request("start", workerInputs[index], 150_000)));
    await waitFor(async () => {
      const values = await Promise.all(workers.map((worker) => worker.request("list", { query: { launchId, limit: 100 } })));
      return values.every((history) =>
        JSON.stringify(history.map((postcard) => postcard.id).sort()) === JSON.stringify(expectedIds)
      );
    }, 90_000);
    await Promise.all(workers.map((worker) => worker.request("view")));
    const postRestartViews = await Promise.all(workers.map((worker) => worker.request("view")));
    const postHashes = postRestartViews.map((view) => hashValue(semanticView(view)));
    const exactRestartViews = postHashes.every((hash, index) => hash === preHashes[index]);
    for (let index = 0; index < postRestartViews.length; index += 1) {
      fs.writeFileSync(path.join(viewsDir, `cypher-${index + 1}-restart.json`), `${JSON.stringify(postRestartViews[index], null, 2)}\n`, "utf8");
    }
    record("restart_reproducibility_checked", { deterministicInProcess, exactRestartViews, preHashes, postHashes });

    const arena = new Contract(deployment.contracts.arena, ARENA_ABI, provider);
    const treasury = new Contract(deployment.contracts.treasury, TREASURY_ABI, provider);
    const cls = await syndicate.getClass(launchId);
    const tickets = [];
    const runway = [];
    for (let agentId = 1; agentId <= 8; agentId += 1) {
      tickets.push((await treasury.tickets(agentId)).toString());
      runway.push((await arena.runway(agentId)).toString());
    }
    const expectedInkPennies = 8 + 6 + published.reduce(
      (sum, result) => sum + Number(SIGNAL_INK_PENNIES[result.result.postcard.type] || 0),
      0
    );
    const chain = {
      classPotMicros: cls.totalCommitted.toString(),
      participantCount: Number(cls.participantCount),
      totalTickets: (await treasury.totalTickets()).toString(),
      tickets,
      runway,
      expectedInkPennies,
    };
    const chainExact = chain.classPotMicros === String(expectedInkPennies * 10_000) &&
      chain.totalTickets === String(expectedInkPennies) && chain.participantCount === 8;
    const modelCost = estimateModelCost(eventRecords, prices);
    const brainContextEvents = eventRecords.filter((event) => event.type === "brain_context");
    const brainDecisionEvents = eventRecords.filter((event) => event.type === "brain_decision");
    const baseAssertions = {
      eightIndependentProcesses: resources.length === 8 && new Set(resources.map((entry) => entry.pid)).size === 8,
      eightInstrumentedContexts: brainContextEvents.length === 8,
      eightInstrumentedDecisions: brainDecisionEvents.length === 8,
      exactHistories,
      deterministicInProcess,
      exactRestartViews,
      divergentLocalViews: uniqueSignatures >= (MODEL_MODE ? 2 : 3),
      chainExact,
      noRejectedDecisions: rejected.length === 0,
      noBrainErrors: brainErrors.length === 0,
    };
    const modeAssertions = MODEL_MODE ? {
      minimumUsefulActions: published.length >= 4,
      multipleActionTypes: actionTypes.length >= 2,
      usageRecorded: modelCost.promptTokens > 0 && modelCost.completionTokens > 0,
    } : FIXTURE_MODE ? {
      expectedFixtureActions: published.length === 7 && silences.length === 1,
      expectedFixtureTypes: ["critique", "endorsement", "question"].every((type) => actionTypes.includes(type)),
      fixtureUsageRecorded: modelCost.promptTokens > 0 && modelCost.completionTokens > 0 && modelCost.exactUsd > 0,
      eightFixtureRequests: eventRecords.filter((event) => event.type === "model_fixture_request").length === 8,
      expectedFixtureEconomics: chain.classPotMicros === "210000" && chain.totalTickets === "21",
    } : {
      expectedControlActions: published.length === 7 && silences.length === 1,
      expectedControlTypes: ["critique", "endorsement", "question"].every((type) => actionTypes.includes(type)),
      expectedControlEconomics: chain.classPotMicros === "210000" && chain.totalTickets === "21",
    };
    const assertions = { ...baseAssertions, ...modeAssertions };
    const passed = Object.values(assertions).every(Boolean);
    const summary = {
      version: 1,
      runId,
      passed,
      mode: manifest.mode,
      durationMs: Date.now() - startedAt,
      assertions,
      proposalIds,
      conversation: {
        published: published.length,
        silences: silences.length,
        rejected: rejected.length,
        brainErrors: brainErrors.length,
        actionTypes,
        expectedHistoryCount,
      },
      localViews: STRATEGIES.map((strategy, index) => ({
        worker: `cypher-${index + 1}`,
        strategy: strategy.name,
        bias: strategy.bias,
        model: models[index],
        signature: signatures[index],
        hashBefore: preHashes[index],
        hashAfterRestart: postHashes[index],
      })),
      uniqueOutcomeSignatures: uniqueSignatures,
      chain,
      modelCost,
      resources,
    };
    fs.writeFileSync(path.join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(runDir, "metrics.csv"), [
      "worker,model,strategy,bias,view_signature,view_hash,restart_hash,rss_bytes,heap_used_bytes,user_cpu_micros,system_cpu_micros",
      ...STRATEGIES.map((strategy, index) => [
        `cypher-${index + 1}`,
        JSON.stringify(models[index]),
        strategy.name,
        strategy.bias,
        JSON.stringify(signatures[index]),
        preHashes[index],
        postHashes[index],
        resources[index].memory.rss,
        resources[index].memory.heapUsed,
        resources[index].cpu.userCPUTime,
        resources[index].cpu.systemCPUTime,
      ].join(",")),
      "",
    ].join("\n"), "utf8");
    fs.writeFileSync(path.join(runDir, "REPORT.md"), [
      "# Eight-Cypher Coalition Laboratory",
      "",
      `- Run: \`${runId}\``,
      `- Revision: \`${revision}\``,
      `- Mode: \`${manifest.mode}\``,
      `- Result: **${passed ? "PASS" : "FAIL"}**`,
      `- Paid public actions: ${published.length}; silence: ${silences.length}; rejected: ${rejected.length}; brain errors: ${brainErrors.length}`,
      `- Exact accepted history: ${expectedHistoryCount} postcards on all eight Cyphers`,
      `- Distinct local outcome signatures: ${uniqueSignatures}`,
      `- Exact view hashes across three reads: ${deterministicInProcess}`,
      `- Exact view hashes after process restart: ${exactRestartViews}`,
      `- Class pot: ${chain.classPotMicros} micros; tickets: ${chain.totalTickets}`,
      `- Model tokens: ${modelCost.promptTokens} input / ${modelCost.completionTokens} output`,
      `- Model cost: $${modelCost.exactUsd.toFixed(8)} exact; $${modelCost.catalogEstimatedUsd.toFixed(8)} catalog estimate`,
      "",
      "| Cypher | Brain | Local bias | Local result |",
      "| --- | --- | --- | --- |",
      ...STRATEGIES.map((strategy, index) =>
        `| cypher-${index + 1} | ${models[index]} | ${strategy.bias} | ${signatures[index]} |`
      ),
      "",
      "## Assertions",
      "",
      ...Object.entries(assertions).map(([name, value]) => `- [${value ? "x" : " "}] ${name}`),
      "",
    ].join("\n"), "utf8");
    record("run_completed", { passed, assertions, modelCost, chain });
    if (!passed) throw new Error(`coalition assertions failed; see ${runDir}`);
    console.log(`PASS ${runDir}`);
  } finally {
    await Promise.all(workers.map((worker) => worker.close()));
    if (hardhat && !hardhat.killed) hardhat.kill();
    if (clusterStarted) {
      try {
        const output = await runProcess(process.execPath, [WAKU_CLUSTER, "down"], { cwd: ROOT, env: { ...process.env } });
        fs.writeFileSync(path.join(runDir, "waku-cluster-down.log"), output, "utf8");
      } catch (error) {
        record("cleanup_error", { component: "waku-cluster", message: error.message });
      }
    }
    if (modelServer) await new Promise((resolve) => modelServer.close(resolve));
    await new Promise((resolve) => eventStream.end(resolve));
  }
}

main().catch((error) => {
  console.error(String(error?.stack || error?.message || error).replace(/sk-or-v1-[a-z0-9]+/gi, "[redacted]"));
  process.exitCode = 1;
});
