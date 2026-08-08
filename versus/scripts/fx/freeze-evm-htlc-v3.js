const path = require("node:path");
const { writeV3FreezeRecord } = require("./v3-build-freeze");

const root = path.resolve(__dirname, "..", "..");
const outputPath = path.join(
  root,
  "deployments",
  "fx",
  "evm-htlc-v3-build.json"
);
const record = writeV3FreezeRecord(outputPath, root);
console.log(
  JSON.stringify(
    {
      outputPath,
      nativeCreationCodeHash: record.builds.native.creationCodeHash,
      erc20CreationCodeHash: record.builds.erc20.creationCodeHash,
      compiler: record.builds.native.compilerLongVersion,
    },
    null,
    2
  )
);
