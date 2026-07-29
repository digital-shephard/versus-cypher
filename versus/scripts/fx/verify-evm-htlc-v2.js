const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");
const {
  preflightEvmV2Capability,
  validateEvmV2Manifest,
} = require("../../../packages/network/src/fx-evm-v2-adapter");

async function main() {
  const network = await hre.ethers.provider.getNetwork();
  const manifestPath = path.join(
    __dirname,
    "..",
    "..",
    "deployments",
    "fx",
    `${hre.network.name}-${network.chainId}-evm-htlc-v2.json`
  );
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const evidence = raw.evidence;
  delete raw.evidence;
  const manifest = validateEvmV2Manifest(raw);
  const [native, erc20] = await Promise.all([
    preflightEvmV2Capability(hre.ethers.provider, manifest, {
      chainId: String(network.chainId),
      token: "native:eth",
    }),
    preflightEvmV2Capability(hre.ethers.provider, manifest, {
      chainId: String(network.chainId),
      token: manifest.capabilities[0].erc20.asset.address,
    }),
  ]);
  if (process.env.FX_EXPLORER_VERIFY === "true") {
    await hre.run("verify:verify", {
      address: native.adapterAddress,
      constructorArguments: [
        native.policy.timeoutPolicy.minimumSeconds,
        native.policy.timeoutPolicy.maximumSeconds,
      ],
      contract: "contracts/fx/EvmNativeHtlcV2.sol:EvmNativeHtlcV2",
    });
    await hre.run("verify:verify", {
      address: erc20.adapterAddress,
      constructorArguments: [
        erc20.asset.address,
        erc20.asset.decimals,
        erc20.policy.timeoutPolicy.minimumSeconds,
        erc20.policy.timeoutPolicy.maximumSeconds,
      ],
      contract: "contracts/fx/EvmHtlcV2.sol:EvmHtlcV2",
    });
  }
  console.log(JSON.stringify({
    verified: true,
    chainId: String(network.chainId),
    nativeAdapterAddress: native.adapterAddress,
    nativeTransactionHash: evidence?.native?.transactionHash,
    erc20AdapterAddress: erc20.adapterAddress,
    erc20TransactionHash: evidence?.erc20?.transactionHash,
    explorerSubmitted: process.env.FX_EXPLORER_VERIFY === "true",
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
