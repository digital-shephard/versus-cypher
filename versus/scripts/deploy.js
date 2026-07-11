const fs = require("fs");
const path = require("path");
require("dotenv").config();
const hre = require("hardhat");
const { deployOwnerlessVersus, deployLocalStack } = require("./lib/deployOwnerless");
const CONSTANTS = require("./lib/constants");

function requireAddress(name) {
  const v = process.env[name];
  if (!v || !/^0x[a-fA-F0-9]{40}$/.test(v)) {
    throw new Error(
      `${name} must be a 0x…40-hex address (your immutable dev vault). Set it in versus/.env`
    );
  }
  return v;
}

async function main() {
  const network = hre.network.name;
  const [deployer] = await hre.ethers.getSigners();
  console.log(`\nVersus deploy — network=${network} deployer=${deployer.address}\n`);

  let usdcAddress;
  let routerAddress;
  let v2FactoryAddress = null;
  let usedMockUsdc = false;
  let usedMockRouter = false;
  let protocolRecipient;
  let graduationFloor = CONSTANTS.GRADUATION_FLOOR;
  const transactions = [];

  async function recordDeployment(label, contract) {
    await contract.waitForDeployment();
    const receipt = await contract.deploymentTransaction().wait();
    transactions.push(receiptRecord(label, receipt));
    return contract;
  }

  async function recordCall(label, transactionPromise) {
    const transaction = await transactionPromise;
    const receipt = await transaction.wait();
    transactions.push(receiptRecord(label, receipt));
    return receipt;
  }

  if (process.env.GRADUATION_FLOOR_USDC) {
    const dollars = Number(process.env.GRADUATION_FLOOR_USDC);
    if (!Number.isFinite(dollars) || dollars <= 0) throw new Error("GRADUATION_FLOOR_USDC invalid");
    graduationFloor = BigInt(Math.round(dollars * 1e6));
  }

  if (network === "hardhat" || network === "localhost") {
    protocolRecipient = process.env.PROTOCOL_RECIPIENT || deployer.address;
    console.log("Local stack: MockUSDC + Mock Uniswap V2");
    console.log("protocolRecipient:", protocolRecipient);
    console.log("graduationFloor:", graduationFloor.toString(), `($${(Number(graduationFloor) / 1e6).toFixed(2)})`);

    const stack = await deployLocalStack(hre.ethers, {
      protocolRecipient,
      graduationFloor,
    });
    await (await stack.usdc.mint(deployer.address, hre.ethers.parseUnits("1000000", 6))).wait();

    usdcAddress = await stack.usdc.getAddress();
    routerAddress = await stack.v2Router.getAddress();
    v2FactoryAddress = await stack.v2Factory.getAddress();
    usedMockUsdc = true;
    usedMockRouter = true;

    return writeOut({
      network,
      deployer: deployer.address,
      protocolRecipient,
      graduationFloor,
      usedMockUsdc,
      usedMockRouter,
      contracts: {
        usdc: usdcAddress,
        v2Factory: v2FactoryAddress,
        v2Router: routerAddress,
        ...stack.addresses,
      },
      stack,
      transactions: stack.transactions,
    });
  }

  // ── Live networks (baseSepolia / base) ──────────────────────────────────
  protocolRecipient = requireAddress("PROTOCOL_RECIPIENT");
  console.log("IMMUTABLE protocolRecipient (dev vault):", protocolRecipient);
  console.log("graduationFloor:", graduationFloor.toString(), `($${(Number(graduationFloor) / 1e6).toFixed(2)})`);

  const cfg = CONSTANTS[network];
  if (!cfg) throw new Error(`No constants for network ${network}`);

  const useMockUsdc = process.env.USE_MOCK_USDC === "true";
  if (useMockUsdc) {
    if (network === "base") {
      throw new Error("Refusing USE_MOCK_USDC on Base mainnet");
    }
    const mock = await recordDeployment(
      "deploy MockUSDC",
      await (await hre.ethers.getContractFactory("MockUSDC")).deploy()
    );
    usdcAddress = await mock.getAddress();
    usedMockUsdc = true;
    console.log("MockUSDC:", usdcAddress);
    const mockMint = process.env.MOCK_USDC_MINT_USDC
      ? hre.ethers.parseUnits(process.env.MOCK_USDC_MINT_USDC, 6)
      : hre.ethers.parseUnits("100000", 6);
    await recordCall(
      "mint MockUSDC to deployer",
      mock.mint(deployer.address, mockMint)
    );
  } else {
    usdcAddress = process.env.USDC_ADDRESS || cfg.usdc;
    if (!usdcAddress) throw new Error("USDC address missing");
    console.log("USDC:", usdcAddress);
  }

  // Router: use mocks on Sepolia unless a complete external deployment is explicitly provided.
  const requestedRouter = process.env.UNISWAP_V2_ROUTER || cfg.uniswapV2Router;
  const requestedFactory = process.env.UNISWAP_V2_FACTORY || cfg.uniswapV2Factory;
  if (network === "baseSepolia" && ((!requestedRouter || !requestedFactory) || process.env.USE_MOCK_ROUTER === "true")) {
    const factory = await recordDeployment(
      "deploy MockUniswapV2Factory",
      await (await hre.ethers.getContractFactory("MockUniswapV2Factory")).deploy()
    );
    const router = await recordDeployment(
      "deploy MockUniswapV2Router",
      await (await hre.ethers.getContractFactory("MockUniswapV2Router")).deploy(await factory.getAddress())
    );
    v2FactoryAddress = await factory.getAddress();
    routerAddress = await router.getAddress();
    usedMockRouter = true;
    console.log("Mock V2 factory/router:", v2FactoryAddress, routerAddress);
  } else {
    routerAddress = requestedRouter;
    v2FactoryAddress = requestedFactory;
    if (!routerAddress || !v2FactoryAddress) {
      throw new Error("UNISWAP_V2_ROUTER and UNISWAP_V2_FACTORY required");
    }

    const externalRouter = new hre.ethers.Contract(
      routerAddress,
      ["function factory() view returns (address)", "function WETH() view returns (address)"],
      hre.ethers.provider
    );
    const [boundFactory, boundWeth, routerCode, factoryCode] = await Promise.all([
      externalRouter.factory(),
      externalRouter.WETH(),
      hre.ethers.provider.getCode(routerAddress),
      hre.ethers.provider.getCode(v2FactoryAddress),
    ]);
    if (boundFactory.toLowerCase() !== v2FactoryAddress.toLowerCase()) {
      throw new Error(`V2 router factory mismatch: expected ${v2FactoryAddress}, received ${boundFactory}`);
    }
    if (routerCode === "0x" || factoryCode === "0x") throw new Error("external V2 router or factory has no bytecode");
    if (network === "baseSepolia" && boundWeth.toLowerCase() !== "0x4200000000000000000000000000000000000006") {
      throw new Error(`unexpected Base Sepolia WETH binding: ${boundWeth}`);
    }
    console.log("External V2 factory/router:", v2FactoryAddress, routerAddress);
    console.log("External V2 WETH:", boundWeth);
  }

  const core = await deployOwnerlessVersus(hre.ethers, {
    usdcAddress,
    routerAddress,
    protocolRecipient,
    graduationFloor,
  });
  transactions.push(...core.transactions);

  // Verify immutables on-chain
  const onChainRecipient = await core.treasury.protocolRecipient();
  const onChainFloor = await core.syndicate.graduationFloor();
  if (onChainRecipient.toLowerCase() !== protocolRecipient.toLowerCase()) {
    throw new Error("protocolRecipient mismatch after deploy");
  }
  if (onChainFloor !== graduationFloor) {
    throw new Error("graduationFloor mismatch after deploy");
  }

  console.log("\n✔ Bootstrapped ownerless stack");
  console.log("  Arena     ", core.addresses.arena);
  console.log("  AgentNFT  ", core.addresses.agents);
  console.log("  Syndicate ", core.addresses.syndicate);
  console.log("  Treasury  ", core.addresses.treasury);
  console.log("  Escrow    ", core.addresses.missionEscrow);
  console.log("  Graduation", core.addresses.graduation);
  console.log("  Dev vault ", onChainRecipient);
  console.log("  Floor     ", onChainFloor.toString());

  return writeOut({
    network,
    deployer: deployer.address,
    protocolRecipient,
    graduationFloor,
    usedMockUsdc,
    usedMockRouter,
    contracts: {
      usdc: usdcAddress,
      v2Factory: v2FactoryAddress,
      v2Router: routerAddress,
      ...core.addresses,
    },
    transactions,
  });
}

function receiptRecord(label, receipt) {
  return {
    label,
    hash: receipt.hash,
    blockNumber: receipt.blockNumber,
    status: Number(receipt.status),
    gasUsed: receipt.gasUsed.toString(),
    contractAddress: receipt.contractAddress || null,
  };
}

function writeOut({ network, deployer, protocolRecipient, graduationFloor, usedMockUsdc, usedMockRouter, contracts, transactions = [] }) {
  const out = {
    network,
    chainId: null, // filled below async — sync write in caller
    deployer,
    ownerless: true,
    economics: {
      graduationFloorUSDC: (Number(graduationFloor) / 1e6).toFixed(2),
      graduationFloorRaw: graduationFloor.toString(),
      protocolTrancheBps: 1000,
      protocolRecipient,
      seedFund: false,
      classPenniesAreTheFund: true,
      taxBps: 100,
    },
    usedMockUsdc,
    usedMockRouter,
    transactions,
    contracts,
    checklist: {
      protocolRecipientImmutable: true,
      noOwnable: true,
      noPause: true,
      noSeedFund: true,
      missionEscrowOwnerless: true,
      paidSignalBatches: true,
      permanentDailyVoiceCredentials: true,
      publicGraduateSwapBackContinuousClaim: true,
    },
    deployedAt: new Date().toISOString(),
  };

  return hre.ethers.provider.getNetwork().then((net) => {
    out.chainId = Number(net.chainId);
    const dir = path.join(__dirname, "..", "deployments");
    fs.mkdirSync(dir, { recursive: true });
    const file = process.env.VERSUS_DEPLOYMENT_OUT
      ? path.resolve(process.env.VERSUS_DEPLOYMENT_OUT)
      : path.join(dir, `${network}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    console.log("\nWrote", file);
    console.log(JSON.stringify(out, null, 2));
    return out;
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
