const assert = require("node:assert/strict");
const test = require("node:test");
const { Wallet } = require("ethers");
const {
  FX_PRICE_REFERENCE_ENDPOINTS,
  canonicalFxPriceReference,
  fetchNodeFxPriceReference,
  fetchNodeFxUsdPrice,
  fxPriceReferenceEndpointsFromEnv,
  fxPriceReferenceMessage,
  validateNodeFxPriceReference,
} = require("../src/fx-price-reference");

const now = 1_786_100_000_000;

async function signedReference(wallet, overrides = {}) {
  const base = canonicalFxPriceReference({
    market: "versus-fx-mainnet-v1",
    prices: [
      {
        symbol: "AVAX",
        usdMicros: "6449922",
        sourceChainId: "43114",
        feed: "0x0A77230d17318075983913bC2145DB16C7366156",
        sourceDescription: "AVAX / USD",
        sourceDecimals: 8,
        roundId: "12",
        sourceUpdatedAt: Math.floor(now / 1_000) - 60,
      },
      {
        symbol: "ETH",
        usdMicros: "1914912500",
        sourceChainId: "8453",
        feed: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
        sourceDescription: "ETH / USD",
        sourceDecimals: 8,
        roundId: "13",
        sourceUpdatedAt: Math.floor(now / 1_000) - 60,
      },
      {
        symbol: "EURC",
        usdMicros: "1151938",
        sourceChainId: "8453",
        feed: "0xDAe398520e2B67cd3f27aeF9Cf14D93D927f8250",
        sourceDescription: "EURC / USD",
        sourceDecimals: 8,
        roundId: "14",
        sourceUpdatedAt: Math.floor(now / 1_000) - 60,
      },
    ],
    observedAt: Math.floor(now / 1_000),
    validUntil: Math.floor(now / 1_000) + 180,
    staleUntil: Math.floor(now / 1_000) + 900,
    ...overrides,
  });
  const value = { ...base, signer: wallet.address };
  value.signature = await wallet.signMessage(fxPriceReferenceMessage(value));
  return value;
}

test("requires two distinct trusted relay signatures and returns the median reference", async () => {
  const relayA = new Wallet(`0x${"7".repeat(64)}`);
  const relayB = new Wallet(`0x${"8".repeat(64)}`);
  const values = [await signedReference(relayA), await signedReference(relayB)];
  values[1] = await signedReference(relayB, {
    prices: values[1].prices.map((price) => price.symbol === "ETH"
      ? { ...price, usdMicros: "1915000000" }
      : price),
  });
  const reference = await fetchNodeFxPriceReference({
    endpoints: ["https://relay-a.test", "https://relay-b.test"],
    trustedSigners: [relayA.address, relayB.address],
    now,
    fetchImpl: async (url) => ({
      ok: true,
      headers: { get: () => null },
      json: async () => values[url.includes("relay-b") ? 1 : 0],
    }),
  });
  assert.equal(reference.signerCount, 2);
  assert.equal(reference.prices.get("ETH"), 1_914_956_250n);
  assert.equal(await fetchNodeFxUsdPrice({
    symbol: "AVAX",
    endpoints: ["https://relay-a.test", "https://relay-b.test"],
    trustedSigners: [relayA.address, relayB.address],
    now,
    fetchImpl: async (url) => ({
      ok: true,
      headers: { get: () => null },
      json: async () => values[url.includes("relay-b") ? 1 : 0],
    }),
  }), 6_449_922n);
});

test("rejects one relay, duplicate signers, divergent prices, and stale oracle data", async () => {
  const relayA = new Wallet(`0x${"9".repeat(64)}`);
  const relayB = new Wallet(`0x${"a".repeat(64)}`);
  const valueA = await signedReference(relayA);
  const valueB = await signedReference(relayB, {
    prices: valueA.prices.map((price) => price.symbol === "AVAX"
      ? { ...price, usdMicros: "7000000" }
      : price),
  });
  await assert.rejects(fetchNodeFxPriceReference({
    endpoints: ["https://relay-a.test"],
    trustedSigners: [relayA.address],
    now,
    fetchImpl: async () => ({ ok: true, headers: { get: () => null }, json: async () => valueA }),
  }), /requires 2 distinct/);
  await assert.rejects(fetchNodeFxPriceReference({
    endpoints: ["https://one.test", "https://two.test"],
    trustedSigners: [relayA.address],
    now,
    fetchImpl: async () => ({ ok: true, headers: { get: () => null }, json: async () => valueA }),
  }), /requires 2 distinct/);
  await assert.rejects(fetchNodeFxPriceReference({
    endpoints: ["https://relay-a.test", "https://relay-b.test"],
    trustedSigners: [relayA.address, relayB.address],
    now,
    fetchImpl: async (url) => ({
      ok: true,
      headers: { get: () => null },
      json: async () => url.includes("relay-b") ? valueB : valueA,
    }),
  }), /disagree about AVAX/);

  const stale = await signedReference(relayA, {
    prices: valueA.prices.map((price) => price.symbol === "ETH"
      ? { ...price, sourceUpdatedAt: Math.floor(now / 1_000) - 7_201 }
      : price),
  });
  assert.throws(() => validateNodeFxPriceReference(stale, {
    trustedSigners: [relayA.address],
    now,
  }), /timestamp for ETH/);
});

test("price endpoints are public defaults with an operator override", () => {
  assert.deepEqual(fxPriceReferenceEndpointsFromEnv({}), [...FX_PRICE_REFERENCE_ENDPOINTS]);
  assert.deepEqual(
    fxPriceReferenceEndpointsFromEnv({ VERSUS_FX_PRICE_REFERENCE_ENDPOINTS: "https://one.test/v1/fx/prices" }),
    ["https://one.test/v1/fx/prices"],
  );
});
