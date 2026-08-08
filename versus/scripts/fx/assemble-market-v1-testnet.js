const fs = require("node:fs");
const path = require("node:path");
const {
  buildFxMarketDeployment,
} = require("../../../packages/network/src/fx-market-deployment");
const { readMarket } = require("./market-candidate-config");

function writeFrozenArtifact(outputPath, serialized) {
  try {
    fs.writeFileSync(outputPath, serialized, {
      encoding: "utf8",
      flag: "wx",
    });
    return "created";
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const frozen = fs.readFileSync(outputPath, "utf8");
    if (frozen !== serialized) {
      throw new Error(
        `assembled testnet deployment differs from frozen artifact: ${outputPath}`
      );
    }
    return "unchanged";
  }
}

function main() {
  const contractsRoot = path.resolve(__dirname, "..", "..");
  const deploymentRoot = path.join(contractsRoot, "deployments", "fx");
  const market = readMarket(contractsRoot, "testnet");
  const chainRecords = [
    "baseSepolia-84532-market-v1-testnet.json",
    "avalancheFuji-43113-market-v1-testnet.json",
  ].map((fileName) => JSON.parse(fs.readFileSync(
    path.join(deploymentRoot, fileName),
    "utf8"
  )));
  const v3Freeze = JSON.parse(fs.readFileSync(
    path.join(deploymentRoot, "evm-htlc-v3-build.json"),
    "utf8"
  ));
  const exactFreeze = JSON.parse(fs.readFileSync(
    path.join(deploymentRoot, "evm-exact-build.json"),
    "utf8"
  ));
  const deployment = buildFxMarketDeployment({
    market,
    chainRecords,
    v3Builds: v3Freeze.builds,
    exactBuild: exactFreeze,
  });
  const outputPath = path.join(
    deploymentRoot,
    "public-testnet-v1-market-deployment.json"
  );
  const serialized = `${JSON.stringify(deployment, null, 2)}\n`;
  const writeStatus = writeFrozenArtifact(outputPath, serialized);
  console.log(JSON.stringify({
    outputPath,
    writeStatus,
    marketId: deployment.marketId,
    deploymentId: deployment.deploymentId,
    coordinationDomain: deployment.coordinationDomain,
  }, null, 2));
}

if (require.main === module) main();

module.exports = { writeFrozenArtifact };
