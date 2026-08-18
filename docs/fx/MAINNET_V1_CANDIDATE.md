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

Mainnet dependency preflight uses two pinned RPCs per chain and requires
byte-for-byte identical token metadata, runtime hashes, domain separators, and
EIP-3009 probe results from the primary and fallback. Base defaults to
`public.1rpc.io/base` and `base-mainnet.public.blastapi.io`; Avalanche defaults to its public
C-Chain RPC and PublicNode. Operators may replace each pair with comma-separated
`BASE_RPC_URLS` and `AVALANCHE_RPC_URLS`. A missing endpoint, failed call, or
divergent result blocks the preflight. The rate-limited `mainnet.base.org` and
free-plan-limited `base.drpc.org` endpoints, and PublicNode's token-gated archive
reads are intentionally not production deployment defaults.

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

The fresh mirror is deployed under deployment ID
`0x8cd9ede68d18e52213372ed6041bdb83867c5846119461c860d95f74e689ed54`
and isolated Waku coordination domain
`0x50aea8e208dd1de883d5f8b50eefe71f328b6b9aea996388d402f87ef4415ed9`.

| Chain | Native V3 | USDC V3 | USDC exact | EURC V3 | EURC exact |
| --- | --- | --- | --- | --- | --- |
| Base Sepolia | [`0xbd2695...52d4`](https://sepolia.basescan.org/address/0xbd26951157abb0b0de5c570e80dd923d5a2352d4#code) | [`0xee74f9...1670`](https://sepolia.basescan.org/address/0xee74f9b37688e501cf2fddf37c17c7ef9a6f1670#code) | [`0x0189b7...875`](https://sepolia.basescan.org/address/0x0189b743515caf47e4e0ca5d93e59b7f278f0875#code) | [`0x5c1e3c...2c86`](https://sepolia.basescan.org/address/0x5c1e3ca73084370f6ef394051a504cf466e52c86#code) | [`0xb08867...b480`](https://sepolia.basescan.org/address/0xb088673c5ac252d6dff5d10c89d8b1c341f4b480#code) |
| Avalanche Fuji | [`0xcba3d9...e01b`](https://testnet.snowtrace.io/address/0xcba3d9354dd4c30bb6961abb4473a6340486e01b#code) | [`0xe7a02d...334d`](https://testnet.snowtrace.io/address/0xe7a02dd38f9191d8ee20daa24b4feee911da334d#code) | [`0x1a4123...d9f6`](https://testnet.snowtrace.io/address/0x1a412352645e54e1527c68c926bd3a1e117fd9f6#code) | [`0x9ddb82...dff6`](https://testnet.snowtrace.io/address/0x9ddb82ee6eb48833906dec8e3196465dd5f5dff6#code) | [`0x45dabb...63b7`](https://testnet.snowtrace.io/address/0x45dabb99e841198befe3e8211b4eae08ad0163b7#code) |

The assembled artifact is
`versus/deployments/fx/public-testnet-v1-market-deployment.json`. The desktop
loads it only through an explicit absolute `VERSUS_FX_MARKET_DEPLOYMENT` path.
`npm run preflight:fx-market --prefix apps/pet` independently rechecks both
chain IDs, current RPC heads, all ten successful deployment receipts and their
deployer/block/address/gas commitments, all V3 runtime and immutable
commitments, every exact-factory runtime plus its token/HTLC wiring, the
six-position/30-route shape, domain isolation, and the two-signer
ETH/AVAX/EURC price quorum. The desktop test suite also reconstructs the
assembled artifact from the candidate, both chain records, and both build
freezes and requires an exact object match.

Automated acceptance currently passes the complete desktop and network suites,
all V3 and exact Hardhat tests, and the deep V3 and exact Foundry fuzz/invariant
profiles. The funded single-workstation live-chain cohort also passes all 30
routes, both-chain zero-gas recipients, both-chain timeout/refunds, mid-swap
restart recovery, stale-price and unavailable-RPC rejection, deterministic
relay reconnect, and four stock generic x402 exact payments covering USDC and
EURC as inputs on both chains.

Physical acceptance subsequently passed with a Windows requester and a
separate macOS dealer using both public Versus relays. All 30 unique route pairs
reached `funds_ready`; the public transport recovered from `wait` to `ready`
and `caught_up`; and four stock x402 exact payments completed with USDC and
EURC as inputs on each chain. The macOS dealer also remained armed with two
LightPush, Filter, and Store peers over an IPv6-only T-Mobile path. The
sanitized evidence and public transaction hashes are preserved in
[`PUBLIC_TESTNET_V1_PHYSICAL_ACCEPTANCE_2026-08-09.md`](./PUBLIC_TESTNET_V1_PHYSICAL_ACCEPTANCE_2026-08-09.md).

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

Gates 1-9 are complete for the public-testnet candidate. The controlled failure
matrix remains backed by the funded single-workstation live-chain cohort; its
public-relay reconnect component, the complete 30-route market, and all four
generic x402 exact inputs also passed the physical two-device campaign. The
dated review is preserved
in [`PUBLIC_TESTNET_V1_ADVERSARIAL_REVIEW_2026-08-07.md`](./PUBLIC_TESTNET_V1_ADVERSARIAL_REVIEW_2026-08-07.md).
The physical checkpoint is preserved in
[`PUBLIC_TESTNET_V1_PHYSICAL_ACCEPTANCE_2026-08-09.md`](./PUBLIC_TESTNET_V1_PHYSICAL_ACCEPTANCE_2026-08-09.md).
Neither document authorizes mainnet.

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

$env:VERSUS_FX_TESTNET_ACCEPT="I_UNDERSTAND_PUBLIC_TESTNET_ONLY"
npm run acceptance:fx-public-testnet --prefix apps/pet
npm run acceptance:fx-public-testnet --prefix apps/pet -- --x402
npm run acceptance:fx-public-testnet --prefix apps/pet -- --zero-destination-gas
npm run acceptance:fx-public-testnet --prefix apps/pet -- --restart-mid-swap
npm run acceptance:fx-public-testnet --prefix apps/pet -- --timeout-refund
npm run acceptance:fx-public-testnet --prefix apps/pet -- --stale-price
npm run acceptance:fx-public-testnet --prefix apps/pet -- --stale-rpc
npm run acceptance:fx-public-testnet --prefix apps/pet -- --relay-reconnect

$env:VERSUS_FX_MARKET_DEPLOYMENT=(Resolve-Path ".\versus\deployments\fx\public-testnet-v1-market-deployment.json")
$env:VERSUS_FX_DEVELOPMENT="1"
npm start --prefix apps/pet
```

The desktop refuses candidate market JSON and accepts only the assembled,
explorer-verified deployment artifact through an absolute path. No command in
this document authorizes or performs a mainnet deployment.

## Guarded mainnet tooling

The accepted candidate now includes deploy, explorer-verify, and assemble
tooling, but every state-changing entry point fails closed by default. Merely
running an npm command is insufficient. Deployment additionally requires:

- the exact broadcast acknowledgement
  `FX_MARKET_MAINNET_DEPLOY=I_UNDERSTAND_THIS_BROADCASTS_MAINNET`;
- the reviewed chain ID, market ID, and full 40-character source commit;
- a clean tracked worktree and index at that source commit;
- two pinned RPCs whose dependency preflights agree;
- explicit per-deployment gas, fee-per-gas, and total chain-deployment cost
  ceilings; and
- absolute paths to a separate mainnet deployer keystore and password file.

The deployer simulates each creation on both RPCs before signing, journals each
confirmed deployment, and requires both RPCs to agree on receipt block and
runtime hash before continuing. It refuses to overwrite a public chain record.
Verification has a separate acknowledgement and chain binding. Assembly has a
third acknowledgement, requires both verified chain records to name the same
reviewed commit, repeats both-RPC runtime/immutable preflight, and creates the
final artifact exclusively.

The guarded commands are:

```powershell
npm run fx:market:deploy:base --prefix versus
npm run fx:market:deploy:avalanche --prefix versus
npm run fx:market:verify:base --prefix versus
npm run fx:market:verify:avalanche --prefix versus
npm run fx:market:assemble:mainnet --prefix versus
```

These command names are documentation, not authorization. Do not set their
guards or fund a deployer until the final human address/hash review explicitly
authorizes mainnet. The tiny post-deployment canary remains a separate explicit
authorization after assembly.
