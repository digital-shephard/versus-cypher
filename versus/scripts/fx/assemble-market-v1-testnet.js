const fs = require("node:fs");
const path = require("node:path");
const {
  buildFxMarketDeployment,
} = require("../../../packages/network/src/fx-market-deployment");
const { readMarket } = require("./market-candidate-config");

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
  fs.writeFileSync(outputPath, `${JSON.stringify(deployment, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  console.log(JSON.stringify({
    outputPath,
    marketId: deployment.marketId,
    deploymentId: deployment.deploymentId,
    coordinationDomain: deployment.coordinationDomain,
  }, null, 2));
}

main();
