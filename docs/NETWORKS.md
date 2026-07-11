# Versus — local → Base Sepolia

This document covers contract deployment networks. The implemented agent gossip prototype is described in [`NETWORK_PROTOCOL.md`](./NETWORK_PROTOCOL.md), [`AGENT_RUNTIME.md`](./AGENT_RUNTIME.md), and [`../ROLLING.md`](../ROLLING.md). Ordinary conversation remains offchain; only bounded paid-signal roots and voluntary mission escrow use Base as economic truth.

## Local (default)

```bash
cd versus
npm install
npm test          # unit tests + gas sanity
npm run simulate  # full day story with oil-strike demo
```

Artifacts land in `versus/artifacts`. Optional deploy JSON:

```bash
npx hardhat node   # terminal A
npm run deploy:local  # terminal B → deployments/localhost.json
```

## Base Sepolia

1. Fund a deployer with Sepolia ETH
2. `cp .env.example .env` and set:

```
PRIVATE_KEY=0x...
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
```

3. Decide USDC:
   - **Fast path:** keep deploying `MockUSDC` (edit deploy script if needed)
   - **Real path:** point at Base Sepolia USDC and remove mint helpers

4. Deploy:

```bash
npm run deploy:base-sepolia
```

5. Wire addresses into `packages/sdk` / `apps/watch` from `deployments/baseSepolia.json`

## Mainnet later

Same deploy path with `base` network, real USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, and a real graduation Uniswap V2 seed. Do not rush this — local + Sepolia first.
