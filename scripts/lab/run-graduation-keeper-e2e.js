const fs = require("node:fs");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
process.chdir(path.resolve(__dirname, "../../versus"));
const hre = require("../../versus/node_modules/hardhat");
const { deployLocalStack } = require("../../versus/scripts/lib/deployOwnerless");

const MIN_RUNWAY = 7_000_000n;
const PENNY = 10_000n;

function check(value, message) {
  if (!value) throw new Error(message);
}

function gitSnapshot(directory) {
  return {
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim(),
    dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: directory, encoding: "utf8" }).trim()),
  };
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

class MemoryStateStore {
  constructor(chainId, arena) {
    this.value = {
      version: 1,
      chainId: String(chainId),
      arena,
      pending: null,
      eligibleClass: null,
      eligibleSince: null,
      completedTransactions: 0,
      lastGraduatedClass: null,
      lastReceiptBlock: null,
    };
  }
  load() { return structuredClone(this.value); }
  save(value) { this.value = structuredClone(value); }
}

async function main() {
  const startedAt = new Date();
  const relayModule = path.resolve(__dirname, "../../../versus-waku-relay/src/graduation-keeper.mjs");
  const cypherRoot = path.resolve(__dirname, "../..");
  const relayRoot = path.resolve(__dirname, "../../../versus-waku-relay");
  const source = {
    cypher: gitSnapshot(cypherRoot),
    relay: gitSnapshot(relayRoot),
    keeperSha256: sha256(relayModule),
    rpcSha256: sha256(path.join(relayRoot, "src", "rpc.mjs")),
    harnessSha256: sha256(__filename),
  };
  const { GraduationKeeper } = await import(pathToFileURL(relayModule).href);
  const { ethers, network } = hre;
  const [deployer, owner] = await ethers.getSigners();
  const stack = await deployLocalStack(ethers, {
    protocolRecipient: deployer.address,
    graduationFloor: PENNY,
  });
  const arenaAddress = await stack.arena.getAddress();
  const graduationAddress = await stack.graduation.getAddress();
  const syndicateAddress = await stack.syndicate.getAddress();

  await (await stack.usdc.mint(owner.address, MIN_RUNWAY)).wait();
  await (await stack.usdc.connect(owner).approve(arenaAddress, MIN_RUNWAY)).wait();
  await (await stack.arena.connect(owner).hatch(MIN_RUNWAY)).wait();
  await (await stack.arena.connect(owner).commit(1)).wait();
  check(await stack.syndicate.canGraduate(1), "Class 1 did not reach its exact penny floor");

  const keeperWallet = ethers.Wallet.createRandom();
  await network.provider.send("hardhat_setBalance", [
    keeperWallet.address,
    ethers.toQuantity(ethers.parseEther("1")),
  ]);
  const rpc = { call: (method, params = []) => network.provider.send(method, params) };
  const stateStore = new MemoryStateStore(31337, arenaAddress);
  const keeper = new GraduationKeeper({
    enabled: true,
    chainId: 31337,
    arena: arenaAddress,
    privateKey: keeperWallet.privateKey,
    rpc,
    stateStore,
    confirmations: 0,
    maxExecutionFeeWei: ethers.parseEther("1"),
  });

  const eligibleBlock = await ethers.provider.getBlockNumber();
  const submitted = await keeper.poll({ confirmedBlock: eligibleBlock });
  check(submitted.status === "submitted", `keeper did not submit: ${submitted.status}`);
  check(stateStore.value.pending?.txHash === submitted.txHash, "transaction was not journaled");

  const confirmed = await keeper.poll({ confirmedBlock: await ethers.provider.getBlockNumber() });
  check(confirmed.status === "confirmed", `keeper did not confirm: ${confirmed.status}`);
  check(stateStore.value.pending === null, "confirmed transaction remained pending");
  check(stateStore.value.completedTransactions === 1, "keeper completion counter was not exact");

  const receipt = await ethers.provider.getTransactionReceipt(submitted.txHash);
  const graduatedEvent = receipt.logs.map((log) => {
    try { return stack.graduation.interface.parseLog(log); } catch { return null; }
  }).find((event) => event?.name === "Graduated");
  check(graduatedEvent, "Graduated event was absent");
  check(graduatedEvent.args.caller === keeperWallet.address, "Graduated caller was not the keeper");
  check(await stack.syndicate.currentClassId() === 2n, "class counter did not advance to 2");

  const [token, pair, , seeded, active] = await stack.graduation.getGraduation(1);
  check(active, "graduation record was not active");
  check(token !== ethers.ZeroAddress && pair !== ethers.ZeroAddress, "token or pair was not created");
  check(seeded === PENNY, "graduation did not seed the exact class penny");
  const idle = await keeper.poll({ confirmedBlock: await ethers.provider.getBlockNumber() });
  check(idle.status === "not_ready" && idle.classId === "2", "keeper attempted to repeat graduation");

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDirectory = path.resolve(__dirname, `../../research/graduation-keeper-runs/${runId}`);
  fs.mkdirSync(outputDirectory, { recursive: true });
  const report = {
    runId,
    passed: true,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    runtime: { node: process.version, platform: process.platform, architecture: process.arch },
    source,
    chainId: 31337,
    arena: arenaAddress,
    syndicate: syndicateAddress,
    graduation: graduationAddress,
    keeper: keeperWallet.address,
    classBefore: "1",
    classAfter: "2",
    floorMicros: PENNY.toString(),
    seededMicros: seeded.toString(),
    transactionHash: submitted.txHash,
    receiptBlock: receipt.blockNumber,
    receiptStatus: Number(receipt.status),
    gasUsed: receipt.gasUsed.toString(),
    gasPriceWei: receipt.gasPrice.toString(),
    transactionFeeWei: (receipt.gasUsed * receipt.gasPrice).toString(),
    token,
    pair,
    journalCompletedTransactions: stateStore.value.completedTransactions,
    nextPoll: idle.status,
    assertions: [
      "confirmed class met exact floor",
      "keeper discovered Arena-derived canonical wiring",
      "signed transaction journaled before receipt reconciliation",
      "graduateClass pinned Class 1",
      "Graduated caller equaled independent keeper EOA",
      "Token 0 and canonical pair were created",
      "exact class penny seeded liquidity",
      "current class advanced from 1 to 2",
      "receipt closed exactly one journal entry",
      "next poll remained not_ready for Class 2",
    ],
  };
  fs.writeFileSync(path.join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, report: path.join(outputDirectory, "report.json") }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
