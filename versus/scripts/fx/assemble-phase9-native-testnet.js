const fs = require("node:fs");
const path = require("node:path");
const { keccak256, toUtf8Bytes } = require("ethers");
const { canonicalJson } = require("../../../packages/network/src/fx-protocol");
const {
  validateEvmAdapterManifest,
} = require("../../../packages/network/src/fx-evm-adapter");
const {
  validateEvmNativeAdapterManifest,
} = require("../../../packages/network/src/fx-evm-native-adapter");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function withoutEvidence(record) {
  const { evidence, ...manifest } = record;
  return { manifest, evidence };
}

function main() {
  const contractsRoot = path.resolve(__dirname, "..", "..");
  const repositoryRoot = path.resolve(contractsRoot, "..");
  const phase5Directory = path.resolve(
    process.env.FX_PHASE5_IDENTITY_DIRECTORY ||
      path.join(repositoryRoot, ".local", "fx-phase5-testnet")
  );
  const phase5 = readJson(
    path.join(phase5Directory, "phase5-testnet-routes.json")
  );
  const erc20Manifest = validateEvmAdapterManifest(phase5.manifest);
  const baseRecord = withoutEvidence(readJson(path.join(
    contractsRoot,
    "deployments",
    "fx",
    "baseSepolia-84532-evm-native-htlc-v1.json"
  )));
  const arbitrumRecord = withoutEvidence(readJson(path.join(
    contractsRoot,
    "deployments",
    "fx",
    "arbitrumSepolia-421614-evm-native-htlc-v1.json"
  )));
  const nativeManifest = validateEvmNativeAdapterManifest({
    ...baseRecord.manifest,
    capabilities: [
      ...baseRecord.manifest.capabilities,
      ...arbitrumRecord.manifest.capabilities,
    ],
  });
  const adapters = [
    ...erc20Manifest.capabilities.map((capability) => ({
      chainId: capability.chainId,
      assetId: `erc20:${capability.asset.address}`,
      adapterId: "evm-htlc-v1",
      adapterAddress: capability.adapterAddress,
      runtimeCodeHash: capability.runtimeCodeHash,
    })),
    ...nativeManifest.capabilities.map((capability) => ({
      chainId: capability.chainId,
      assetId: capability.asset.assetId,
      adapterId: "evm-native-htlc-v1",
      adapterAddress: capability.adapterAddress,
      runtimeCodeHash: capability.runtimeCodeHash,
    })),
  ].sort((left, right) =>
    `${left.chainId}:${left.assetId}`.localeCompare(
      `${right.chainId}:${right.assetId}`
    )
  );
  const deploymentId = keccak256(toUtf8Bytes(canonicalJson({
    protocol: "versus-fx-phase9",
    environment: "public-testnet",
    adapters,
  })));
  const output = {
    schema: "versus-fx-phase9-public-testnet",
    schemaVersion: 1,
    environment: "public-testnet",
    enabledByDefault: false,
    productionFunds: false,
    deploymentId,
    nativeAssetWireAddress: "0x0000000000000000000000000000000000000000",
    erc20Manifest,
    nativeManifest,
    nativeDeploymentEvidence: {
      "84532": baseRecord.evidence,
      "421614": arbitrumRecord.evidence,
    },
  };
  const outputPath = path.join(
    contractsRoot,
    "deployments",
    "fx",
    "phase9-public-testnet.json"
  );
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, {
    encoding: "utf8",
  });
  console.log(JSON.stringify({ outputPath, deploymentId, adapters }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
}
