const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { keccak256 } = require("ethers");

const CONTRACT_SOURCE = "contracts/fx/EvmHtlcV1.sol";
const CONTRACT_NAME = "EvmHtlcV1";

function sha256Hex(bytes) {
  return `0x${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function findBuildInfo(root, artifact) {
  const buildInfoDirectory = path.join(root, "artifacts", "build-info");
  const files = fs.readdirSync(buildInfoDirectory).filter((name) => name.endsWith(".json"));
  for (const file of files.sort()) {
    const candidate = readJson(path.join(buildInfoDirectory, file));
    const contract =
      candidate.output?.contracts?.[CONTRACT_SOURCE]?.[CONTRACT_NAME];
    if (
      contract?.evm?.bytecode?.object &&
      `0x${contract.evm.bytecode.object}` === artifact.bytecode
    ) {
      return candidate;
    }
  }
  throw new Error("matching Hardhat build-info was not found");
}

function buildFreezeRecord(root = path.resolve(__dirname, "..", "..")) {
  const sourcePath = path.join(root, CONTRACT_SOURCE);
  const artifactPath = path.join(
    root,
    "artifacts",
    "contracts",
    "fx",
    "EvmHtlcV1.sol",
    "EvmHtlcV1.json"
  );
  const source = fs.readFileSync(sourcePath);
  const artifact = readJson(artifactPath);
  const buildInfo = findBuildInfo(root, artifact);
  const settings = buildInfo.input.settings;
  const sourceEntry = buildInfo.input.sources[CONTRACT_SOURCE];

  return {
    schema: "versus-fx-evm-build-freeze",
    schemaVersion: 1,
    adapter: {
      id: "evm-htlc",
      version: 1,
      contract: CONTRACT_NAME,
      sourcePath: `versus/${CONTRACT_SOURCE}`,
    },
    sourceControl: {
      tag: "agentic-fx-phase3-v1",
    },
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

function writeFreezeRecord(outputPath, root) {
  const record = buildFreezeRecord(root);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

module.exports = {
  buildFreezeRecord,
  writeFreezeRecord,
};
