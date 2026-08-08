const fs = require("node:fs");
const path = require("node:path");
const {
  networkConfig,
  preflightDeployment,
  providerFor,
} = require("./exact-testnet-config");

async function main() {
  const contractsRoot = path.resolve(__dirname, "..", "..");
  const results = [];
  for (const networkId of ["base-sepolia", "arbitrum-sepolia"]) {
    const network = networkConfig(networkId);
    const record = JSON.parse(fs.readFileSync(path.join(
      contractsRoot,
      "deployments",
      "fx",
      `${network.key}-${network.chainId}-x402-exact.json`
    ), "utf8"));
    results.push(await preflightDeployment(providerFor(network), network, record));
  }
  console.log(JSON.stringify({
    schema: "versus-fx-x402-exact-rpc-preflight",
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    results,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
