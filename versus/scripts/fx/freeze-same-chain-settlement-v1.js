const path = require("node:path");
const { writeSettlementFreeze } = require("./settlement-build-freeze");

const root = path.resolve(__dirname, "..", "..");
const outputPath = process.env.FX_SETTLEMENT_FREEZE_OUTPUT
  ? path.resolve(process.env.FX_SETTLEMENT_FREEZE_OUTPUT)
  : path.join(
      root,
      "deployments",
      "fx",
      "same-chain-settlement-v1-build.json"
    );
const record = writeSettlementFreeze(outputPath, root);
console.log(JSON.stringify({
  outputPath,
  sourceSha256: record.sourceSha256,
  creationCodeHash: record.creationCodeHash,
  compiler: record.compiler.longVersion,
}, null, 2));
