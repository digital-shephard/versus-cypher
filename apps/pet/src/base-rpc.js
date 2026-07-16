const { Contract, FallbackProvider, JsonRpcProvider, getAddress, verifyMessage } = require("ethers");

const BASE_CHAIN_ID = 8453;
const BASE_PUBLIC_RPCS = Object.freeze([
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
  "https://base.drpc.org",
]);
const BASE_WETH = "0x4200000000000000000000000000000000000006";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_UNISWAP_QUOTER_V2 = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const BASE_UNISWAP_SWAP_ROUTER_02 = "0x2626664c2603336E57B271c5C0b26F421741e481";
const FEE_TIERS = Object.freeze([500, 3000, 10000]);
const BASE_HATCH_QUOTE_ENDPOINTS = Object.freeze([
  "https://relay-a.versuscypher.com/v1/hatch-quote",
  "https://relay-b.versuscypher.com/v1/hatch-quote",
]);
const BASE_CLASS_STATE_ENDPOINTS = Object.freeze([
  "https://relay-a.versuscypher.com/v1/class-state",
  "https://relay-b.versuscypher.com/v1/class-state",
]);
const HATCH_QUOTE_DOMAIN = "VERSUS_HATCH_QUOTE_V1";
const CLASS_STATE_DOMAIN = "VERSUS_CLASS_STATE_V1";
const BPS = 10_000n;
const DEFAULT_RUNWAY_BPS = 7_000n;
const DEFAULT_SWAP_MIN_BPS = 9_900n;
const BASE_RPC_PROVIDER_OPTIONS = Object.freeze({
  staticNetwork: true,
  // Several public Base endpoints cap JSON-RPC batches at ten calls. State
  // reconciliation intentionally issues more reads than that, so keep each
  // request independent and let FallbackProvider handle endpoint failover.
  batchMaxCount: 1,
});
const MAX_NODE_CLOCK_DISAGREEMENT_MS = 120_000;

const quoterAbi = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
];

function rpcUrlsFromEnv(env = process.env) {
  const configured = String(env.VERSUS_RPC_URLS || env.VERSUS_RPC_URL || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(configured.length ? configured : BASE_PUBLIC_RPCS)];
}

function hatchQuoteEndpointsFromEnv(env = process.env) {
  const configured = String(env.VERSUS_HATCH_QUOTE_ENDPOINTS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(configured.length ? configured : BASE_HATCH_QUOTE_ENDPOINTS)];
}

function classStateEndpointsFromEnv(env = process.env) {
  const configured = String(env.VERSUS_CLASS_STATE_ENDPOINTS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(configured.length ? configured : BASE_CLASS_STATE_ENDPOINTS)];
}

function canonicalClassState(value) {
  return {
    version: 1,
    chainId: String(value.chainId),
    arena: getAddress(value.arena),
    syndicate: getAddress(value.syndicate),
    classId: String(value.classId),
    totalCommittedMicros: String(value.totalCommittedMicros),
    participantCount: Number(value.participantCount),
    openedDay: Number(value.openedDay),
    chainDay: Number(value.chainDay),
    graduated: Boolean(value.graduated),
    graduationFloorMicros: String(value.graduationFloorMicros),
    blockNumber: String(value.blockNumber),
    observedAt: Number(value.observedAt),
    validUntil: Number(value.validUntil),
    staleUntil: Number(value.staleUntil),
  };
}

function classStateMessage(value) {
  return `${CLASS_STATE_DOMAIN}\n${JSON.stringify(canonicalClassState(value))}`;
}

function responseClock(response, startedAt, finishedAt) {
  const header = response?.headers?.get?.("date");
  const serverTimeMs = header ? Date.parse(header) : NaN;
  if (!Number.isFinite(serverTimeMs)) return { serverTimeMs: null, clockOffsetMs: 0 };
  const midpoint = startedAt + Math.max(0, finishedAt - startedAt) / 2;
  return { serverTimeMs, clockOffsetMs: Math.round(serverTimeMs - midpoint) };
}

function validateNodeClassState(value, { trustedSigners, chainId, arena, syndicate, now = Date.now() }) {
  if (!value || typeof value !== "object") throw new TypeError("class state is invalid");
  if (Number(value.version) !== 1) throw new Error("class state version is invalid");
  const payload = canonicalClassState(value);
  const signer = getAddress(verifyMessage(classStateMessage(payload), value.signature));
  const trusted = new Set((trustedSigners || []).map((address) => getAddress(address).toLowerCase()));
  const nowSeconds = Math.floor(now / 1000);
  if (!trusted.has(signer.toLowerCase())) throw new Error("class state signer is not trusted");
  if (
    payload.chainId !== String(chainId) ||
    payload.arena !== getAddress(arena) ||
    payload.syndicate !== getAddress(syndicate)
  ) throw new Error("class state deployment mismatch");
  if (payload.observedAt > nowSeconds + 30 || payload.staleUntil < nowSeconds) throw new Error("class state is expired");
  if (payload.validUntil < payload.observedAt || payload.staleUntil < payload.validUntil) throw new Error("class state timing is invalid");
  if (payload.validUntil - payload.observedAt > 180 || payload.staleUntil - payload.observedAt > 900) {
    throw new Error("class state lifetime is invalid");
  }
  for (const name of ["classId", "totalCommittedMicros", "graduationFloorMicros", "blockNumber"]) {
    if (!/^\d+$/.test(payload[name])) throw new Error(`class state ${name} is invalid`);
  }
  for (const name of ["participantCount", "openedDay", "chainDay"]) {
    if (!Number.isSafeInteger(payload[name]) || payload[name] < 0) throw new Error(`class state ${name} is invalid`);
  }
  if (BigInt(payload.graduationFloorMicros) !== 1_000_000_000n) throw new Error("class state graduation floor is invalid");
  return {
    ...payload,
    signer,
    signature: value.signature,
    classId: BigInt(payload.classId),
    totalCommittedMicros: BigInt(payload.totalCommittedMicros),
    graduationFloorMicros: BigInt(payload.graduationFloorMicros),
    blockNumber: BigInt(payload.blockNumber),
    freshness: nowSeconds <= payload.validUntil ? "fresh" : "stale",
  };
}

async function fetchNodeClassState({
  endpoints = BASE_CLASS_STATE_ENDPOINTS,
  trustedSigners,
  chainId = BASE_CHAIN_ID,
  arena,
  syndicate,
  fetchImpl = globalThis.fetch,
  timeoutMs = 2_500,
  now = Date.now(),
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("class state fetch is unavailable");
  const settled = await Promise.allSettled(endpoints.map(async (endpoint) => {
    const startedAt = Date.now();
    const response = await fetchImpl(endpoint, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const clock = responseClock(response, startedAt, Date.now());
    if (!response.ok) throw new Error(`class state endpoint returned ${response.status}`);
    return {
      ...validateNodeClassState(await response.json(), {
        trustedSigners,
        chainId,
        arena,
        syndicate,
        now: clock.serverTimeMs ?? now,
      }),
      sourceEndpoint: endpoint,
      ...clock,
    };
  }));
  const valid = settled.filter((result) => result.status === "fulfilled").map((result) => result.value);
  if (!valid.length) throw new AggregateError(
    settled.filter((result) => result.status === "rejected").map((result) => result.reason),
    "no signed class state endpoint was available",
  );
  const serverTimes = valid.map((value) => value.serverTimeMs).filter(Number.isFinite);
  if (serverTimes.length > 1 && Math.max(...serverTimes) - Math.min(...serverTimes) > MAX_NODE_CLOCK_DISAGREEMENT_MS) {
    throw new Error("Versus nodes disagree about network time");
  }
  valid.sort((left, right) => left.blockNumber > right.blockNumber ? -1 : left.blockNumber < right.blockNumber ? 1 : 0);
  const offsets = valid.map((value) => value.clockOffsetMs).filter(Number.isFinite).sort((a, b) => a - b);
  valid[0].clockOffsetMs = serverTimes.length > 1 && offsets.length > 1
    ? offsets[Math.floor(offsets.length / 2)]
    : null;
  valid[0].clockQuorum = serverTimes.length > 1 ? serverTimes.length : 0;
  return valid[0];
}

function canonicalHatchQuote(value) {
  return {
    version: 1,
    chainId: String(value.chainId),
    arena: getAddress(value.arena),
    targetUsdMicros: String(value.targetUsdMicros),
    requiredRunwayMicros: String(value.requiredRunwayMicros),
    runwayBps: Number(value.runwayBps),
    bufferBps: Number(value.bufferBps),
    feeTier: Number(value.feeTier),
    depositWei: String(value.depositWei),
    swapWei: String(value.swapWei),
    gasReserveWei: String(value.gasReserveWei),
    quotedAt: Number(value.quotedAt),
    validUntil: Number(value.validUntil),
    staleUntil: Number(value.staleUntil),
  };
}

function hatchQuoteMessage(value) {
  return `${HATCH_QUOTE_DOMAIN}\n${JSON.stringify(canonicalHatchQuote(value))}`;
}

function validateNodeHatchQuote(value, { trustedSigners, chainId, arena, now = Date.now() }) {
  if (!value || typeof value !== "object") throw new TypeError("hatch quote is invalid");
  if (Number(value.version) !== 1) throw new Error("hatch quote version is invalid");
  const payload = canonicalHatchQuote(value);
  const signer = getAddress(verifyMessage(hatchQuoteMessage(payload), value.signature));
  const trusted = new Set((trustedSigners || []).map((address) => getAddress(address).toLowerCase()));
  const nowSeconds = Math.floor(now / 1000);
  if (!trusted.has(signer.toLowerCase())) throw new Error("hatch quote signer is not trusted");
  if (payload.chainId !== String(chainId) || payload.arena !== getAddress(arena)) throw new Error("hatch quote deployment mismatch");
  if (payload.quotedAt > nowSeconds + 30 || payload.staleUntil < nowSeconds) throw new Error("hatch quote is expired");
  if (payload.validUntil < payload.quotedAt || payload.staleUntil < payload.validUntil) throw new Error("hatch quote timing is invalid");
  if (payload.validUntil - payload.quotedAt > 180 || payload.staleUntil - payload.quotedAt > 900) throw new Error("hatch quote lifetime is invalid");
  if (payload.targetUsdMicros !== "10000000" || payload.requiredRunwayMicros !== "7000000") throw new Error("hatch quote target is invalid");
  if (payload.runwayBps !== 7000 || payload.bufferBps < 200 || payload.bufferBps > 300) throw new Error("hatch quote safety policy is invalid");
  if (!FEE_TIERS.includes(payload.feeTier)) throw new Error("hatch quote fee tier is invalid");
  const depositWei = BigInt(payload.depositWei);
  const swapWei = BigInt(payload.swapWei);
  const gasReserveWei = BigInt(payload.gasReserveWei);
  if (depositWei <= 0n || swapWei <= 0n || swapWei + gasReserveWei !== depositWei) throw new Error("hatch quote split is invalid");
  if ((depositWei * BigInt(payload.runwayBps)) / BPS !== swapWei) throw new Error("hatch quote runway split is invalid");
  return {
    ...payload,
    signer,
    signature: value.signature,
    depositWei,
    swapWei,
    gasReserveWei,
    fee: payload.feeTier,
    quotedRunwayMicros: BigInt(payload.requiredRunwayMicros),
    minimumRunwayMicros: BigInt(payload.requiredRunwayMicros),
    slippageBps: BPS - BigInt(payload.bufferBps),
    quoteGasEstimate: 0n,
    nodeQuote: true,
    freshness: nowSeconds <= payload.validUntil ? "fresh" : "stale",
  };
}

async function fetchNodeHatchQuote({
  endpoints = BASE_HATCH_QUOTE_ENDPOINTS,
  trustedSigners,
  chainId = BASE_CHAIN_ID,
  arena,
  fetchImpl = globalThis.fetch,
  timeoutMs = 2_500,
  now = Date.now(),
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("hatch quote fetch is unavailable");
  const attempts = endpoints.map(async (endpoint) => {
    const startedAt = Date.now();
    const response = await fetchImpl(endpoint, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const clock = responseClock(response, startedAt, Date.now());
    if (!response.ok) throw new Error(`hatch quote endpoint returned ${response.status}`);
    return {
      ...validateNodeHatchQuote(await response.json(), {
        trustedSigners,
        chainId,
        arena,
        now: clock.serverTimeMs ?? now,
      }),
      sourceEndpoint: endpoint,
      ...clock,
    };
  });
  if (!attempts.length) throw new Error("no hatch quote endpoints are configured");
  return Promise.any(attempts);
}

function createBaseProvider(env = process.env) {
  const urls = rpcUrlsFromEnv(env);
  if (urls.length === 1) {
    return new JsonRpcProvider(urls[0], BASE_CHAIN_ID, BASE_RPC_PROVIDER_OPTIONS);
  }
  const providers = urls.map((url, index) => ({
    provider: new JsonRpcProvider(url, BASE_CHAIN_ID, BASE_RPC_PROVIDER_OPTIONS),
    priority: index + 1,
    stallTimeout: 900,
    weight: 1,
  }));
  return new FallbackProvider(providers, BASE_CHAIN_ID, { quorum: 1 });
}

function splitDepositWei(depositWei, runwayBps = DEFAULT_RUNWAY_BPS) {
  depositWei = BigInt(depositWei);
  runwayBps = BigInt(runwayBps);
  if (depositWei <= 0n) throw new RangeError("deposit must be positive");
  if (runwayBps <= 0n || runwayBps >= BPS) throw new RangeError("runway split is invalid");
  const swapWei = (depositWei * runwayBps) / BPS;
  return { depositWei, swapWei, gasReserveWei: depositWei - swapWei, runwayBps };
}

function divideRoundUp(numerator, denominator) {
  if (denominator <= 0n) throw new RangeError("denominator must be positive");
  return (numerator + denominator - 1n) / denominator;
}

function runwaySafeTargetMicros(
  targetMicros,
  {
    requiredRunwayMicros = 0n,
    runwayBps = DEFAULT_RUNWAY_BPS,
    slippageBps = DEFAULT_SWAP_MIN_BPS,
  } = {}
) {
  targetMicros = BigInt(targetMicros);
  requiredRunwayMicros = BigInt(requiredRunwayMicros);
  runwayBps = BigInt(runwayBps);
  slippageBps = BigInt(slippageBps);
  if (targetMicros <= 0n) throw new RangeError("target must be positive");
  if (requiredRunwayMicros < 0n) throw new RangeError("required runway cannot be negative");
  if (runwayBps <= 0n || runwayBps >= BPS) throw new RangeError("runway split is invalid");
  if (slippageBps <= 0n || slippageBps > BPS) throw new RangeError("slippage floor is invalid");
  if (requiredRunwayMicros === 0n) return targetMicros;

  const quotedRunwayRequired = divideRoundUp(requiredRunwayMicros * BPS, slippageBps);
  const grossTargetRequired = divideRoundUp(quotedRunwayRequired * BPS, runwayBps);
  return targetMicros > grossTargetRequired ? targetMicros : grossTargetRequired;
}

async function quoteEthToUsdc(provider, amountWei, { quoterAddress = BASE_UNISWAP_QUOTER_V2 } = {}) {
  amountWei = BigInt(amountWei);
  if (amountWei <= 0n) throw new RangeError("quote amount must be positive");
  const quoter = new Contract(quoterAddress, quoterAbi, provider);
  const quotes = await Promise.all(
    FEE_TIERS.map(async (fee) => {
      try {
        const result = await quoter.quoteExactInputSingle.staticCall({
          tokenIn: BASE_WETH,
          tokenOut: BASE_USDC,
          amountIn: amountWei,
          fee,
          sqrtPriceLimitX96: 0,
        });
        return { fee, amountOut: BigInt(result.amountOut ?? result[0]), gasEstimate: BigInt(result.gasEstimate ?? result[3]) };
      } catch (_) {
        return null;
      }
    })
  );
  const viable = quotes.filter(Boolean).sort((left, right) => (left.amountOut > right.amountOut ? -1 : 1));
  if (!viable.length) throw new Error("no live Uniswap ETH to USDC quote was available");
  return viable[0];
}

async function quoteDepositPlan(provider, depositWei, options = {}) {
  const split = splitDepositWei(depositWei, options.runwayBps);
  const quote = await quoteEthToUsdc(provider, split.swapWei, options);
  const slippageBps = BigInt(options.slippageBps ?? DEFAULT_SWAP_MIN_BPS);
  if (slippageBps <= 0n || slippageBps > BPS) throw new RangeError("slippage floor is invalid");
  return {
    ...split,
    fee: quote.fee,
    quotedRunwayMicros: quote.amountOut,
    minimumRunwayMicros: (quote.amountOut * slippageBps) / BPS,
    slippageBps,
    quoteGasEstimate: quote.gasEstimate,
  };
}

async function quoteUsdDepositTarget(provider, targetMicros = 10_000_000n, options = {}) {
  const requiredRunwayMicros = BigInt(options.requiredRunwayMicros ?? 0n);
  targetMicros = runwaySafeTargetMicros(targetMicros, { ...options, requiredRunwayMicros });
  const probeWei = 3_000_000_000_000_000n;
  const probe = await quoteEthToUsdc(provider, probeWei, options);
  let targetDepositWei = divideRoundUp(probeWei * targetMicros, probe.amountOut);
  let plan = await quoteDepositPlan(provider, targetDepositWei, options);

  // Re-quote against the real trade size; pool curvature can differ from the small probe.
  for (let attempt = 0; requiredRunwayMicros > 0n && plan.minimumRunwayMicros < requiredRunwayMicros; attempt++) {
    if (attempt >= 2 || plan.minimumRunwayMicros === 0n) {
      throw new Error("unable to quote a hatch deposit above the minimum runway");
    }
    targetDepositWei = divideRoundUp(plan.depositWei * requiredRunwayMicros, plan.minimumRunwayMicros);
    plan = await quoteDepositPlan(provider, targetDepositWei, options);
  }
  return plan;
}

module.exports = {
  BASE_CHAIN_ID,
  BASE_CLASS_STATE_ENDPOINTS,
  BASE_HATCH_QUOTE_ENDPOINTS,
  BASE_PUBLIC_RPCS,
  BASE_RPC_PROVIDER_OPTIONS,
  BASE_UNISWAP_QUOTER_V2,
  BASE_UNISWAP_SWAP_ROUTER_02,
  BASE_USDC,
  BASE_WETH,
  FEE_TIERS,
  createBaseProvider,
  classStateEndpointsFromEnv,
  classStateMessage,
  fetchNodeClassState,
  fetchNodeHatchQuote,
  hatchQuoteEndpointsFromEnv,
  hatchQuoteMessage,
  quoteDepositPlan,
  quoteEthToUsdc,
  quoteUsdDepositTarget,
  rpcUrlsFromEnv,
  runwaySafeTargetMicros,
  splitDepositWei,
  validateNodeHatchQuote,
  validateNodeClassState,
};
