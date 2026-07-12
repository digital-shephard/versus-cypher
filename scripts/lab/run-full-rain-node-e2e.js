const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  Contract,
  Interface,
  JsonRpcProvider,
  NonceManager,
  Wallet,
} = require("../../packages/network/node_modules/ethers");
const { WakuPostcardTransport } = require("../../packages/network/src");
const { RainInbox } = require("../../apps/pet/src/rain-inbox");

const RPC = process.env.VERSUS_RAIN_E2E_RPC || "http://127.0.0.1:8545";
const REST = process.env.VERSUS_RAIN_WAKU_REST || "http://127.0.0.1:18645";
const WS_PORT = Number(process.env.VERSUS_RAIN_WAKU_WS_PORT || 18000);
const DEPLOYMENT = process.env.VERSUS_RAIN_E2E_DEPLOYMENT || path.resolve(__dirname, "../../versus/deployments/localhost.json");
const HARDHAT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

function waitForExit(child) {
  return new Promise((resolve) => child.once("exit", resolve));
}

async function main() {
  const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
  const provider = new JsonRpcProvider(RPC, deployment.chainId, { staticNetwork: true });
  const owner = new NonceManager(new Wallet(HARDHAT_KEY, provider));
  const ownerAddress = await owner.getAddress();
  const attestor = Wallet.createRandom();
  const info = await fetch(`${REST}/debug/v1/info`).then((response) => response.json());
  const peerId = String(info.listenAddresses[0]).split("/p2p/")[1];
  const transport = new WakuPostcardTransport({
    chainId: deployment.chainId,
    contractAddress: deployment.contracts.agents,
    launchId: 1,
    arenaAddress: deployment.contracts.arena,
    trustedRainAttestors: [attestor.address],
    bootstrapPeers: [`/ip4/127.0.0.1/tcp/${WS_PORT}/ws/p2p/${peerId}`],
    defaultBootstrap: false,
    enableStore: true,
    allowInsecureWebSockets: true,
  });
  await transport.start();

  const usdc = new Contract(deployment.contracts.usdc, [
    "function mint(address,uint256)",
    "function approve(address,uint256) returns (bool)",
  ], owner);
  const arenaAbi = [
    "function hatch(uint256) returns (uint256)",
    "function commit(uint256)",
    "function rainFromRunway(uint256,uint256)",
    "event Hatched(uint256 indexed agentId,address indexed owner,uint8 cypherId,uint256 runwayAmount)",
  ];
  const arena = new Contract(deployment.contracts.arena, arenaAbi, owner);
  await (await usdc.mint(ownerAddress, 10_000_000)).wait();
  await (await usdc.approve(deployment.contracts.arena, 10_000_000)).wait();
  const hatchReceipt = await (await arena.hatch(7_000_000)).wait();
  const arenaInterface = new Interface(arenaAbi);
  const hatched = hatchReceipt.logs.map((log) => {
    try { return arenaInterface.parseLog(log); } catch { return null; }
  }).find((event) => event?.name === "Hatched");
  const agentId = hatched.args.agentId;
  const commitReceipt = await (await arena.commit(agentId)).wait();
  await (await arena.rainFromRunway(agentId, 5)).wait();

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "versus-full-rain-"));
  const inbox = new RainInbox({ filePath: path.join(temporary, "inbox.json") });
  let acceptedPennies = 0;
  const completed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("full Versus node rain path timed out")), 30_000);
    transport.on("rainBatch", (batch) => {
      acceptedPennies += inbox.acceptBatch(batch).acceptedPennies;
      if (acceptedPennies === 6) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });

  const nodeMain = path.resolve(__dirname, "../../../versus-waku-relay/src/main.mjs");
  const child = spawn(process.execPath, [nodeMain], {
    cwd: path.dirname(nodeMain),
    env: {
      ...process.env,
      VERSUS_BASE_RPC_URL: RPC,
      VERSUS_CHAIN_ID: String(deployment.chainId),
      VERSUS_ARENA_ADDRESS: deployment.contracts.arena,
      VERSUS_RAIN_ATTESTOR_PRIVATE_KEY: attestor.privateKey,
      VERSUS_RAIN_START_BLOCK: String(commitReceipt.blockNumber),
      VERSUS_RAIN_POLL_MS: "10000",
      VERSUS_RAIN_CONFIRMATIONS: "0",
      VERSUS_RAIN_DISTRIBUTION_MS: "10000",
      VERSUS_RPC_DAILY_CREDIT_BUDGET: "3000000",
      VERSUS_WAKU_REST_URL: REST,
      VERSUS_NODE_STATE_PATH: path.join(temporary, "node-state.json"),
      VERSUS_NODE_HEALTH_PORT: "18789",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let nodeOutput = "";
  child.stdout.on("data", (chunk) => { nodeOutput += chunk; });
  child.stderr.on("data", (chunk) => { nodeOutput += chunk; });

  try {
    await completed;
    let drops = 0;
    let clock = Date.now();
    const replay = new RainInbox({ filePath: path.join(temporary, "inbox.json"), now: () => clock });
    while (replay.status().pending) {
      const result = replay.next();
      if (result.drop) drops += 1;
      clock = Math.max(clock + 120, Number(result.nextAt || clock));
    }
    if (drops !== 6) throw new Error(`expected six exact drops, drained ${drops}`);
    console.log(JSON.stringify({
      ok: true,
      agentId: agentId.toString(),
      confirmedTransactions: 2,
      acceptedPennies,
      exactDrops: drops,
      nodeOutput: nodeOutput.trim().split(/\r?\n/).slice(-3),
    }, null, 2));
  } finally {
    child.kill("SIGTERM");
    await Promise.race([waitForExit(child), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    await transport.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
