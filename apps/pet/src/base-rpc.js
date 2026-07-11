const { Contract, FallbackProvider, JsonRpcProvider } = require("ethers");

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

function createBaseProvider(env = process.env) {
  const urls = rpcUrlsFromEnv(env);
  if (urls.length === 1) {
    return new JsonRpcProvider(urls[0], BASE_CHAIN_ID, { staticNetwork: true });
  }
  const providers = urls.map((url, index) => ({
    provider: new JsonRpcProvider(url, BASE_CHAIN_ID, { staticNetwork: true }),
    priority: index + 1,
    stallTimeout: 900,
    weight: 1,
  }));
  return new FallbackProvider(providers, BASE_CHAIN_ID, { quorum: 1 });
}

function splitDepositWei(depositWei, runwayBps = 7000n) {
  depositWei = BigInt(depositWei);
  runwayBps = BigInt(runwayBps);
  if (depositWei <= 0n) throw new RangeError("deposit must be positive");
  if (runwayBps <= 0n || runwayBps >= 10_000n) throw new RangeError("runway split is invalid");
  const swapWei = (depositWei * runwayBps) / 10_000n;
  return { depositWei, swapWei, gasReserveWei: depositWei - swapWei, runwayBps };
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
  return {
    ...split,
    fee: quote.fee,
    quotedRunwayMicros: quote.amountOut,
    minimumRunwayMicros: (quote.amountOut * 9900n) / 10_000n,
    quoteGasEstimate: quote.gasEstimate,
  };
}

async function quoteUsdDepositTarget(provider, targetMicros = 10_000_000n, options = {}) {
  targetMicros = BigInt(targetMicros);
  if (targetMicros <= 0n) throw new RangeError("target must be positive");
  const probeWei = 3_000_000_000_000_000n;
  const probe = await quoteEthToUsdc(provider, probeWei, options);
  const targetDepositWei = (probeWei * targetMicros + probe.amountOut - 1n) / probe.amountOut;
  return quoteDepositPlan(provider, targetDepositWei, options);
}

module.exports = {
  BASE_CHAIN_ID,
  BASE_PUBLIC_RPCS,
  BASE_UNISWAP_QUOTER_V2,
  BASE_UNISWAP_SWAP_ROUTER_02,
  BASE_USDC,
  BASE_WETH,
  FEE_TIERS,
  createBaseProvider,
  quoteDepositPlan,
  quoteEthToUsdc,
  quoteUsdDepositTarget,
  rpcUrlsFromEnv,
  splitDepositWei,
};
