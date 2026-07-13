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
| Singleton | `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762` (frozen Safe L2 singleton) |
| Modules / guard | No enabled modules; zero guard |
| Fallback handler | `0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99` (frozen CompatibilityFallbackHandler) |
| Base mainnet check (2026-07-11) | **Confirmed contract** — Safe `getOwners()` succeeds |

The address is frozen in `versus/scripts/lib/constants.js`. `PROTOCOL_RECIPIENT` may be omitted at deploy time; if supplied for operator visibility, it must match this address exactly. Manifest validation and independent audit compare the deployed Treasury recipient back to the same constant.

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
| Rolling 24-hour commit | 1 penny (`10_000`) |
| Referral reward | $1 USDC (`1_000_000`) per valid referred hatch while funded |
| Autonomous referral funding | Exactly 1 penny per Cypher per UTC day, owner-disabled by default |
| Signal ink prices | 1 / 2 / 3 / 5 pennies by type |
| Admin after bootstrap | None |
| NFT metadata root | `ipfs://bafybeicbtgrjvljtdjgjua6n6vteayl5micu222mbw5ifessrx63xpuyzy/` |

The metadata root is compiled into `AgentNFT`; there is no URI administrator. The corresponding animated image root is `bafybeicngwx5b64pbr2ot4dh7bfbzvoyjlphdi6s7up7fllvpkk7anhmmm`. Both roots are reproducible from the checked source assets, were independently ingested by Lighthouse, are publicly pinned and verified through Pinata, and are recorded with per-file SHA-256 hashes in `deployments/ipfs/cypher-nfts.json`. `scripts/arweave/upload-cypher-nfts.js` also regenerates provider-independent CAR recovery artifacts under ignored `tmp/ipfs-publish/`; publish those CARs with the release artifacts so another provider can restore the exact roots.

## Base mainnet dependencies (confirm at deploy)

| Dependency | Address |
|---|---|
| Chain ID | `8453` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Uniswap V2 factory | `0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6` |
| Uniswap V2 router | `0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24` |

Source of truth for dependency addresses: `versus/scripts/lib/constants.js`. `deploy:base` rejects every mismatching environment override, runs the canonical dependency/Safe preflight internally before its first transaction, and records only the frozen addresses. Manifest validation and independent post-deploy audit compare back to the same constants. Re-verify on Basescan immediately before deployment.

Onchain recheck on 2026-07-12 confirmed that the configured router's `factory()` returns this address, the factory and router both contain bytecode, and `WETH()` is Base WETH `0x4200000000000000000000000000000000000006`. The previously recorded factory ending in `...b28eC70f` contained no bytecode and was removed before deployment.

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
VERSUS_RELEASE_STAGE=closed-cohort
```

`PROTOCOL_RECIPIENT` is optional and shown only as an explicit cross-check; any different value aborts before deployment.

Do **not** set `USE_MOCK_USDC` on mainnet.

## Still not done (do not skip)

1. Deploy + verify + independently audit + publish the four Base deployment evidence files listed in `versus/DEPLOY.md`
2. After the first mainnet mint, submit both existing CIDs to NFT.Storage/Filecoin and record confirmed storage deals; a Pinata pin and empty Lighthouse deal list are not permanent-storage proof
3. Publish the two generated CAR files with immutable release artifacts
4. Closed cohort before unrestricted public hatch

## Related

- Ethos: `MISSION.md`
- Deploy checklist: `versus/DEPLOY.md`
- Living gates: `ROLLING.md`
