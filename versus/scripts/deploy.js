const fs = require("fs");
const path = require("path");
require("dotenv").config();
const hre = require("hardhat");
const { deployOwnerlessVersus, deployLocalStack } = require("./lib/deployOwnerless");
const CONSTANTS = require("./lib/constants");
const { inspectBaseProduction } = require("./lib/base-production");
const {
  MANIFEST_VERSION,
  CONTRACT_KEYS,
  assertBaseSourceReady,
  collectSourceHashes,
  constructorArguments,
  resolveReleaseStage,
  resolveSourceState,
} = require("./lib/deployment-manifest");
const {
  assertBuildMatchesFreeze,
  collectFreshBuildFingerprint,
  loadBuildFreeze,
} = require("./lib/build-freeze");

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
  const repoRoot = path.join(__dirname, "..", "..");
  const projectRoot = path.join(__dirname, "..");
  const releaseStage = resolveReleaseStage(network);
  const source = resolveSourceState(repoRoot);
  if (network === "base") assertBaseSourceReady(source);
  const [deployer] = await hre.ethers.getSigners();
  console.log(`\nVersus deploy — network=${network} deployer=${deployer.address}\n`);

  let usdcAddress;
  let routerAddress;
  let v2FactoryAddress = null;
  let usedMockUsdc = false;
  let usedMockRouter = false;
  let protocolRecipient;
  let graduationFloor = CONSTANTS.GRADUATION_FLOOR;
  let referralReward = CONSTANTS.REFERRAL_REWARD;
  let safePolicy = null;
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

  if (network === "base" && process.env.GRADUATION_FLOOR_USDC) {
    throw new Error("GRADUATION_FLOOR_USDC cannot override the immutable $1,000 Base mainnet floor");
  }
  if (network === "base" && process.env.REFERRAL_REWARD_USDC) {
    throw new Error("REFERRAL_REWARD_USDC cannot override the immutable $1 Base mainnet referral reward");
  }
  if (process.env.REFERRAL_REWARD_USDC) {
    const dollars = Number(process.env.REFERRAL_REWARD_USDC);
    if (!Number.isFinite(dollars) || dollars <= 0) throw new Error("REFERRAL_REWARD_USDC invalid");
    referralReward = BigInt(Math.round(dollars * 1e6));
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
    console.log("referralReward:", referralReward.toString(), `($${(Number(referralReward) / 1e6).toFixed(2)})`);

    const stack = await deployLocalStack(hre.ethers, {
      protocolRecipient,
      graduationFloor,
      referralReward,
    });
    await (await stack.usdc.mint(deployer.address, hre.ethers.parseUnits("1000000", 6))).wait();

    usdcAddress = await stack.usdc.getAddress();
    routerAddress = await stack.v2Router.getAddress();
    v2FactoryAddress = await stack.v2Factory.getAddress();
    usedMockUsdc = true;
    usedMockRouter = true;

    return writeOut({
      network,
      releaseStage,
      source,
      projectRoot,
      deployer: deployer.address,
      protocolRecipient,
      graduationFloor,
      referralReward,
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
      safePolicy,
    });
  }

  let buildFingerprint = null;
  if (network === "base") {
    console.log("Cleaning Hardhat artifacts and verifying committed Base build freeze…");
    await hre.run("clean");
    await hre.run("compile", { force: true });
    const freeze = loadBuildFreeze(projectRoot);
    buildFingerprint = collectFreshBuildFingerprint(projectRoot, hre.ethers);
    assertBuildMatchesFreeze(buildFingerprint, freeze);
    console.log("Base build freeze matched freshly compiled creation bytecode");
  }

  // ── Live networks (baseSepolia / base) ──────────────────────────────────
  protocolRecipient = network === "base" ? CONSTANTS.base.protocolRecipient : requireAddress("PROTOCOL_RECIPIENT");
  console.log("IMMUTABLE protocolRecipient (dev vault):", protocolRecipient);
  console.log("graduationFloor:", graduationFloor.toString(), `($${(Number(graduationFloor) / 1e6).toFixed(2)})`);
  console.log("referralReward:", referralReward.toString(), `($${(Number(referralReward) / 1e6).toFixed(2)})`);

  const cfg = CONSTANTS[network];
  if (!cfg) throw new Error(`No constants for network ${network}`);
  let baseDependencies = null;
  if (network === "base") {
    const inspected = await inspectBaseProduction({
      provider: hre.ethers.provider,
      protocolRecipient,
      releaseStage,
    });
    safePolicy = inspected.safePolicy;
    baseDependencies = {
      usdc: inspected.usdc,
      factory: inspected.factory,
      router: inspected.router,
    };
    console.log("Canonical Base dependency preflight passed");
  }

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
    usdcAddress = network === "base" ? baseDependencies.usdc : process.env.USDC_ADDRESS || cfg.usdc;
    if (!usdcAddress) throw new Error("USDC address missing");
    console.log("USDC:", usdcAddress);
  }

  // Router: use mocks on Sepolia unless a complete external deployment is explicitly provided.
  const requestedRouter = network === "base" ? baseDependencies.router : process.env.UNISWAP_V2_ROUTER || cfg.uniswapV2Router;
  const requestedFactory = network === "base" ? baseDependencies.factory : process.env.UNISWAP_V2_FACTORY || cfg.uniswapV2Factory;
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

  if (network === "base") {
    if (safePolicy.hardeningRequired) {
      console.warn("WARNING: closed-cohort deployment; unrestricted public release remains blocked until the Safe is at least 2-of-3");
    }
  }

  const core = await deployOwnerlessVersus(hre.ethers, {
    usdcAddress,
    routerAddress,
    protocolRecipient,
    graduationFloor,
    referralReward,
  });
  transactions.push(...core.transactions);

  if (network === "base" && graduationFloor !== 1_000_000_000n) {
    throw new Error("Base mainnet graduation floor must equal exactly 1,000 USDC");
  }
  if (network === "base" && referralReward !== 1_000_000n) {
    throw new Error("Base mainnet referral reward must equal exactly 1 USDC");
  }
  const { onChainRecipient, onChainFloor } = await verifyLiveDeployment({
    core,
    usdcAddress,
    routerAddress,
    v2FactoryAddress,
    protocolRecipient,
    graduationFloor,
    referralReward,
  });

  console.log("\n✔ Bootstrapped ownerless stack");
  console.log("  Arena     ", core.addresses.arena);
  console.log("  AgentNFT  ", core.addresses.agents);
  console.log("  Syndicate ", core.addresses.syndicate);
  console.log("  Treasury  ", core.addresses.treasury);
  console.log("  Escrow    ", core.addresses.missionEscrow);
  console.log("  Referrals ", core.addresses.referralPool);
  console.log("  Graduation", core.addresses.graduation);
  console.log("  Dev vault ", onChainRecipient);
  console.log("  Floor     ", onChainFloor.toString());

  return writeOut({
    network,
    releaseStage,
    source,
    projectRoot,
    deployer: deployer.address,
    protocolRecipient,
    graduationFloor,
    referralReward,
    usedMockUsdc,
    usedMockRouter,
    contracts: {
      usdc: usdcAddress,
      v2Factory: v2FactoryAddress,
      v2Router: routerAddress,
      ...core.addresses,
    },
    transactions,
    safePolicy,
    buildFingerprint,
  });
}

async function verifyLiveDeployment({ core, usdcAddress, routerAddress, v2FactoryAddress, protocolRecipient, graduationFloor, referralReward }) {
  const same = (actual, expected, label) => {
    if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
      throw new Error(`${label} mismatch after deploy: expected ${expected}, received ${actual}`);
    }
  };
  const truthy = (actual, label) => {
    if (actual !== true) throw new Error(`${label} was not bootstrapped`);
  };
  const a = core.addresses;
  const [
    onChainRecipient,
    onChainFloor,
    recipientCode,
    agentArena, agentTreasury, agentEscrow, agentReferralPool, agentUsdc, agentBootstrapped,
    syndicateArena, syndicateGraduation, syndicateUsdc, syndicateBootstrapped,
    treasuryArena, treasuryAgents, treasuryUsdc, treasuryBootstrapped,
    arenaUsdc, arenaAgents, arenaSyndicate, arenaTreasury, arenaReferralPool,
    graduationUsdc, graduationRouter, graduationFactory, graduationSyndicate, graduationTreasury,
    escrowUsdc, escrowAgents,
    referralUsdc, referralAgents, referralArena, referralRewardOnChain, referralBootstrapped,
    penny, minRunway, protocolBps, bps,
  ] = await Promise.all([
    core.treasury.protocolRecipient(), core.syndicate.graduationFloor(), hre.ethers.provider.getCode(protocolRecipient),
    core.agents.arena(), core.agents.treasury(), core.agents.missionEscrow(), core.agents.referralPool(), core.agents.usdc(), core.agents.bootstrapped(),
    core.syndicate.arena(), core.syndicate.graduation(), core.syndicate.usdc(), core.syndicate.bootstrapped(),
    core.treasury.arena(), core.treasury.agents(), core.treasury.usdc(), core.treasury.bootstrapped(),
    core.arena.usdc(), core.arena.agents(), core.arena.syndicate(), core.arena.treasury(), core.arena.referralPool(),
    core.graduation.usdc(), core.graduation.router(), core.graduation.factory(), core.graduation.syndicate(), core.graduation.treasury(),
    core.missionEscrow.usdc(), core.missionEscrow.agents(),
    core.referralPool.usdc(), core.referralPool.agents(), core.referralPool.arena(), core.referralPool.rewardPerReferral(), core.referralPool.bootstrapped(),
    core.arena.PENNY(), core.arena.MIN_RUNWAY(), core.treasury.PROTOCOL_TRANCHE_BPS(), core.treasury.BPS(),
  ]);
  if (recipientCode === "0x") throw new Error("PROTOCOL_RECIPIENT must contain contract bytecode on live deployments");
  same(onChainRecipient, protocolRecipient, "treasury protocol recipient");
  if (onChainFloor !== graduationFloor) throw new Error("graduation floor mismatch after deploy");
  same(agentArena, a.arena, "agents arena"); same(agentTreasury, a.treasury, "agents treasury");
  same(agentEscrow, a.missionEscrow, "agents mission escrow"); same(agentReferralPool, a.referralPool, "agents referral pool");
  same(agentUsdc, usdcAddress, "agents USDC"); truthy(agentBootstrapped, "agents");
  same(syndicateArena, a.arena, "syndicate arena"); same(syndicateGraduation, a.graduation, "syndicate graduation");
  same(syndicateUsdc, usdcAddress, "syndicate USDC"); truthy(syndicateBootstrapped, "syndicate");
  same(treasuryArena, a.arena, "treasury arena"); same(treasuryAgents, a.agents, "treasury agents");
  same(treasuryUsdc, usdcAddress, "treasury USDC"); truthy(treasuryBootstrapped, "treasury");
  same(arenaUsdc, usdcAddress, "arena USDC"); same(arenaAgents, a.agents, "arena agents");
  same(arenaSyndicate, a.syndicate, "arena syndicate"); same(arenaTreasury, a.treasury, "arena treasury");
  same(arenaReferralPool, a.referralPool, "arena referral pool");
  same(graduationUsdc, usdcAddress, "graduation USDC"); same(graduationRouter, routerAddress, "graduation router");
  same(graduationFactory, v2FactoryAddress, "graduation factory"); same(graduationSyndicate, a.syndicate, "graduation syndicate");
  same(graduationTreasury, a.treasury, "graduation treasury"); same(escrowUsdc, usdcAddress, "escrow USDC");
  same(escrowAgents, a.agents, "escrow agents");
  same(referralUsdc, usdcAddress, "referral pool USDC"); same(referralAgents, a.agents, "referral pool agents");
  same(referralArena, a.arena, "referral pool arena"); truthy(referralBootstrapped, "referral pool");
  if (referralRewardOnChain !== referralReward) throw new Error("referral reward mismatch after deploy");
  if (penny !== 10_000n || minRunway !== 7_000_000n || protocolBps !== 1_000n || bps !== 10_000n) {
    throw new Error("economic constants mismatch after deploy");
  }
  return { onChainRecipient, onChainFloor };
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

function writeOut({ network, releaseStage, source, projectRoot, deployer, protocolRecipient, graduationFloor, referralReward, usedMockUsdc, usedMockRouter, contracts, transactions = [], safePolicy = null, buildFingerprint = null }) {
  const rainAttestors = String(process.env.VERSUS_RAIN_ATTESTORS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => hre.ethers.getAddress(value));
  const sourceInventory = collectSourceHashes(projectRoot);
  let creationBytecode = null;
  let compilerInputSha256 = null;
  if (network === "base") {
    const fingerprint = buildFingerprint || collectFreshBuildFingerprint(projectRoot, hre.ethers);
    compilerInputSha256 = fingerprint.compilerInputSha256;
    creationBytecode = Object.fromEntries(
      Object.entries(fingerprint.contracts).map(([name, value]) => [
        name,
        { keccak256: value.creationBytecodeKeccak256, bytes: value.creationBytecodeBytes },
      ])
    );
  }
  const out = {
    manifestVersion: MANIFEST_VERSION,
    protocol: "versus-cypher",
    network,
    releaseStage,
    releasePolicy: { protocolSafe: safePolicy },
    chainId: null, // filled below async — sync write in caller
    ...(rainAttestors.length ? { rainAttestors: Array.from(new Set(rainAttestors)) } : {}),
    deployer,
    ownerless: true,
    economics: {
      graduationFloorUSDC: (Number(graduationFloor) / 1e6).toFixed(2),
      graduationFloorRaw: graduationFloor.toString(),
      referralRewardUSDC: (Number(referralReward) / 1e6).toFixed(2),
      referralRewardRaw: referralReward.toString(),
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
    dependencies: {
      usdc: contracts.usdc,
      uniswapV2Factory: contracts.v2Factory,
      uniswapV2Router: contracts.v2Router,
    },
    constructorArguments: constructorArguments(contracts, graduationFloor, protocolRecipient, referralReward),
    checklist: {
      protocolRecipientImmutable: true,
      noOwnable: true,
      noPause: true,
      noSeedFund: true,
      missionEscrowOwnerless: true,
      continuousReferralPoolOwnerless: true,
      paidSignalBatches: true,
      permanentDailyVoiceCredentials: true,
      boundedSellTaxSwapContinuousClaim: true,
    },
    source: {
      ...source,
      ...sourceInventory,
    },
    compiler: {
      solidity: "0.8.26",
      optimizer: { enabled: true, runs: 1 },
      viaIR: true,
      evmVersion: "cancun",
      ...(compilerInputSha256 ? { compilerInputSha256, creationBytecode } : {}),
    },
    verification: {
      basescan: { status: network === "base" ? "pending" : "not-applicable" },
      independentAudit: { status: "pending" },
    },
    runtimeBytecode: {},
    deployedAt: new Date().toISOString(),
  };

  return hre.ethers.provider.getNetwork().then(async (net) => {
    out.chainId = Number(net.chainId);
    for (const key of CONTRACT_KEYS) {
      const address = contracts[key];
      if (typeof address !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
        throw new Error(`manifest contracts.${key} is missing`);
      }
      const code = await hre.ethers.provider.getCode(address);
      out.runtimeBytecode[key] = {
        address: hre.ethers.getAddress(address),
        bytes: (code.length - 2) / 2,
        keccak256: hre.ethers.keccak256(code),
      };
    }
    const blockNumbers = transactions.map((transaction) => Number(transaction.blockNumber)).filter(Number.isFinite);
    out.deploymentBlocks = {
      first: blockNumbers.length ? Math.min(...blockNumbers) : null,
      last: blockNumbers.length ? Math.max(...blockNumbers) : null,
    };
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
