const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { keccak256 } = require("ethers");

const CONTRACTS = Object.freeze({
  native: Object.freeze({
    source: "contracts/fx/EvmNativeHtlcV2.sol",
    name: "EvmNativeHtlcV2",
    adapterId: "evm-native-htlc-v2",
  }),
  erc20: Object.freeze({
    source: "contracts/fx/EvmHtlcV2.sol",
    name: "EvmHtlcV2",
    adapterId: "evm-htlc-v2",
  }),
});

function sha256(bytes) {
  return `0x${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function findBuildInfo(root, definition, artifact) {
  const directory = path.join(root, "artifacts", "build-info");
  for (const file of fs.readdirSync(directory).filter((name) => name.endsWith(".json")).sort()) {
    const candidate = readJson(path.join(directory, file));
    const contract =
      candidate.output?.contracts?.[definition.source]?.[definition.name];
    if (
      contract?.evm?.bytecode?.object &&
      `0x${contract.evm.bytecode.object}` === artifact.bytecode
    ) {
      return candidate;
    }
  }
  throw new Error(`matching build-info was not found for ${definition.name}`);
}

function buildOne(root, kind) {
  const definition = CONTRACTS[kind];
  if (!definition) throw new Error(`unsupported V2 build kind ${kind}`);
  const artifact = readJson(path.join(
    root,
    "artifacts",
    "contracts",
    "fx",
    `${definition.name}.sol`,
    `${definition.name}.json`
  ));
  const buildInfo = findBuildInfo(root, definition, artifact);
  const settings = buildInfo.input.settings;
  const source = fs.readFileSync(path.join(root, definition.source));
  return {
    adapterId: definition.adapterId,
    adapterVersion: 2,
    contract: definition.name,
    sourcePath: `versus/${definition.source}`,
    sourceTag: "agentic-fx-settlement-v2",
    compiler: buildInfo.solcVersion,
    compilerLongVersion: buildInfo.solcLongVersion,
    evmVersion: settings.evmVersion,
    optimizerRuns: settings.optimizer?.runs,
    viaIR: settings.viaIR === true,
    sourceSha256: sha256(source),
    creationCodeHash: keccak256(artifact.bytecode),
    runtimeTemplateHash: keccak256(artifact.deployedBytecode),
    creationCodeBytes: (artifact.bytecode.length - 2) / 2,
    runtimeTemplateBytes: (artifact.deployedBytecode.length - 2) / 2,
  };
}

function buildV2FreezeRecord(root = path.resolve(__dirname, "..", "..")) {
  return {
    schema: "versus-fx-evm-v2-build-freeze",
    schemaVersion: 2,
    settlementMode: "dealer-secret-destination-first",
    builds: {
      native: buildOne(root, "native"),
      erc20: buildOne(root, "erc20"),
    },
  };
}

function writeV2FreezeRecord(outputPath, root) {
  const record = buildV2FreezeRecord(root);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

module.exports = { buildV2FreezeRecord, writeV2FreezeRecord };
