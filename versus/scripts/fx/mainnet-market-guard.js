const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Wallet } = require("ethers");
const { assert } = require("./market-candidate-config");

const DEPLOY_CONFIRMATION = "I_UNDERSTAND_THIS_BROADCASTS_MAINNET";
const VERIFY_CONFIRMATION = "I_UNDERSTAND_THIS_SUBMITS_MAINNET_VERIFICATION";
const ASSEMBLE_CONFIRMATION = "I_HAVE_REVIEWED_MAINNET_ADDRESSES_AND_HASHES";

function positiveBigInt(value, label) {
  assert(/^\d+$/.test(String(value || "")), `${label} must be a positive integer`);
  const parsed = BigInt(value);
  assert(parsed > 0n, `${label} must be a positive integer`);
  return parsed;
}

function validateMainnetDeployAuthorization(environment, network, marketId) {
  assert(
    environment.FX_MARKET_MAINNET_DEPLOY === DEPLOY_CONFIRMATION,
    `set FX_MARKET_MAINNET_DEPLOY=${DEPLOY_CONFIRMATION} to authorize mainnet deployment`
  );
  assert(
    String(environment.FX_MARKET_MAINNET_CHAIN || "") === network.chainId,
    `FX_MARKET_MAINNET_CHAIN must equal ${network.chainId}`
  );
  assert(
    String(environment.FX_MARKET_MAINNET_MARKET_ID || "").toLowerCase() === marketId,
    `FX_MARKET_MAINNET_MARKET_ID must equal ${marketId}`
  );
  const maximumFeePerGasWei = positiveBigInt(
    environment.FX_MARKET_MAINNET_MAX_FEE_PER_GAS_WEI,
    "FX_MARKET_MAINNET_MAX_FEE_PER_GAS_WEI"
  );
  const maximumGasPerDeployment = positiveBigInt(
    environment.FX_MARKET_MAINNET_MAX_GAS_PER_DEPLOYMENT,
    "FX_MARKET_MAINNET_MAX_GAS_PER_DEPLOYMENT"
  );
  const maximumChainDeploymentCostWei = positiveBigInt(
    environment.FX_MARKET_MAINNET_MAX_CHAIN_DEPLOY_COST_WEI,
    "FX_MARKET_MAINNET_MAX_CHAIN_DEPLOY_COST_WEI"
  );
  assert(
    maximumFeePerGasWei * maximumGasPerDeployment * 5n <=
      maximumChainDeploymentCostWei,
    "five-deployment worst-case cost exceeds FX_MARKET_MAINNET_MAX_CHAIN_DEPLOY_COST_WEI"
  );
  assert(
    path.isAbsolute(String(environment.FX_MAINNET_DEPLOYER_KEYSTORE || "")),
    "FX_MAINNET_DEPLOYER_KEYSTORE must be an absolute path"
  );
  assert(
    path.isAbsolute(String(environment.FX_MAINNET_DEPLOYER_PASSWORD_FILE || "")),
    "FX_MAINNET_DEPLOYER_PASSWORD_FILE must be an absolute path"
  );
  return {
    maximumFeePerGasWei,
    maximumGasPerDeployment,
    maximumChainDeploymentCostWei,
  };
}

function validateMainnetVerifyAuthorization(environment, network) {
  assert(
    environment.FX_MARKET_MAINNET_VERIFY === VERIFY_CONFIRMATION,
    `set FX_MARKET_MAINNET_VERIFY=${VERIFY_CONFIRMATION} to authorize explorer verification`
  );
  assert(
    String(environment.FX_MARKET_MAINNET_CHAIN || "") === network.chainId,
    `FX_MARKET_MAINNET_CHAIN must equal ${network.chainId}`
  );
}

function validateMainnetAssembleAuthorization(environment) {
  assert(
    environment.FX_MARKET_MAINNET_ASSEMBLE === ASSEMBLE_CONFIRMATION,
    `set FX_MARKET_MAINNET_ASSEMBLE=${ASSEMBLE_CONFIRMATION} after reviewing every mainnet address and hash`
  );
}

function reviewedSourceCommit(repositoryRoot, environment = process.env) {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim().toLowerCase();
  const branch = execFileSync("git", ["branch", "--show-current"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  assert(branch === "main", "mainnet tooling must run from the main branch");
  const remoteLine = execFileSync(
    "git",
    ["ls-remote", "origin", "refs/heads/main"],
    { cwd: repositoryRoot, encoding: "utf8" }
  ).trim();
  const remoteHead = remoteLine.split(/\s+/)[0]?.toLowerCase();
  assert(remoteHead === head, "reviewed HEAD must already be pushed to origin/main");
  assert(
    /^[0-9a-f]{40}$/.test(String(environment.FX_MARKET_MAINNET_SOURCE_COMMIT || "")) &&
      String(environment.FX_MARKET_MAINNET_SOURCE_COMMIT).toLowerCase() === head,
    `FX_MARKET_MAINNET_SOURCE_COMMIT must equal reviewed HEAD ${head}`
  );
  for (const args of [["diff", "--quiet"], ["diff", "--cached", "--quiet"]]) {
    try {
      execFileSync("git", args, { cwd: repositoryRoot, stdio: "ignore" });
    } catch {
      throw new Error("mainnet tooling requires a clean tracked worktree and index");
    }
  }
  return head;
}

async function decryptMainnetDeployer(environment = process.env) {
  const keystorePath = path.resolve(environment.FX_MAINNET_DEPLOYER_KEYSTORE);
  const passwordPath = path.resolve(environment.FX_MAINNET_DEPLOYER_PASSWORD_FILE);
  const password = fs.readFileSync(passwordPath, "utf8").trim();
  assert(password.length > 0, "mainnet deployer password file is empty");
  return Wallet.fromEncryptedJson(fs.readFileSync(keystorePath, "utf8"), password);
}

module.exports = {
  ASSEMBLE_CONFIRMATION,
  DEPLOY_CONFIRMATION,
  VERIFY_CONFIRMATION,
  decryptMainnetDeployer,
  reviewedSourceCommit,
  validateMainnetAssembleAuthorization,
  validateMainnetDeployAuthorization,
  validateMainnetVerifyAuthorization,
};
