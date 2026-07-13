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

1. Verify the frozen immutable `PROTOCOL_RECIPIENT` Safe in `scripts/lib/constants.js` and `docs/PRODUCTION_FREEZE.md`. Base deployment rejects a different environment value and fails if the Safe has no bytecode or violates the selected threshold policy.
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

Base mainnet refuses mock USDC, any graduation-floor override, and any USDC/router/factory/protocol-recipient environment value that differs from `scripts/lib/constants.js`. The deploy script resolves only the frozen canonical dependencies and Safe, then asserts the exact `1_000_000_000` floor.

The Base deploy command runs the read-only production preflight internally before its first transaction. Run it separately as an operator preview; it validates Base chain ID, canonical dependency bytecode, router bindings, USDC decimals, and the protocol Safe owner threshold:

```powershell
$env:VERSUS_RELEASE_STAGE = "closed-cohort"
npm run preflight:base
```

`closed-cohort` accepts a valid Safe and publishes a warning until it is at least 2-of-3. `unrestricted-public` fails closed unless the Safe has at least three owners and threshold two. Base deploys also fail before transaction signing unless the repository is clean, the source commit is a full 40-character Git commit, every configured production dependency equals its frozen canonical address, the protocol Safe singleton/modules/guard/fallback match the freeze, and freshly compiled creation bytecode matches `deployments/base-build-freeze.json`.

Regenerate the freeze only after intentional contract changes:

```powershell
npm run freeze:base-build
```

Run public Base deployment from a clean isolated worktree populated with `npm ci --ignore-scripts` from the committed lockfile so ignored `node_modules` and stale artifacts cannot diverge from the reviewed freeze.

The contract E2E suite imports the sibling network and desktop chain services. Populate all three pinned dependency trees in that clean worktree before running the final suite:

```powershell
cd packages/network
npm ci --ignore-scripts
cd ../../apps/pet
npm ci --ignore-scripts
cd ../../versus
npm ci --ignore-scripts
git submodule update --init --recursive
```

Run the disposable Base mainnet fork rehearsal through Docker and Anvil. It uses canonical Base state but spends no real funds:

```powershell
npm run test:base-fork
```

After deployment, commit `deployments/base.json`. It conforms to `deployments/schema-v2.json` and records the exact commit, clean-source hash inventory, compiler settings, compiler-input fingerprint, creation-bytecode freeze hashes, constructor arguments, transaction receipts, deployment block range, and runtime bytecode hashes. Then publish source through Basescan:

```powershell
$env:VERSUS_DEPLOYMENT = "deployments/base.json"
npm run verify:base
```

Finally, audit the deployment through a second Base RPC. This independently reads every binding, bootstrap seal, frozen economic constant, router dependency, Safe policy, and runtime bytecode hash, then writes the publishable evidence files `base-verification.json` and `base-ownerless-summary.md`:

```powershell
$env:BASE_AUDIT_RPC_URL = "<independent Base RPC>"
npm run audit:base
```

Publish together:

- `deployments/base.json`
- `deployments/base-source-verification.json`
- `deployments/base-verification.json`
- `deployments/base-ownerless-summary.md`

## Post-deploy invariants

- `treasury.protocolRecipient()` is the intended immutable recipient.
- `treasury.PROTOCOL_TRANCHE_BPS()` is `1000`.
- `syndicate.graduationFloor()` is `1000000000`.
- `arena.MIN_RUNWAY()` is `7000000`.
- `referralPool.rewardPerReferral()` is `1000000` and its one-shot Arena bootstrap is sealed.
- Arena USDC balance is at least `totalRunwayLiability()` and `runwaySolvent()` is true.
- A successful commit sets `committedDays(agentId, currentDay())`, schedules `nextCommitAt(agentId)` for 24 hours after the confirmed block, and decrements runway by `10000`.
- AgentNFT reward vault is unchanged by runway spending.
- Every Arena, AgentNFT, Syndicate, Treasury, Graduation, MissionEscrow, and ReferralPool link matches the deployment; all one-shot bootstrap flags are true.
- Graduation router/factory wiring and `PENNY`, `MIN_RUNWAY`, tranche BPS, and total BPS match the frozen values.
- No core contract exposes an owner, pause, rescue sweep, or upgrade path.

Bug response is a new opt-in deployment, not a kill switch.
