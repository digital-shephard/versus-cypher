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
const INPUTS = Object.freeze([
  "baseSepolia-84532-evm-htlc-v2.json",
  "arbitrumSepolia-421614-evm-htlc-v2.json",
]);
const OUTPUT = path.join(DEPLOYMENTS, "phase10-v2-public-testnet.json");

function readDeployment(fileName) {
  return JSON.parse(fs.readFileSync(path.join(DEPLOYMENTS, fileName), "utf8"));
}

function main() {
  const records = INPUTS.map(readDeployment);
  const manifest = validateEvmV2Manifest({
    schema: records[0].schema,
    schemaVersion: records[0].schemaVersion,
    settlementMode: records[0].settlementMode,
    builds: records[0].builds,
    capabilities: records
      .flatMap((record) => record.capabilities)
      .sort((left, right) => BigInt(left.chainId) < BigInt(right.chainId) ? -1 : 1),
  });
  const deploymentId = keccak256(toUtf8Bytes(canonicalJson(manifest)));
  const output = {
    ...manifest,
    deploymentId,
    evidence: Object.fromEntries(records.map((record) => [
      record.capabilities[0].chainId,
      record.evidence,
    ])),
  };
  fs.writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ outputPath: OUTPUT, deploymentId }, null, 2));
}

main();
