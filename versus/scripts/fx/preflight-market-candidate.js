const path = require("node:path");
const {
  networkFor,
  preflightMarketChainAcrossRpcs,
  readMarket,
} = require("./market-candidate-config");

async function main() {
  const profile = String(process.argv[2] || "testnet");
  const requestedNetwork = process.argv[3] == null ? null : String(process.argv[3]);
  const contractsRoot = path.resolve(__dirname, "..", "..");
  const market = readMarket(contractsRoot, profile);
  const networks = requestedNetwork == null
    ? market.chains.map((chain) => networkFor(market, chain.chainId))
    : [networkFor(market, requestedNetwork)];
  const evidence = [];
  const rpcConsensus = [];
  for (const network of networks) {
    const result = await preflightMarketChainAcrossRpcs(network);
    evidence.push(result.evidence);
    rpcConsensus.push(result.consensus);
  }
  console.log(JSON.stringify({
    profile,
    marketId: market.marketId,
    releaseStage: market.releaseStage,
    routeCount: market.routes.length,
    rpcConsensus,
    evidence,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
