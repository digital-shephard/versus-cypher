const fs = require("node:fs");
const path = require("node:path");
const {
  FILE_KEYS,
  deploymentPaths,
  preflightV3Capability,
  providerFor,
  validateV3Manifest,
} = require("./v3-deployment-manifest");

async function preflightOne(contractsRoot, networkId) {
  const { network, outputPath } = deploymentPaths(contractsRoot, networkId);
  const record = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  const manifest = validateV3Manifest(record, contractsRoot);
  const result = await preflightV3Capability(
    providerFor(network),
    manifest,
    network.chainId
  );
  return {
    ...result,
    nativeTransactionHash: record.evidence?.native?.transactionHash,
    erc20TransactionHash: record.evidence?.erc20?.transactionHash,
    nativeVerification: record.evidence?.native?.verification,
    erc20Verification: record.evidence?.erc20?.verification,
  };
}

async function main() {
  const requested = String(process.argv[2] || "all");
  const networkIds =
    requested === "all" ? Object.keys(FILE_KEYS) : [requested];
  const contractsRoot = path.resolve(__dirname, "..", "..");
  const results = [];
  for (const networkId of networkIds) {
    results.push(await preflightOne(contractsRoot, networkId));
  }
  console.log(JSON.stringify({
    schema: "versus-fx-v3-rpc-preflight",
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    results,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
