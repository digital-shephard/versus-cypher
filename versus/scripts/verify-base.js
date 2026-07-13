const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { AbiCoder } = require("ethers");
const hre = require("hardhat");
const { validateManifest } = require("./lib/deployment-manifest");

const API_URL = "https://api.etherscan.io/v2/api";
const CHAIN_ID = "8453";
const COMPILER_VERSION = "v0.8.26+commit.8a97fa7a";
const POLL_INTERVAL_MS = 2_000;
const POLL_ATTEMPTS = 30;

const JOBS = [
  { name: "AgentNFT", key: "agents", source: "contracts/core/AgentNFT.sol" },
  { name: "SyndicateEngine", key: "syndicate", source: "contracts/core/SyndicateEngine.sol" },
  { name: "TrancheTreasury", key: "treasury", source: "contracts/core/TrancheTreasury.sol" },
  { name: "MissionEscrow", key: "missionEscrow", source: "contracts/core/MissionEscrow.sol" },
  { name: "ReferralPool", key: "referralPool", source: "contracts/core/ReferralPool.sol" },
  { name: "Arena", key: "arena", source: "contracts/core/Arena.sol" },
  { name: "GraduationModule", key: "graduation", source: "contracts/launch/GraduationModule.sol" },
];

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findCompilerInput(expectedSha256) {
  const buildInfoDir = path.join(__dirname, "..", "artifacts", "build-info");
  if (!fs.existsSync(buildInfoDir)) throw new Error("Hardhat build-info is missing; run npm run compile first");
  for (const file of fs.readdirSync(buildInfoDir).filter((name) => name.endsWith(".json"))) {
    const buildInfo = JSON.parse(fs.readFileSync(path.join(buildInfoDir, file), "utf8"));
    const encoded = JSON.stringify(buildInfo.input);
    if (sha256(encoded) === expectedSha256) return { input: buildInfo.input, encoded };
  }
  throw new Error(`no Hardhat build-info matches frozen compiler input ${expectedSha256}`);
}

async function etherscanRequest(apiKey, query, body) {
  const url = new URL(API_URL);
  url.search = new URLSearchParams({ chainid: CHAIN_ID, apikey: apiKey, ...query }).toString();
  const response = await fetch(url, body ? {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  } : undefined);
  const payload = await response.json();
  if (!response.ok) throw new Error(`Etherscan HTTP ${response.status}`);
  return payload;
}

async function submitVerification(apiKey, manifest, compilerInput, job) {
  const artifact = await hre.artifacts.readArtifact(job.name);
  const constructor = artifact.abi.find((item) => item.type === "constructor");
  const constructorTypes = (constructor?.inputs || []).map((input) => input.type);
  const constructorValues = manifest.constructorArguments[job.key] || [];
  const constructorArguments = constructorTypes.length
    ? AbiCoder.defaultAbiCoder().encode(constructorTypes, constructorValues).slice(2)
    : "";
  const settings = compilerInput.input.settings || {};
  const form = new URLSearchParams({
    module: "contract",
    action: "verifysourcecode",
    contractaddress: manifest.contracts[job.key],
    sourceCode: compilerInput.encoded,
    codeformat: "solidity-standard-json-input",
    contractname: `${job.source}:${job.name}`,
    compilerversion: COMPILER_VERSION,
    optimizationUsed: settings.optimizer?.enabled ? "1" : "0",
    runs: String(settings.optimizer?.runs || 200),
    constructorArguments,
    evmVersion: settings.evmVersion || "default",
    licenseType: "3",
  });
  const payload = await etherscanRequest(apiKey, {}, form);
  if (payload.status === "1") return { guid: payload.result, status: "submitted" };
  if (/already verified/i.test(String(payload.result))) return { guid: null, status: "already-verified" };
  throw new Error(`${job.name} submission failed: ${payload.result || payload.message}`);
}

async function waitForVerification(apiKey, job, submission) {
  if (submission.status === "already-verified") return submission;
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    const payload = await etherscanRequest(apiKey, {
      module: "contract",
      action: "checkverifystatus",
      guid: submission.guid,
    });
    if (/pass - verified/i.test(String(payload.result))) return { ...submission, status: "verified" };
    if (!/pending|queue/i.test(String(payload.result))) {
      throw new Error(`${job.name} verification failed: ${payload.result || payload.message}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`${job.name} verification timed out for GUID ${submission.guid}`);
}

async function main() {
  const apiKey = process.env.ETHERSCAN_API_KEY || process.env.BASESCAN_API_KEY;
  if (!apiKey) throw new Error("ETHERSCAN_API_KEY or BASESCAN_API_KEY is required");
  const manifestPath = process.env.VERSUS_DEPLOYMENT || path.join(__dirname, "..", "deployments", "base.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`Base deployment manifest not found: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.network !== "base" || Number(manifest.chainId) !== Number(CHAIN_ID)) {
    throw new Error("verification requires a Base mainnet deployment manifest");
  }
  const schema = validateManifest(manifest);
  if (!schema.valid) throw new Error(`invalid manifest: ${schema.errors.join("; ")}`);
  const compilerInputSha256 = manifest.compiler?.compilerInputSha256;
  if (!compilerInputSha256) throw new Error("manifest is missing compiler.compilerInputSha256");
  const compilerInput = findCompilerInput(compilerInputSha256);

  const results = [];
  for (const job of JOBS) {
    const address = manifest.contracts[job.key];
    const submission = await submitVerification(apiKey, manifest, compilerInput, job);
    const verified = await waitForVerification(apiKey, job, submission);
    console.log(`${verified.status} ${job.name}: ${address}`);
    results.push({ name: job.name, address, guid: verified.guid, status: verified.status });
    await sleep(400);
  }

  const checkedAt = new Date().toISOString();
  const reportName = "base-basescan-verification.json";
  manifest.verification = manifest.verification || {};
  manifest.verification.basescan = {
    status: "verified",
    provider: "Etherscan V2",
    checkedAt,
    report: reportName,
    contracts: results,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const reportPath = path.join(path.dirname(manifestPath), reportName);
  fs.writeFileSync(reportPath, `${JSON.stringify({
    kind: "versus-base-basescan-verification",
    provider: "Etherscan V2",
    chainId: Number(CHAIN_ID),
    checkedAt,
    sourceCommit: manifest.source.commit,
    compilerInputSha256,
    contracts: results,
  }, null, 2)}\n`);
  console.log(`wrote ${reportPath}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
