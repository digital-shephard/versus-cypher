const fs = require("node:fs");
const path = require("node:path");
const { keccak256, toUtf8Bytes } = require("ethers");
const { canonicalJson } = require("../../../packages/network/src/fx-protocol");
const {
  SCHEMA,
  SCHEMA_VERSION,
  SETTLEMENT_MODE,
  assert,
  validateV3Manifest,
} = require("./v3-deployment-manifest");

const INPUTS = Object.freeze([
  "baseSepolia-84532-evm-htlc-v3.json",
  "arbitrumSepolia-421614-evm-htlc-v3.json",
]);
const LEGACY_INPUTS = Object.freeze([
  "phase10-v2-public-testnet.json",
  "phase11-v2-source-first-public-testnet.json",
]);
const OUTPUT = "phase12-v3-public-testnet.json";

function main() {
  const contractsRoot = path.resolve(__dirname, "..", "..");
  const deployments = path.join(contractsRoot, "deployments", "fx");
  const records = INPUTS.map((fileName) =>
    JSON.parse(fs.readFileSync(path.join(deployments, fileName), "utf8"))
  );
  for (const record of records) {
    assert(
      record.evidence?.native?.verification?.sourceVerified === true &&
        record.evidence?.erc20?.verification?.sourceVerified === true,
      `V3 deployment ${record.capabilities?.[0]?.chainId} is not explorer verified`
    );
  }
  const manifest = validateV3Manifest({
    schema: SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    settlementMode: SETTLEMENT_MODE,
    builds: records[0].builds,
    capabilities: records
      .flatMap((record) => record.capabilities)
      .sort((left, right) =>
        BigInt(left.chainId) < BigInt(right.chainId) ? -1 : 1
      ),
  }, contractsRoot);
  const deploymentId = keccak256(toUtf8Bytes(canonicalJson(manifest)));
  const coordinationDomain = keccak256(
    toUtf8Bytes(`versus-fx-v3-coordination:${deploymentId}`)
  );
  for (const legacyFile of LEGACY_INPUTS) {
    const legacyPath = path.join(deployments, legacyFile);
    if (fs.existsSync(legacyPath)) {
      const legacy = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
      assert(
        deploymentId !== legacy.deploymentId &&
          coordinationDomain !== legacy.deploymentId,
        `V3 domain collides with ${legacyFile}`
      );
    }
  }
  const output = {
    ...manifest,
    deploymentId,
    coordinationDomain,
    evidence: Object.fromEntries(records.map((record) => [
      record.capabilities[0].chainId,
      record.evidence,
    ])),
  };
  const outputPath = path.join(deployments, OUTPUT);
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  console.log(JSON.stringify({
    outputPath,
    deploymentId,
    coordinationDomain,
  }, null, 2));
}

main();
