const fs = require("node:fs");
const path = require("node:path");
const {
  buildFxMarketDeployment,
} = require("../../../packages/network/src/fx-market-deployment");
const {
  networkFor,
  preflightMarketChainAcrossRpcs,
  preflightMarketDeploymentAcrossRpcs,
  readMarket,
} = require("./market-candidate-config");
const {
  reviewedSourceCommit,
  validateMainnetAssembleAuthorization,
} = require("./mainnet-market-guard");

function writeFrozenArtifact(outputPath, serialized) {
  fs.writeFileSync(outputPath, serialized, {
    encoding: "utf8",
    flag: "wx",
  });
}

async function main() {
  validateMainnetAssembleAuthorization(process.env);
  const contractsRoot = path.resolve(__dirname, "..", "..");
  const repositoryRoot = path.resolve(contractsRoot, "..");
  const sourceCommit = reviewedSourceCommit(repositoryRoot);
  const deploymentRoot = path.join(contractsRoot, "deployments", "fx");
  const market = readMarket(contractsRoot, "mainnet");
  const recordFiles = [
    "base-8453-market-v1-mainnet.json",
    "avalanche-43114-market-v1-mainnet.json",
  ];
  const chainRecords = recordFiles.map((fileName) => JSON.parse(fs.readFileSync(
    path.join(deploymentRoot, fileName),
    "utf8"
  )));
  for (const record of chainRecords) {
    if (record.sourceCommit !== sourceCommit) {
      throw new Error(`chain ${record.chainId} was not deployed from reviewed HEAD ${sourceCommit}`);
    }
    const network = networkFor(market, record.chainId);
    await preflightMarketChainAcrossRpcs(network);
    await preflightMarketDeploymentAcrossRpcs(network, record);
  }
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
    "mainnet-v1-market-deployment.json"
  );
  writeFrozenArtifact(outputPath, `${JSON.stringify(deployment, null, 2)}\n`);
  console.log(JSON.stringify({
    outputPath,
    sourceCommit,
    marketId: deployment.marketId,
    deploymentId: deployment.deploymentId,
    coordinationDomain: deployment.coordinationDomain,
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { writeFrozenArtifact };
