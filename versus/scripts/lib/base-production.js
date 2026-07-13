const { Contract, getAddress } = require("ethers");
const CONSTANTS = require("./constants");
const { evaluateSafePolicy } = require("./deployment-manifest");
const { inspectSafeConfiguration } = require("./safe-inspection");

const BASE_DEPENDENCY_ENV = Object.freeze({
  USDC_ADDRESS: "usdc",
  UNISWAP_V2_FACTORY: "uniswapV2Factory",
  UNISWAP_V2_ROUTER: "uniswapV2Router",
  PROTOCOL_RECIPIENT: "protocolRecipient",
});

function canonicalBaseDependencies(env = process.env) {
  if (env.USE_MOCK_USDC === "true" || env.USE_MOCK_ROUTER === "true") {
    throw new Error("Base mainnet deployment cannot use mock USDC or Uniswap contracts");
  }

  for (const [name, key] of Object.entries(BASE_DEPENDENCY_ENV)) {
    const value = env[name];
    if (!value) continue;
    let actual;
    try {
      actual = getAddress(value);
    } catch (_) {
      throw new Error(`${name} is not a valid address`);
    }
    const expected = getAddress(CONSTANTS.base[key]);
    if (actual !== expected) {
      throw new Error(`${name} cannot override canonical Base dependency ${expected}`);
    }
  }

  return Object.freeze({
    chainId: CONSTANTS.base.chainId,
    weth: getAddress(CONSTANTS.base.weth),
    usdc: getAddress(CONSTANTS.base.usdc),
    factory: getAddress(CONSTANTS.base.uniswapV2Factory),
    router: getAddress(CONSTANTS.base.uniswapV2Router),
    protocolRecipient: getAddress(CONSTANTS.base.protocolRecipient),
    safeSingleton: getAddress(CONSTANTS.base.safeSingleton),
    safeFallbackHandler: getAddress(CONSTANTS.base.safeFallbackHandler),
  });
}

async function inspectBaseProduction({ provider, protocolRecipient, releaseStage, env = process.env }) {
  const dependencies = canonicalBaseDependencies(env);
  const recipient = getAddress(protocolRecipient || dependencies.protocolRecipient);
  if (recipient !== dependencies.protocolRecipient) {
    throw new Error(`protocol recipient must equal canonical Base Safe ${dependencies.protocolRecipient}`);
  }
  const router = new Contract(
    dependencies.router,
    ["function factory() view returns (address)", "function WETH() view returns (address)"],
    provider
  );
  const usdc = new Contract(dependencies.usdc, ["function decimals() view returns (uint8)"], provider);

  const [network, factory, weth, decimals, usdcCode, factoryCode, routerCode, recipientCode, safeConfig] =
    await Promise.all([
      provider.getNetwork(),
      router.factory(),
      router.WETH(),
      usdc.decimals(),
      provider.getCode(dependencies.usdc),
      provider.getCode(dependencies.factory),
      provider.getCode(dependencies.router),
      provider.getCode(recipient),
      inspectSafeConfiguration(provider, recipient, {
        expectedSingleton: dependencies.safeSingleton,
        expectedFallbackHandler: dependencies.safeFallbackHandler,
      }),
    ]);

  if (Number(network.chainId) !== dependencies.chainId) throw new Error("Base RPC returned the wrong chain");
  if (getAddress(factory) !== dependencies.factory) throw new Error(`router factory mismatch: ${factory}`);
  if (getAddress(weth) !== dependencies.weth) throw new Error(`router WETH mismatch: ${weth}`);
  if (Number(decimals) !== 6) throw new Error(`canonical Base USDC decimals mismatch: ${decimals}`);
  for (const [label, code] of [
    ["USDC", usdcCode],
    ["Uniswap V2 factory", factoryCode],
    ["Uniswap V2 router", routerCode],
    ["protocol recipient", recipientCode],
  ]) {
    if (code === "0x") throw new Error(`${label} has no bytecode`);
  }

  const safePolicy = evaluateSafePolicy({
    owners: safeConfig.owners,
    threshold: safeConfig.threshold,
    releaseStage,
  });
  safePolicy.owners = safeConfig.owners;
  safePolicy.singleton = safeConfig.singleton;
  safePolicy.modules = safeConfig.modules;
  safePolicy.guard = safeConfig.guard;
  safePolicy.fallbackHandler = safeConfig.fallbackHandler;
  if (!safePolicy.passed) {
    throw new Error(`protocol Safe does not satisfy ${safePolicy.required} policy`);
  }

  return {
    chainId: Number(network.chainId),
    ...dependencies,
    safeOwners: safePolicy.owners,
    safeThreshold: safeConfig.threshold,
    safeSingleton: safeConfig.singleton,
    safeConfig,
    safePolicy,
  };
}

module.exports = { BASE_DEPENDENCY_ENV, canonicalBaseDependencies, inspectBaseProduction };
