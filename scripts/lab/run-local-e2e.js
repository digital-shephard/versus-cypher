#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { fork, spawn } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const { Contract, JsonRpcProvider, NonceManager, Wallet } = require("../../apps/pet/node_modules/ethers");
const { createChainRainService } = require("../../apps/pet/src/chain");

const ROOT = path.resolve(__dirname, "..", "..");
const VERSUS = path.join(ROOT, "versus");
const WORKER = path.join(__dirname, "cypher-worker.js");
const HARDHAT_CLI = path.join(VERSUS, "node_modules", "hardhat", "internal", "cli", "cli.js");
const RUN_ROOT = path.join(ROOT, "research", "network-runs");
const HARDHAT_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const USDC_ABI = [
  "function mint(address to,uint256 amount)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
];
const ARENA_ABI = [
  "function hatch(uint8 cypherId,uint256 runwayAmount) returns (uint256 agentId)",
  "function commit(uint256 agentId)",
  "function runway(uint256 agentId) view returns (uint256)",
];
const TREASURY_ABI = [
  "function tickets(uint256 agentId) view returns (uint256)",
  "function totalTickets() view returns (uint256)",
];
const SYNDICATE_ABI = [
  "function currentClassId() view returns (uint256)",
  "function getClass(uint256 classId) view returns (uint256 totalCommitted,uint32 participantCount,uint32 openedDay,bool graduated)",
];

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function sourceRevision() {
  const files = [
    __filename,
    WORKER,
    path.join(ROOT, "apps", "pet", "src", "network.js"),
    path.join(ROOT, "packages", "network", "src", "agent-runtime.js"),
    path.join(ROOT, "packages", "network", "src", "node.js"),
    path.join(VERSUS, "contracts", "core", "Arena.sol"),
  ];
  const hash = createHash("sha256");
  for (const file of files) hash.update(fs.readFileSync(file));
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

async function waitForRpc(provider, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { await provider.getBlockNumber(); return; } catch (error) { lastError = error; }
    await delay(250);
  }
  throw new Error(`Hardhat RPC did not become ready: ${lastError?.message || "timeout"}`);
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

class WorkerClient {
  constructor(name, runDir, record) {
    this.name = name;
    this.record = record;
    this.nextId = 1;
    this.pending = new Map();
    this.child = fork(WORKER, [], { cwd: ROOT, silent: true, env: { ...process.env } });
    const log = fs.createWriteStream(path.join(runDir, `${name}.log`), { flags: "a" });
    this.child.stdout.pipe(log);
    this.child.stderr.pipe(log);
    this.child.on("message", (message) => this.onMessage(message));
    this.child.on("exit", (code) => {
      for (const { reject } of this.pending.values()) reject(new Error(`${name} worker exited ${code}`));
      this.pending.clear();
    });
  }

  onMessage(message) {
    if (message?.kind === "event") {
      this.record(message.type, { worker: message.worker, ...message.detail }, message.at);
      return;
    }
    if (message?.kind !== "response") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code, stack: message.error.stack }));
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
    try { await this.request("close", {}, 5000); } catch (_) {}
    if (this.child.connected) this.child.disconnect();
    if (!this.child.killed) this.child.kill();
  }
}

async function waitFor(predicate, timeoutMs = 20_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await predicate();
    if (value) return value;
    await delay(intervalMs);
  }
  throw new Error("condition timed out");
}

async function main() {
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const seed = randomUUID();
  const revision = sourceRevision();
  const runDir = path.join(RUN_ROOT, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const eventPath = path.join(runDir, "events.jsonl");
  const events = fs.createWriteStream(eventPath, { flags: "a" });
  const record = (type, detail = {}, at = Date.now()) => {
    events.write(`${JSON.stringify({ runId, at, type, detail })}\n`);
  };
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const deploymentPath = path.join(runDir, "deployment.json");
  let hardhat = null;
  let alpha = null;
  let beta = null;
  const startedAt = Date.now();

  try {
    fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify({
      version: 1,
      runId,
      seed,
      codeRevision: revision,
      startedAt: new Date(startedAt).toISOString(),
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      scenario: "two-agent-paid-proposal-critique-restart-next-day",
      transport: "tcp",
      chain: { kind: "hardhat", chainId: 31337, rpcPort: port },
      configuration: {
        deterministicBrains: true,
        isolatedProcesses: true,
        isolatedDatabases: true,
        acceleratedDays: 1,
        directTransportOnly: true,
      },
      agents: [
        { name: "alpha", agentId: 1, role: "proposer" },
        { name: "beta", agentId: 2, role: "critic" },
      ],
      secretsRecorded: false,
    }, null, 2));
    record("run_started", { rpcUrl, seed, codeRevision: revision });

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
    const arenaAddresses = deployment.contracts.arena;
    for (let index = 0; index < wallets.length; index += 1) {
      const wallet = wallets[index];
      const name = index === 0 ? "alpha" : "beta";
      await recordTransaction(
        record,
        "fund_test_wallet",
        deployer.sendTransaction({ to: wallet.address, value: 1_000_000_000_000_000_000n }),
        { agent: name }
      );
      await recordTransaction(record, "mint_mock_usdc", usdc.mint(wallet.address, 10_000_000n), { agent: name });
      const appChain = createChainRainService(
        { rpcUrl, deployment, env: { VERSUS_RPC_URL: rpcUrl } },
        { provider: new JsonRpcProvider(rpcUrl, 31337, { staticNetwork: true }) }
      );
      const hatch = await appChain.hatchWithRunway({
        privateKey: wallet.privateKey,
        cypherId: index + 3,
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
      recordReceipt(record, "commit_daily_voice", commit, { agent: name, acceleratedDay: 0, productionAdapter: true });
      record("cypher_hatched", { name, address: wallet.address, agentId: index + 1 });
    }

    const syndicate = new Contract(deployment.contracts.syndicate, SYNDICATE_ABI, provider);
    const launchId = (await syndicate.currentClassId()).toString();
    const initialNowSeconds = Number((await provider.getBlock("latest")).timestamp);
    const shared = { rpcUrl, chainId: 31337, deployment, launchId, nowSeconds: initialNowSeconds };
    const workerInputs = [
      { ...shared, name: "alpha", role: "proposer", privateKey: wallets[0].privateKey, agentId: 1, dataDir: path.join(runDir, "alpha") },
      { ...shared, name: "beta", role: "critic", privateKey: wallets[1].privateKey, agentId: 2, dataDir: path.join(runDir, "beta") },
    ];
    alpha = new WorkerClient("alpha", runDir, record);
    beta = new WorkerClient("beta", runDir, record);
    const [alphaStatus, betaStatus] = await Promise.all([
      alpha.request("start", workerInputs[0]),
      beta.request("start", workerInputs[1]),
    ]);
    await beta.request("connect", { url: alphaStatus.listen.url });
    record("mesh_connected", { alpha: alphaStatus.listen.url, betaPeerCount: (await beta.request("status")).peerCount });

    const alphaTick = await alpha.request("tick", {}, 60_000);
    record("alpha_tick_complete", { status: alphaTick.status });
    const proposal = await waitFor(async () => {
      const list = await beta.request("list", { query: { launchId, limit: 20 } });
      return list.find((postcard) => postcard.type === "proposal") || null;
    }, 30_000);
    record("proposal_observed", { postcardId: proposal.id });

    const betaTick = await beta.request("tick", {}, 60_000);
    record("beta_tick_complete", { status: betaTick.status });
    const alphaHistory = await waitFor(async () => {
      const list = await alpha.request("list", { query: { launchId, limit: 20 } });
      return list.some((postcard) => postcard.type === "critique") ? list : null;
    }, 30_000);
    const betaHistory = await beta.request("list", { query: { launchId, limit: 20 } });
    const critique = alphaHistory.find((postcard) => postcard.type === "critique");

    await Promise.all([alpha.close(), beta.close()]);
    alpha = new WorkerClient("alpha-restart", runDir, record);
    beta = new WorkerClient("beta-restart", runDir, record);
    const [restartedAlphaStatus] = await Promise.all([
      alpha.request("start", workerInputs[0]),
      beta.request("start", workerInputs[1]),
    ]);
    await beta.request("connect", { url: restartedAlphaStatus.listen.url });
    const historiesAfterRestart = await Promise.all([
      alpha.request("list", { query: { launchId, limit: 20 } }),
      beta.request("list", { query: { launchId, limit: 20 } }),
    ]);
    const sameDayTicks = await Promise.all([alpha.request("tick"), beta.request("tick")]);
    record("processes_restarted", {
      alphaHistoryCount: historiesAfterRestart[0].length,
      betaHistoryCount: historiesAfterRestart[1].length,
      sameDayTickStatuses: sameDayTicks.map((tick) => tick.status),
    });

    await provider.send("evm_increaseTime", [86_400]);
    await provider.send("evm_mine", []);
    const acceleratedNowSeconds = Number((await provider.getBlock("latest")).timestamp);
    for (let index = 0; index < wallets.length; index += 1) {
      const receipt = await createChainRainService(
        { rpcUrl, deployment, env: { VERSUS_RPC_URL: rpcUrl } },
        { provider: new JsonRpcProvider(rpcUrl, 31337, { staticNetwork: true }) }
      ).commitDaily({ privateKey: wallets[index].privateKey, agentId: index + 1 });
      recordReceipt(record, "commit_daily_voice", receipt, {
        agent: index === 0 ? "alpha" : "beta",
        acceleratedDay: 1,
        productionAdapter: true,
      });
    }
    await Promise.all([
      alpha.request("setNow", { nowSeconds: acceleratedNowSeconds }),
      beta.request("setNow", { nowSeconds: acceleratedNowSeconds }),
    ]);
    const nextDayTicks = await Promise.all([alpha.request("tick"), beta.request("tick")]);
    const finalHistories = await Promise.all([
      alpha.request("list", { query: { launchId, limit: 20 } }),
      beta.request("list", { query: { launchId, limit: 20 } }),
    ]);
    const finalStatuses = await Promise.all([alpha.request("status"), beta.request("status")]);
    record("accelerated_day_complete", {
      nowSeconds: acceleratedNowSeconds,
      utcDay: Math.floor(acceleratedNowSeconds / 86_400),
      tickStatuses: nextDayTicks.map((tick) => tick.status),
      historyCounts: finalHistories.map((history) => history.length),
    });

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
    const passed = Boolean(
      proposal && critique &&
      alphaHistory.filter((postcard) => [proposal.id, critique.id].includes(postcard.id)).length === 2 &&
      betaHistory.filter((postcard) => [proposal.id, critique.id].includes(postcard.id)).length === 2 &&
      historiesAfterRestart.every((history) => history.length === 2) &&
      sameDayTicks.every((tick) => tick.status === "idle") &&
      finalHistories.every((history) => history.length === 2) &&
      nextDayTicks[0].status === "duplicate_decision" && nextDayTicks[1].status === "idle" &&
      chain.alphaTickets === "5" && chain.betaTickets === "3" && chain.classPotMicros === "80000"
    );
    const summary = {
      version: 1,
      runId,
      passed,
      durationMs: Date.now() - startedAt,
      proposalId: proposal.id,
      critiqueId: critique?.id || null,
      alphaAcceptedIds: finalHistories[0].map((postcard) => postcard.id),
      betaAcceptedIds: finalHistories[1].map((postcard) => postcard.id),
      restart: {
        sameDayTickStatuses: sameDayTicks.map((tick) => tick.status),
        nextDayTickStatuses: nextDayTicks.map((tick) => tick.status),
        exactHistoryCounts: finalHistories.map((history) => history.length),
      },
      localDatabases: finalStatuses.map((status) => status.localDatabase),
      chain,
    };
    fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
    fs.writeFileSync(
      path.join(runDir, "metrics.csv"),
      "run_id,passed,duration_ms,postcards,alpha_tickets,beta_tickets,class_pot_micros,alpha_db_bytes,beta_db_bytes\n" +
      `${runId},${passed},${summary.durationMs},2,${chain.alphaTickets},${chain.betaTickets},${chain.classPotMicros},${finalStatuses[0].localDatabase.fileBytes},${finalStatuses[1].localDatabase.fileBytes}\n`
    );
    fs.writeFileSync(path.join(runDir, "REPORT.md"), `# Local Versus E2E\n\n- Run: \`${runId}\`\n- Revision: \`${revision}\`\n- Result: **${passed ? "PASS" : "FAIL"}**\n- Duration: ${summary.durationMs} ms\n- Proposal: \`${summary.proposalId}\`\n- Critique: \`${summary.critiqueId}\`\n- Restart: same-day ${sameDayTicks.map((tick) => tick.status).join("/")}; next-day ${nextDayTicks.map((tick) => tick.status).join("/")}\n- Histories after restart and accelerated day: ${finalHistories.map((history) => history.length).join("/")}\n- Class pot: ${chain.classPotMicros} micros\n- Tickets: alpha ${chain.alphaTickets}, beta ${chain.betaTickets}\n`);
    record("run_completed", { passed, chain });
    if (!passed) throw new Error(`local E2E assertions failed; see ${runDir}`);
    console.log(`PASS ${runDir}`);
  } finally {
    await Promise.all([alpha?.close(), beta?.close()]);
    if (hardhat && !hardhat.killed) hardhat.kill();
    events.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
