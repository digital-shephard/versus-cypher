const { getAddress, verifyMessage } = require("ethers");

const FX_PRICE_REFERENCE_DOMAIN = "VERSUS_FX_PRICE_REFERENCE_V1";
const FX_PRICE_REFERENCE_MARKET = "versus-fx-mainnet-v1";
const FX_PRICE_REFERENCE_ENDPOINTS = Object.freeze([
  "https://relay-a.versuscypher.com/v1/fx/prices",
  "https://relay-b.versuscypher.com/v1/fx/prices",
]);
const MAX_REFERENCE_DIVERGENCE_BPS = 100n;
const MAX_NODE_CLOCK_DISAGREEMENT_MS = 120_000;
const EXPECTED_SOURCES = Object.freeze({
  AVAX: Object.freeze({
    sourceChainId: "43114",
    feed: "0x0A77230d17318075983913bC2145DB16C7366156",
    sourceDescription: "AVAX / USD",
    maximumSourceAgeSeconds: 7_200,
  }),
  ETH: Object.freeze({
    sourceChainId: "8453",
    feed: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
    sourceDescription: "ETH / USD",
    maximumSourceAgeSeconds: 7_200,
  }),
  EURC: Object.freeze({
    sourceChainId: "8453",
    feed: "0xDAe398520e2B67cd3f27aeF9Cf14D93D927f8250",
    sourceDescription: "EURC / USD",
    maximumSourceAgeSeconds: 90_000,
  }),
});

function fxPriceReferenceEndpointsFromEnv(env = process.env) {
  const configured = String(env.VERSUS_FX_PRICE_REFERENCE_ENDPOINTS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(configured.length ? configured : FX_PRICE_REFERENCE_ENDPOINTS)];
}

function canonicalFxPriceReference(value) {
  const prices = [...(value.prices || [])]
    .map((price) => ({
      symbol: String(price.symbol),
      usdMicros: String(price.usdMicros),
      sourceChainId: String(price.sourceChainId),
      feed: getAddress(price.feed),
      sourceDescription: String(price.sourceDescription),
      sourceDecimals: Number(price.sourceDecimals),
      roundId: String(price.roundId),
      sourceUpdatedAt: Number(price.sourceUpdatedAt),
    }))
    .sort((left, right) => left.symbol.localeCompare(right.symbol));
  return {
    version: 1,
    market: String(value.market),
    prices,
    observedAt: Number(value.observedAt),
    validUntil: Number(value.validUntil),
    staleUntil: Number(value.staleUntil),
  };
}

function fxPriceReferenceMessage(value) {
  return `${FX_PRICE_REFERENCE_DOMAIN}\n${JSON.stringify(canonicalFxPriceReference(value))}`;
}

function responseClock(response, startedAt, finishedAt) {
  const header = response?.headers?.get?.("date");
  const serverTimeMs = header ? Date.parse(header) : NaN;
  if (!Number.isFinite(serverTimeMs)) return { serverTimeMs: null, clockOffsetMs: 0 };
  const midpoint = startedAt + Math.max(0, finishedAt - startedAt) / 2;
  return { serverTimeMs, clockOffsetMs: Math.round(serverTimeMs - midpoint) };
}

function validateNodeFxPriceReference(value, { trustedSigners, now = Date.now() }) {
  if (!value || typeof value !== "object") throw new TypeError("FX price reference is invalid");
  const payload = canonicalFxPriceReference(value);
  if (payload.version !== 1 || payload.market !== FX_PRICE_REFERENCE_MARKET) {
    throw new Error("FX price reference domain is invalid");
  }
  const signer = getAddress(verifyMessage(fxPriceReferenceMessage(payload), value.signature));
  const trusted = new Set((trustedSigners || []).map((address) => getAddress(address).toLowerCase()));
  if (!trusted.has(signer.toLowerCase())) throw new Error("FX price reference signer is not trusted");
  const nowSeconds = Math.floor(now / 1_000);
  if (payload.observedAt > nowSeconds + 30 || payload.staleUntil < nowSeconds) {
    throw new Error("FX price reference is expired");
  }
  if (
    payload.validUntil < payload.observedAt ||
    payload.staleUntil < payload.validUntil ||
    payload.validUntil - payload.observedAt > 180 ||
    payload.staleUntil - payload.observedAt > 900
  ) {
    throw new Error("FX price reference timing is invalid");
  }
  if (payload.prices.length !== Object.keys(EXPECTED_SOURCES).length) {
    throw new Error("FX price reference source count is invalid");
  }
  const prices = new Map();
  for (const price of payload.prices) {
    const expected = EXPECTED_SOURCES[price.symbol];
    if (
      !expected ||
      price.sourceChainId !== expected.sourceChainId ||
      price.feed !== getAddress(expected.feed) ||
      price.sourceDescription !== expected.sourceDescription ||
      price.sourceDecimals !== 8
    ) {
      throw new Error(`FX price source for ${price.symbol} is invalid`);
    }
    if (!/^\d+$/.test(price.usdMicros) || BigInt(price.usdMicros) <= 0n) {
      throw new Error(`FX price for ${price.symbol} is invalid`);
    }
    if (!/^\d+$/.test(price.roundId) || BigInt(price.roundId) <= 0n) {
      throw new Error(`FX round for ${price.symbol} is invalid`);
    }
    if (
      !Number.isSafeInteger(price.sourceUpdatedAt) ||
      price.sourceUpdatedAt <= 0 ||
      price.sourceUpdatedAt > payload.observedAt + 30 ||
      payload.observedAt - price.sourceUpdatedAt > expected.maximumSourceAgeSeconds
    ) {
      throw new Error(`FX source timestamp for ${price.symbol} is invalid`);
    }
    if (prices.has(price.symbol)) throw new Error(`FX price source for ${price.symbol} is duplicated`);
    prices.set(price.symbol, BigInt(price.usdMicros));
  }
  return {
    ...payload,
    signer,
    signature: value.signature,
    prices,
    freshness: nowSeconds <= payload.validUntil ? "fresh" : "stale",
  };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2n;
}

async function fetchNodeFxPriceReference({
  endpoints = FX_PRICE_REFERENCE_ENDPOINTS,
  trustedSigners,
  fetchImpl = globalThis.fetch,
  timeoutMs = 2_500,
  now = Date.now(),
  minimumSigners = 2,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("FX price reference fetch is unavailable");
  if (!Number.isInteger(minimumSigners) || minimumSigners < 1) throw new RangeError("minimum signers is invalid");
  const settled = await Promise.allSettled(endpoints.map(async (endpoint) => {
    const startedAt = Date.now();
    const response = await fetchImpl(endpoint, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const clock = responseClock(response, startedAt, Date.now());
    if (!response.ok) throw new Error(`FX price endpoint returned ${response.status}`);
    return {
      ...validateNodeFxPriceReference(await response.json(), {
        trustedSigners,
        now: clock.serverTimeMs ?? now,
      }),
      sourceEndpoint: endpoint,
      ...clock,
    };
  }));
  const validBySigner = new Map();
  for (const result of settled) {
    if (result.status === "fulfilled") validBySigner.set(result.value.signer.toLowerCase(), result.value);
  }
  const valid = [...validBySigner.values()];
  if (valid.length < minimumSigners) {
    throw new AggregateError(
      settled.filter((result) => result.status === "rejected").map((result) => result.reason),
      `FX price reference requires ${minimumSigners} distinct trusted relays`,
    );
  }
  const serverTimes = valid.map((value) => value.serverTimeMs).filter(Number.isFinite);
  if (serverTimes.length > 1 && Math.max(...serverTimes) - Math.min(...serverTimes) > MAX_NODE_CLOCK_DISAGREEMENT_MS) {
    throw new Error("Versus price relays disagree about network time");
  }
  const prices = new Map();
  for (const symbol of Object.keys(EXPECTED_SOURCES)) {
    const values = valid.map((reference) => reference.prices.get(symbol));
    const low = values.reduce((left, right) => left < right ? left : right);
    const high = values.reduce((left, right) => left > right ? left : right);
    if ((high - low) * 10_000n > low * MAX_REFERENCE_DIVERGENCE_BPS) {
      throw new Error(`Versus price relays disagree about ${symbol}/USD`);
    }
    prices.set(symbol, median(values));
  }
  return {
    market: FX_PRICE_REFERENCE_MARKET,
    prices,
    references: valid,
    signerCount: valid.length,
    validUntil: Math.min(...valid.map((reference) => reference.validUntil)),
    freshness: valid.every((reference) => reference.freshness === "fresh") ? "fresh" : "stale",
  };
}

async function fetchNodeFxUsdPrice({ symbol, ...options } = {}) {
  symbol = String(symbol || "").toUpperCase();
  if (!EXPECTED_SOURCES[symbol]) throw new Error(`FX price symbol ${symbol || "missing"} is unsupported`);
  const reference = await fetchNodeFxPriceReference(options);
  if (reference.freshness !== "fresh") throw new Error(`fresh signed relay ${symbol}/USD quote is unavailable`);
  return reference.prices.get(symbol);
}

module.exports = {
  EXPECTED_SOURCES,
  FX_PRICE_REFERENCE_DOMAIN,
  FX_PRICE_REFERENCE_ENDPOINTS,
  FX_PRICE_REFERENCE_MARKET,
  canonicalFxPriceReference,
  fetchNodeFxPriceReference,
  fetchNodeFxUsdPrice,
  fxPriceReferenceEndpointsFromEnv,
  fxPriceReferenceMessage,
  validateNodeFxPriceReference,
};
