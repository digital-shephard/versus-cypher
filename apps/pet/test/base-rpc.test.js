const assert = require("node:assert/strict");
const test = require("node:test");
const { Wallet } = require("ethers");
const {
  BASE_HATCH_QUOTE_ENDPOINTS,
  BASE_PUBLIC_RPCS,
  BASE_RPC_PROVIDER_OPTIONS,
  fetchNodeHatchQuote,
  hatchQuoteEndpointsFromEnv,
  hatchQuoteMessage,
  rpcUrlsFromEnv,
  runwaySafeTargetMicros,
  splitDepositWei,
  validateNodeHatchQuote,
} = require("../src/base-rpc");

test("Base RPC reads stay below restrictive public-provider batch caps", () => {
  assert.equal(BASE_RPC_PROVIDER_OPTIONS.batchMaxCount, 1);
  assert.equal(BASE_RPC_PROVIDER_OPTIONS.staticNetwork, true);
});

test("deposit split keeps thirty percent ETH and assigns seventy percent to runway", () => {
  const plan = splitDepositWei(10_000_000_000_000_000n);
  assert.equal(plan.swapWei, 7_000_000_000_000_000n);
  assert.equal(plan.gasReserveWei, 3_000_000_000_000_000n);
  assert.equal(plan.swapWei + plan.gasReserveWei, plan.depositWei);
});

test("hatch target keeps the slippage-adjusted runway above the contract floor", () => {
  const target = runwaySafeTargetMicros(10_000_000n, { requiredRunwayMicros: 7_000_000n });
  const quotedRunway = (target * 7_000n) / 10_000n;
  const minimumRunway = (quotedRunway * 9_900n) / 10_000n;
  assert.equal(target, 10_101_012n);
  assert.ok(minimumRunway >= 7_000_000n);
});

test("Base RPC pool needs no signup and accepts an explicit operator override", () => {
  assert.deepEqual(rpcUrlsFromEnv({}), [...BASE_PUBLIC_RPCS]);
  assert.deepEqual(rpcUrlsFromEnv({ VERSUS_RPC_URLS: "https://one.test, https://two.test" }), [
    "https://one.test",
    "https://two.test",
  ]);
  assert.deepEqual(rpcUrlsFromEnv({ VERSUS_RPC_URL: "https://private.test" }), [
    "https://private.test",
  ]);
});

test("unhatched devices accept only fresh deployment-scoped signed node quotes", async () => {
  const wallet = new Wallet(`0x${"2".repeat(64)}`);
  const now = 1_780_000_000_000;
  const quote = {
    version: 1,
    chainId: "8453",
    arena: "0x1000000000000000000000000000000000000001",
    targetUsdMicros: "10000000",
    requiredRunwayMicros: "7000000",
    runwayBps: 7000,
    bufferBps: 300,
    feeTier: 500,
    depositWei: "1471428571428572",
    swapWei: "1030000000000000",
    gasReserveWei: "441428571428572",
    quotedAt: 1_780_000_000,
    validUntil: 1_780_000_180,
    staleUntil: 1_780_000_900,
  };
  quote.signer = wallet.address;
  quote.signature = await wallet.signMessage(hatchQuoteMessage(quote));
  const result = await fetchNodeHatchQuote({
    endpoints: ["https://relay.test/v1/hatch-quote"],
    trustedSigners: [wallet.address],
    chainId: 8453,
    arena: quote.arena,
    now,
    fetchImpl: async () => ({ ok: true, json: async () => quote }),
  });
  assert.equal(result.nodeQuote, true);
  assert.equal(result.depositWei, 1_471_428_571_428_572n);
  assert.equal(result.minimumRunwayMicros, 7_000_000n);
  assert.equal(result.freshness, "fresh");
  assert.equal(result.sourceEndpoint, "https://relay.test/v1/hatch-quote");

  assert.throws(() => validateNodeHatchQuote(quote, {
    trustedSigners: [Wallet.createRandom().address],
    chainId: 8453,
    arena: quote.arena,
    now,
  }), /not trusted/);
  assert.throws(() => validateNodeHatchQuote(quote, {
    trustedSigners: [wallet.address],
    chainId: 8453,
    arena: quote.arena,
    now: (quote.staleUntil + 1) * 1000,
  }), /expired/);
  assert.throws(() => validateNodeHatchQuote({ ...quote, version: 2 }, {
    trustedSigners: [wallet.address],
    chainId: 8453,
    arena: quote.arena,
    now,
  }), /version/);
});

test("node quote endpoints are public defaults with an operator override", () => {
  assert.deepEqual(hatchQuoteEndpointsFromEnv({}), [...BASE_HATCH_QUOTE_ENDPOINTS]);
  assert.deepEqual(hatchQuoteEndpointsFromEnv({ VERSUS_HATCH_QUOTE_ENDPOINTS: "https://one.test/v1/hatch-quote" }), [
    "https://one.test/v1/hatch-quote",
  ]);
});
