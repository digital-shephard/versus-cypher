const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const MANIFEST_VERSION = 2;
const RELEASE_STAGES = Object.freeze({
  TEST: "test",
  CLOSED_COHORT: "closed-cohort",
  UNRESTRICTED_PUBLIC: "unrestricted-public",
});

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
  const roots = ["contracts", "scripts/lib/deployOwnerless.js", "hardhat.config.js", "package.json", "package-lock.json"];
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

function validateManifest(manifest) {
  const errors = [];
  const addressPattern = /^0x[a-fA-F0-9]{40}$/;
  const hashPattern = /^(?:0x)?[a-fA-F0-9]{64}$/;
  if (manifest?.manifestVersion !== MANIFEST_VERSION) errors.push(`manifestVersion must equal ${MANIFEST_VERSION}`);
  if (manifest?.protocol !== "versus-cypher") errors.push("protocol must equal versus-cypher");
  if (!Number.isInteger(Number(manifest?.chainId))) errors.push("chainId is required");
  if (!Object.values(RELEASE_STAGES).includes(manifest?.releaseStage)) errors.push("releaseStage is invalid");
  if (!/^[a-fA-F0-9]{40}$/.test(manifest?.source?.commit || "")) errors.push("source.commit must be full length");
  if (!hashPattern.test(manifest?.source?.treeSha256 || "")) errors.push("source.treeSha256 is invalid");
  const contractKeys = ["usdc", "v2Factory", "v2Router", "agents", "arena", "syndicate", "treasury", "missionEscrow", "referralPool", "graduation"];
  for (const key of contractKeys) {
    if (!addressPattern.test(manifest?.contracts?.[key] || "")) errors.push(`contracts.${key} is invalid`);
    if (!addressPattern.test(manifest?.runtimeBytecode?.[key]?.address || "")) errors.push(`runtimeBytecode.${key} is missing`);
    if (!hashPattern.test(manifest?.runtimeBytecode?.[key]?.keccak256 || "")) errors.push(`runtimeBytecode.${key}.keccak256 is invalid`);
  }
  for (const key of ["agents", "syndicate", "treasury", "missionEscrow", "referralPool", "arena", "graduation"]) {
    if (!Array.isArray(manifest?.constructorArguments?.[key])) errors.push(`constructorArguments.${key} is required`);
  }
  if (manifest?.network === "base") {
    if (Number(manifest.chainId) !== 8453) errors.push("Base chainId must equal 8453");
    if (manifest.releaseStage === RELEASE_STAGES.TEST) errors.push("Base releaseStage cannot be test");
    if (manifest?.source?.clean !== true) errors.push("Base source must be clean");
    if (manifest?.economics?.graduationFloorRaw !== "1000000000") errors.push("Base graduation floor must equal 1000000000");
    if (manifest?.economics?.referralRewardRaw !== "1000000") errors.push("Base referral reward must equal 1000000");
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  MANIFEST_VERSION,
  RELEASE_STAGES,
  assertBaseSourceReady,
  collectSourceHashes,
  constructorArguments,
  evaluateSafePolicy,
  resolveReleaseStage,
  resolveSourceState,
  validateManifest,
};
