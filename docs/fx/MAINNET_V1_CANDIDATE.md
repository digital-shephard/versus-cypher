# Agentic FX mainnet-v1 candidate

Status: **not deployed**. This document freezes the candidate market and the acceptance path. It does not authorize a mainnet transaction.

## Product name versus contract version

The public product release may be called **Agentic FX v1**. The reviewed settlement contracts remain `EvmNativeHtlcV3` and `EvmHtlcV3`; renaming audited bytecode to make the internal version look cleaner would create needless review risk.

## Frozen market

| Chain | Chain ID | Native inventory | Stable inventory |
| --- | ---: | --- | --- |
| Base | 8453 | ETH | USDC, EURC |
| Avalanche C-Chain | 43114 | AVAX | USDC, EURC |

All six positions are tradeable. Every directed route except a position back to itself is supported: **30 routes total**, including **12 same-chain routes**. Native assets are available through the direct Versus swap flow. USDC and EURC may additionally be generic x402 exact inputs because their frozen contracts expose the required authorization surface.

No onchain maximum trade amount is introduced. Dealer maximum trade, requester exposure, asset exposure, total exposure, gas, and spread remain local operator policy. Actual fills remain bounded by signed requester maximum input, dealer inventory, gas economics, and contract integer limits.

## Canonical mainnet assets

| Position | Address | Decimals |
| --- | --- | ---: |
| Base ETH | native | 18 |
| Base USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | 6 |
| Base EURC | `0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42` | 6 |
| Avalanche AVAX | native | 18 |
| Avalanche USDC | `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` | 6 |
| Avalanche EURC | `0xC891EB4cbdEFf6e073e859e987815Ed1505c2ACD` | 6 |

The machine-readable freeze also binds each stablecoin runtime-code hash, EIP-712 domain separator, token name, version, decimals, and EIP-3009 probe. Sources:

- https://developers.circle.com/stablecoins/usdc-contract-addresses
- https://developers.circle.com/stablecoins/eurc-contract-addresses
- https://docs.base.org/base-chain/quickstart/connecting-to-base

## Candidate policies

- V3 minimum lock: 60 seconds
- V3 maximum lock: 604800 seconds
- Minimum cross-chain timeout delta: 3600 seconds
- Destination execution window: 3600 seconds
- Generic x402 quote lifetime: 120 seconds
- Generic x402 settlement lifetime: 7200 seconds
- Starting dealer spread: 5 bps, offchain and operator-controlled
- Starting generic facilitator fee: 1000 stablecoin atomic units (0.001 USDC or EURC)
- Base wallet native reserve: 0.00025 ETH
- Avalanche wallet native reserve: 0.05 AVAX
- Minimum displayed gas readiness: $1 per chain

The native reserves are local dealing safeguards, not contract ceilings. Operators may keep larger reserves.

## Price formation

USDC uses a one-dollar reference. EURC, ETH, and AVAX use independently
signed relay snapshots of the direct Chainlink ETH/USD and EURC/USD feeds on
Base and AVAX/USD feed on Avalanche. The quote engine caches prices per asset
and computes:

- output principal using the output asset price;
- input principal using the input asset price;
- source execution gas using the source native price;
- destination funding and claim gas using the destination native price;
- executor bounty in the actual output asset.

Each relay refreshes its oracle snapshot once per minute. Public reads use only
the signed cache and cannot trigger provider work. The desktop requires fresh
snapshots from two distinct configured relay attestors, verifies the frozen
feed identities and source timestamps, rejects prices more than 100 basis
points apart, and then uses their median. ETH and AVAX oracle rounds may be at
most two hours old; the direct EURC feed may be at most 25 hours old to
accommodate its daily heartbeat. A required price with no fresh quorum fails
closed. Mainnet remains blocked until both public relay deployments pass the
signed endpoint, disagreement, stale-oracle, and relay-failover acceptance
checks.

## Public-testnet mirror

The acceptance cohort uses Base Sepolia (84532) and Avalanche Fuji (43113), with Circle's canonical test USDC and EURC contracts. It deploys per chain:

- one native V3 HTLC;
- one USDC V3 HTLC;
- one EURC V3 HTLC;
- one USDC exact factory;
- one EURC exact factory.

Deployment is guarded by `FX_MARKET_PUBLIC_TESTNET_DEPLOY=I_UNDERSTAND_PUBLIC_TESTNET_ONLY`. The scripts reject the mainnet candidate and refuse to overwrite an existing public record. Assembly fails until both chain records are explorer verified and pass independent runtime/immutable preflight.

## Acceptance gates

1. Regenerate the V3 and exact build freezes with no diff.
2. Preflight Base Sepolia and Fuji token metadata and runtime hashes.
3. Deploy and verify all ten public-testnet contracts.
4. Assemble a fresh deployment ID and Waku coordination domain that cannot mix with the Base/Arbitrum cohort.
5. Run Base Sepolia/Fuji in both directions for native/native, native/stable, stable/native, USDC/EURC, and EURC/USDC.
6. Run same-chain Base and same-chain Fuji stable/native and stable/stable swaps.
7. Repeat with zero destination gas, restart during settlement, timeout/refund, stale-price rejection, stale-RPC rejection, and relay reconnection.
8. Run generic exact x402 inputs for USDC and EURC through both public relays.
9. Complete an adversarial review of the frozen artifacts and all deployment records.
10. Merge the reviewed branch to `main` only after testnet acceptance. Mainnet deployment happens from that reviewed merge commit, after a separate human address/hash review and explicit authorization.

## Commands

```powershell
npm run fx:market:preflight:testnet --prefix versus
npm run fx:market:preflight:mainnet --prefix versus

$env:FX_MARKET_PUBLIC_TESTNET_DEPLOY="I_UNDERSTAND_PUBLIC_TESTNET_ONLY"
npm run fx:market:deploy:base-sepolia --prefix versus
npm run fx:market:deploy:avalanche-fuji --prefix versus

$env:FX_EXPLORER_VERIFY="true"
npm run fx:market:verify:base-sepolia --prefix versus
npm run fx:market:verify:avalanche-fuji --prefix versus
npm run fx:market:assemble:testnet --prefix versus

$env:VERSUS_FX_MARKET_DEPLOYMENT=(Resolve-Path ".\versus\deployments\fx\public-testnet-v1-market-deployment.json")
$env:VERSUS_FX_DEVELOPMENT="1"
npm start --prefix apps/pet
```

The desktop refuses candidate market JSON and accepts only the assembled,
explorer-verified deployment artifact through an absolute path. No command in
this document authorizes or performs a mainnet deployment, and no mainnet
deployment script is included in this candidate.
