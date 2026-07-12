# Contract security review - 2026-07-12

Scope: the eight production contracts under `versus/contracts/core` and `versus/contracts/launch`, deployment wiring, frozen Base dependencies, and exact-floor lifecycle tests.

This is a dedicated internal review, not an independent third-party audit. An external review remains required before unrestricted public hatch.

## Methods

- Manual authorization, accounting, reentrancy, lifecycle, narrowing-cast, and ownerless-bootstrap review.
- Slither 0.11.5 over a clean Hardhat build, with OpenZeppelin and local Uniswap mocks filtered during triage.
- Full repository tests plus a new exact `$1,000` production-configuration rehearsal.
- A disposable Anvil fork of Base mainnet using canonical USDC and the deployed Uniswap V2 factory/router.
- `npm audit --omit=dev` for production contract-package dependencies.
- Read-only Base RPC validation of chain ID, bytecode, router factory, router WETH, and Safe configuration.

## Fixed findings

### Critical: dead Base factory constant

The recorded factory `0x8909...8eC70f` had no bytecode and did not match the configured router. The router's onchain `factory()` and Uniswap's deployment record identify `0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6`. The constant and freeze record were corrected before mainnet deployment, and `npm run preflight:base` now fails on any future mismatch.

### Defensive: vault narrowing

`AgentNFT` previously narrowed credits into `uint128` storage without an explicit pre-transfer bound. Canonical USDC cannot realistically approach that range, but the invariant is now enforced by `VaultOverflow` before funds move.

### Defensive: graduation external calls

Graduation and tax-harvest entrypoints now use `ReentrancyGuard`. Class-token transfers and approvals use `SafeERC20`. The synchronous sell callback remains intentional and can call only the immutable graduation collector.

### Defensive: Arena safe-mint callback

`AgentNFT._safeMint` invokes contract recipients before `Arena.hatch` finishes writing the new Cypher's runway. A recipient could previously re-enter `replenishRunway` during that callback, after which the outer hatch overwrote the per-Cypher runway while leaving `totalRunwayLiability` inflated. Every external Arena runway mutation now shares one `ReentrancyGuard`. A hostile ERC-721 receiver regression test attempts the exact callback, permits the hatch to finish after the blocked call, and verifies that Arena custody, per-Cypher runway, and total liability remain equal.

### Continuous referral pool

`ReferralPool` has no owner, withdrawal, reward setter, or arbitrary recipient. One-shot wiring admits only Arena for referral recording and fixed runway funding. Manual deposits require current ownership of the declared sponsor Cypher. Referral accounting cannot block hatching: Arena catches rejected or unexpectedly failing referral calls, and a valid attribution records with a zero payout when the pool is underfunded. Rewards move only into the existing referrer NFT vault. Arena separately fixes autonomous funding at one penny per Cypher per UTC day and awards no class ticket for it. Tests cover final-reward races, unpaid attribution, same-wallet rejection without hatch failure, exact custody and payout accounting, manual funding authorization, daily nullification, and transfer-independent vault ownership.

### Defensive: client-selectable species

The desktop originally submitted a locally selected `cypherId`, so a modified client could choose any valid species. `Arena.hatch` now accepts runway only and derives the species on-chain from Base's inherited Ethereum `prevrandao` plus owner, next NFT ID, block, chain, and contract context. The confirmed `Hatched` event is the desktop's source of truth. `AgentNFT` independently rejects IDs outside the immutable 29-species collection.

### Protocol correction: staggered 24-hour commitments

The original equality check against `block.timestamp / 1 days` concentrated eligible automatic commits around UTC midnight. `Arena` now initializes a per-Cypher `nextCommitAt` at hatch, rejects early commits, and advances it to 24 hours after each confirmed commit. The timestamp is written before token and accounting calls but remains atomic with their reverts. Offline Cyphers receive no backlog allowance. `AgentNFT` receives only Arena's deterministic indication of whether a complete cadence was missed, so ordinary scheduler delay does not reset a streak while a full missed window does. Unit and production-configuration tests cover early rejection, staggered hatches, skipped backlog, streak reset, the public getter, and the exact next timestamp.

## Base fork rehearsal

The one-command `npm run test:base-fork` rehearsal passed with the continuous referral pool against Base block `48,552,393`. It independently re-read the deployment, dependency, bytecode, metadata, bootstrap, economic, referral, and Safe-policy invariants; deployed the full ownerless stack locally; manually funded the pool through canonical Base USDC; completed a referred hatch and immediate `$1` NFT-vault reward; then completed a second referred hatch after depletion with durable attribution and zero reward; verified immutable metadata and rolling cadence; replenished runway; committed daily rain and typed signal ink; filled the exact `1_000_000_000` USDC floor; created the canonical V2 pair; completed taxed buy and sell paths; credited and claimed rolling rewards; withdrew the NFT vault; transferred the NFT; and confirmed the former owner lost withdrawal authority. No mainnet state or funds were changed. The machine-readable evidence is `research/base-fork-runs/2026-07-12T22-08-53-915Z/report.json`.

## Triaged findings

- Per-Cypher `nextCommitAt` cooldowns, UTC voice-day receipts, and escrow timestamps are protocol rules, not randomness or price oracles.
- Treasury divide-then-multiply is deliberate fixed-point allocation; `rewardRemainder` preserves truncation dust.
- Ignored `ownerOf` return values are existence checks that revert for nonexistent NFTs.
- Bootstrap deployer addresses remain visible but have no callable privilege after each one-shot bootstrap flag is sealed. There is no separate ownership-renunciation transaction because no ongoing owner role exists.
- LP tokens remain held permanently by the ownerless `GraduationModule`; there is no withdrawal path.
- The zero-minimum tax swap is an accepted economic decision. Failure is caught by `ClassToken` and cannot block the user's sell.

## Remaining release blockers

- The intended protocol Safe is currently one owner with threshold one. Closed-cohort preflight accepts a valid Safe with a published hardening warning; unrestricted-public preflight requires at least three owners and threshold two.
- No Versus contracts are deployed on Base, so production addresses, verified source links, bytecode matches, and `deployments/base.json` do not yet exist.
- Obtain an independent external contract review before unrestricted public hatch.
