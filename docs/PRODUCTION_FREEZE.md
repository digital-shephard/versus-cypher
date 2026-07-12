# Versus production freeze

Status: **parameters frozen for intended Base mainnet deploy**
Frozen: 2026-07-11
This is the deploy intent record. It does **not** mean mainnet is live.

## PROTOCOL_RECIPIENT (immutable)

| Field | Value |
|---|---|
| Address | `0x93645ce5BCF0009026D8100aea5901cDd52217bF` |
| Kind | Safe vault on Base mainnet (8453) |
| Role | Receives **10%** of every finalized tranche forever |
| Controllers | Safe owners (intended: 3 separately stored keys; on-chain check 2026-07-11 showed **1** owner so far) |
| Base mainnet check (2026-07-11) | **Confirmed contract** — Safe `getOwners()` succeeds |

Versus cannot change this address after deploy. Distribution logic later (splitter, payouts to other addresses) must be done **through** this Safe, not by retargeting Versus.

Superseded candidate (do not use): `0x3281F83eb931fe5b35Aa7385Fd91b261fC1Bf767` (EOA / no Base Safe code).

## Immutable economics (already in contracts)

| Parameter | Value |
|---|---|
| Graduation floor | $1,000 USDC (`1_000_000_000`) |
| Protocol tranche cut | 10% (`PROTOCOL_TRANCHE_BPS = 1000`) |
| Seed fund | None |
| Class token tax | 1% buy/sell |
| Minimum hatch runway | $7 USDC (`7_000_000`) |
| Daily commit | 1 penny (`10_000`) |
| Signal ink prices | 1 / 2 / 3 / 5 pennies by type |
| Admin after bootstrap | None |

## Base mainnet dependencies (confirm at deploy)

| Dependency | Address |
|---|---|
| Chain ID | `8453` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Uniswap V2 factory | `0x8909Dc15e40173Ff4699343b9eB28605b28eC70f` |
| Uniswap V2 router | `0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24` |

Source of truth for dependency addresses: `versus/scripts/lib/constants.js`. Re-verify on Basescan immediately before `deploy:base`.

## Deployer

- Separate hot deployer key (not one of the Safe owners if avoidable).
- Used only for contract create + one-shot `bootstrap`.
- Holds **no** Versus admin after bootstrap.
- Set in `versus/.env` as `PRIVATE_KEY` only at deploy time; never commit.

## Env at mainnet deploy

```text
PROTOCOL_RECIPIENT=0x93645ce5BCF0009026D8100aea5901cDd52217bF
PRIVATE_KEY=<deployer>
BASE_RPC_URL=https://mainnet.base.org
```

Do **not** set `USE_MOCK_USDC` on mainnet.

## Still not done (do not skip)

1. Dedicated contract/security review
2. Full-floor mainnet-config rehearsal (not Sepolia $1 mocks)
3. Deploy + verify + publish `deployments/base.json`
4. Closed cohort before unrestricted public hatch

## Related

- Ethos: `MISSION.md`
- Deploy checklist: `versus/DEPLOY.md`
- Living gates: `ROLLING.md`
