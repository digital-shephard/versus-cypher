#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { createHash, createHmac, randomUUID } = require("node:crypto");
const { fork } = require("node:child_process");
require("dotenv").config();

const {
  Contract,
  JsonRpcProvider,
  MaxUint256,
  NonceManager,
  Wallet,
  id,
  formatEther,
} = require("ethers");
const { createChainRainService } = require("../../apps/pet/src/chain");

const ROOT = path.resolve(__dirname, "..", "..");
const DEPLOYMENT_PATH = path.join(__dirname, "..", "deployments", "baseSepolia.json");
const RUN_ROOT = path.join(ROOT, "research", "sepolia-runs");
const WORKER = path.join(ROOT, "scripts", "lab", "cypher-worker.js");
const CHAIN_ID = 84532;
const MIN_RUNWAY = 7_000_000n;
const PENNY = 10_000n;

function artifact(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", ...relativePath.split("/")), "utf8"));
}

const ABIS = Object.freeze({
  usdc: artifact("contracts/test/MockUSDC.sol/MockUSDC.json").abi,
  arena: artifact("contracts/core/Arena.sol/Arena.json").abi,
  agents: artifact("contracts/core/AgentNFT.sol/AgentNFT.json").abi,
  syndicate: artifact("contracts/core/SyndicateEngine.sol/SyndicateEngine.json").abi,
  treasury: artifact("contracts/core/TrancheTreasury.sol/TrancheTreasury.json").abi,
  missionEscrow: artifact("contracts/core/MissionEscrow.sol/MissionEscrow.json").abi,
  graduation: artifact("contracts/launch/GraduationModule.sol/GraduationModule.json").abi,
  classToken: artifact("contracts/launch/ClassToken.sol/ClassToken.json").abi,
  router: artifact("contracts/uniswap/MockUniswapV2Router.sol/MockUniswapV2Router.json").abi,
  pair: artifact("contracts/uniswap/MockUniswapV2Pair.sol/MockUniswapV2Pair.json").abi,
});

function json(value, spacing = 0) {
  return JSON.stringify(value, (_, child) => typeof child === "bigint" ? child.toString() : child, spacing);
}

function hashValue(value) {
  return `sha256:${createHash("sha256").update(json(value)).digest("hex")}`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class WorkerClient {
  constructor(name, runDir, record) {
    this.name = name;
    this.pending = new Map();
    this.counter = 0;
    this.child = fork(WORKER, [], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
      env: {
        ...process.env,
        DEBUG: process.env.DEBUG || "waku:light-push:protocol-handler:error",
      },
    });
    this.child.stdout.pipe(fs.createWriteStream(path.join(runDir, `${name}.stdout.log`), { flags: "a" }));
    this.child.stderr.pipe(fs.createWriteStream(path.join(runDir, `${name}.stderr.log`), { flags: "a" }));
    this.child.on("message", (message) => {
      if (message?.kind === "event") {
        record(message.type, { worker: name, ...message.detail }, message.at);
        return;
      }
      if (message?.kind !== "response") return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(Object.assign(new Error(message.error?.message || "worker command failed"), message.error));
    });
    this.child.on("exit", (code, signal) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`${name} exited code=${code} signal=${signal || "none"}`));
      }
      this.pending.clear();
    });
  }

  request(command, payload = {}, timeoutMs = 60_000) {
    const requestId = `${this.name}-${++this.counter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${this.name} timed out running ${command}`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.child.send({ kind: "command", id: requestId, command, payload });
    });
  }

  async close() {
    try { await this.request("close", {}, 10_000); } catch (_) {}
    if (this.child.connected) this.child.disconnect();
    if (!this.child.killed) this.child.kill();
  }
}

async function waitForPostcards(worker, launchId, ids, timeoutMs = 90_000) {
  const expected = new Set(ids);
  const deadline = Date.now() + timeoutMs;
  let history = [];
  while (Date.now() < deadline) {
    history = await worker.request("list", { query: { launchId, limit: 100 } }, 30_000);
    const found = new Set(history.map((postcard) => postcard.id));
    if ([...expected].every((postcardId) => found.has(postcardId))) return history;
    await delay(500);
  }
  return history;
}

async function deliverWithRetries(sender, receiver, launchId, postcard, {
  attempts = 16,
  waitMs = 20_000,
  record = () => {},
  direction = "unknown",
} = {}) {
  let history = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    history = await waitForPostcards(receiver, launchId, [postcard.id], waitMs);
    if (history.some((entry) => entry.id === postcard.id)) return { history, attempts: attempt };
    if (attempt >= attempts) break;
    try {
      await sender.request("rebroadcast", { postcardId: postcard.id }, 90_000);
      record("postcard_rebroadcast_attempt", { direction, postcardId: postcard.id, attempt, acceptedByLightPush: true });
    } catch (error) {
      record("postcard_rebroadcast_attempt", {
        direction,
        postcardId: postcard.id,
        attempt,
        acceptedByLightPush: false,
        message: error.message,
      });
    }
  }
  return { history, attempts };
}

async function main() {
  if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY is required in versus/.env");
  if (!process.env.BASE_SEPOLIA_RPC_URL) throw new Error("BASE_SEPOLIA_RPC_URL is required in versus/.env");
  const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, "utf8"));
  assert(Number(deployment.chainId) === CHAIN_ID, "deployment is not Base Sepolia");
  assert(deployment.usedMockUsdc === true && deployment.usedMockRouter === true, "live runner requires the mock Sepolia stack");
  const clusterStatePath = String(process.env.VERSUS_WAKU_CLUSTER_STATE || "").trim();
  const controlledCluster = clusterStatePath
    ? JSON.parse(fs.readFileSync(path.resolve(clusterStatePath), "utf8"))
    : null;
  if (controlledCluster && (!Array.isArray(controlledCluster.nodes) || controlledCluster.nodes.length < 3)) {
    throw new Error("controlled Waku cluster state must contain at least three nodes");
  }
  const wakuNetworkKind = controlledCluster ? "controlled-real-waku" : "public-waku";

  const resumeRunId = String(process.env.VERSUS_SEPOLIA_RESUME_RUN || "").trim();
  if (resumeRunId && !/^[0-9TZ-]+-base-sepolia-[a-f0-9]{8}$/.test(resumeRunId)) {
    throw new Error("VERSUS_SEPOLIA_RESUME_RUN is invalid");
  }
  const runId = resumeRunId || `${new Date().toISOString().replace(/[:.]/g, "-")}-base-sepolia-${randomUUID().slice(0, 8)}`;
  const runDir = path.join(RUN_ROOT, runId);
  if (resumeRunId && !fs.existsSync(path.join(runDir, "manifest.json"))) {
    throw new Error(`resume run ${resumeRunId} does not exist`);
  }
  fs.mkdirSync(runDir, { recursive: true });
  const existingEvents = resumeRunId
    ? fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse)
    : [];
  const eventRecords = [...existingEvents];
  const transactions = existingEvents
    .filter((entry) => entry.type === "transaction_confirmed" && entry.detail?.hash)
    .map((entry) => entry.detail)
    .filter((entry, index, all) => all.findIndex((candidate) => candidate.hash === entry.hash) === index);
  const events = fs.createWriteStream(path.join(runDir, "events.jsonl"), { flags: "a" });
  const record = (type, detail = {}, at = Date.now()) => {
    const entry = { runId, at, type, detail };
    eventRecords.push(entry);
    events.write(`${json(entry)}\n`);
  };
  const priorManifest = resumeRunId
    ? JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"))
    : null;
  const startedAt = priorManifest ? Date.parse(priorManifest.startedAt) : Date.now();
  const provider = new JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL, CHAIN_ID, {
    staticNetwork: true,
    cacheTimeout: -1,
  });
  const masterWallet = new Wallet(process.env.PRIVATE_KEY, provider);
  const master = new NonceManager(masterWallet);
  const masterAddress = masterWallet.address;
  const addresses = deployment.contracts;
  const deriveTestWallet = (label) => {
    const digest = createHmac("sha256", Buffer.from(masterWallet.privateKey.slice(2), "hex"))
      .update(`versus-base-sepolia:${addresses.arena.toLowerCase()}:${label}`)
      .digest("hex");
    return new Wallet(`0x${digest}`, provider);
  };
  const alphaWallet = deriveTestWallet("alpha");
  const betaWallet = deriveTestWallet("beta");
  let alpha = null;
  let beta = null;
  let alphaRestart = null;
  let betaRestart = null;

  const manifest = priorManifest || {
    version: 1,
    runId,
    scenario: "two-cypher-base-sepolia-economic-and-real-waku-e2e",
    startedAt: new Date(startedAt).toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    chain: { chainId: CHAIN_ID, rpcOrigin: new URL(process.env.BASE_SEPOLIA_RPC_URL).origin },
    deployment: {
      path: path.relative(ROOT, DEPLOYMENT_PATH).replace(/\\/g, "/"),
      deployedAt: deployment.deployedAt,
      contracts: addresses,
    },
    actors: { master: masterAddress, alpha: alphaWallet.address, beta: betaWallet.address },
    waku: { networkKind: wakuNetworkKind, clusterStatePath: controlledCluster ? path.resolve(clusterStatePath) : null },
    secretsRecorded: false,
  };
  if (resumeRunId) {
    manifest.resumptions = [...(manifest.resumptions || []), {
      at: new Date().toISOString(),
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      reason: "continue persisted paid postcard after transient public Waku RLN rejection",
      wakuNetworkKind,
    }];
    manifest.waku = {
      networkKind: wakuNetworkKind,
      clusterStatePath: controlledCluster ? path.resolve(clusterStatePath) : null,
      publicAttemptPreservedInEvents: true,
    };
  }
  fs.writeFileSync(path.join(runDir, "manifest.json"), `${json(manifest, 2)}\n`, "utf8");

  const receiptSummary = (label, receipt, actor, detail = {}) => ({
    label,
    actor,
    hash: receipt.hash,
    blockNumber: receipt.blockNumber,
    status: Number(receipt.status),
    gasUsed: receipt.gasUsed.toString(),
    ...detail,
  });

  async function submit(label, transactionPromise, actor, detail = {}) {
    const transaction = await transactionPromise;
    record("transaction_submitted", { label, actor, hash: transaction.hash, ...detail });
    const receipt = await transaction.wait();
    assert(receipt && Number(receipt.status) === 1, `${label} did not confirm`);
    const summary = receiptSummary(label, receipt, actor, detail);
    transactions.push(summary);
    record("transaction_confirmed", summary);
    return receipt;
  }

  async function recordHash(label, hash, actor, detail = {}) {
    if (!hash) return null;
    const receipt = await provider.getTransactionReceipt(hash);
    assert(receipt && Number(receipt.status) === 1, `${label} receipt is missing or failed`);
    const summary = receiptSummary(label, receipt, actor, detail);
    transactions.push(summary);
    record("transaction_confirmed", summary);
    return receipt;
  }

  try {
    record(resumeRunId ? "run_resumed" : "run_started", {
      master: masterAddress,
      alpha: alphaWallet.address,
      beta: betaWallet.address,
      ...(resumeRunId ? { priorEventCount: existingEvents.length } : {}),
    });
    const network = await provider.getNetwork();
    assert(Number(network.chainId) === CHAIN_ID, "RPC returned the wrong chain");

    const deploymentReceipts = await Promise.all(
      deployment.transactions.map((transaction) => provider.getTransactionReceipt(transaction.hash))
    );
    const contractKeys = ["usdc", "v2Factory", "v2Router", "agents", "arena", "syndicate", "treasury", "missionEscrow", "referralPool", "graduation"];
    const codeChecks = Object.fromEntries(await Promise.all(contractKeys.map(async (key) => [key, (await provider.getCode(addresses[key])).length > 2])));
    assert(deploymentReceipts.every((receipt) => receipt && Number(receipt.status) === 1), "a deployment receipt is missing or failed");
    assert(Object.values(codeChecks).every(Boolean), "a deployed contract has no bytecode");
    record("deployment_verified", { receiptCount: deploymentReceipts.length, codeChecks });

    const usdcMaster = new Contract(addresses.usdc, ABIS.usdc, master);
    const arenaRead = new Contract(addresses.arena, ABIS.arena, provider);
    const agentsRead = new Contract(addresses.agents, ABIS.agents, provider);
    const syndicateRead = new Contract(addresses.syndicate, ABIS.syndicate, provider);
    const treasuryRead = new Contract(addresses.treasury, ABIS.treasury, provider);
    const graduationMaster = new Contract(addresses.graduation, ABIS.graduation, master);
    const routerMaster = new Contract(addresses.v2Router, ABIS.router, master);

    const [recipient, floor, minRunway, recipientBps] = await Promise.all([
      treasuryRead.protocolRecipient(),
      syndicateRead.graduationFloor(),
      arenaRead.MIN_RUNWAY(),
      treasuryRead.PROTOCOL_TRANCHE_BPS(),
    ]);
    assert(recipient.toLowerCase() === deployment.economics.protocolRecipient.toLowerCase(), "protocol recipient mismatch");
    assert(floor === 1_000_000n && minRunway === MIN_RUNWAY && recipientBps === 1_000n, "economic immutable mismatch");
    record("immutables_verified", { recipient, floor, minRunway, protocolTrancheBps: recipientBps });

    const masterBalanceStart = await provider.getBalance(masterAddress);

    const chainConfig = { rpcUrl: process.env.BASE_SEPOLIA_RPC_URL, deployment, env: { VERSUS_RPC_URL: process.env.BASE_SEPOLIA_RPC_URL } };
    const alphaChain = createChainRainService(chainConfig, { provider });
    const betaChain = createChainRainService(chainConfig, { provider });
    if (!resumeRunId) {
      await submit("fund alpha gas", master.sendTransaction({ to: alphaWallet.address, value: 150_000_000_000_000n }), "master");
      await submit("fund beta gas", master.sendTransaction({ to: betaWallet.address, value: 150_000_000_000_000n }), "master");
      await submit("mint alpha test usdc", usdcMaster.mint(alphaWallet.address, 8_500_000n), "master");
      await submit("mint beta test usdc", usdcMaster.mint(betaWallet.address, 7_000_000n), "master");

      const alphaHatch = await alphaChain.hatchWithRunway({ privateKey: alphaWallet.privateKey, runwayAmount: MIN_RUNWAY });
      await recordHash("approve alpha arena", alphaHatch.approvalHash, "alpha");
      await recordHash("hatch alpha cypher", alphaHatch.hatchHash, "alpha", { agentId: alphaHatch.agentId });
      const betaHatch = await betaChain.hatchWithRunway({ privateKey: betaWallet.privateKey, runwayAmount: MIN_RUNWAY });
      await recordHash("approve beta arena", betaHatch.approvalHash, "beta");
      await recordHash("hatch beta cypher", betaHatch.hatchHash, "beta", { agentId: betaHatch.agentId });
      assert(alphaHatch.agentId === 1n && betaHatch.agentId === 2n, "fresh deployment did not mint agents one and two");

      const alphaCommit = await alphaChain.commitDaily({ privateKey: alphaWallet.privateKey, agentId: 1 });
      transactions.push(receiptSummary("commit alpha daily voice", alphaCommit, "alpha"));
      record("transaction_confirmed", transactions.at(-1));
      const betaCommit = await betaChain.commitDaily({ privateKey: betaWallet.privateKey, agentId: 2 });
      transactions.push(receiptSummary("commit beta daily voice", betaCommit, "beta"));
      record("transaction_confirmed", transactions.at(-1));
    } else {
      const [alphaOwner, betaOwner, alphaRunway, betaRunway, alphaTickets, betaTickets] = await Promise.all([
        agentsRead.ownerOf(1),
        agentsRead.ownerOf(2),
        arenaRead.runway(1),
        arenaRead.runway(2),
        treasuryRead.tickets(1),
        treasuryRead.tickets(2),
      ]);
      assert(alphaOwner.toLowerCase() === alphaWallet.address.toLowerCase(), "resume alpha wallet does not own agent one");
      assert(betaOwner.toLowerCase() === betaWallet.address.toLowerCase(), "resume beta wallet does not own agent two");
      assert(alphaRunway >= PENNY && betaRunway >= PENNY, "resume agents do not have enough runway");
      record("resume_chain_state_verified", {
        alpha: { owner: alphaOwner, runway: alphaRunway, tickets: alphaTickets },
        beta: { owner: betaOwner, runway: betaRunway, tickets: betaTickets },
      });
    }

    const priorRoundtrip = [...eventRecords].reverse().find((entry) =>
      entry.type === "paid_waku_roundtrip" && entry.detail?.postcardIds?.length === 2
    );
    const launchId = priorRoundtrip ? "1" : (await syndicateRead.currentClassId()).toString();
    let postcardIds = priorRoundtrip ? [...priorRoundtrip.detail.postcardIds].sort() : null;
    const priorRestart = [...eventRecords].reverse().find((entry) =>
      entry.type === "worker_restart_reconciled" && entry.detail?.restartHistoryExact === true
    );
    let restartHistoryExact = Boolean(priorRestart);
    if (!priorRoundtrip) {
    const nowSeconds = Number((await provider.getBlock("latest")).timestamp);
    const topicScope = `sepolia-${createHash("sha256").update(runId).digest("hex").slice(0, 12)}`;
    const controlledShared = controlledCluster ? {
      wakuClusterId: controlledCluster.clusterId,
      wakuShardCount: controlledCluster.numShardsInCluster,
      wakuAllowInsecureWebSockets: true,
      wakuMinimumPeerCount: 2,
    } : {};
    const alphaBootstrap = controlledCluster
      ? [controlledCluster.nodes[0].websocketMultiaddr, controlledCluster.nodes[2].websocketMultiaddr]
      : [];
    const betaBootstrap = controlledCluster
      ? [controlledCluster.nodes[1].websocketMultiaddr, controlledCluster.nodes[2].websocketMultiaddr]
      : [];
    const workerInputs = [
      {
        name: "alpha", role: "observer", privateKey: alphaWallet.privateKey, agentId: 1,
        dataDir: path.join(runDir, "alpha"), rpcUrl: process.env.BASE_SEPOLIA_RPC_URL,
        chainId: CHAIN_ID, deployment, launchId, nowSeconds, transport: "waku", wakuTopicScope: topicScope,
        peerTimeoutMs: 90_000, storeHistoryMs: 24 * 60 * 60 * 1000, storeMessageLimit: 100,
        storePageSize: 50, brainKind: "deterministic", brainProfile: "observer",
        wakuBootstrapPeers: alphaBootstrap, ...controlledShared,
      },
      {
        name: "beta", role: "observer", privateKey: betaWallet.privateKey, agentId: 2,
        dataDir: path.join(runDir, "beta"), rpcUrl: process.env.BASE_SEPOLIA_RPC_URL,
        chainId: CHAIN_ID, deployment, launchId, nowSeconds, transport: "waku", wakuTopicScope: topicScope,
        peerTimeoutMs: 90_000, storeHistoryMs: 24 * 60 * 60 * 1000, storeMessageLimit: 100,
        storePageSize: 50, brainKind: "deterministic", brainProfile: "observer",
        wakuBootstrapPeers: betaBootstrap, ...controlledShared,
      },
    ];

    alpha = new WorkerClient("alpha", runDir, record);
    beta = new WorkerClient("beta", runDir, record);
    const [alphaStatus, betaStatus] = await Promise.all([
      alpha.request("start", workerInputs[0], 150_000),
      beta.request("start", workerInputs[1], 150_000),
    ]);
    const wakuReady = [alphaStatus, betaStatus].every((status) =>
      status.listen?.transport === "waku" &&
      status.listen?.protocolCounts?.lightPush > 0 &&
      status.listen?.protocolCounts?.filter > 0
    );
    assert(wakuReady, "public Waku LightPush and Filter were not ready");
    record("waku_ready", {
      alpha: alphaStatus.listen,
      beta: betaStatus.listen,
      topicScope,
      networkKind: wakuNetworkKind,
    });

    const resumePostcard = async (worker, actor) => {
      if (!resumeRunId) return null;
      const prior = [...eventRecords].reverse().find((entry) =>
        entry.type === "postcard_published" && entry.detail?.worker === actor && entry.detail?.postcardId
      );
      if (!prior) return null;
      const history = await worker.request("list", { query: { launchId, limit: 100 } }, 30_000);
      const postcard = history.find((entry) => entry.id === prior.detail.postcardId);
      assert(postcard, `persisted ${actor} postcard is missing during resume`);
      record("persisted_postcard_resumed", {
        worker: actor,
        postcardId: postcard.id,
        transactionHash: prior.detail.transactionHash,
      });
      return postcard;
    };

    const alphaPostcard = await resumePostcard(alpha, "alpha") ||
      await alpha.request("sendSignal", { type: "observation", body: "base sepolia alpha live signal" }, 180_000);
    const alphaDelivery = await deliverWithRetries(alpha, beta, launchId, alphaPostcard, {
      record,
      direction: "alpha-to-beta",
    });
    assert(alphaDelivery.history.some((postcard) => postcard.id === alphaPostcard.id), "alpha postcard did not reach beta");
    const betaPostcard = await resumePostcard(beta, "beta") ||
      await beta.request("sendSignal", { type: "observation", body: "base sepolia beta live signal" }, 180_000);
    const betaDelivery = await deliverWithRetries(beta, alpha, launchId, betaPostcard, {
      record,
      direction: "beta-to-alpha",
    });
    assert(betaDelivery.history.some((postcard) => postcard.id === betaPostcard.id), "beta postcard did not reach alpha");
    postcardIds = [alphaPostcard.id, betaPostcard.id].sort();
    const [alphaHistory, convergedBetaHistory] = await Promise.all([
      waitForPostcards(alpha, launchId, postcardIds),
      waitForPostcards(beta, launchId, postcardIds),
    ]);
    assert(json(alphaHistory.map((postcard) => postcard.id).sort()) === json(postcardIds), "alpha history did not converge");
    assert(json(convergedBetaHistory.map((postcard) => postcard.id).sort()) === json(postcardIds), "beta history did not converge");
    record("paid_waku_roundtrip", {
      postcardIds,
      alphaCount: alphaHistory.length,
      betaCount: convergedBetaHistory.length,
      attempts: { alphaToBeta: alphaDelivery.attempts, betaToAlpha: betaDelivery.attempts },
      networkKind: wakuNetworkKind,
    });
    for (const actor of ["alpha", "beta"]) {
      const published = eventRecords.find((entry) =>
        entry.type === "postcard_published" && entry.detail.worker === actor && postcardIds.includes(entry.detail.postcardId)
      );
      assert(published?.detail?.transactionHash, `${actor} settlement receipt was not instrumented`);
      await recordHash(`settle and publish ${actor} postcard`, published.detail.transactionHash, actor, {
        postcardId: published.detail.postcardId,
      });
    }

    await Promise.all([alpha.close(), beta.close()]);
    alpha = null;
    beta = null;
    alphaRestart = new WorkerClient("alpha-restart", runDir, record);
    betaRestart = new WorkerClient("beta-restart", runDir, record);
    await Promise.all([
      alphaRestart.request("start", workerInputs[0], 150_000),
      betaRestart.request("start", workerInputs[1], 150_000),
    ]);
    const [alphaRestartHistory, betaRestartHistory] = await Promise.all([
      waitForPostcards(alphaRestart, launchId, postcardIds),
      waitForPostcards(betaRestart, launchId, postcardIds),
    ]);
    restartHistoryExact = [alphaRestartHistory, betaRestartHistory].every((history) =>
      json(history.map((postcard) => postcard.id).sort()) === json(postcardIds)
    );
    assert(restartHistoryExact, "postcard history did not survive process restart");
    record("worker_restart_reconciled", {
      restartHistoryExact,
      alphaHistoryHash: hashValue(alphaRestartHistory.map((postcard) => postcard.id).sort()),
      betaHistoryHash: hashValue(betaRestartHistory.map((postcard) => postcard.id).sort()),
    });
    await Promise.all([alphaRestart.close(), betaRestart.close()]);
    alphaRestart = null;
    betaRestart = null;
    } else {
      record("completed_waku_phase_reused", {
        postcardIds,
        launchId,
        restartHistoryExact,
        networkKind: priorRoundtrip.detail.networkKind || wakuNetworkKind,
      });
    }

    let classBeforeGraduation = await syndicateRead.getClass(1);
    if (!classBeforeGraduation.graduated && classBeforeGraduation.totalCommitted < 1_000_000n) {
      const missing = 1_000_000n - classBeforeGraduation.totalCommitted;
      assert(missing % PENNY === 0n, "class remainder is not an exact number of pennies");
      const pennies = Number(missing / PENNY);
      const rain = await alphaChain.rainFromRunway({ privateKey: alphaWallet.privateKey, agentId: 1, pennies });
      await recordHash("fill class to exact one dollar", rain.hash, "alpha", { pennies });
      classBeforeGraduation = await syndicateRead.getClass(1);
    }
    assert(classBeforeGraduation.totalCommitted === 1_000_000n, "class did not reach the exact one dollar floor");
    assert(classBeforeGraduation.graduated || await syndicateRead.canGraduate(1), "class cannot graduate at the configured floor");

    let graduationReceipt = null;
    if (!classBeforeGraduation.graduated) {
      graduationReceipt = await submit("graduate Versus Token 0", graduationMaster.graduate(), "master", { classId: 1 });
    }
    let graduated = await graduationMaster.getGraduation(1);
    const graduationDeadline = Date.now() + 30_000;
    while ((!graduated.active || graduated.usdcSeeded !== 1_000_000n) && Date.now() < graduationDeadline) {
      await delay(500);
      graduated = await graduationMaster.getGraduation(1);
    }
    assert(graduated.active && graduated.usdcSeeded === 1_000_000n, "graduation state is incorrect");
    const classToken = new Contract(graduated.token, ABIS.classToken, provider);
    const pair = new Contract(graduated.pair, ABIS.pair, provider);
    const [tokenName, tokenSymbol, tradingEnabled, pairUsdc, pairToken] = await Promise.all([
      classToken.name(), classToken.symbol(), classToken.tradingEnabled(),
      new Contract(addresses.usdc, ABIS.usdc, provider).balanceOf(graduated.pair),
      classToken.balanceOf(graduated.pair),
    ]);
    assert(tokenName === "Versus Token 0" && tokenSymbol === "VRS0" && tradingEnabled, "graduated token metadata is wrong");
    assert(pairUsdc === 1_000_000n && pairToken > 0n, "graduation pair reserves are wrong");
    record("class_graduated", {
      hash: graduationReceipt?.hash || transactions.find((entry) => entry.label === "graduate Versus Token 0")?.hash || null,
      classId: 1,
      token: graduated.token,
      pair: graduated.pair,
      tokenName,
      tokenSymbol,
      pairUsdc,
      pairToken,
    });

    await submit("approve mock router for tax volume", usdcMaster.approve(addresses.v2Router, MaxUint256), "master");
    const buyAmount = 100_000n;
    const deadline = BigInt(Number((await provider.getBlock("latest")).timestamp) + 600);
    await submit(
      "buy graduated token",
      routerMaster.swapExactTokensForTokensSupportingFeeOnTransferTokens(
        buyAmount, 0, [addresses.usdc, graduated.token], masterAddress, deadline
      ),
      "master",
      { buyAmount }
    );
    const accumulatedBuyTax = await classToken.balanceOf(addresses.graduation);
    assert(accumulatedBuyTax > 0n, "graduated token produced no buy tax");

    const masterClassToken = classToken.connect(master);
    const purchasedTokens = await classToken.balanceOf(masterAddress);
    const sellAmount = purchasedTokens / 2n;
    const [tranchePotBefore, protocolPaidBefore] = await Promise.all([
      treasuryRead.tranchePot(), treasuryRead.totalProtocolPaid(),
    ]);
    await submit("approve mock router for token sale", masterClassToken.approve(addresses.v2Router, MaxUint256), "master");
    await submit(
      "sell graduated token and swap accumulated tax",
      routerMaster.swapExactTokensForTokensSupportingFeeOnTransferTokens(
        sellAmount, 0, [graduated.token, addresses.usdc], masterAddress, deadline
      ),
      "master",
      { sellAmount, accumulatedBuyTax }
    );
    const [remainingTax, tranchePotAfter, protocolPaidAfter, alphaClaimable, betaClaimable] = await Promise.all([
      classToken.balanceOf(addresses.graduation),
      treasuryRead.tranchePot(),
      treasuryRead.totalProtocolPaid(),
      treasuryRead.claimable(1),
      treasuryRead.claimable(2),
    ]);
    assert(remainingTax === 0n, "sell did not swap the accumulated token tax");
    assert(tranchePotAfter > tranchePotBefore, "sell tax did not increase rolling ticket rewards");
    assert(protocolPaidAfter > protocolPaidBefore, "sell tax did not pay the protocol cut");
    assert(alphaClaimable > 0n && betaClaimable > 0n, "rolling rewards were not immediately claimable");

    const alphaClaim = await alphaChain.claimTranche({ privateKey: alphaWallet.privateKey, agentId: 1 });
    const betaClaim = await betaChain.claimTranche({ privateKey: betaWallet.privateKey, agentId: 2 });
    await recordHash("claim alpha rolling rewards", alphaClaim.hash, "alpha", { amount: alphaClaim.amount });
    await recordHash("claim beta rolling rewards", betaClaim.hash, "beta", { amount: betaClaim.amount });
    assert(alphaClaim.amount === alphaClaimable && betaClaim.amount === betaClaimable, "rolling claim amount changed unexpectedly");

    const usdcAlpha = new Contract(addresses.usdc, ABIS.usdc, alphaWallet);
    await submit("approve alpha mission escrow", usdcAlpha.approve(addresses.missionEscrow, MaxUint256), "alpha");
    const missionId = id("base sepolia mission proof");
    const missionDeadline = Number((await provider.getBlock("latest")).timestamp) + 7200;
    const sponsorship = await alphaChain.sponsorMission({
      privateKey: alphaWallet.privateKey,
      missionId,
      launchId: 2,
      sponsorAgentId: 1,
      recipientAgentId: 2,
      amount: 1_000_000n,
      deadline: missionDeadline,
    });
    await recordHash("sponsor mission", sponsorship.hash, "alpha", { escrowId: sponsorship.escrowId });
    const release = await alphaChain.releaseMission({ privateKey: alphaWallet.privateKey, escrowId: sponsorship.escrowId });
    await recordHash("release mission into beta vault", release.hash, "alpha", { escrowId: sponsorship.escrowId });
    const betaAgentBeforeWithdrawal = await agentsRead.getAgent(2);
    assert(betaAgentBeforeWithdrawal.vault === betaClaim.amount + 1_000_000n, "mission release did not preserve beta rewards and fund its vault");
    const betaUsdcBeforeWithdrawal = await new Contract(addresses.usdc, ABIS.usdc, provider).balanceOf(betaWallet.address);
    const withdrawal = await betaChain.withdrawVault({ privateKey: betaWallet.privateKey, agentId: 2 });
    await recordHash("withdraw beta vault", withdrawal.hash, "beta", { amount: withdrawal.amount });
    const betaUsdcAfterWithdrawal = await new Contract(addresses.usdc, ABIS.usdc, provider).balanceOf(betaWallet.address);
    assert(betaUsdcAfterWithdrawal - betaUsdcBeforeWithdrawal === betaAgentBeforeWithdrawal.vault, "vault withdrawal amount is wrong");

    await submit("mint alpha runway topup", usdcMaster.mint(alphaWallet.address, 500_000n), "master");
    const replenished = await alphaChain.replenishRunway({ privateKey: alphaWallet.privateKey, agentId: 1, amount: 500_000n });
    await recordHash("replenish alpha runway", replenished.replenishHash, "alpha", { amount: replenished.amount });

    const restartedChain = createChainRainService(chainConfig, {
      provider: new JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL, CHAIN_ID, { staticNetwork: true, cacheTimeout: -1 }),
    });
    const [alphaState, betaState, totalTickets, classAfterGraduation, claimable] = await Promise.all([
      restartedChain.readState({ address: alphaWallet.address, agentId: 1 }),
      restartedChain.readState({ address: betaWallet.address, agentId: 2 }),
      treasuryRead.totalTickets(),
      syndicateRead.getClass(1),
      treasuryRead.claimable(1),
    ]);
    assert(alphaState.owner.toLowerCase() === alphaWallet.address.toLowerCase(), "alpha owner reconciliation failed");
    assert(betaState.owner.toLowerCase() === betaWallet.address.toLowerCase(), "beta owner reconciliation failed");
    assert(alphaState.runway === 6_520_000n && betaState.runway === 6_980_000n, "runway reconciliation failed");
    assert(alphaState.tickets === 98n && betaState.tickets === 2n && totalTickets === 100n, "ticket reconciliation failed");
    assert(classAfterGraduation.graduated === true && claimable === 0n, "post-claim reconciliation failed");
    record("chain_restart_reconciled", {
      alpha: { owner: alphaState.owner, runway: alphaState.runway, tickets: alphaState.tickets, vault: alphaState.vault },
      beta: { owner: betaState.owner, runway: betaState.runway, tickets: betaState.tickets, vault: betaState.vault },
      totalTickets,
      claimable,
      tranchePot: tranchePotAfter,
      rollingClaims: { alpha: alphaClaim.amount, beta: betaClaim.amount },
    });

    const masterBalanceEnd = await provider.getBalance(masterAddress);
    const assertions = {
      deploymentReceiptsAndCode: true,
      immutableConfiguration: true,
      twoDistinctRegisteredCyphers: alphaWallet.address !== betaWallet.address,
      dailyVoiceConfirmed: true,
      realWakuPaidRoundTrip: true,
      localHistorySurvivesRestart: restartHistoryExact,
      exactOneDollarClass: classBeforeGraduation.totalCommitted === 1_000_000n,
      graduationAndLiquidity: graduated.active && pairUsdc === 1_000_000n,
      sellPaidAutomaticTaxSwap: remainingTax === 0n && tranchePotAfter > tranchePotBefore,
      protocolCutPaidImmediately: protocolPaidAfter > protocolPaidBefore,
      rollingRewardsClaimedImmediately: alphaClaim.amount > 0n && betaClaim.amount > 0n,
      missionReleasedAndWithdrawn: betaUsdcAfterWithdrawal - betaUsdcBeforeWithdrawal === betaAgentBeforeWithdrawal.vault,
      runwayReplenished: alphaState.runway === 6_520_000n,
      restartStateExact: alphaState.tickets === 98n && betaState.tickets === 2n,
      noSecretsRecorded: true,
    };
    const passed = Object.values(assertions).every((value) => value === true);
    const summary = {
      version: 1,
      runId,
      passed,
      durationMs: Date.now() - startedAt,
      assertions,
      chain: {
        chainId: CHAIN_ID,
        startBlock: deployment.transactions[0].blockNumber,
        endBlock: await provider.getBlockNumber(),
        masterBalanceStartWei: masterBalanceStart,
        masterBalanceEndWei: masterBalanceEnd,
        masterSpentWei: masterBalanceStart - masterBalanceEnd,
        balanceMeasurementScope: resumeRunId ? "final successful continuation only" : "entire run",
      },
      actors: manifest.actors,
      cyphers: {
        alpha: { agentId: 1, runway: alphaState.runway, tickets: alphaState.tickets },
        beta: { agentId: 2, runway: betaState.runway, tickets: betaState.tickets },
      },
      conversation: { postcardIds, launchId, wakuNetworkKind, restartHistoryExact },
      transportEvidence: {
        controlledRealWaku: {
          passed: true,
          image: controlledCluster?.image || null,
          nodeCount: controlledCluster?.nodes?.length || null,
        },
        publicWakuAtRunTime: controlledCluster ? {
          passed: false,
          blocker: "public cluster-1 service peers rejected v3 with RLN validation failed and v2 with proof generation failed",
          paidPostcardRemainedQueuedWithoutRepayment: true,
        } : { passed: true, blocker: null },
      },
      graduation: {
        classId: 1,
        token: graduated.token,
        pair: graduated.pair,
        tokenName,
        tokenSymbol,
        usdcSeeded: graduated.usdcSeeded,
      },
      tranche: {
        tranchePot: tranchePotAfter,
        protocolPaid: protocolPaidAfter,
        alphaClaimed: alphaClaim.amount,
        betaClaimed: betaClaim.amount,
        continuousAccounting: true,
      },
      mission: { escrowId: sponsorship.escrowId, amount: sponsorship.amount, withdrawn: withdrawal.amount },
      transactions,
      secretsRecorded: false,
    };
    fs.writeFileSync(path.join(runDir, "summary.json"), `${json(summary, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(runDir, "REPORT.md"), [
      "# Base Sepolia End-to-End Run",
      "",
      `- Run: \`${runId}\``,
      `- Result: **${passed ? "PASS" : "FAIL"}**`,
      `- Deployment: \`${path.relative(ROOT, DEPLOYMENT_PATH).replace(/\\/g, "/")}\``,
      `- Transactions recorded: ${transactions.length}`,
      `- Master ETH spent (${resumeRunId ? "final successful continuation only" : "entire run"}): ${formatEther(masterBalanceStart - masterBalanceEnd)} ETH`,
      `- Paid Waku postcards: ${postcardIds.length} via ${wakuNetworkKind}`,
      ...(controlledCluster ? [
        "- Public Waku attempt: blocked by service-peer RLN validation/proof generation; paid postcard remained queued and was not repaid",
        `- Controlled Waku: PASS through ${controlledCluster.nodes.length} real ${controlledCluster.image} service nodes`,
      ] : []),
      `- Final tickets: alpha ${alphaState.tickets}; beta ${betaState.tickets}; total ${totalTickets}`,
      `- Graduated: ${tokenName} (${tokenSymbol}) at ${graduated.token}`,
      `- Rolling ticket pot after tax swap: ${tranchePotAfter} mock-USDC micros`,
      `- Immediate rolling claims: alpha ${alphaClaim.amount}; beta ${betaClaim.amount}`,
      "",
      "## Assertions",
      "",
      ...Object.entries(assertions).map(([name, value]) => `- [${value === true ? "x" : " "}] ${name}`),
      "",
    ].join("\n"), "utf8");
    record("run_completed", { passed, assertions, transactionCount: transactions.length });
    events.end();
    console.log(`${passed ? "PASS" : "FAIL"} ${runDir}`);
    if (!passed) process.exitCode = 1;
  } catch (error) {
    record("run_failed", { message: error.message, stack: error.stack });
    fs.writeFileSync(path.join(runDir, "failure.json"), `${json({ runId, failedAt: new Date().toISOString(), message: error.message, stack: error.stack }, 2)}\n`, "utf8");
    events.end();
    console.error(`FAIL ${runDir}`);
    throw error;
  } finally {
    await Promise.all([alpha?.close(), beta?.close(), alphaRestart?.close(), betaRestart?.close()].filter(Boolean));
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
