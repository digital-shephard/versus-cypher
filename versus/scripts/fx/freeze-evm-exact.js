const path = require("node:path");
const { writeExactFreezeRecord } = require("./exact-build-freeze");

const root = path.resolve(__dirname, "..", "..");
const outputPath = path.join(
  root,
  "deployments",
  "fx",
  "evm-exact-build.json"
);
const record = writeExactFreezeRecord(outputPath, root);
console.log(JSON.stringify({
  outputPath,
  factoryCreationCodeHash:
    record.builds.EvmExactHtlcFactory.creationCodeHash,
  escrowCreationCodeHash:
    record.builds.EvmExactHtlcEscrow.creationCodeHash,
  compiler: record.builds.EvmExactHtlcFactory.compilerLongVersion,
}, null, 2));
