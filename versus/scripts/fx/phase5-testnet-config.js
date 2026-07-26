const NETWORKS = Object.freeze({
  "base-sepolia": Object.freeze({
    name: "Base Sepolia",
    chainId: "84532",
    rpcEnvironmentVariable: "BASE_SEPOLIA_RPC_URL",
    publicRpcUrl: "https://sepolia.base.org",
    explorerUrl: "https://sepolia-explorer.base.org",
    canonicalTestUsdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    minimumDeployerBalanceWei: "2000000000000000",
    roleGasGrantWei: "250000000000000",
    maximumActionFeeWei: "200000000000000",
    requiredConfirmations: 2,
    reorgSafetyBlocks: 12,
  }),
  "arbitrum-sepolia": Object.freeze({
    name: "Arbitrum Sepolia",
    chainId: "421614",
    rpcEnvironmentVariable: "ARBITRUM_SEPOLIA_RPC_URL",
    publicRpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
    explorerUrl: "https://sepolia.arbiscan.io",
    canonicalTestUsdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    minimumDeployerBalanceWei: "3000000000000000",
    roleGasGrantWei: "500000000000000",
    maximumActionFeeWei: "500000000000000",
    requiredConfirmations: 2,
    reorgSafetyBlocks: 20,
  }),
});

function phase5Network(id) {
  const network = NETWORKS[id];
  if (!network) {
    throw new Error(`FX_PHASE5_NETWORK must be one of ${Object.keys(NETWORKS).join(", ")}`);
  }
  return network;
}

module.exports = {
  NETWORKS,
  phase5Network,
};
