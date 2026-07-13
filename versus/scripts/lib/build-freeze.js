/**
 * Base build freeze: creation-bytecode and compiler-input fingerprints.
 * Compared against freshly compiled Hardhat artifacts before any Base transaction.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PRODUCTION_CONTRACTS = Object.freeze([
  "AgentNFT",
  "SyndicateEngine",
  "TrancheTreasury",
  "MissionEscrow",
  "ReferralPool",
  "Arena",
  "GraduationModule",
  "ClassToken",
]);

const FREEZE_RELATIVE = path.join("deployments", "base-build-freeze.json");

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function keccak256Hex(ethers, hexData) {
  const normalized = hexData.startsWith("0x") ? hexData : `0x${hexData}`;
  return ethers.keccak256(normalized).slice(2);
}

function freezePath(projectRoot) {
  return path.join(projectRoot, FREEZE_RELATIVE);
}

function loadBuildFreeze(projectRoot) {
  const file = freezePath(projectRoot);
  if (!fs.existsSync(file)) {
    throw new Error(`Missing Base build freeze at ${FREEZE_RELATIVE}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function artifactPath(projectRoot, contractName) {
  const candidates = [
    path.join(projectRoot, "artifacts", "contracts", "core", `${contractName}.sol`, `${contractName}.json`),
    path.join(projectRoot, "artifacts", "contracts", "launch", `${contractName}.sol`, `${contractName}.json`),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Hardhat artifact missing for ${contractName}; run a clean compile first`);
}

function findBuildInfo(projectRoot) {
  const dir = path.join(projectRoot, "artifacts", "build-info");
  if (!fs.existsSync(dir)) throw new Error("Hardhat build-info directory missing; run a clean compile first");
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const info = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    const names = new Set();
    for (const contracts of Object.values(info.output?.contracts || {})) {
      Object.keys(contracts).forEach((n) => names.add(n));
    }
    if (PRODUCTION_CONTRACTS.every((n) => names.has(n))) return info;
  }
  throw new Error("Could not locate Hardhat build-info covering production contracts");
}

function collectImportedSourceHashes(buildInfo) {
  const sources = buildInfo.input?.sources || {};
  const files = Object.keys(sources)
    .sort()
    .map((sourcePath) => {
      const content = sources[sourcePath].content;
      return { path: sourcePath.replace(/\\/g, "/"), sha256: sha256Hex(content) };
    });
  const treeSha256 = sha256Hex(files.map((entry) => `${entry.path}:${entry.sha256}`).join("\n"));
  return { treeSha256, files };
}

function collectFreshBuildFingerprint(projectRoot, ethers) {
  const contracts = {};
  for (const name of PRODUCTION_CONTRACTS) {
    const artifact = JSON.parse(fs.readFileSync(artifactPath(projectRoot, name), "utf8"));
    const creation = artifact.bytecode;
    if (!creation || creation === "0x") {
      throw new Error(`${name} artifact has empty creation bytecode`);
    }
    contracts[name] = {
      creationBytecodeKeccak256: keccak256Hex(ethers, creation),
      creationBytecodeBytes: (creation.length - 2) / 2,
    };
  }

  const buildInfo = findBuildInfo(projectRoot);
  const compilerInput = JSON.stringify(buildInfo.input);
  const imported = collectImportedSourceHashes(buildInfo);

  return {
    solidity: "0.8.26",
    compiler: {
      version: buildInfo.solcLongVersion || buildInfo.solcVersion,
      settings: buildInfo.input?.settings || null,
    },
    compilerInputSha256: sha256Hex(compilerInput),
    importedSources: imported,
    contracts,
  };
}

function assertBuildMatchesFreeze(fresh, freeze) {
  const errors = [];
  if (!freeze || freeze.kind !== "versus-base-build-freeze") {
    errors.push("freeze kind must equal versus-base-build-freeze");
  }
  if (fresh.compilerInputSha256 !== freeze.compilerInputSha256) {
    errors.push(
      `compilerInputSha256 mismatch: fresh ${fresh.compilerInputSha256}, freeze ${freeze.compilerInputSha256}`
    );
  }
  if (fresh.importedSources.treeSha256 !== freeze.importedSources?.treeSha256) {
    errors.push("importedSources.treeSha256 mismatch");
  }
  for (const name of PRODUCTION_CONTRACTS) {
    const expected = freeze.contracts?.[name]?.creationBytecodeKeccak256;
    const actual = fresh.contracts[name]?.creationBytecodeKeccak256;
    if (!expected) errors.push(`freeze missing ${name}`);
    else if (actual !== expected) {
      errors.push(`${name} creation bytecode mismatch: fresh ${actual}, freeze ${expected}`);
    }
  }
  const freezeKeys = Object.keys(freeze.contracts || {}).sort();
  const expectedKeys = [...PRODUCTION_CONTRACTS].sort();
  if (JSON.stringify(freezeKeys) !== JSON.stringify(expectedKeys)) {
    errors.push(`freeze contract key set must equal ${expectedKeys.join(",")}`);
  }
  if (errors.length) {
    throw new Error(`Base build freeze mismatch:\n- ${errors.join("\n- ")}`);
  }
  return true;
}

function writeBuildFreeze(projectRoot, fingerprint, meta = {}) {
  const out = {
    kind: "versus-base-build-freeze",
    generatedAt: new Date().toISOString(),
    ...meta,
    solidity: "0.8.26",
    compiler: {
      optimizer: { enabled: true, runs: 1 },
      viaIR: true,
      evmVersion: "cancun",
      ...(fingerprint.compiler || {}),
    },
    compilerInputSha256: fingerprint.compilerInputSha256,
    importedSources: fingerprint.importedSources,
    contracts: fingerprint.contracts,
  };
  const file = freezePath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  return out;
}

module.exports = {
  PRODUCTION_CONTRACTS,
  FREEZE_RELATIVE,
  assertBuildMatchesFreeze,
  collectFreshBuildFingerprint,
  freezePath,
  loadBuildFreeze,
  writeBuildFreeze,
};
