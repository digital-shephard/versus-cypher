const { Contract, getAddress, keccak256 } = require("ethers");
const { evaluateSafePolicy, validateManifest } = require("./deployment-manifest");
const { inspectSafeConfiguration } = require("./safe-inspection");
const CONSTANTS = require("./constants");

const ROUTER_ABI = ["function factory() view returns (address)", "function WETH() view returns (address)"];
const EXPECTED_WETH = CONSTANTS.base.weth;

async function auditDeployment(provider, manifest, options = {}) {
  const schema = validateManifest(manifest, options);
  if (!schema.valid) throw new Error(`invalid deployment manifest: ${schema.errors.join("; ")}`);
  const checks = [];
  const check = (name, actual, expected) => {
    const passed = String(actual).toLowerCase() === String(expected).toLowerCase();
    checks.push({ name, passed, actual: String(actual), expected: String(expected) });
    if (!passed) throw new Error(`${name}: expected ${expected}, received ${actual}`);
  };
  const network = await provider.getNetwork();
  check("chain id", Number(network.chainId), Number(manifest.chainId));
  const c = manifest.contracts;
  const abis = {
    agents: ["function usdc() view returns(address)", "function arena() view returns(address)", "function treasury() view returns(address)", "function missionEscrow() view returns(address)", "function referralPool() view returns(address)", "function bootstrapped() view returns(bool)", "function CYPHER_COUNT() view returns(uint8)", "function METADATA_BASE_URI() view returns(string)"],
    syndicate: ["function usdc() view returns(address)", "function arena() view returns(address)", "function graduation() view returns(address)", "function graduationFloor() view returns(uint256)", "function bootstrapped() view returns(bool)"],
    treasury: ["function usdc() view returns(address)", "function arena() view returns(address)", "function agents() view returns(address)", "function protocolRecipient() view returns(address)", "function PROTOCOL_TRANCHE_BPS() view returns(uint256)", "function BPS() view returns(uint256)", "function bootstrapped() view returns(bool)"],
    arena: ["function usdc() view returns(address)", "function agents() view returns(address)", "function syndicate() view returns(address)", "function treasury() view returns(address)", "function referralPool() view returns(address)", "function PENNY() view returns(uint256)", "function MIN_RUNWAY() view returns(uint256)"],
    graduation: ["function usdc() view returns(address)", "function router() view returns(address)", "function factory() view returns(address)", "function syndicate() view returns(address)", "function treasury() view returns(address)"],
    missionEscrow: ["function usdc() view returns(address)", "function agents() view returns(address)"],
    referralPool: ["function usdc() view returns(address)", "function agents() view returns(address)", "function arena() view returns(address)", "function rewardPerReferral() view returns(uint256)", "function bootstrapped() view returns(bool)"],
  };
  const x = Object.fromEntries(Object.entries(abis).map(([key, abi]) => [key, new Contract(c[key], abi, provider)]));
  const expectedBindings = [
    ["agents.usdc", await x.agents.usdc(), c.usdc], ["agents.arena", await x.agents.arena(), c.arena],
    ["agents.treasury", await x.agents.treasury(), c.treasury], ["agents.missionEscrow", await x.agents.missionEscrow(), c.missionEscrow],
    ["agents.referralPool", await x.agents.referralPool(), c.referralPool],
    ["syndicate.usdc", await x.syndicate.usdc(), c.usdc], ["syndicate.arena", await x.syndicate.arena(), c.arena],
    ["syndicate.graduation", await x.syndicate.graduation(), c.graduation],
    ["treasury.usdc", await x.treasury.usdc(), c.usdc], ["treasury.arena", await x.treasury.arena(), c.arena],
    ["treasury.agents", await x.treasury.agents(), c.agents], ["treasury.protocolRecipient", await x.treasury.protocolRecipient(), manifest.economics.protocolRecipient],
    ["arena.usdc", await x.arena.usdc(), c.usdc], ["arena.agents", await x.arena.agents(), c.agents],
    ["arena.syndicate", await x.arena.syndicate(), c.syndicate], ["arena.treasury", await x.arena.treasury(), c.treasury],
    ["arena.referralPool", await x.arena.referralPool(), c.referralPool],
    ["graduation.usdc", await x.graduation.usdc(), c.usdc], ["graduation.router", await x.graduation.router(), c.v2Router],
    ["graduation.factory", await x.graduation.factory(), c.v2Factory], ["graduation.syndicate", await x.graduation.syndicate(), c.syndicate],
    ["graduation.treasury", await x.graduation.treasury(), c.treasury], ["missionEscrow.usdc", await x.missionEscrow.usdc(), c.usdc],
    ["missionEscrow.agents", await x.missionEscrow.agents(), c.agents],
    ["referralPool.usdc", await x.referralPool.usdc(), c.usdc], ["referralPool.agents", await x.referralPool.agents(), c.agents],
    ["referralPool.arena", await x.referralPool.arena(), c.arena],
  ];
  expectedBindings.forEach(([name, actual, expected]) => check(name, actual, expected));
  check("agents bootstrapped", await x.agents.bootstrapped(), true);
  check("syndicate bootstrapped", await x.syndicate.bootstrapped(), true);
  check("treasury bootstrapped", await x.treasury.bootstrapped(), true);
  check("referral pool bootstrapped", await x.referralPool.bootstrapped(), true);
  check("graduation floor", await x.syndicate.graduationFloor(), manifest.economics.graduationFloorRaw);
  check("penny", await x.arena.PENNY(), 10000);
  check("minimum runway", await x.arena.MIN_RUNWAY(), 7000000);
  check("referral reward", await x.referralPool.rewardPerReferral(), manifest.economics.referralRewardRaw);
  check("protocol tranche bps", await x.treasury.PROTOCOL_TRANCHE_BPS(), 1000);
  check("basis points", await x.treasury.BPS(), 10000);
  check("cypher species count", await x.agents.CYPHER_COUNT(), 29);
  check("metadata base URI", await x.agents.METADATA_BASE_URI(), "ipfs://bafybeicbtgrjvljtdjgjua6n6vteayl5micu222mbw5ifessrx63xpuyzy/");

  const bytecode = {};
  for (const label of Object.keys(manifest.runtimeBytecode)) {
    const expectedAddress = getAddress(manifest.contracts[label]);
    check(`${label} runtime address binding`, getAddress(manifest.runtimeBytecode[label].address), expectedAddress);
    const code = await provider.getCode(expectedAddress);
    if (code === "0x") throw new Error(`${label} has no runtime bytecode`);
    const hash = keccak256(code);
    check(`${label} runtime bytecode`, hash, manifest.runtimeBytecode[label].keccak256);
    bytecode[label] = { address: expectedAddress, bytes: (code.length - 2) / 2, keccak256: hash };
  }

  let safePolicy = null;
  if (manifest.network === "base") {
    check("canonical Base USDC", c.usdc, CONSTANTS.base.usdc);
    check("canonical Base V2 factory", c.v2Factory, CONSTANTS.base.uniswapV2Factory);
    check("canonical Base V2 router", c.v2Router, CONSTANTS.base.uniswapV2Router);
    check("canonical Base protocol recipient", manifest.economics.protocolRecipient, CONSTANTS.base.protocolRecipient);
    const router = new Contract(c.v2Router, ROUTER_ABI, provider);
    check("router factory", await router.factory(), c.v2Factory);
    check("router WETH", await router.WETH(), EXPECTED_WETH);
    const safeConfig = await inspectSafeConfiguration(provider, manifest.economics.protocolRecipient, {
      expectedSingleton: CONSTANTS.base.safeSingleton,
      expectedFallbackHandler: CONSTANTS.base.safeFallbackHandler,
    });
    check("safe singleton", safeConfig.singleton, CONSTANTS.base.safeSingleton);
    check("safe modules empty", safeConfig.modules.length, 0);
    check("safe guard zero", safeConfig.guard || "0x0", "0x0");
    check("safe fallback handler", safeConfig.fallbackHandler, CONSTANTS.base.safeFallbackHandler);
    safePolicy = evaluateSafePolicy({
      owners: safeConfig.owners,
      threshold: safeConfig.threshold,
      releaseStage: manifest.releaseStage,
    });
    safePolicy.owners = safeConfig.owners;
    safePolicy.singleton = safeConfig.singleton;
    safePolicy.modules = safeConfig.modules;
    safePolicy.guard = safeConfig.guard;
    safePolicy.fallbackHandler = safeConfig.fallbackHandler;
    if (!safePolicy.passed) throw new Error(`protocol Safe does not satisfy ${safePolicy.required} policy`);
  }
  return { passed: true, checks, bytecode, safePolicy };
}

module.exports = { auditDeployment, EXPECTED_WETH };
