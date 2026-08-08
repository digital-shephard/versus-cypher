const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { validateFxMarketConfig } = require("../src/fx-market-config");

const CANDIDATE_PATH = path.resolve(
  __dirname,
  "../../../versus/deployments/fx/mainnet-v1-market-candidate.json"
);
const TESTNET_CANDIDATE_PATH = path.resolve(
  __dirname,
  "../../../versus/deployments/fx/public-testnet-v1-market-candidate.json"
);

function candidate() {
  return JSON.parse(fs.readFileSync(CANDIDATE_PATH, "utf8"));
}

test("public testnet candidate mirrors the production asset shape on Fuji", () => {
  const market = validateFxMarketConfig(
    JSON.parse(fs.readFileSync(TESTNET_CANDIDATE_PATH, "utf8"))
  );
  assert.deepEqual(market.chains.map((chain) => chain.chainId), ["43113", "84532"]);
  assert.deepEqual(
    market.chains.find((chain) => chain.chainId === "43113").assets.map((asset) => asset.symbol),
    ["AVAX", "USDC", "EURC"]
  );
  assert.notEqual(market.marketId, validateFxMarketConfig(candidate()).marketId);
});

test("mainnet v1 candidate freezes six positions and all meaningful routes", () => {
  const market = validateFxMarketConfig(candidate());
  assert.equal(market.chains.length, 2);
  assert.equal(market.chains.flatMap((chain) => chain.assets).length, 6);
  assert.equal(market.routes.length, 30);
  assert.equal(market.routes.filter((route) => route.sameChain).length, 12);
  assert.equal(market.routes.filter((route) => route.x402ExactEligible).length, 20);
});

test("native ETH and AVAX are tradeable but not generic exact payment inputs", () => {
  const market = validateFxMarketConfig(candidate());
  const natives = market.chains.map((chain) =>
    chain.assets.find((asset) => asset.kind === "native")
  );
  assert.deepEqual(natives.map((asset) => asset.symbol), ["ETH", "AVAX"]);
  assert(natives.every((asset) => !asset.x402ExactInput));
  assert(market.routes.some((route) =>
    route.input.symbol === "ETH" && route.output.symbol === "AVAX"
  ));
});

test("same-chain stable and native routes remain part of the frozen matrix", () => {
  const market = validateFxMarketConfig(candidate());
  for (const chain of market.chains) {
    assert(market.routes.some((route) =>
      route.sameChain &&
      route.input.chainId === chain.chainId &&
      route.input.kind === "native" &&
      route.output.symbol === "USDC"
    ));
    assert(market.routes.some((route) =>
      route.sameChain &&
      route.input.chainId === chain.chainId &&
      route.input.symbol === "USDC" &&
      route.output.symbol === "EURC"
    ));
  }
});

test("candidate economics and timeout policy fail closed", () => {
  const excessiveSpread = candidate();
  excessiveSpread.marketId = undefined;
  excessiveSpread.economics.defaultDealerSpreadBps = 10_001;
  assert.throws(
    () => validateFxMarketConfig(excessiveSpread),
    /cannot exceed 10000 bps/
  );

  const impossibleTimeout = candidate();
  impossibleTimeout.marketId = undefined;
  impossibleTimeout.timeoutPolicy.settlementLifetimeSeconds = 604_801;
  assert.throws(
    () => validateFxMarketConfig(impossibleTimeout),
    /internally inconsistent/
  );
});
