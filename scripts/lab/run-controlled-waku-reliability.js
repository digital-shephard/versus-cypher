#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { fork, spawn, spawnSync } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const { Contract, JsonRpcProvider, NonceManager, Wallet } = require("../../apps/pet/node_modules/ethers");
const { createChainRainService } = require("../../apps/pet/src/chain");

const ROOT = path.resolve(__dirname, "..", "..");
const VERSUS = path.join(ROOT, "versus");
const WORKER = path.join(__dirname, "cypher-worker.js");
const CLUSTER_STATE = path.join(ROOT, "research", "waku-lab", "cluster.json");
const COMPOSE = path.join(__dirname, "waku-cluster.compose.yml");
const RUN_ROOT = path.join(ROOT, "research", "network-runs");
const HARDHAT_CLI = path.join(VERSUS, "node_modules", "hardhat", "internal", "cli", "cli.js");
const HARDHAT_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const PROJECT = "versus-waku-lab";
const NETWORK = `${PROJECT}_versus-waku`;
const CONTAINERS = {
  node1: `${PROJECT}-node1-1`,
  node2: `${PROJECT}-node2-1`,
  node3: `${PROJECT}-node3-1`,
};
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

let composeEnvironment = process.env;

function docker(args, { allowFailure = false, env = process.env } = {}) {
  const result = spawnSync("docker", args, { cwd: ROOT, env, encoding: "utf8", windowsHide: true });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`docker ${args.join(" ")} failed\n${result.stdout || ""}${result.stderr || ""}`);
  }
  return { status: result.status, output: `${result.stdout || ""}${result.stderr || ""}`.trim() };
}

function compose(args) {
  return docker(["compose", "--project-name", PROJECT, "--file", COMPOSE, ...args], {
    env: composeEnvironment,
  });
}

async function waitForUrl(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) { lastError = error; }
    await delay(250);
  }
  throw new Error(`${url} did not become healthy: ${lastError?.message || "unknown"}`);
}

async function connectAdminPeer(restUrl, multiaddr) {
  const response = await fetch(`${restUrl}/admin/v1/peers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([multiaddr]),
  });
  if (!response.ok) throw new Error(`Waku admin peer connect failed with HTTP ${response.status}: ${await response.text()}`);
}

async function waitForAdminPeer(restUrl, peerId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${restUrl}/admin/v1/peers`);
      if (response.ok) {
        const value = await response.json();
        const peers = Array.isArray(value) ? value : value ? [value] : [];
        if (peers.some((peer) => peer.connected === "Connected" && String(peer.multiaddr || "").endsWith(`/p2p/${peerId}`))) return;
      }
    } catch {}
    await delay(250);
  }
  throw new Error(`Waku service at ${restUrl} did not connect to ${peerId}`);
}

async function waitForRpc(provider, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await provider.getBlockNumber(); return; } catch (_) {}
    await delay(200);
  }
  throw new Error("Hardhat RPC did not become ready");
}

async function createRpcProxy(upstream, runDir, record) {
  let mode = "online";
  const port = await freePort();
  const eventsPath = path.join(runDir, "rpc-events.jsonl");
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", async () => {
      const startedAt = Date.now();
      let parsed = null;
      try { parsed = JSON.parse(body); } catch (_) {}
      const calls = Array.isArray(parsed) ? parsed : [parsed];
      const methods = calls.filter(Boolean).map((call) => String(call.method || "unknown")).slice(0, 100);
      if (mode === "offline") {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: parsed?.id ?? null, error: { code: -32098, message: "controlled rpc offline" } }));
        fs.appendFileSync(eventsPath, `${JSON.stringify({ at: startedAt, mode, methods, status: 503, bodyBytes: Buffer.byteLength(body) })}\n`);
        return;
      }
      try {
        const upstreamResponse = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body });
        const responseBody = await upstreamResponse.text();
        response.writeHead(upstreamResponse.status, { "content-type": "application/json" });
        response.end(responseBody);
        fs.appendFileSync(eventsPath, `${JSON.stringify({ at: startedAt, mode, methods, status: upstreamResponse.status, bodyBytes: Buffer.byteLength(body), latencyMs: Date.now() - startedAt })}\n`);
      } catch (error) {
        response.writeHead(502, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: parsed?.id ?? null, error: { code: -32097, message: "controlled rpc upstream unavailable" } }));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const setMode = (next) => {
    mode = next;
    record("rpc_mode", { mode });
  };
  return {
    url: `http://127.0.0.1:${port}`,
    setMode,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

class WorkerClient {
  constructor(label, runDir, record) {
    this.label = label;
    this.nextId = 1;
    this.pending = new Map();
    this.child = fork(WORKER, [], { cwd: ROOT, silent: true, env: { ...process.env } });
    const log = fs.createWriteStream(path.join(runDir, `${label}.log`), { flags: "a" });
    this.child.stdout.pipe(log);
    this.child.stderr.pipe(log);
    this.child.on("message", (message) => {
      if (message?.kind === "event") {
        record(message.type, { workerProcess: label, worker: message.worker, ...message.detail }, message.at);
        return;
      }
      if (message?.kind !== "response") return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(Object.assign(new Error(message.error.message), message.error));
    });
    this.child.on("exit", (code, signal) => {
      for (const pending of this.pending.values()) pending.reject(new Error(`${label} worker exited ${code}/${signal}`));
      this.pending.clear();
      record("worker_process_exit", { workerProcess: label, code, signal });
    });
    this.child.on("error", (error) => {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      record("worker_process_error", { workerProcess: label, message: error.message, code: error.code || null });
    });
  }

  request(command, payload = {}, timeoutMs = 60_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!this.child.connected) {
        reject(new Error(`${this.label} worker IPC channel is closed`));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.label} ${command} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.child.send({ kind: "command", id, command, payload }, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  kill() {
    if (!this.child.killed) this.child.kill("SIGKILL");
  }

  async close() {
    try { await this.request("close", {}, 8000); } catch (_) {}
    if (this.child.connected) this.child.disconnect();
    if (!this.child.killed) this.child.kill();
  }
}

async function waitForIds(worker, launchId, ids, timeoutMs = 15_000) {
  const expected = new Set(ids);
  const deadline = Date.now() + timeoutMs;
  let history = [];
  while (Date.now() < deadline) {
    history = await worker.request("list", { query: { launchId, limit: 10_000 } });
    const found = new Set(history.map((postcard) => postcard.id));
    if ([...expected].every((id) => found.has(id))) return history;
    await delay(200);
  }
  return history;
}

function idsOf(history) { return history.map((postcard) => postcard.id).sort(); }
function sameIds(left, right) { return JSON.stringify(idsOf(left)) === JSON.stringify(idsOf(right)); }

async function main() {
  if (!fs.existsSync(CLUSTER_STATE)) throw new Error("Start the controlled Waku cluster first");
  const cluster = JSON.parse(fs.readFileSync(CLUSTER_STATE, "utf8"));
  composeEnvironment = {
    ...process.env,
    VERSUS_WAKU_NODE1: cluster.node1StaticMultiaddr,
  };
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-waku-reliability-${randomUUID().slice(0, 8)}`;
  const topicScope = `fault-${createHash("sha256").update(runId).digest("hex").slice(0, 12)}`;
  const runDir = path.join(RUN_ROOT, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const eventRecords = [];
  const events = fs.createWriteStream(path.join(runDir, "events.jsonl"), { flags: "a" });
  const record = (type, detail = {}, at = Date.now()) => {
    const value = { runId, at, type, detail };
    eventRecords.push(value);
    events.write(`${JSON.stringify(value)}\n`);
  };
  const startedAt = Date.now();
  const rpcPort = await freePort();
  const directRpcUrl = `http://127.0.0.1:${rpcPort}`;
  const deploymentPath = path.join(runDir, "deployment.json");
  let hardhat = null;
  let rpcProxy = null;
  const workers = new Map();
  let clusterAltered = false;

  try {
    for (const node of cluster.nodes) await waitForUrl(`${node.restUrl}/debug/v1/info`, 5000);
    fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify({
      version: 1,
      runId,
      codeRevision: sourceRevision(),
      startedAt: new Date(startedAt).toISOString(),
      scenario: "controlled-waku-destructive-reliability",
      topicScope,
      cluster: {
        image: cluster.image,
        dockerVersion: cluster.dockerVersion,
        clusterId: cluster.clusterId,
        numShardsInCluster: cluster.numShardsInCluster,
        nodes: cluster.nodes.map((node) => ({ name: node.name, peerId: node.peerId, websocketMultiaddr: node.websocketMultiaddr })),
      },
      faults: ["relay-kill", "publisher-crash", "filter-failover", "partition-heal", "drop-delay-duplicate-reorder", "process-restart", "rpc-outage"],
      secretsRecorded: false,
    }, null, 2));
    record("run_started", { topicScope, codeRevision: sourceRevision() });

    hardhat = spawnLogged(process.execPath, [HARDHAT_CLI, "node", "--hostname", "127.0.0.1", "--port", String(rpcPort)], {
      cwd: VERSUS,
      env: { ...process.env },
      logPath: path.join(runDir, "hardhat.log"),
    });
    const directProvider = new JsonRpcProvider(directRpcUrl, 31337, { staticNetwork: true, cacheTimeout: -1 });
    await waitForRpc(directProvider);
    record("rpc_ready", { blockNumber: await directProvider.getBlockNumber() });
    rpcProxy = await createRpcProxy(directRpcUrl, runDir, record);

    const deployOutput = await runProcess(process.execPath, [HARDHAT_CLI, "run", "scripts/deploy.js", "--network", "localhost"], {
      cwd: VERSUS,
      env: { ...process.env, LOCAL_RPC_URL: directRpcUrl, VERSUS_DEPLOYMENT_OUT: deploymentPath },
    });
    fs.writeFileSync(path.join(runDir, "deploy.log"), deployOutput, "utf8");
    const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
    record("contracts_deployed", { contracts: deployment.contracts });

    const deployer = new NonceManager(new Wallet(HARDHAT_PRIVATE_KEY, directProvider));
    const usdc = new Contract(deployment.contracts.usdc, USDC_ABI, deployer);
    const wallets = Array.from({ length: 4 }, () => Wallet.createRandom().connect(directProvider));
    const names = ["alpha", "beta", "partition-alpha", "partition-beta"];
    for (let index = 0; index < wallets.length; index += 1) {
      const wallet = wallets[index];
      await (await deployer.sendTransaction({ to: wallet.address, value: 1_000_000_000_000_000_000n })).wait();
      await (await usdc.mint(wallet.address, 10_000_000n)).wait();
      const chain = createChainRainService({ rpcUrl: directRpcUrl, deployment, env: { VERSUS_RPC_URL: directRpcUrl } }, {
        provider: new JsonRpcProvider(directRpcUrl, 31337, { staticNetwork: true, cacheTimeout: -1 }),
      });
      const hatch = await chain.hatchWithRunway({ privateKey: wallet.privateKey, cypherId: index + 9, runwayAmount: 7_000_000n });
      const commit = await chain.commitDaily({ privateKey: wallet.privateKey, agentId: index + 1 });
      record("cypher_ready", { name: names[index], address: wallet.address, agentId: index + 1, hatchHash: hatch.hatchHash, commitHash: commit.hash });
    }

    const syndicate = new Contract(deployment.contracts.syndicate, SYNDICATE_ABI, directProvider);
    const arena = new Contract(deployment.contracts.arena, ARENA_ABI, directProvider);
    const treasury = new Contract(deployment.contracts.treasury, TREASURY_ABI, directProvider);
    const launchId = (await syndicate.currentClassId()).toString();
    const nowSeconds = Number((await directProvider.getBlock("latest")).timestamp);
    const shared = {
      rpcUrl: rpcProxy.url,
      chainId: 31337,
      deployment,
      launchId,
      nowSeconds,
      transport: "waku",
      wakuTopicScope: topicScope,
      wakuClusterId: cluster.clusterId,
      wakuShardCount: cluster.numShardsInCluster,
      wakuAllowInsecureWebSockets: true,
      peerTimeoutMs: 45_000,
      storeHistoryMs: 60 * 60 * 1000,
      storeMessageLimit: 1000,
      storePageSize: 100,
    };
    const inputs = {
      alpha: { ...shared, name: "alpha", role: "observer", privateKey: wallets[0].privateKey, agentId: 1, dataDir: path.join(runDir, "alpha"), wakuMinimumPeerCount: 2, wakuBootstrapPeers: [cluster.nodes[0].websocketMultiaddr, cluster.nodes[2].websocketMultiaddr] },
      beta: { ...shared, name: "beta", role: "observer", privateKey: wallets[1].privateKey, agentId: 2, dataDir: path.join(runDir, "beta"), wakuMinimumPeerCount: 2, wakuBootstrapPeers: [cluster.nodes[1].websocketMultiaddr, cluster.nodes[2].websocketMultiaddr] },
      partitionAlpha: { ...shared, name: "partition-alpha", role: "observer", privateKey: wallets[2].privateKey, agentId: 3, dataDir: path.join(runDir, "partition-alpha"), wakuMinimumPeerCount: 1, wakuBootstrapPeers: [cluster.nodes[0].websocketMultiaddr] },
      partitionBeta: { ...shared, name: "partition-beta", role: "observer", privateKey: wallets[3].privateKey, agentId: 4, dataDir: path.join(runDir, "partition-beta"), wakuMinimumPeerCount: 1, wakuBootstrapPeers: [cluster.nodes[1].websocketMultiaddr] },
    };
    for (const key of Object.keys(inputs)) workers.set(key, new WorkerClient(key, runDir, record));
    const startResults = await Promise.all([...workers.entries()].map(([key, worker]) => worker.request("start", inputs[key], 90_000)));
    const pinnedReady = startResults.every((status) => status.listen?.transport === "waku" && status.listen?.protocolCounts?.lightPush > 0 && status.listen?.protocolCounts?.filter > 0);
    if (!pinnedReady) throw new Error("controlled workers did not establish pinned Waku services");
    record("workers_ready", { workers: startResults.map((status) => ({ address: status.address, listen: status.listen })) });

    const chainSnapshot = async () => {
      const cls = await syndicate.getClass(launchId);
      return {
        blockNumber: await directProvider.getBlockNumber(),
        classPotMicros: cls.totalCommitted.toString(),
        totalTickets: (await treasury.totalTickets()).toString(),
        tickets: await Promise.all([1, 2, 3, 4].map(async (id) => (await treasury.tickets(id)).toString())),
        runway: await Promise.all([1, 2, 3, 4].map(async (id) => (await arena.runway(id)).toString())),
      };
    };
    const sendAndRequire = async (senderKey, receiverKey, body) => {
      const postcard = await workers.get(senderKey).request("sendSignal", { body }, 60_000);
      const history = await waitForIds(workers.get(receiverKey), launchId, [postcard.id]);
      if (!history.some((entry) => entry.id === postcard.id)) throw new Error(`${body} was not delivered`);
      return postcard;
    };

    const baseline = await sendAndRequire("alpha", "beta", "controlled baseline signal");
    record("scenario_pass", { scenario: "normal_two_way", postcardId: baseline.id });

    compose(["kill", "node1"]);
    clusterAltered = true;
    record("fault_injected", { scenario: "relay_kill", node: "node1" });
    await delay(1800);
    const relayFailover = await sendAndRequire("alpha", "beta", "relay failover signal");
    record("scenario_pass", { scenario: "relay_kill", postcardId: relayFailover.id });
    compose(["start", "node1"]);
    await waitForUrl(`${cluster.nodes[0].restUrl}/debug/v1/info`);
    await Promise.all([
      connectAdminPeer(cluster.nodes[1].restUrl, cluster.node1StaticMultiaddr),
      connectAdminPeer(cluster.nodes[2].restUrl, cluster.node1StaticMultiaddr),
    ]);
    await Promise.all([
      waitForAdminPeer(cluster.nodes[1].restUrl, cluster.nodes[0].peerId),
      waitForAdminPeer(cluster.nodes[2].restUrl, cluster.nodes[0].peerId),
    ]);
    await Promise.all([
      workers.get("alpha").request("connect", { url: cluster.nodes[0].websocketMultiaddr }),
      workers.get("partitionAlpha").request("connect", { url: cluster.nodes[0].websocketMultiaddr }),
    ]);
    await delay(1000);
    record("fault_recovered", { scenario: "relay_kill", node: "node1" });

    compose(["kill", "node2"]);
    record("fault_injected", { scenario: "filter_failover", node: "node2" });
    await delay(1800);
    const filterFailover = await sendAndRequire("beta", "alpha", "filter failover signal");
    record("scenario_pass", { scenario: "filter_failover", postcardId: filterFailover.id });
    compose(["start", "node2"]);
    await waitForUrl(`${cluster.nodes[1].restUrl}/debug/v1/info`);
    await connectAdminPeer(cluster.nodes[1].restUrl, cluster.node1StaticMultiaddr);
    await waitForAdminPeer(cluster.nodes[1].restUrl, cluster.nodes[0].peerId);
    await Promise.all([
      workers.get("beta").request("connect", { url: cluster.nodes[1].websocketMultiaddr }),
      workers.get("partitionBeta").request("connect", { url: cluster.nodes[1].websocketMultiaddr }),
    ]);
    record("fault_recovered", { scenario: "filter_failover", node: "node2" });

    const beforeCrash = await chainSnapshot();
    const crashStaged = await workers.get("alpha").request("preparePaidSignal", { body: "publisher crash recovery signal" }, 60_000);
    const afterCrashSettlement = await chainSnapshot();
    workers.get("alpha").kill();
    workers.delete("alpha");
    await delay(500);
    const alphaRestarted = new WorkerClient("alpha-restarted", runDir, record);
    workers.set("alpha", alphaRestarted);
    await alphaRestarted.request("start", inputs.alpha, 90_000);
    const pending = await alphaRestarted.request("publishPending", {}, 60_000);
    const crashHistory = await waitForIds(workers.get("beta"), launchId, [crashStaged.postcard.id]);
    const afterCrashPublish = await chainSnapshot();
    const crashRecovered = crashHistory.some((entry) => entry.id === crashStaged.postcard.id) && pending.postcardIds.includes(crashStaged.postcard.id);
    const noCrashDoubleSettlement = afterCrashSettlement.totalTickets === afterCrashPublish.totalTickets && BigInt(afterCrashSettlement.totalTickets) === BigInt(beforeCrash.totalTickets) + 1n;
    if (!crashRecovered || !noCrashDoubleSettlement) throw new Error("publisher crash recovery failed or double-settled");
    record("scenario_pass", { scenario: "publisher_crash", postcardId: crashStaged.postcard.id, noDoubleSettlement: true });

    const dropped = await alphaRestarted.request("preparePaidSignal", { body: "controlled dropped boundary signal" }, 60_000);
    await delay(1200);
    const beforeRetry = await workers.get("beta").request("list", { query: { launchId, limit: 10_000 } });
    if (beforeRetry.some((entry) => entry.id === dropped.postcard.id)) throw new Error("dropped postcard arrived before retry");
    await alphaRestarted.request("publishStaged", { postcardId: dropped.postcard.id });
    const dropRecovered = await waitForIds(workers.get("beta"), launchId, [dropped.postcard.id]);
    if (!dropRecovered.some((entry) => entry.id === dropped.postcard.id)) throw new Error("dropped postcard retry failed");
    record("scenario_pass", { scenario: "drop_and_retry", postcardId: dropped.postcard.id, delayMs: 1200 });

    const staged = [];
    for (const word of ["first", "second", "third"]) {
      staged.push(await alphaRestarted.request("preparePaidSignal", { body: `controlled reorder ${word} signal` }, 60_000));
    }
    const reversed = [...staged].reverse();
    for (const entry of reversed) {
      await alphaRestarted.request("publishStaged", { postcardId: entry.postcard.id });
      await delay(120);
    }
    const reorderIds = staged.map((entry) => entry.postcard.id);
    const reorderedHistory = await waitForIds(workers.get("beta"), launchId, reorderIds);
    if (!reorderIds.every((id) => reorderedHistory.some((entry) => entry.id === id))) throw new Error("reordered postcards did not converge");
    const duplicateTarget = staged[0].postcard.id;
    await alphaRestarted.request("rebroadcast", { postcardId: duplicateTarget });
    await alphaRestarted.request("rebroadcast", { postcardId: duplicateTarget });
    await delay(800);
    const afterDuplicates = await workers.get("beta").request("list", { query: { launchId, limit: 10_000 } });
    if (afterDuplicates.filter((entry) => entry.id === duplicateTarget).length !== 1) throw new Error("duplicate delivery created duplicate history");
    record("scenario_pass", { scenario: "delay_duplicate_reorder", postcardIds: reorderIds, duplicateAccepted: 1 });

    const partitionBaseline = await sendAndRequire("partitionAlpha", "partitionBeta", "partition baseline signal");
    record("partition_baseline", { postcardId: partitionBaseline.id });
    docker(["network", "disconnect", NETWORK, CONTAINERS.node1]);
    record("fault_injected", { scenario: "relay_partition", container: CONTAINERS.node1 });
    await delay(1000);
    const partitioned = await workers.get("partitionAlpha").request("sendSignal", { body: "partition held signal" }, 60_000);
    await delay(1500);
    const duringPartition = await workers.get("partitionBeta").request("list", { query: { launchId, limit: 10_000 } });
    const blockedDuringPartition = !duringPartition.some((entry) => entry.id === partitioned.id);
    if (!blockedDuringPartition) throw new Error("partitioned signal crossed the disconnected relay graph");
    docker(["network", "connect", NETWORK, CONTAINERS.node1]);
    await waitForUrl(`${cluster.nodes[0].restUrl}/debug/v1/info`);
    await Promise.all([
      connectAdminPeer(cluster.nodes[1].restUrl, cluster.node1StaticMultiaddr),
      connectAdminPeer(cluster.nodes[2].restUrl, cluster.node1StaticMultiaddr),
    ]);
    await Promise.all([
      waitForAdminPeer(cluster.nodes[1].restUrl, cluster.nodes[0].peerId),
      waitForAdminPeer(cluster.nodes[2].restUrl, cluster.nodes[0].peerId),
    ]);
    await workers.get("partitionAlpha").request("connect", { url: cluster.nodes[0].websocketMultiaddr });
    await delay(1000);
    await workers.get("partitionAlpha").request("rebroadcast", { postcardId: partitioned.id });
    const healed = await waitForIds(workers.get("partitionBeta"), launchId, [partitioned.id], 20_000);
    if (!healed.some((entry) => entry.id === partitioned.id)) throw new Error("partition heal did not converge");
    record("scenario_pass", { scenario: "partition_heal", postcardId: partitioned.id, blockedDuringPartition });

    const beforeRestart = {};
    for (const key of ["alpha", "beta", "partitionAlpha", "partitionBeta"]) {
      beforeRestart[key] = await workers.get(key).request("list", { query: { launchId, limit: 10_000 } });
    }
    for (const worker of workers.values()) await worker.close();
    workers.clear();
    await delay(500);
    for (const key of Object.keys(inputs)) {
      const worker = new WorkerClient(`${key}-disk-restart`, runDir, record);
      workers.set(key, worker);
      await worker.request("start", inputs[key], 90_000);
    }
    const restartComparisons = {};
    for (const key of Object.keys(inputs)) {
      const after = await workers.get(key).request("list", { query: { launchId, limit: 10_000 } });
      restartComparisons[key] = { before: beforeRestart[key].length, after: after.length, exact: sameIds(beforeRestart[key], after) };
    }
    if (!Object.values(restartComparisons).every((value) => value.exact)) throw new Error("disk restart histories diverged");
    record("scenario_pass", { scenario: "disk_restart", workers: restartComparisons });

    const beforeRpc = await chainSnapshot();
    rpcProxy.setMode("offline");
    let rpcFailure = null;
    try {
      await workers.get("beta").request("sendSignal", { body: "rpc outage should not settle" }, 15_000);
    } catch (error) { rpcFailure = error.message; }
    if (!rpcFailure) throw new Error("RPC outage did not fail the settlement");
    const duringRpc = await chainSnapshot();
    rpcProxy.setMode("online");
    await delay(500);
    const rpcRecovered = await sendAndRequire("beta", "alpha", "rpc recovery signal");
    const afterRpc = await chainSnapshot();
    const noRpcSpend = beforeRpc.totalTickets === duringRpc.totalTickets;
    const oneRecoverySpend = BigInt(afterRpc.totalTickets) === BigInt(beforeRpc.totalTickets) + 1n;
    if (!noRpcSpend || !oneRecoverySpend) throw new Error("RPC outage accounting was not exact");
    record("scenario_pass", { scenario: "rpc_outage_recovery", error: rpcFailure, postcardId: rpcRecovered.id, noSpendWhileOffline: true });

    const finalHistories = {};
    for (const key of Object.keys(inputs)) {
      finalHistories[key] = await workers.get(key).request("list", { query: { launchId, limit: 10_000 } });
    }
    const chain = await chainSnapshot();
    const scenarios = [
      "normal_two_way",
      "relay_kill",
      "filter_failover",
      "publisher_crash",
      "drop_and_retry",
      "delay_duplicate_reorder",
      "partition_heal",
      "disk_restart",
      "rpc_outage_recovery",
    ];
    const passedScenarios = new Set(eventRecords.filter((entry) => entry.type === "scenario_pass").map((entry) => entry.detail.scenario));
    const passed = scenarios.every((scenario) => passedScenarios.has(scenario));
    const summary = {
      version: 1,
      runId,
      passed,
      durationMs: Date.now() - startedAt,
      topicScope,
      scenarios: Object.fromEntries(scenarios.map((scenario) => [scenario, passedScenarios.has(scenario)])),
      crash: { postcardId: crashStaged.postcard.id, recovered: crashRecovered, noDoubleSettlement: noCrashDoubleSettlement },
      partition: { postcardId: partitioned.id, blockedDuringPartition, healed: true },
      rpc: { failedOffline: Boolean(rpcFailure), noSpendWhileOffline: noRpcSpend, oneRecoverySpend },
      restartComparisons,
      finalHistoryCounts: Object.fromEntries(Object.entries(finalHistories).map(([key, history]) => [key, history.length])),
      chain,
      secretsRecorded: false,
    };
    fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(runDir, "metrics.csv"), `run_id,passed,duration_ms,alpha_records,beta_records,partition_alpha_records,partition_beta_records,total_tickets,class_pot_micros\n${runId},${passed},${summary.durationMs},${finalHistories.alpha.length},${finalHistories.beta.length},${finalHistories.partitionAlpha.length},${finalHistories.partitionBeta.length},${chain.totalTickets},${chain.classPotMicros}\n`);
    fs.writeFileSync(path.join(runDir, "REPORT.md"), `# Controlled Waku reliability\n\n- Run: \`${runId}\`\n- Result: **${passed ? "PASS" : "FAIL"}**\n- Relay kill with live failover: ${summary.scenarios.relay_kill}\n- Filter peer loss with resubscription path: ${summary.scenarios.filter_failover}\n- Publisher crash after confirmed local staging: ${summary.crash.recovered}\n- No crash double settlement: ${summary.crash.noDoubleSettlement}\n- Drop, delay, duplicate, and reorder convergence: ${summary.scenarios.delay_duplicate_reorder && summary.scenarios.drop_and_retry}\n- Partition blocked delivery before heal: ${summary.partition.blockedDuringPartition}\n- Partition healed with stable-ID retry: ${summary.partition.healed}\n- Exact histories after disk restart: ${Object.values(restartComparisons).every((value) => value.exact)}\n- RPC outage spent nothing and recovered once: ${summary.rpc.noSpendWhileOffline && summary.rpc.oneRecoverySpend}\n- Final accepted records: ${Object.entries(summary.finalHistoryCounts).map(([key, count]) => `${key} ${count}`).join(", ")}\n- Final tickets/class pot: ${chain.totalTickets}/${chain.classPotMicros} micros\n`);
    if (!passed) throw new Error("controlled Waku reliability assertions failed");
    console.log(`PASS ${runDir}`);
  } catch (error) {
    record("run_failed", { message: error.message, stack: error.stack });
    fs.writeFileSync(path.join(runDir, "failure.json"), JSON.stringify({ runId, passed: false, failedAt: new Date().toISOString(), error: { message: error.message, stack: error.stack } }, null, 2));
    throw error;
  } finally {
    for (const worker of workers.values()) await worker.close().catch(() => {});
    if (rpcProxy) await rpcProxy.close().catch(() => {});
    if (hardhat && !hardhat.killed) hardhat.kill();
    if (clusterAltered) {
      docker(["network", "connect", NETWORK, CONTAINERS.node1], { allowFailure: true });
      compose(["up", "--detach", "node1", "node2", "node3"]);
    }
    events.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
