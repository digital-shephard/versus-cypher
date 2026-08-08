const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { keccak256 } = require("ethers");

const CONTRACT_SOURCE = "contracts/fx/SameChainSettlementV1.sol";
const CONTRACT_NAME = "SameChainSettlementV1";

function sha256Hex(bytes) {
  return `0x${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function findBuildInfo(root, artifact) {
  const directory = path.join(root, "artifacts", "build-info");
  for (const file of fs.readdirSync(directory).filter((name) => name.endsWith(".json")).sort()) {
    const buildInfo = readJson(path.join(directory, file));
    const contract = buildInfo.output?.contracts?.[CONTRACT_SOURCE]?.[CONTRACT_NAME];
    if (
      contract?.evm?.bytecode?.object &&
      `0x${contract.evm.bytecode.object}` === artifact.bytecode
    ) {
      return buildInfo;
    }
  }
  throw new Error("matching SameChainSettlementV1 build-info was not found");
}

function buildSettlementFreeze(root = path.resolve(__dirname, "..", "..")) {
  const source = fs.readFileSync(path.join(root, CONTRACT_SOURCE));
  const artifact = readJson(
    path.join(
      root,
      "artifacts",
      "contracts",
      "fx",
      "SameChainSettlementV1.sol",
      "SameChainSettlementV1.json"
    )
  );
  const buildInfo = findBuildInfo(root, artifact);
  const settings = buildInfo.input.settings;
  const sourceEntry = buildInfo.input.sources[CONTRACT_SOURCE];
  return {
    schema: "versus-fx-settlement-build-freeze",
    schemaVersion: 1,
    settlement: {
      id: "same-chain-exact-output",
      version: 1,
      contract: CONTRACT_NAME,
      sourcePath: `versus/${CONTRACT_SOURCE}`,
    },
    sourceControl: { tag: "agentic-fx-phase4-v1" },
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

function writeSettlementFreeze(outputPath, root) {
  const record = buildSettlementFreeze(root);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

module.exports = {
  buildSettlementFreeze,
  writeSettlementFreeze,
};
