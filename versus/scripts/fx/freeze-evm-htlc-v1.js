const path = require("node:path");

const { writeFreezeRecord } = require("./build-freeze");

const root = path.resolve(__dirname, "..", "..");
const outputPath = process.env.FX_BUILD_FREEZE_OUTPUT
  ? path.resolve(process.env.FX_BUILD_FREEZE_OUTPUT)
  : path.join(root, "deployments", "fx", "evm-htlc-v1-build.json");
const record = writeFreezeRecord(outputPath, root);

console.log(
  JSON.stringify(
    {
      outputPath,
      sourceSha256: record.sourceSha256,
      creationCodeHash: record.creationCodeHash,
      compiler: record.compiler.longVersion,
    },
    null,
    2
  )
);
