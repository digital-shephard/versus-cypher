#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { fork, spawn, spawnSync } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const { Contract, JsonRpcProvider, NonceManager, Wallet } = require("../../apps/pet/node_modules/ethers");
const { createChainRainService } = require("../../apps/pet/src/chain");

const ROOT = path.resolve(__dirname, "..", "..");
const VERSUS = path.join(ROOT, "versus");
const WORKER = path.join(__dirname, "cypher-worker.js");
const HARDHAT_CLI = path.join(VERSUS, "node_modules", "hardhat", "internal", "cli", "cli.js");
const RUN_ROOT = path.join(ROOT, "research", "network-runs");
const WAKU_COMPOSE = path.join(__dirname, "waku-cluster.compose.yml");
const HARDHAT_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const USDC_ABI = [
  "function mint(address to,uint256 amount)",
];
const ARENA_ABI = ["function runway(uint256 agentId) view returns (uint256)"];
const TREASURY_ABI = [
  "function tickets(uint256 agentId) view returns (uint256)",
  "function totalTickets() view returns (uint256)",
];
const SYNDICATE_ABI = [
  "function currentClassId() view returns (uint256)",
  "function getClass(uint256 classId) view returns (uint256 totalCommitted,uint32 participantCount,uint32 openedDay,bool graduated)",
];

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

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

function sourceRevision() {
  const hash = createHash("sha256");
  for (const file of [
    __filename,
    WORKER,
    path.join(ROOT, "packages", "network", "src", "waku-transport.js"),
    path.join(ROOT, "packages", "network", "src", "node.js"),
    path.join(ROOT, "apps", "pet", "src", "network.js"),
  ]) hash.update(fs.readFileSync(file));
  return `sha256:${hash.digest("hex").slice(0, 16)}`;
}

function redactLogChunk(chunk) {
  return String(chunk).replace(/(Private Key:\s*)0x[0-9a-f]{64}/gi, "$1[redacted-known-dev-key]");
}

function spawnLogged(command, args, { cwd, env, logPath }) {
  const stream = fs.createWriteStream(logPath, { flags: "a" });
  const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true });
  child.stdout.on("data", (chunk) => stream.write(redactLogChunk(chunk)));
  child.stderr.on("data", (chunk) => stream.write(redactLogChunk(chunk)));
  child.on("exit", (code, signal) => stream.write(`\nprocess exit code=${code} signal=${signal}\n`));
  return child;
}

async function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, shell: false, windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(output) : reject(new Error(`${command} exited ${code}\n${output}`)));
  });
}

async function waitForRpc(provider, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await provider.getBlockNumber(); return; } catch (_) {}
    await delay(250);
  }
  throw new Error("Hardhat RPC did not become ready");
}

async function waitForHttp(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await delay(250);
  }
  throw new Error(`HTTP health timed out for ${url}`);
}

async function restartControlledStoreNodes(cluster) {
  const result = spawnSync("docker", [
    "compose", "--project-name", "versus-waku-lab", "--file", WAKU_COMPOSE,
    "restart", "node1", "node2", "node3",
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      VERSUS_WAKU_NODE1: cluster.node1StaticMultiaddr,
      VERSUS_WAKU_STORE_RETENTION_SECONDS: String(cluster.storeRetention.seconds),
    },
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`controlled Store restart failed: ${result.stdout || ""}${result.stderr || ""}`);
  await Promise.all(cluster.nodes.map((node) => waitForHttp(`${node.restUrl}/debug/v1/info`)));
  await delay(2000);
}

async function recordTransaction(record, label, transactionPromise, detail = {}) {
  const receipt = await (await transactionPromise).wait();
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
      else pending.reject(Object.assign(new Error(message.error.message), message.error));
    });
    this.child.on("exit", (code) => {
      for (const pending of this.pending.values()) pending.reject(new Error(`${name} worker exited ${code}`));
      this.pending.clear();
    });
  }

  request(command, payload = {}, timeoutMs = 60_000) {
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
    try { await this.request("close", {}, 8000); } catch (_) {}
    if (this.child.connected) this.child.disconnect();
    if (!this.child.killed) this.child.kill();
  }
}

async function waitForIds(worker, launchId, ids, timeoutMs = 12_000) {
  const expected = new Set(ids);
  const deadline = Date.now() + timeoutMs;
  let history = [];
  while (Date.now() < deadline) {
    history = await worker.request("list", { query: { launchId, limit: 100 } });
    const found = new Set(history.map((postcard) => postcard.id));
    if ([...expected].every((id) => found.has(id))) return history;
    await delay(250);
  }
  return history;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function main() {
  const clusterStatePath = process.env.VERSUS_WAKU_CLUSTER_STATE
    ? path.resolve(process.env.VERSUS_WAKU_CLUSTER_STATE)
    : null;
  const controlledCluster = clusterStatePath
    ? JSON.parse(fs.readFileSync(clusterStatePath, "utf8"))
    : null;
  if (controlledCluster && (!Array.isArray(controlledCluster.nodes) || controlledCluster.nodes.length < 3)) {
    throw new Error("controlled Waku cluster state must contain at least three nodes");
  }
  const networkKind = controlledCluster ? "controlled" : "public";
  const expectStoreExpiry = process.env.VERSUS_WAKU_EXPECT_STORE_MISS === "1";
  const storeExpiryWaitMs = Number(process.env.VERSUS_WAKU_EXPIRY_WAIT_MS || 10_000);
  if (!Number.isInteger(storeExpiryWaitMs) || storeExpiryWaitMs < 0 || storeExpiryWaitMs > 120_000) {
    throw new RangeError("VERSUS_WAKU_EXPIRY_WAIT_MS must be between 0 and 120000");
  }
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-waku-${networkKind}-${randomUUID().slice(0, 8)}`;
  const topicScope = `run-${createHash("sha256").update(runId).digest("hex").slice(0, 12)}`;
  const seed = randomUUID();
  const revision = sourceRevision();
  const runDir = path.join(RUN_ROOT, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const eventRecords = [];
  const events = fs.createWriteStream(path.join(runDir, "events.jsonl"), { flags: "a" });
  const record = (type, detail = {}, at = Date.now()) => {
    const value = { runId, at, type, detail };
    eventRecords.push(value);
    events.write(`${JSON.stringify(value)}\n`);
  };
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const deploymentPath = path.join(runDir, "deployment.json");
  let hardhat = null;
  let alpha = null;
  let beta = null;
  let recovery = null;
  let tcpAlpha = null;
  let tcpRecovery = null;
  const startedAt = Date.now();

  try {
    fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify({
      version: 1,
      runId,
      seed,
      codeRevision: revision,
      startedAt: new Date(startedAt).toISOString(),
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      scenario: `two-agent-paid-${networkKind}-waku-round-trip`,
      transport: `${networkKind}-waku-only`,
      controlledCluster: controlledCluster ? {
        image: controlledCluster.image,
        clusterId: controlledCluster.clusterId,
        numShardsInCluster: controlledCluster.numShardsInCluster,
        shard: controlledCluster.shard,
        nodes: controlledCluster.nodes.map((node) => ({
          name: node.name,
          peerId: node.peerId,
          websocketMultiaddr: node.websocketMultiaddr,
        })),
      } : null,
      topicScope,
      targetPostcards: 20,
      maxApplicationAttempts: 4,
      expectStoreExpiry,
      storeExpiryWaitMs,
      chain: { kind: "hardhat", chainId: 31337, rpcPort: port },
      secretsRecorded: false,
    }, null, 2));
    record("run_started", { seed, codeRevision: revision, topicScope });

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

    const deployer = new NonceManager(new Wallet(HARDHAT_PRIVATE_KEY, provider));
    const usdc = new Contract(deployment.contracts.usdc, USDC_ABI, deployer);
    const wallets = [Wallet.createRandom().connect(provider), Wallet.createRandom().connect(provider)];
    for (let index = 0; index < wallets.length; index += 1) {
      const wallet = wallets[index];
      const name = index === 0 ? "alpha" : "beta";
      await recordTransaction(record, "fund_test_wallet", deployer.sendTransaction({
        to: wallet.address,
        value: 1_000_000_000_000_000_000n,
      }), { agent: name });
      await recordTransaction(record, "mint_mock_usdc", usdc.mint(wallet.address, 10_000_000n), { agent: name });
      const appChain = createChainRainService(
        { rpcUrl, deployment, env: { VERSUS_RPC_URL: rpcUrl } },
        { provider: new JsonRpcProvider(rpcUrl, 31337, { staticNetwork: true }) }
      );
      const hatch = await appChain.hatchWithRunway({
        privateKey: wallet.privateKey,
        runwayAmount: 7_000_000n,
      });
      record("chain_transaction", {
        label: "hatch_cypher",
        hash: hatch.hatchHash,
        blockNumber: hatch.blockNumber,
        gasUsed: hatch.gasUsed.toString(),
        status: 1,
        agent: name,
        productionAdapter: true,
      });
      const commit = await createChainRainService(
        { rpcUrl, deployment, env: { VERSUS_RPC_URL: rpcUrl } },
        { provider: new JsonRpcProvider(rpcUrl, 31337, { staticNetwork: true }) }
      ).commitDaily({ privateKey: wallet.privateKey, agentId: index + 1 });
      recordReceipt(record, "commit_daily_voice", commit, { agent: name, productionAdapter: true });
      record("cypher_hatched", { name, address: wallet.address, agentId: index + 1 });
    }

    const syndicate = new Contract(deployment.contracts.syndicate, SYNDICATE_ABI, provider);
    const launchId = (await syndicate.currentClassId()).toString();
    const nowSeconds = Number((await provider.getBlock("latest")).timestamp);
    const shared = {
      rpcUrl,
      chainId: 31337,
      deployment,
      launchId,
      nowSeconds,
      transport: "waku",
      wakuTopicScope: topicScope,
      peerTimeoutMs: 60_000,
      storeHistoryMs: 60 * 60 * 1000,
      storeMessageLimit: 100,
      storePageSize: 50,
      wakuClusterId: controlledCluster?.clusterId || 1,
      wakuShardCount: controlledCluster?.numShardsInCluster || 8,
      wakuAllowInsecureWebSockets: Boolean(controlledCluster),
    };
    const alphaBootstrap = controlledCluster
      ? [controlledCluster.nodes[0].websocketMultiaddr, controlledCluster.nodes[2].websocketMultiaddr]
      : [];
    const betaBootstrap = controlledCluster
      ? [controlledCluster.nodes[1].websocketMultiaddr, controlledCluster.nodes[2].websocketMultiaddr]
      : [];
    const workerInputs = [
      { ...shared, name: "alpha", role: "observer", privateKey: wallets[0].privateKey, agentId: 1, dataDir: path.join(runDir, "alpha"), wakuBootstrapPeers: alphaBootstrap },
      { ...shared, name: "beta", role: "observer", privateKey: wallets[1].privateKey, agentId: 2, dataDir: path.join(runDir, "beta"), wakuBootstrapPeers: betaBootstrap },
    ];
    alpha = new WorkerClient("alpha", runDir, record);
    beta = new WorkerClient("beta", runDir, record);
    const [alphaStatus, betaStatus] = await Promise.all([
      alpha.request("start", workerInputs[0], 90_000),
      beta.request("start", workerInputs[1], 90_000),
    ]);
    const statuses = [alphaStatus, betaStatus];
    const wakuOnly = statuses.every((status) => status.listen?.transport === "waku" && !status.listen?.url);
    const usableProtocols = statuses.every((status) =>
      status.listen?.protocolCounts?.lightPush > 0 && status.listen?.protocolCounts?.filter > 0
    );
    record("waku_workers_ready", {
      wakuOnly,
      usableProtocols,
      workers: statuses.map((status) => ({
        address: status.address,
        contentTopic: status.listen?.contentTopic,
        peerCount: status.listen?.peerCount,
        peers: status.listen?.peers,
        protocolCounts: status.listen?.protocolCounts,
      })),
    });
    if (!wakuOnly || !usableProtocols) throw new Error("workers did not establish Waku-only LightPush and Filter service");

    const deliveries = [];
    const send = async (sender, receiver, senderName, receiverName, ordinal) => {
      const postcard = await sender.request("sendSignal", {
        body: `public waku ${senderName} signal ${String(ordinal).padStart(2, "0")}`,
      }, 90_000);
      let attempts = 1;
      let history = await waitForIds(receiver, launchId, [postcard.id]);
      while (!history.some((entry) => entry.id === postcard.id) && attempts < 4) {
        attempts += 1;
        await sender.request("rebroadcast", { postcardId: postcard.id }, 60_000);
        history = await waitForIds(receiver, launchId, [postcard.id]);
      }
      if (!history.some((entry) => entry.id === postcard.id)) {
        throw new Error(`${postcard.id} did not reach ${receiverName} after ${attempts} attempts`);
      }
      const published = eventRecords.find((entry) =>
        entry.type === "waku_published" && entry.detail.worker === senderName && entry.detail.postcardId === postcard.id
      );
      const accepted = eventRecords.find((entry) =>
        entry.type === "postcard_accepted" && entry.detail.worker === receiverName &&
        entry.detail.postcardId === postcard.id && entry.detail.source === "peer"
      );
      const latencyMs = published && accepted ? Math.max(0, accepted.at - published.detail.startedAt) : null;
      const delivery = { postcardId: postcard.id, sender: senderName, receiver: receiverName, attempts, latencyMs };
      deliveries.push(delivery);
      record("delivery_confirmed", delivery);
      await delay(350);
      return postcard;
    };

    const alphaCards = [];
    const betaCards = [];
    for (let index = 1; index <= 10; index += 1) {
      alphaCards.push(await send(alpha, beta, "alpha", "beta", index));
    }
    for (let index = 1; index <= 10; index += 1) {
      betaCards.push(await send(beta, alpha, "beta", "alpha", index));
    }
    const expectedIds = [...alphaCards, ...betaCards].map((postcard) => postcard.id);
    const histories = await Promise.all([
      waitForIds(alpha, launchId, expectedIds, 20_000),
      waitForIds(beta, launchId, expectedIds, 20_000),
    ]);

    await Promise.all([
      alpha.request("rebroadcast", { postcardId: alphaCards[0].id }),
      beta.request("rebroadcast", { postcardId: betaCards[0].id }),
    ]);
    await delay(4000);
    const historiesAfterDuplicates = await Promise.all([
      alpha.request("list", { query: { launchId, limit: 100 } }),
      beta.request("list", { query: { launchId, limit: 100 } }),
    ]);

    const unpaid = await alpha.request("broadcastUnpaid", { body: "public waku unpaid validation probe" });
    await delay(5000);
    const betaAfterUnpaid = await beta.request("list", { query: { launchId, limit: 100 } });
    await beta.request("tick", {}, 60_000);
    const unpaidRejected = eventRecords.some((entry) =>
      entry.type === "postcard_rejected" && entry.detail.worker === "beta" &&
      entry.detail.postcardId === unpaid.id && entry.detail.code === "MISSING_PAYMENT_PROOF"
    );
    const unpaidReachedBrain = eventRecords.some((entry) =>
      entry.type === "brain_context" && entry.detail.worker === "beta" &&
      entry.detail.newPostcards.includes(unpaid.id)
    );
    record("invalid_admission_probe", {
      postcardId: unpaid.id,
      rejected: unpaidRejected,
      enteredHistory: betaAfterUnpaid.some((postcard) => postcard.id === unpaid.id),
      reachedBrain: unpaidReachedBrain,
    });

    await delay(expectStoreExpiry ? storeExpiryWaitMs : 5000);
    await beta.close();
    beta = null;
    if (expectStoreExpiry) await restartControlledStoreNodes(controlledCluster);
    recovery = new WorkerClient("beta-recovery", runDir, record);
    const recoveryInput = {
      ...workerInputs[1],
      name: "beta-recovery",
      dataDir: path.join(runDir, "beta-recovery"),
    };
    const recoveryStatus = await recovery.request("start", recoveryInput, 90_000);
    const storeRecovery = await recovery.request("history", {}, 90_000);
    const storeRecoveredHistory = await waitForIds(recovery, launchId, expectedIds, expectStoreExpiry ? 2000 : 20_000);
    record("store_recovery_measured", {
      listen: recoveryStatus.listen,
      result: storeRecovery.result,
      acceptedCount: storeRecoveredHistory.length,
      acceptedIds: storeRecoveredHistory.map((postcard) => postcard.id),
    });
    let recoveredHistory = storeRecoveredHistory;
    let cypherHistoryRecovery = null;
    if (expectStoreExpiry) {
      if (storeRecoveredHistory.length !== 0) {
        throw new Error(`expected expired Waku Store history but recovered ${storeRecoveredHistory.length} records`);
      }
      await alpha.close();
      alpha = null;
      await recovery.close();
      recovery = null;
      tcpAlpha = new WorkerClient("alpha-history-source", runDir, record);
      tcpRecovery = new WorkerClient("beta-history-recovery", runDir, record);
      const [tcpAlphaStatus] = await Promise.all([
        tcpAlpha.request("start", { ...workerInputs[0], transport: "tcp" }, 90_000),
        tcpRecovery.request("start", { ...recoveryInput, transport: "tcp" }, 90_000),
      ]);
      await tcpRecovery.request("connect", { url: tcpAlphaStatus.listen.url }, 30_000);
      recoveredHistory = await waitForIds(tcpRecovery, launchId, expectedIds, 20_000);
      cypherHistoryRecovery = {
        recoveredCount: recoveredHistory.length,
        recoveredIds: recoveredHistory.map((postcard) => postcard.id),
        transport: "authenticated-tcp-cypher-history-sync",
      };
      record("cypher_history_recovery", cypherHistoryRecovery);
      if (recoveredHistory.length !== expectedIds.length) {
        throw new Error(`Cypher history sync recovered ${recoveredHistory.length}/${expectedIds.length} expired Store records`);
      }
    }

    const arena = new Contract(deployment.contracts.arena, ARENA_ABI, provider);
    const treasury = new Contract(deployment.contracts.treasury, TREASURY_ABI, provider);
    const cls = await syndicate.getClass(launchId);
    const chain = {
      classPotMicros: cls.totalCommitted.toString(),
      participantCount: Number(cls.participantCount),
      alphaRunway: (await arena.runway(1)).toString(),
      betaRunway: (await arena.runway(2)).toString(),
      alphaTickets: (await treasury.tickets(1)).toString(),
      betaTickets: (await treasury.tickets(2)).toString(),
      totalTickets: (await treasury.totalTickets()).toString(),
    };
    const latencies = deliveries.map((delivery) => delivery.latencyMs).filter(Number.isFinite);
    const retryCount = deliveries.reduce((sum, delivery) => sum + delivery.attempts - 1, 0);
    const exactHistories = historiesAfterDuplicates.every((history) =>
      history.length === 20 && new Set(history.map((postcard) => postcard.id)).size === 20
    );
    const recoveryPass = expectStoreExpiry
      ? storeRecoveredHistory.length === 0 && recoveredHistory.length === 20
      : recoveredHistory.length === 20;
    const passed = Boolean(
      wakuOnly && usableProtocols && deliveries.length === 20 &&
      exactHistories && unpaidRejected && !unpaidReachedBrain &&
      recoveryPass &&
      !betaAfterUnpaid.some((postcard) => postcard.id === unpaid.id) &&
      chain.alphaTickets === "11" && chain.betaTickets === "11" && chain.classPotMicros === "220000"
    );
    const summary = {
      version: 1,
      runId,
      passed,
      durationMs: Date.now() - startedAt,
      topicScope,
      wakuOnly,
      usableProtocols,
      deliveries,
      latencyMs: {
        count: latencies.length,
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        max: latencies.length ? Math.max(...latencies) : null,
      },
      retryCount,
      acceptedHistoryCounts: historiesAfterDuplicates.map((history) => history.length),
      duplicateAcceptedRecords: historiesAfterDuplicates.map((history) => history.length - new Set(history.map((postcard) => postcard.id)).size),
      invalidProbe: { postcardId: unpaid.id, rejected: unpaidRejected, reachedBrain: unpaidReachedBrain },
      storeRecovery: {
        result: storeRecovery.result,
        acceptedCount: storeRecoveredHistory.length,
      },
      cypherHistoryRecovery,
      chain,
    };
    fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
    fs.writeFileSync(
      path.join(runDir, "metrics.csv"),
      "run_id,passed,deliveries,retries,p50_ms,p95_ms,max_ms,alpha_records,beta_records,store_recovered,cypher_sync_recovered,class_pot_micros\n" +
      `${runId},${passed},${deliveries.length},${retryCount},${summary.latencyMs.p50},${summary.latencyMs.p95},${summary.latencyMs.max},${historiesAfterDuplicates[0].length},${historiesAfterDuplicates[1].length},${storeRecoveredHistory.length},${cypherHistoryRecovery?.recoveredCount || 0},${chain.classPotMicros}\n`
    );
    fs.writeFileSync(path.join(runDir, "REPORT.md"), `# ${controlledCluster ? "Controlled" : "Public"} Waku E2E\n\n- Run: \`${runId}\`\n- Revision: \`${revision}\`\n- Result: **${passed ? "PASS" : "FAIL"}**\n- Topic scope: \`${topicScope}\`\n- Paid deliveries: ${deliveries.length}/20\n- Application retries: ${retryCount}\n- Latency p50/p95/max: ${summary.latencyMs.p50}/${summary.latencyMs.p95}/${summary.latencyMs.max} ms\n- Exact accepted histories: ${historiesAfterDuplicates.map((history) => history.length).join("/")}\n- Unpaid probe rejected before brain: ${unpaidRejected && !unpaidReachedBrain}\n- ${controlledCluster ? "Controlled" : "Public"} Store observed recovery: ${storeRecoveredHistory.length}/20 accepted records (${storeRecovery.result.error || "no query error"})\n- Cypher history recovery after Store expiry: ${cypherHistoryRecovery ? `${cypherHistoryRecovery.recoveredCount}/20` : "not requested"}\n- Tickets: alpha ${chain.alphaTickets}, beta ${chain.betaTickets}; class pot ${chain.classPotMicros} micros\n`);
    record("run_completed", { passed, summary });
    if (!passed) throw new Error(`public Waku E2E assertions failed; see ${runDir}`);
    console.log(`PASS ${runDir}`);
  } finally {
    await Promise.all([alpha?.close(), beta?.close(), recovery?.close(), tcpAlpha?.close(), tcpRecovery?.close()]);
    if (hardhat && !hardhat.killed) hardhat.kill();
    events.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
