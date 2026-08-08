const fs = require("node:fs");
const path = require("node:path");
const { keccak256, toUtf8Bytes } = require("ethers");
const {
  canonicalJson,
} = require("../../../packages/network/src/fx-protocol");
const {
  validateEvmV2Manifest,
} = require("../../../packages/network/src/fx-evm-v2-adapter");

const ROOT = path.resolve(__dirname, "..", "..");
const DEPLOYMENTS = path.join(ROOT, "deployments", "fx");
const INPUT = path.join(
  DEPLOYMENTS,
  "phase10-v2-public-testnet.json"
);
const OUTPUT = path.join(
  DEPLOYMENTS,
  "phase11-v2-source-first-public-testnet.json"
);

function main() {
  const previous = JSON.parse(fs.readFileSync(INPUT, "utf8"));
  const manifest = validateEvmV2Manifest({
    schema: previous.schema,
    schemaVersion: previous.schemaVersion,
    settlementMode: "dealer-secret-source-first",
    builds: previous.builds,
    capabilities: previous.capabilities,
  });
  const deploymentId = keccak256(toUtf8Bytes(canonicalJson(manifest)));
  const output = {
    ...manifest,
    deploymentId,
    reusesContractDeploymentId: previous.deploymentId,
    evidence: previous.evidence,
  };
  fs.writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ outputPath: OUTPUT, deploymentId }, null, 2));
}

main();
