#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { Contract, JsonRpcProvider, JsonRpcSigner, NonceManager, Wallet } = require("../../apps/pet/node_modules/ethers");

const ROOT = path.resolve(__dirname, "..", "..");
const VERSUS = path.join(ROOT, "versus");
const HARDHAT_CLI = path.join(VERSUS, "node_modules", "hardhat", "internal", "cli", "cli.js");
const LAB_ROOT = path.join(ROOT, "research", "pet-walkthrough-harness");
const CURRENT_PATH = path.join(LAB_ROOT, "current.json");
const DEFAULT_PACKAGE = path.join(ROOT, "apps", "pet", "dist-walkthrough", "win-unpacked");
const DEV_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const INITIAL_DEPOSIT_WEI = 3_000_000_000_000_000n;
const USDC_ABI = [
  "function mint(address to,uint256 amount)",
  "function approve(address spender,uint256 amount) returns (bool)",
];
const TREASURY_ABI = [
  "function depositFees(uint256 amount)",
  "function claimable(uint256 agentId) view returns (uint256)",
  "function tranchePot() view returns (uint256)",
  "function tickets(uint256 agentId) view returns (uint256)",
];
const AGENT_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getAgent(uint256 agentId) view returns (uint8 cypherId,uint32 level,uint32 streak,uint32 lastCommitDay,uint128 vault,address owner)",
];
const ARENA_ABI = [
  "function runway(uint256 agentId) view returns (uint128)",
  "function rainFromRunway(uint256 agentId,uint256 pennies)",
  "function replenishRunway(uint256 agentId,uint256 amount)",
];
const SYNDICATE_ABI = [
  "function currentClassId() view returns (uint256)",
  "function getClass(uint256 classId) view returns (uint256 totalCommitted,uint32 participantCount,uint32 openedDay,bool graduated)",
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function current() {
  if (!fs.existsSync(CURRENT_PATH)) throw new Error("No pet walkthrough harness is active");
  return JSON.parse(fs.readFileSync(CURRENT_PATH, "utf8"));
}

function saveCurrent(state) {
  fs.mkdirSync(LAB_ROOT, { recursive: true });
  fs.writeFileSync(CURRENT_PATH, JSON.stringify(state, null, 2));
}

function writeMarker(state, transport = state.attachedTransport || "tcp") {
  fs.writeFileSync(state.markerPath, JSON.stringify({
    version: 1,
    userDataPath: state.profilePath,
    environment: {
      VERSUS_RPC_URL: state.appRpcUrl || state.rpcUrl,
      VERSUS_DEPLOYMENT: state.deploymentPath,
      VERSUS_P2P_TRANSPORT: transport,
      VERSUS_AGENT_AUTOSTART: "0",
      VERSUS_AGENT_TIMEOUT_MS: "1200",
      VERSUS_WALKTHROUGH_EVIDENCE_DIR: path.join(LAB_ROOT, state.runId),
      VERSUS_WALKTHROUGH_DEVICE_SCALE: String(state.deviceScaleFactor || 1),
    },
  }, null, 2));
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function redactKnownDevKeys(runDir) {
  const file = path.join(runDir, "hardhat.log");
  if (!fs.existsSync(file)) return;
  const original = fs.readFileSync(file, "utf8");
  const redacted = original.replace(
    /(Private Key:\s*)0x[0-9a-f]{64}/gi,
    "$1[redacted-known-dev-key]"
  );
  if (redacted !== original) fs.writeFileSync(file, redacted, "utf8");
}

async function waitForRpc(provider, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      await provider.getBlockNumber();
      return;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`Hardhat RPC did not become ready: ${lastError?.message || "timeout"}`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, shell: false, windowsHide: true });
    let output = "";
    child.stdout?.on("data", (chunk) => { output += chunk; });
    child.stderr?.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} exited ${code}\n${output}`));
    });
  });
}

function profileWallet(state) {
  const file = path.join(state.profilePath, "wallet.json");
  if (!fs.existsSync(file)) throw new Error("The packaged app has not created its wallet yet");
  const wallet = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!/^0x[0-9a-f]{40}$/i.test(wallet.address || "")) throw new Error("Walkthrough wallet address is invalid");
  return { address: wallet.address };
}

function profileBond(state) {
  const file = path.join(state.profilePath, "bond.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

async function start() {
  if (fs.existsSync(CURRENT_PATH)) {
    const previous = current();
    if (processAlive(previous.hardhatPid)) throw new Error(`Harness ${previous.runId} is already active`);
  }

  const packageDir = path.resolve(process.env.VERSUS_WALKTHROUGH_PACKAGE || DEFAULT_PACKAGE);
  const executablePath = path.join(packageDir, "Versus.exe");
  const resourcesPath = path.join(packageDir, "resources");
  if (!fs.existsSync(executablePath) || !fs.existsSync(path.join(resourcesPath, "app.asar"))) {
    throw new Error(`Build the unpacked walkthrough package first: ${executablePath}`);
  }

  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const runDir = path.join(LAB_ROOT, runId);
  const profilePath = path.join(os.tmpdir(), `versus-pet-harness-${runId}`);
  const deploymentPath = path.join(runDir, "deployment.json");
  const markerPath = path.join(resourcesPath, "versus-walkthrough-profile.json");
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(profilePath, { recursive: true });

  const logFd = fs.openSync(path.join(runDir, "hardhat.log"), "a");
  const hardhat = spawn(process.execPath, [HARDHAT_CLI, "node", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: VERSUS,
    env: { ...process.env },
    detached: true,
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
  });
  hardhat.unref();
  fs.closeSync(logFd);

  const state = {
    version: 1,
    runId,
    status: "starting",
    startedAt: new Date().toISOString(),
    hardhatPid: hardhat.pid,
    rpcUrl,
    chainId: 31337,
    deploymentPath,
    packageDir,
    executablePath,
    markerPath,
    profilePath,
    profilePaths: [profilePath],
    secretsRecorded: false,
  };
  saveCurrent(state);

  try {
    const provider = new JsonRpcProvider(rpcUrl, 31337, { staticNetwork: true, cacheTimeout: -1 });
    await waitForRpc(provider);
    const deployOutput = await run(process.execPath, [HARDHAT_CLI, "run", "scripts/deploy.js", "--network", "localhost"], {
      cwd: VERSUS,
      env: { ...process.env, LOCAL_RPC_URL: rpcUrl, VERSUS_DEPLOYMENT_OUT: deploymentPath },
    });
    fs.writeFileSync(path.join(runDir, "deploy.log"), deployOutput, "utf8");
    const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
    state.attachedTransport = "tcp";
    writeMarker(state);
    Object.assign(state, {
      status: "ready",
      readyAt: new Date().toISOString(),
      contracts: deployment.contracts,
    });
    saveCurrent(state);
    console.log(JSON.stringify(state, null, 2));
  } catch (error) {
    state.status = "failed";
    state.error = error.message;
    saveCurrent(state);
    if (processAlive(hardhat.pid)) process.kill(hardhat.pid);
    throw error;
  }
}

async function fund(amountWei = INITIAL_DEPOSIT_WEI) {
  const state = current();
  const wallet = profileWallet(state);
  const provider = new JsonRpcProvider(state.rpcUrl, state.chainId, { staticNetwork: true, cacheTimeout: -1 });
  const deployer = new Wallet(DEV_PRIVATE_KEY, provider);
  const receipt = await (await deployer.sendTransaction({ to: wallet.address, value: BigInt(amountWei) })).wait();
  const result = {
    action: "fund",
    address: wallet.address,
    amountWei: String(amountWei),
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
  };
  fs.appendFileSync(path.join(LAB_ROOT, state.runId, "events.jsonl"), `${JSON.stringify({ at: Date.now(), ...result })}\n`);
  console.log(JSON.stringify(result, null, 2));
}

async function seedClaim(amountMicros = 10_000_000n) {
  const state = current();
  const bond = profileBond(state);
  if (bond?.phase !== "active" || !bond.agentId) throw new Error("Hatch the packaged Cypher before seeding rolling rewards");
  const provider = new JsonRpcProvider(state.rpcUrl, state.chainId, { staticNetwork: true, cacheTimeout: -1 });
  const deployerWallet = new Wallet(DEV_PRIVATE_KEY, provider);
  const deployer = new NonceManager(deployerWallet);
  const usdc = new Contract(state.contracts.usdc, USDC_ABI, deployer);
  const treasury = new Contract(state.contracts.treasury, TREASURY_ABI, deployer);
  await (await usdc.mint(deployerWallet.address, BigInt(amountMicros))).wait();
  await (await usdc.approve(state.contracts.treasury, BigInt(amountMicros))).wait();
  const receipt = await (await treasury.depositFees(BigInt(amountMicros))).wait();
  const result = {
    action: "seed_claim",
    agentId: Number(bond.agentId),
    depositedMicros: String(amountMicros),
    claimableMicros: (await treasury.claimable(BigInt(bond.agentId))).toString(),
    remainingTrancheMicros: (await treasury.tranchePot()).toString(),
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
  };
  fs.appendFileSync(path.join(LAB_ROOT, state.runId, "events.jsonl"), `${JSON.stringify({ at: Date.now(), ...result })}\n`);
  console.log(JSON.stringify(result, null, 2));
}

async function setGasBalance(amountWei) {
  const state = current();
  const wallet = profileWallet(state);
  const provider = new JsonRpcProvider(state.rpcUrl, state.chainId, { staticNetwork: true, cacheTimeout: -1 });
  const before = await provider.getBalance(wallet.address);
  await provider.send("hardhat_setBalance", [wallet.address, `0x${BigInt(amountWei).toString(16)}`]);
  const after = await provider.getBalance(wallet.address);
  const result = {
    action: "set_gas_balance",
    address: wallet.address,
    beforeWei: before.toString(),
    afterWei: after.toString(),
  };
  fs.appendFileSync(path.join(LAB_ROOT, state.runId, "events.jsonl"), `${JSON.stringify({ at: Date.now(), ...result })}\n`);
  console.log(JSON.stringify(result, null, 2));
}

async function drainRunway(remainingMicros = 0n) {
  const state = current();
  const wallet = profileWallet(state);
  const bond = profileBond(state);
  if (bond?.phase !== "active" || !bond.agentId) throw new Error("Hatch the packaged Cypher before draining runway");
  remainingMicros = BigInt(remainingMicros);
  if (remainingMicros < 0n || remainingMicros % 10_000n !== 0n) {
    throw new Error("remaining runway must be a nonnegative whole number of pennies");
  }
  const provider = new JsonRpcProvider(state.rpcUrl, state.chainId, { staticNetwork: true, cacheTimeout: -1 });
  const arenaRead = new Contract(state.contracts.arena, ARENA_ABI, provider);
  const before = BigInt(await arenaRead.runway(BigInt(bond.agentId)));
  if (remainingMicros > before) throw new Error("remaining runway exceeds current runway");
  const spend = before - remainingMicros;
  if (spend % 10_000n !== 0n) throw new Error("current runway cannot be drained to that penny boundary");
  const hashes = [];
  await provider.send("hardhat_impersonateAccount", [wallet.address]);
  try {
    await provider.send("hardhat_setBalance", [wallet.address, "0x56BC75E2D63100000"]);
    const signer = new JsonRpcSigner(provider, wallet.address);
    const arena = new Contract(state.contracts.arena, ARENA_ABI, signer);
    let pennies = spend / 10_000n;
    while (pennies > 0n) {
      const batch = pennies > 100n ? 100n : pennies;
      const receipt = await (await arena.rainFromRunway(BigInt(bond.agentId), batch)).wait();
      hashes.push({ hash: receipt.hash, blockNumber: receipt.blockNumber, pennies: Number(batch), gasUsed: receipt.gasUsed.toString() });
      pennies -= batch;
    }
  } finally {
    await provider.send("hardhat_stopImpersonatingAccount", [wallet.address]);
  }
  const after = BigInt(await arenaRead.runway(BigInt(bond.agentId)));
  const result = {
    action: "drain_runway",
    agentId: Number(bond.agentId),
    beforeMicros: before.toString(),
    afterMicros: after.toString(),
    transactions: hashes,
  };
  fs.appendFileSync(path.join(LAB_ROOT, state.runId, "events.jsonl"), `${JSON.stringify({ at: Date.now(), ...result })}\n`);
  console.log(JSON.stringify(result, null, 2));
}

async function sponsorRunway(amountMicros = 7_000_000n) {
  const state = current();
  const bond = profileBond(state);
  if (bond?.phase !== "active" || !bond.agentId) throw new Error("Hatch the packaged Cypher before sponsoring runway");
  amountMicros = BigInt(amountMicros);
  if (amountMicros <= 0n) throw new Error("sponsored runway must be positive");
  const provider = new JsonRpcProvider(state.rpcUrl, state.chainId, { staticNetwork: true, cacheTimeout: -1 });
  const deployerWallet = new Wallet(DEV_PRIVATE_KEY, provider);
  const deployer = new NonceManager(deployerWallet);
  const usdc = new Contract(state.contracts.usdc, USDC_ABI, deployer);
  const arena = new Contract(state.contracts.arena, ARENA_ABI, deployer);
  const before = BigInt(await arena.runway(BigInt(bond.agentId)));
  const mint = await (await usdc.mint(deployerWallet.address, amountMicros)).wait();
  const approval = await (await usdc.approve(state.contracts.arena, amountMicros)).wait();
  const receipt = await (await arena.replenishRunway(BigInt(bond.agentId), amountMicros)).wait();
  const after = BigInt(await arena.runway(BigInt(bond.agentId)));
  const result = {
    action: "sponsor_runway",
    agentId: Number(bond.agentId),
    amountMicros: amountMicros.toString(),
    beforeMicros: before.toString(),
    afterMicros: after.toString(),
    mintHash: mint.hash,
    approvalHash: approval.hash,
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
  };
  fs.appendFileSync(path.join(LAB_ROOT, state.runId, "events.jsonl"), `${JSON.stringify({ at: Date.now(), ...result })}\n`);
  console.log(JSON.stringify(result, null, 2));
}

function newProfile(label = "restore") {
  const state = current();
  if (!/^[a-z0-9-]{1,24}$/i.test(label)) throw new Error("profile label must be concise alphanumeric text");
  const profilePath = path.join(os.tmpdir(), `versus-pet-harness-${state.runId}-${label}-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(profilePath, { recursive: true });
  const profilePaths = Array.from(new Set([...(state.profilePaths || [state.profilePath]), profilePath]));
  state.previousProfilePath = state.profilePath;
  state.profilePath = profilePath;
  state.profilePaths = profilePaths;
  saveCurrent(state);
  writeMarker(state);
  const result = {
    action: "new_profile",
    runId: state.runId,
    label,
    profilePath,
    previousProfilePath: state.previousProfilePath,
    profileCount: profilePaths.length,
  };
  fs.appendFileSync(path.join(LAB_ROOT, state.runId, "events.jsonl"), `${JSON.stringify({ at: Date.now(), ...result })}\n`);
  console.log(JSON.stringify(result, null, 2));
}

function setScale(percent = 100) {
  const state = current();
  percent = Number(percent);
  if (![100, 125, 150].includes(percent)) throw new Error("scale must be 100, 125, or 150 percent");
  state.deviceScaleFactor = percent / 100;
  saveCurrent(state);
  writeMarker(state);
  const result = { action: "set_scale", runId: state.runId, percent, factor: state.deviceScaleFactor };
  fs.appendFileSync(path.join(LAB_ROOT, state.runId, "events.jsonl"), `${JSON.stringify({ at: Date.now(), ...result })}\n`);
  console.log(JSON.stringify(result, null, 2));
}

function setNetworkState(value = "actual") {
  const state = current();
  value = String(value).toLowerCase();
  const allowed = new Set(["actual", "offline", "reconnecting", "caught_up", "degraded_store"]);
  if (!allowed.has(value)) throw new Error("network state must be actual, offline, reconnecting, caught_up, or degraded_store");
  const file = path.join(LAB_ROOT, state.runId, "network-state-fixture.json");
  if (value === "actual") {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } else {
    fs.writeFileSync(file, JSON.stringify({ version: 1, state: value, updatedAt: Date.now() }, null, 2));
  }
  const result = { action: "set_network_state", runId: state.runId, state: value, fixture: value !== "actual" };
  fs.appendFileSync(path.join(LAB_ROOT, state.runId, "events.jsonl"), `${JSON.stringify({ at: Date.now(), ...result })}\n`);
  console.log(JSON.stringify(result, null, 2));
}

function seedStale() {
  const state = current();
  const file = path.join(state.profilePath, "bond.json");
  const bond = profileBond(state);
  if (bond?.phase !== "active") throw new Error("Hatch the packaged Cypher before seeding stale renderer state");
  const canonicalRunway = Number(bond.runway || 0);
  bond.runway = canonicalRunway + 123_456;
  bond.walkthroughStaleFixture = { canonicalRunway, seededAt: Date.now() };
  fs.writeFileSync(file, JSON.stringify(bond, null, 2));
  console.log(JSON.stringify({ action: "seed_stale", canonicalRunway, staleRunway: bond.runway }, null, 2));
}

async function status() {
  const state = current();
  const provider = new JsonRpcProvider(state.rpcUrl, state.chainId, { staticNetwork: true, cacheTimeout: -1 });
  let blockNumber = null;
  let rpcError = null;
  try {
    blockNumber = await provider.getBlockNumber();
  } catch (error) {
    rpcError = error.message;
  }
  let wallet = null;
  try { wallet = profileWallet(state); } catch (_) {}
  const bond = profileBond(state);
  console.log(JSON.stringify({
    runId: state.runId,
    status: state.status,
    hardhatAlive: processAlive(state.hardhatPid),
    blockNumber,
    rpcError,
    wallet,
    bond: bond ? {
      phase: bond.phase,
      agentId: bond.agentId || null,
      cypherId: bond.cypherId ?? null,
      runway: bond.runway ?? null,
      vault: bond.vault ?? null,
      tickets: bond.tickets ?? null,
      claimableMicros: bond.trancheClaimableMicros ?? null,
    } : null,
    paths: {
      runDir: path.join(LAB_ROOT, state.runId),
      profilePath: state.profilePath,
      executablePath: state.executablePath,
    },
  }, null, 2));
}

async function assertState() {
  const state = current();
  const wallet = profileWallet(state);
  const bond = profileBond(state);
  if (bond?.phase !== "active" || !bond.agentId) throw new Error("The packaged Cypher is not active");
  const storedWallet = JSON.parse(fs.readFileSync(path.join(state.profilePath, "wallet.json"), "utf8"));
  const provider = new JsonRpcProvider(state.rpcUrl, state.chainId, { staticNetwork: true, cacheTimeout: -1 });
  const agents = new Contract(state.contracts.agents, AGENT_ABI, provider);
  const arena = new Contract(state.contracts.arena, ARENA_ABI, provider);
  const treasury = new Contract(state.contracts.treasury, TREASURY_ABI, provider);
  const usdc = new Contract(state.contracts.usdc, ["function balanceOf(address owner) view returns (uint256)"], provider);
  const syndicate = new Contract(state.contracts.syndicate, SYNDICATE_ABI, provider);
  const classId = await syndicate.currentClassId();
  const [owner, agent, runway, tickets, claimable, walletUsdc, tranchePot, currentClass, blockNumber] = await Promise.all([
    agents.ownerOf(BigInt(bond.agentId)),
    agents.getAgent(BigInt(bond.agentId)),
    arena.runway(BigInt(bond.agentId)),
    treasury.tickets(BigInt(bond.agentId)),
    treasury.claimable(BigInt(bond.agentId)),
    usdc.balanceOf(wallet.address),
    treasury.tranchePot(),
    syndicate.getClass(classId),
    provider.getBlockNumber(),
  ]);
  const checks = {
    active: bond.phase === "active",
    ownerMatches: owner.toLowerCase() === wallet.address.toLowerCase(),
    cypherMatches: Number(agent.cypherId) === Number(bond.cypherId),
    runwayMatches: Number(runway) === Number(bond.runway),
    ticketsMatch: Number(tickets) === Number(bond.tickets),
    vaultMatches: Number(agent.vault) === Number(bond.vault),
    claimableMatches: Number(claimable) === Number(bond.trancheClaimableMicros || 0),
    encryptedWalletOnly: Boolean(storedWallet.encryptedPrivateKey) && !Object.hasOwn(storedWallet, "privateKey"),
  };
  const summary = {
    version: 1,
    runId: state.runId,
    passed: Object.values(checks).every(Boolean),
    assertedAt: new Date().toISOString(),
    blockNumber,
    wallet: { address: wallet.address, usdcMicros: walletUsdc.toString() },
    cypher: {
      agentId: Number(bond.agentId),
      cypherId: Number(agent.cypherId),
      runwayMicros: runway.toString(),
      tickets: tickets.toString(),
      vaultMicros: agent.vault.toString(),
      claimableMicros: claimable.toString(),
    },
    class: {
      classId: classId.toString(),
      totalCommittedMicros: currentClass.totalCommitted.toString(),
      participantCount: Number(currentClass.participantCount),
      graduated: Boolean(currentClass.graduated),
      tranchePotMicros: tranchePot.toString(),
    },
    checks,
    secretsRecorded: false,
  };
  const runDir = path.join(LAB_ROOT, state.runId);
  redactKnownDevKeys(runDir);
  fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
  fs.appendFileSync(path.join(runDir, "events.jsonl"), `${JSON.stringify({ at: Date.now(), action: "assert", passed: summary.passed, checks })}\n`);
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.passed) throw new Error("Packaged walkthrough chain assertions failed");
}

function stop() {
  const state = current();
  const brainFixturePath = path.join(LAB_ROOT, state.runId, "brain-fixture.json");
  if (fs.existsSync(brainFixturePath)) {
    const brainFixture = JSON.parse(fs.readFileSync(brainFixturePath, "utf8"));
    if (processAlive(brainFixture.pid)) process.kill(brainFixture.pid);
  }
  const rpcFixturePath = path.join(LAB_ROOT, state.runId, "rpc-fixture.json");
  if (fs.existsSync(rpcFixturePath)) {
    const rpcFixture = JSON.parse(fs.readFileSync(rpcFixturePath, "utf8"));
    if (processAlive(rpcFixture.pid)) process.kill(rpcFixture.pid);
  }
  if (processAlive(state.hardhatPid)) process.kill(state.hardhatPid);
  redactKnownDevKeys(path.join(LAB_ROOT, state.runId));
  if (fs.existsSync(state.markerPath)) {
    const marker = JSON.parse(fs.readFileSync(state.markerPath, "utf8"));
    if (path.resolve(marker.userDataPath || "") === path.resolve(state.profilePath)) fs.unlinkSync(state.markerPath);
  }
  const tempRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
  const profilePaths = Array.from(new Set(state.profilePaths || [state.profilePath]));
  for (const profilePath of profilePaths) {
    const resolvedProfile = path.resolve(profilePath);
    if (!resolvedProfile.startsWith(tempRoot) || !path.basename(resolvedProfile).startsWith("versus-pet-harness-")) {
      throw new Error(`Refusing to remove unexpected profile path: ${resolvedProfile}`);
    }
    if (fs.existsSync(resolvedProfile)) fs.rmSync(resolvedProfile, { recursive: true, force: true });
  }
  state.status = "stopped";
  state.stoppedAt = new Date().toISOString();
  state.profileDeleted = true;
  saveCurrent(state);
  console.log(JSON.stringify({ runId: state.runId, status: state.status, profileDeleted: true }, null, 2));
}

function attach(transport = "tcp") {
  const state = current();
  if (!processAlive(state.hardhatPid)) throw new Error("The walkthrough Hardhat process is not running");
  if (!new Set(["tcp", "waku"]).has(transport)) throw new Error("transport must be tcp or waku");
  state.attachedTransport = transport;
  saveCurrent(state);
  writeMarker(state, transport);
  console.log(JSON.stringify({ runId: state.runId, transport, markerPath: state.markerPath, profilePath: state.profilePath }, null, 2));
}

async function main() {
  const command = String(process.argv[2] || "status").toLowerCase();
  if (command === "start") return start();
  if (command === "fund") return fund(process.argv[3] ? BigInt(process.argv[3]) : INITIAL_DEPOSIT_WEI);
  if (command === "fund-runway") return fund(process.argv[3] ? BigInt(process.argv[3]) : INITIAL_DEPOSIT_WEI);
  if (command === "seed-claim") return seedClaim(process.argv[3] ? BigInt(process.argv[3]) : 10_000_000n);
  if (command === "seed-stale") return seedStale();
  if (command === "set-gas") return setGasBalance(process.argv[3] ? BigInt(process.argv[3]) : 0n);
  if (command === "drain-runway") return drainRunway(process.argv[3] ? BigInt(process.argv[3]) : 0n);
  if (command === "sponsor-runway") return sponsorRunway(process.argv[3] ? BigInt(process.argv[3]) : 7_000_000n);
  if (command === "new-profile") return newProfile(process.argv[3] || "restore");
  if (command === "set-scale") return setScale(process.argv[3] || 100);
  if (command === "set-network-state") return setNetworkState(process.argv[3] || "actual");
  if (command === "status") return status();
  if (command === "assert") return assertState();
  if (command === "attach") return attach("tcp");
  if (command === "attach-waku") return attach("waku");
  if (command === "stop") return stop();
  throw new Error("Usage: pet-walkthrough-harness.js start|attach|attach-waku|fund|fund-runway|seed-claim|seed-stale|set-gas|drain-runway|sponsor-runway|new-profile|set-scale|set-network-state|status|assert|stop");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
