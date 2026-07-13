const { JsonRpcProvider } = require("ethers");
const path = require("path");
const hre = require("hardhat");
const CONSTANTS = require("./lib/constants");
const { inspectBaseProduction } = require("./lib/base-production");
const {
  assertBaseSourceReady,
  resolveReleaseStage,
  resolveSourceState,
} = require("./lib/deployment-manifest");
const {
  assertBuildMatchesFreeze,
  collectFreshBuildFingerprint,
  loadBuildFreeze,
} = require("./lib/build-freeze");

async function main() {
  const releaseStage = resolveReleaseStage("base");
  const projectRoot = path.join(__dirname, "..");
  const source = resolveSourceState(path.join(__dirname, "..", ".."));
  assertBaseSourceReady(source);

  await hre.run("compile");
  const freeze = loadBuildFreeze(projectRoot);
  const fingerprint = collectFreshBuildFingerprint(projectRoot, hre.ethers);
  assertBuildMatchesFreeze(fingerprint, freeze);

  const rpcUrl = process.env.BASE_RPC_URL || "https://mainnet.base.org";
  const protocolRecipient = process.env.PROTOCOL_RECIPIENT || CONSTANTS.base.protocolRecipient;
  const provider = new JsonRpcProvider(rpcUrl, CONSTANTS.base.chainId, {
    staticNetwork: true,
    cacheTimeout: -1,
  });
  const inspected = await inspectBaseProduction({ provider, protocolRecipient, releaseStage });

  const report = {
    chainId: inspected.chainId,
    usdc: inspected.usdc,
    factory: inspected.factory,
    router: inspected.router,
    weth: inspected.weth,
    protocolRecipient: inspected.protocolRecipient,
    safeOwners: inspected.safeOwners,
    safeThreshold: inspected.safeThreshold,
    safeSingleton: inspected.safeSingleton,
    safeConfig: {
      singleton: inspected.safeConfig.singleton,
      modules: inspected.safeConfig.modules,
      guard: inspected.safeConfig.guard,
      fallbackHandler: inspected.safeConfig.fallbackHandler,
    },
    buildFreeze: {
      compilerInputSha256: fingerprint.compilerInputSha256,
      contracts: Object.keys(fingerprint.contracts),
    },
    releaseStage,
    sourceCommit: source.commit,
    checkedAt: new Date().toISOString(),
    safePolicy: inspected.safePolicy,
  };
  console.log(JSON.stringify(report, null, 2));
  if (report.safePolicy.hardeningRequired) {
    console.warn("WARNING: closed-cohort Safe accepted, but unrestricted public release remains blocked until it is at least 2-of-3");
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
