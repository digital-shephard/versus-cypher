const path = require("node:path");
const {
  networkFor,
  preflightMarketChain,
  providerFor,
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
  for (const network of networks) {
    evidence.push(await preflightMarketChain(providerFor(network), network));
  }
  console.log(JSON.stringify({
    profile,
    marketId: market.marketId,
    releaseStage: market.releaseStage,
    routeCount: market.routes.length,
    evidence,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
