const fs = require("node:fs");
const path = require("node:path");
const { keccak256, toUtf8Bytes } = require("ethers");
const { canonicalJson } = require("../../../packages/network/src/fx-protocol");
const {
  validateEvmAdapterManifest,
} = require("../../../packages/network/src/fx-evm-adapter");
const {
  validatePhase5Route,
} = require("../../../packages/network/src/fx-phase5-route");

function main() {
  const repositoryRoot = path.resolve(__dirname, "..", "..", "..");
  const directory = path.resolve(
    process.env.FX_PHASE5_IDENTITY_DIRECTORY ||
      path.join(repositoryRoot, ".local", "fx-phase5-testnet")
  );
  const base = JSON.parse(
    fs.readFileSync(path.join(directory, "deployments", "base-sepolia.json"), "utf8")
  );
  const arbitrum = JSON.parse(
    fs.readFileSync(
      path.join(directory, "deployments", "arbitrum-sepolia.json"),
      "utf8"
    )
  );
  const manifest = validateEvmAdapterManifest({
    ...base.manifest,
    capabilities: [
      ...base.manifest.capabilities,
      ...arbitrum.manifest.capabilities,
    ],
  });
  const deploymentId = keccak256(toUtf8Bytes(canonicalJson({
    protocol: "versus-fx-phase5",
    environment: "public-testnet",
    adapters: manifest.capabilities.map((capability) => ({
      chainId: capability.chainId,
      adapterAddress: capability.adapterAddress,
      assetAddress: capability.asset.address,
      runtimeCodeHash: capability.runtimeCodeHash,
    })),
  })));
  const identities = base.identities;
  const leg = (record) => {
    const capability = record.manifest.capabilities[0];
    return {
      chainId: capability.chainId,
      name: record.network.name,
      rpcEnvironmentVariable: record.network.rpcEnvironmentVariable,
      explorerUrl: record.network.explorerUrl,
      adapterAddress: capability.adapterAddress,
      tokenAddress: capability.asset.address,
      decimals: capability.asset.decimals,
    };
  };
  const common = {
    schema: "versus-fx-phase5-route",
    schemaVersion: 1,
    environment: "public-testnet",
    deploymentId,
    enabledByDefault: false,
    productionWaku: false,
    productionFunds: false,
    requester: identities.requester,
    dealer: identities.dealer,
    relayer: identities.relayer,
    inputAmountAtomic: "10000",
    outputAmountAtomic: "10000",
    sourceLockSeconds: 600,
    destinationLockSeconds: 180,
    minimumTimeoutDeltaSeconds: 120,
  };
  const routes = {
    baseToArbitrum: validatePhase5Route({
      ...common,
      source: leg(base),
      destination: leg(arbitrum),
    }, manifest),
    arbitrumToBase: validatePhase5Route({
      ...common,
      source: leg(arbitrum),
      destination: leg(base),
    }, manifest),
  };
  const output = {
    schema: "versus-fx-phase5-testnet-routes",
    schemaVersion: 1,
    environment: "public-testnet",
    deploymentId,
    manifest,
    routes,
  };
  const outputPath = path.join(directory, "phase5-testnet-routes.json");
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify({ outputPath, deploymentId, routes }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
