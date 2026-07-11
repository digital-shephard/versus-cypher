/**
 * Versus production constants (Base).
 * PROTOCOL_RECIPIENT is NEVER hardcoded — must come from env at deploy time.
 */
module.exports = {
  // $1000 USDC (6 decimals)
  GRADUATION_FLOOR: 1_000_000_000n,
  PROTOCOL_TRANCHE_BPS: 1000, // 10% — mirrored in TrancheTreasury.sol
  PENNY: 10_000n,

  // Base mainnet
  base: {
    chainId: 8453,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    // Uniswap V2-style router on Base (Aerodrome/Uniswap — confirm before mainnet)
    // Default: Uniswap V2 router02 is not native on Base the same way; we use the
    // canonical Base Uniswap V2 fork addresses when graduating IRL.
    // For local/mock we deploy MockUniswapV2*.
    // Base Uniswap V2 factory/router (Uniswap deployed V2 on Base):
    uniswapV2Factory: "0x8909Dc15e40173Ff4699343b9eB28605b28eC70f",
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
