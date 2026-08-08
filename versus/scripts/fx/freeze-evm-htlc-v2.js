const path = require("node:path");
const { writeV2FreezeRecord } = require("./v2-build-freeze");

const root = path.resolve(__dirname, "..", "..");
const outputPath = path.join(
  root,
  "deployments",
  "fx",
  "evm-htlc-v2-build.json"
);
const record = writeV2FreezeRecord(outputPath, root);
console.log(JSON.stringify({
  outputPath,
  nativeCreationCodeHash: record.builds.native.creationCodeHash,
  erc20CreationCodeHash: record.builds.erc20.creationCodeHash,
  compiler: record.builds.native.compilerLongVersion,
}, null, 2));
