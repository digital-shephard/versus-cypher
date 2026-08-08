const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");
const {
  preflightEvmNativeCapability,
  validateEvmNativeAdapterManifest,
} = require("../../../packages/network/src/fx-evm-native-adapter");

async function main() {
  const network = await hre.ethers.provider.getNetwork();
  const manifestPath = path.join(
    __dirname,
    "..",
    "..",
    "deployments",
    "fx",
    `${hre.network.name}-${network.chainId}-evm-native-htlc-v1.json`
  );
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const evidence = raw.evidence;
  delete raw.evidence;
  const manifest = validateEvmNativeAdapterManifest(raw);
  const capability = await preflightEvmNativeCapability(
    hre.ethers.provider,
    manifest,
    { chainId: String(network.chainId), assetId: "native:eth" }
  );
  if (process.env.FX_EXPLORER_VERIFY === "true") {
    await hre.run("verify:verify", {
      address: capability.adapterAddress,
      constructorArguments: [
        capability.timeoutPolicy.minimumSeconds,
        capability.timeoutPolicy.maximumSeconds,
      ],
      contract: "contracts/fx/EvmNativeHtlcV1.sol:EvmNativeHtlcV1",
    });
  }
  console.log(JSON.stringify({
    verified: true,
    chainId: capability.chainId,
    adapterAddress: capability.adapterAddress,
    deploymentBlock: capability.deploymentBlock,
    transactionHash: evidence?.transactionHash,
    runtimeCodeHash: capability.runtimeCodeHash,
    explorerSubmitted: process.env.FX_EXPLORER_VERIFY === "true",
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
