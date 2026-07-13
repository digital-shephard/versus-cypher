const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { getAddress } = require("ethers");
const CONSTANTS = require("./constants");
const { FREEZE_RELATIVE, loadBuildFreeze } = require("./build-freeze");

const MANIFEST_VERSION = 2;
const RELEASE_STAGES = Object.freeze({
  TEST: "test",
  CLOSED_COHORT: "closed-cohort",
  UNRESTRICTED_PUBLIC: "unrestricted-public",
});

const CONTRACT_KEYS = Object.freeze([
  "usdc",
  "v2Factory",
  "v2Router",
  "agents",
  "arena",
  "syndicate",
  "treasury",
  "missionEscrow",
  "referralPool",
  "graduation",
]);

const CONSTRUCTOR_KEYS = Object.freeze([
  "agents",
  "syndicate",
  "treasury",
  "missionEscrow",
  "referralPool",
  "arena",
  "graduation",
]);

function evaluateSafePolicy({ owners, threshold, releaseStage }) {
  const ownerCount = Number(owners?.length || 0);
  const numericThreshold = Number(threshold);
  const valid = ownerCount > 0 && numericThreshold > 0 && numericThreshold <= ownerCount;
  const publicReady = valid && ownerCount >= 3 && numericThreshold >= 2;
  const required = releaseStage === RELEASE_STAGES.UNRESTRICTED_PUBLIC ? "2-of-3" : "valid-safe";
  const passed = releaseStage === RELEASE_STAGES.TEST ? true :
    releaseStage === RELEASE_STAGES.UNRESTRICTED_PUBLIC ? publicReady : valid;
  return {
    releaseStage,
    required,
    passed,
    ownerCount,
    threshold: numericThreshold,
    publicReady,
    hardeningRequired: passed && releaseStage === RELEASE_STAGES.CLOSED_COHORT && !publicReady,
  };
}

function resolveReleaseStage(network, value = process.env.VERSUS_RELEASE_STAGE) {
  if (network !== "base") return value || RELEASE_STAGES.TEST;
  if (!value) throw new Error("VERSUS_RELEASE_STAGE is required for Base: closed-cohort or unrestricted-public");
  if (![RELEASE_STAGES.CLOSED_COHORT, RELEASE_STAGES.UNRESTRICTED_PUBLIC].includes(value)) {
    throw new Error("Base VERSUS_RELEASE_STAGE must be closed-cohort or unrestricted-public");
  }
  return value;
}

function git(repoRoot, args) {
  return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }).trim();
}

function resolveSourceState(repoRoot, env = process.env) {
  const headCommit = git(repoRoot, ["rev-parse", "HEAD"]);
  const commit = env.GITHUB_SHA || env.VERSUS_SOURCE_COMMIT || headCommit;
  const status = git(repoRoot, ["status", "--porcelain", "--untracked-files=all"]);
  return {
    repository: env.GITHUB_REPOSITORY || "digital-shephard/versus-cypher",
    commit,
    headCommit,
    clean: status.length === 0,
    dirtyEntries: status ? status.split(/\r?\n/) : [],
  };
}

function assertBaseSourceReady(source) {
  if (!/^[a-fA-F0-9]{40}$/.test(source.commit || "")) {
    throw new Error("Base deployment requires a full 40-character source commit");
  }
  if (source.headCommit && source.commit.toLowerCase() !== source.headCommit.toLowerCase()) {
    throw new Error("Base deployment source commit does not match the checked-out HEAD");
  }
  if (!source.clean) {
    throw new Error(`Base deployment requires a clean git worktree (${source.dirtyEntries.length} dirty entries)`);
  }
}

function collectSourceHashes(projectRoot) {
  const roots = ["contracts", "scripts", "hardhat.config.js", "package.json", "package-lock.json"];
  const files = [];
  const visit = (relative) => {
    const absolute = path.join(projectRoot, relative);
    if (!fs.existsSync(absolute)) return;
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(absolute).sort()) visit(path.join(relative, child));
      return;
    }
    const bytes = fs.readFileSync(absolute);
    files.push({ path: relative.replace(/\\/g, "/"), sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
  };
  roots.forEach(visit);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const treeSha256 = crypto.createHash("sha256")
    .update(files.map((entry) => `${entry.path}:${entry.sha256}`).join("\n"))
    .digest("hex");
  return { treeSha256, files };
}

function constructorArguments(contracts, graduationFloor, protocolRecipient, referralReward = "1000000") {
  return {
    agents: [contracts.usdc],
    syndicate: [contracts.usdc, graduationFloor.toString()],
    treasury: [contracts.usdc, protocolRecipient],
    missionEscrow: [contracts.usdc, contracts.agents],
    referralPool: [contracts.usdc, contracts.agents, referralReward.toString()],
    arena: [contracts.usdc, contracts.agents, contracts.syndicate, contracts.treasury, contracts.referralPool],
    graduation: [contracts.usdc, contracts.v2Router, contracts.syndicate, contracts.treasury],
  };
}

function sameAddress(a, b) {
  try {
    return getAddress(a) === getAddress(b);
  } catch (_) {
    return false;
  }
}

function validateManifest(manifest, options = {}) {
  const errors = [];
  const addressPattern = /^0x[a-fA-F0-9]{40}$/;
  const hashPattern = /^(?:0x)?[a-fA-F0-9]{64}$/;
  if (manifest?.manifestVersion !== MANIFEST_VERSION) errors.push(`manifestVersion must equal ${MANIFEST_VERSION}`);
  if (manifest?.protocol !== "versus-cypher") errors.push("protocol must equal versus-cypher");
  if (!Number.isInteger(Number(manifest?.chainId))) errors.push("chainId is required");
  if (!Object.values(RELEASE_STAGES).includes(manifest?.releaseStage)) errors.push("releaseStage is invalid");
  if (!/^[a-fA-F0-9]{40}$/.test(manifest?.source?.commit || "")) errors.push("source.commit must be full length");
  if (!hashPattern.test(manifest?.source?.treeSha256 || "")) errors.push("source.treeSha256 is invalid");

  const contractKeys = Object.keys(manifest?.contracts || {}).sort();
  const expectedContractKeys = [...CONTRACT_KEYS].sort();
  if (JSON.stringify(contractKeys) !== JSON.stringify(expectedContractKeys)) {
    errors.push(`contracts key set must equal ${expectedContractKeys.join(",")}`);
  }
  const missingContracts = CONTRACT_KEYS.filter((key) => !manifest?.contracts?.[key]);
  if (missingContracts.length) errors.push(`contracts missing keys: ${missingContracts.join(",")}`);
  const runtimeKeys = Object.keys(manifest?.runtimeBytecode || {}).sort();
  const expectedRuntimeKeys = [...CONTRACT_KEYS].sort();
  if (JSON.stringify(runtimeKeys) !== JSON.stringify(expectedRuntimeKeys)) {
    errors.push(`runtimeBytecode key set must equal ${expectedRuntimeKeys.join(",")}`);
  }

  for (const key of CONTRACT_KEYS) {
    if (!addressPattern.test(manifest?.contracts?.[key] || "")) errors.push(`contracts.${key} is invalid`);
    if (!addressPattern.test(manifest?.runtimeBytecode?.[key]?.address || "")) {
      errors.push(`runtimeBytecode.${key} is missing`);
    } else if (
      addressPattern.test(manifest?.contracts?.[key] || "") &&
      !sameAddress(manifest.runtimeBytecode[key].address, manifest.contracts[key])
    ) {
      errors.push(`runtimeBytecode.${key}.address must equal contracts.${key}`);
    }
    if (!hashPattern.test(manifest?.runtimeBytecode?.[key]?.keccak256 || "")) {
      errors.push(`runtimeBytecode.${key}.keccak256 is invalid`);
    }
  }
  for (const key of CONSTRUCTOR_KEYS) {
    if (!Array.isArray(manifest?.constructorArguments?.[key])) errors.push(`constructorArguments.${key} is required`);
  }

  const sourceFiles = manifest?.source?.files;
  if (!Array.isArray(sourceFiles) || sourceFiles.length === 0) {
    errors.push("source.files must be a non-empty array");
  } else {
    const paths = sourceFiles.map((entry) => entry?.path);
    if (paths.some((value) => typeof value !== "string" || !value)) {
      errors.push("source.files entries require path");
    }
    if (new Set(paths).size !== paths.length) errors.push("source.files paths must be unique");
    const sorted = [...paths].sort();
    if (JSON.stringify(paths) !== JSON.stringify(sorted)) errors.push("source.files must be sorted by path");
    for (const entry of sourceFiles) {
      if (!hashPattern.test(entry?.sha256 || "")) errors.push(`source.files ${entry?.path} sha256 is invalid`);
    }
    const recomputedTree = crypto.createHash("sha256")
      .update(sourceFiles.map((entry) => `${entry.path}:${entry.sha256}`).join("\n"))
      .digest("hex");
    if (recomputedTree !== String(manifest.source.treeSha256 || "").replace(/^0x/, "")) {
      errors.push("source.treeSha256 does not match source.files");
    }
  }

  if (options.projectRoot) {
    const live = collectSourceHashes(options.projectRoot);
    if (live.treeSha256 !== String(manifest?.source?.treeSha256 || "").replace(/^0x/, "")) {
      errors.push("source.treeSha256 does not match live repository inventory");
    }
  }

  if (manifest?.network === "base") {
    if (Number(manifest.chainId) !== 8453) errors.push("Base chainId must equal 8453");
    if (manifest.releaseStage === RELEASE_STAGES.TEST) errors.push("Base releaseStage cannot be test");
    if (manifest?.source?.clean !== true) errors.push("Base source must be clean");
    if (manifest?.economics?.graduationFloorRaw !== "1000000000") errors.push("Base graduation floor must equal 1000000000");
    if (manifest?.economics?.referralRewardRaw !== "1000000") errors.push("Base referral reward must equal 1000000");
    if (String(manifest?.economics?.protocolRecipient || "").toLowerCase() !== CONSTANTS.base.protocolRecipient.toLowerCase()) {
      errors.push(`Base economics.protocolRecipient must equal canonical Safe ${CONSTANTS.base.protocolRecipient}`);
    }
    const canonical = {
      usdc: CONSTANTS.base.usdc,
      v2Factory: CONSTANTS.base.uniswapV2Factory,
      v2Router: CONSTANTS.base.uniswapV2Router,
    };
    for (const [key, expected] of Object.entries(canonical)) {
      if (String(manifest?.contracts?.[key] || "").toLowerCase() !== expected.toLowerCase()) {
        errors.push(`Base contracts.${key} must equal canonical address ${expected}`);
      }
    }
    if (!hashPattern.test(manifest?.compiler?.compilerInputSha256 || "")) {
      errors.push("Base compiler.compilerInputSha256 is required");
    }
    if (!manifest?.compiler?.creationBytecode || typeof manifest.compiler.creationBytecode !== "object") {
      errors.push("Base compiler.creationBytecode is required");
    } else {
      try {
        const freeze = options.buildFreeze || loadBuildFreeze(options.projectRoot || path.join(__dirname, "..", ".."));
        const creationKeys = Object.keys(manifest.compiler.creationBytecode).sort();
        const expectedCreationKeys = Object.keys(freeze.contracts || {}).sort();
        if (JSON.stringify(creationKeys) !== JSON.stringify(expectedCreationKeys)) {
          errors.push(`Base compiler.creationBytecode key set must equal ${expectedCreationKeys.join(",")}`);
        }
        if (manifest.compiler.compilerInputSha256 !== freeze.compilerInputSha256) {
          errors.push("Base compiler.compilerInputSha256 must equal committed build freeze");
        }
        for (const [name, expected] of Object.entries(freeze.contracts || {})) {
          const actual = manifest.compiler.creationBytecode[name]?.keccak256
            || manifest.compiler.creationBytecode[name]?.creationBytecodeKeccak256;
          if (actual !== expected.creationBytecodeKeccak256) {
            errors.push(`Base creation bytecode for ${name} must equal committed build freeze`);
          }
        }
      } catch (error) {
        errors.push(error.message || String(error));
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  MANIFEST_VERSION,
  RELEASE_STAGES,
  CONTRACT_KEYS,
  CONSTRUCTOR_KEYS,
  FREEZE_RELATIVE,
  assertBaseSourceReady,
  collectSourceHashes,
  constructorArguments,
  evaluateSafePolicy,
  resolveReleaseStage,
  resolveSourceState,
  validateManifest,
};
