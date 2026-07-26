const fs = require("node:fs");
const path = require("node:path");

const hre = require("hardhat");

const {
  preflightEvmCapability,
  validateEvmAdapterManifest,
} = require("../../../packages/network/src/fx-evm-adapter");

async function main() {
  if (!process.env.FX_ADAPTER_MANIFEST) {
    throw new Error("FX_ADAPTER_MANIFEST is required");
  }
  const manifestPath = path.resolve(process.env.FX_ADAPTER_MANIFEST);
  const manifest = validateEvmAdapterManifest(
    JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  );
  const connectedChainId = String((await hre.ethers.provider.getNetwork()).chainId);
  const capability = manifest.capabilities.find(
    (candidate) => candidate.chainId === connectedChainId
  );
  if (!capability) throw new Error("manifest has no capability for the connected chain");

  await preflightEvmCapability(hre.ethers.provider, manifest, {
    chainId: capability.chainId,
    token: capability.asset.address,
    decimals: capability.asset.decimals,
  });

  if (process.env.FX_EXPLORER_VERIFY === "true") {
    await hre.run("verify:verify", {
      address: capability.adapterAddress,
      constructorArguments: [
        capability.asset.address,
        capability.asset.decimals,
        capability.timeoutPolicy.minimumSeconds,
        capability.timeoutPolicy.maximumSeconds,
      ],
      contract: "contracts/fx/EvmHtlcV1.sol:EvmHtlcV1",
    });
  }
  console.log(
    JSON.stringify(
      {
        verified: true,
        chainId: capability.chainId,
        adapterAddress: capability.adapterAddress,
        runtimeCodeHash: capability.runtimeCodeHash,
        explorerSubmitted: process.env.FX_EXPLORER_VERIFY === "true",
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
