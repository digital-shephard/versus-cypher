const path = require("node:path");
const { writeNativeFreezeRecord } = require("./native-build-freeze");

const root = path.resolve(__dirname, "..", "..");
const outputPath = path.join(
  root,
  "deployments",
  "fx",
  "evm-native-htlc-v1-build.json"
);
const record = writeNativeFreezeRecord(outputPath, root);
console.log(JSON.stringify({
  outputPath,
  sourceSha256: record.sourceSha256,
  creationCodeHash: record.creationCodeHash,
  compiler: record.compiler.longVersion,
}, null, 2));
