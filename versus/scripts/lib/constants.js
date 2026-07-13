/**
 * Versus production constants (Base).
 * Every immutable Base production address is frozen here and reviewed in source.
 */
module.exports = {
  // $1000 USDC (6 decimals)
  GRADUATION_FLOOR: 1_000_000_000n,
  REFERRAL_REWARD: 1_000_000n, // $1 USDC for each atomically referred funded hatch
  PROTOCOL_TRANCHE_BPS: 1000, // 10% — mirrored in TrancheTreasury.sol
  PENNY: 10_000n,

  // Base mainnet
  base: {
    chainId: 8453,
    weth: "0x4200000000000000000000000000000000000006",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    protocolRecipient: "0x93645ce5BCF0009026D8100aea5901cDd52217bF",
    // Safe L2 singleton (1.4.1) currently backing the protocol recipient proxy on Base.
    safeSingleton: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
    // Canonical CompatibilityFallbackHandler currently configured on the protocol Safe.
    safeFallbackHandler: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99",
    // Canonical Uniswap V2 factory/router deployed on Base.
    // For local tests we deploy MockUniswapV2* instead.
    uniswapV2Factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
    uniswapV2Router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
  },

  // Base Sepolia — prefer MockUSDC unless you have test USDC
  baseSepolia: {
    chainId: 84532,
    // Circle test USDC on Base Sepolia (may change — override via env if needed)
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    // Often easier to USE_MOCK_USDC=true on sepolia
    uniswapV2Factory: null,
    uniswapV2Router: null,
  },
};
