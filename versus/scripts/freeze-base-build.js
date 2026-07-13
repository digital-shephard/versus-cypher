/**
 * Regenerate deployments/base-build-freeze.json from a clean Hardhat compile.
 * Commit the result with reviewed source before Base mainnet deployment.
 */
const path = require("path");
const hre = require("hardhat");
const {
  collectFreshBuildFingerprint,
  writeBuildFreeze,
} = require("./lib/build-freeze");

async function main() {
  const projectRoot = path.join(__dirname, "..");
  await hre.run("clean");
  await hre.run("compile", { force: true });
  const fingerprint = collectFreshBuildFingerprint(projectRoot, hre.ethers);
  const freeze = writeBuildFreeze(projectRoot, fingerprint, {
    note: "Compare against freshly compiled artifacts before the first Base deployment transaction.",
  });
  console.log(JSON.stringify({
    wrote: "deployments/base-build-freeze.json",
    compilerInputSha256: freeze.compilerInputSha256,
    contracts: Object.keys(freeze.contracts),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
