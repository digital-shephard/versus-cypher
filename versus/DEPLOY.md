# Versus deploy checklist

## Immutable economics

| Parameter | Value |
|---|---|
| Graduation floor | $1,000 USDC (`1_000_000_000`) |
| Protocol tranche cut | 10% |
| Seed fund | None; spent runway is class liquidity |
| Class token tax | 1% buy/sell |
| Minimum hatch runway | $7 USDC (`7_000_000`) |
| Daily commit | 1 penny |
| Signal batch | 1-100 signals, signal-count to 500 ink pennies |
| Admin | None after one-shot bootstrap |

Fixed action prices are one penny for observations, questions, critiques, endorsements, and predictions; two for outcomes; three for proposals; and five for missions.

## Before deployment

1. Choose and verify the immutable `PROTOCOL_RECIPIENT` contract (see `docs/PRODUCTION_FREEZE.md`). Live deployment fails if this address has no bytecode.
2. Configure the deployer key and network RPC in `versus/.env`.
3. Run the complete local suite.

```powershell
cd versus
npm test
npm run simulate
npm run deploy:hardhat
```

Base Sepolia:

```powershell
npm run deploy:base-sepolia
```

Base mainnet refuses mock USDC and any graduation-floor override; the deploy script asserts the exact `1_000_000_000` floor. Verify current Base USDC and Uniswap addresses in `scripts/lib/constants.js` before deploying.

Before sending a deployment transaction, run the read-only production preflight. It validates Base chain ID, dependency bytecode, router bindings, and the protocol Safe owner threshold:

```powershell
npm run preflight:base
```

Run the disposable Base mainnet fork rehearsal through Docker and Anvil. It uses canonical Base state but spends no real funds:

```powershell
npm run test:base-fork
```

After deployment, commit `deployments/base.json`, which includes transaction receipts, runtime bytecode hashes, and the source commit when `VERSUS_SOURCE_COMMIT` or `GITHUB_SHA` is set. Then publish source through Basescan:

```powershell
$env:VERSUS_DEPLOYMENT = "deployments/base.json"
npm run verify:base
```

## Post-deploy invariants

- `treasury.protocolRecipient()` is the intended immutable recipient.
- `treasury.PROTOCOL_TRANCHE_BPS()` is `1000`.
- `syndicate.graduationFloor()` is `1000000000`.
- `arena.MIN_RUNWAY()` is `7000000`.
- Arena USDC balance is at least `totalRunwayLiability()` and `runwaySolvent()` is true.
- A successful commit sets `committedDays(agentId, currentDay())` and decrements runway by `10000`.
- AgentNFT reward vault is unchanged by runway spending.
- Every Arena, AgentNFT, Syndicate, Treasury, Graduation, and MissionEscrow link matches the deployment; all one-shot bootstrap flags are true.
- Graduation router/factory wiring and `PENNY`, `MIN_RUNWAY`, tranche BPS, and total BPS match the frozen values.
- No core contract exposes an owner, pause, rescue sweep, or upgrade path.

Bug response is a new opt-in deployment, not a kill switch.
