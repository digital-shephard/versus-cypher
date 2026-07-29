const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { keccak256 } = require("ethers");

const CONTRACT_SOURCE = "contracts/fx/EvmNativeHtlcV1.sol";
const CONTRACT_NAME = "EvmNativeHtlcV1";

function sha256Hex(bytes) {
  return `0x${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function findBuildInfo(root, artifact) {
  const directory = path.join(root, "artifacts", "build-info");
  for (const file of fs.readdirSync(directory).filter((name) => name.endsWith(".json")).sort()) {
    const candidate = readJson(path.join(directory, file));
    const contract = candidate.output?.contracts?.[CONTRACT_SOURCE]?.[CONTRACT_NAME];
    if (
      contract?.evm?.bytecode?.object &&
      `0x${contract.evm.bytecode.object}` === artifact.bytecode
    ) {
      return candidate;
    }
  }
  throw new Error("matching native Hardhat build-info was not found");
}

function buildNativeFreezeRecord(root = path.resolve(__dirname, "..", "..")) {
  const sourcePath = path.join(root, CONTRACT_SOURCE);
  const artifactPath = path.join(
    root,
    "artifacts",
    "contracts",
    "fx",
    "EvmNativeHtlcV1.sol",
    "EvmNativeHtlcV1.json"
  );
  const source = fs.readFileSync(sourcePath);
  const artifact = readJson(artifactPath);
  const buildInfo = findBuildInfo(root, artifact);
  const settings = buildInfo.input.settings;
  const sourceEntry = buildInfo.input.sources[CONTRACT_SOURCE];
  return {
    schema: "versus-fx-evm-native-build-freeze",
    schemaVersion: 1,
    adapter: {
      id: "evm-native-htlc",
      version: 1,
      contract: CONTRACT_NAME,
      sourcePath: `versus/${CONTRACT_SOURCE}`,
    },
    sourceControl: { tag: "agentic-fx-native-v1" },
    compiler: {
      version: buildInfo.solcVersion,
      longVersion: buildInfo.solcLongVersion,
      evmVersion: settings.evmVersion,
      viaIR: settings.viaIR === true,
      optimizer: {
        enabled: settings.optimizer?.enabled === true,
        runs: settings.optimizer?.runs,
      },
    },
    sourceSha256: sha256Hex(source),
    compilerInputSourceSha256: sha256Hex(Buffer.from(sourceEntry.content, "utf8")),
    creationCodeHash: keccak256(artifact.bytecode),
    runtimeTemplateHash: keccak256(artifact.deployedBytecode),
    creationCodeBytes: (artifact.bytecode.length - 2) / 2,
    runtimeTemplateBytes: (artifact.deployedBytecode.length - 2) / 2,
  };
}

function writeNativeFreezeRecord(outputPath, root) {
  const record = buildNativeFreezeRecord(root);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

module.exports = { buildNativeFreezeRecord, writeNativeFreezeRecord };
