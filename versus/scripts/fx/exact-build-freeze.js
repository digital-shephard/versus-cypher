const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { keccak256 } = require("ethers");

const SOURCE = "contracts/fx/EvmExactHtlcFactory.sol";
const CONTRACTS = Object.freeze([
  "EvmExactHtlcEscrow",
  "EvmExactHtlcFactory",
]);

function sha256(bytes) {
  return `0x${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function artifactPath(root, name) {
  return path.join(
    root,
    "artifacts",
    "contracts",
    "fx",
    "EvmExactHtlcFactory.sol",
    `${name}.json`
  );
}

function findBuildInfo(root, artifacts) {
  const directory = path.join(root, "artifacts", "build-info");
  for (const file of fs.readdirSync(directory).filter((name) =>
    name.endsWith(".json")
  ).sort()) {
    const candidate = readJson(path.join(directory, file));
    if (CONTRACTS.every((name) => {
      const output = candidate.output?.contracts?.[SOURCE]?.[name];
      return output?.evm?.bytecode?.object &&
        `0x${output.evm.bytecode.object}` === artifacts[name].bytecode;
    })) return candidate;
  }
  throw new Error("matching exact factory build-info was not found");
}

function buildExactFreezeRecord(root = path.resolve(__dirname, "..", "..")) {
  const artifacts = Object.fromEntries(CONTRACTS.map((name) => [
    name,
    readJson(artifactPath(root, name)),
  ]));
  const buildInfo = findBuildInfo(root, artifacts);
  const settings = buildInfo.input.settings;
  const source = fs.readFileSync(path.join(root, SOURCE));
  const builds = Object.fromEntries(CONTRACTS.map((name) => {
    const artifact = artifacts[name];
    return [name, {
      contract: name,
      sourcePath: `versus/${SOURCE}`,
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
    }];
  }));
  return {
    schema: "versus-fx-evm-exact-build-freeze",
    schemaVersion: 1,
    settlementMode: "x402-exact-eip3009-to-v3",
    sourceTag: "generic-x402-exact-v1",
    builds,
  };
}

function writeExactFreezeRecord(outputPath, root) {
  const record = buildExactFreezeRecord(root);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

module.exports = { buildExactFreezeRecord, writeExactFreezeRecord };
