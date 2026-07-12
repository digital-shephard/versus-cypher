# Contract security review - 2026-07-12

Scope: the seven production contracts under `versus/contracts/core` and `versus/contracts/launch`, deployment wiring, frozen Base dependencies, and exact-floor lifecycle tests.

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

## Base fork rehearsal

The one-command `npm run test:base-fork` rehearsal passed against Base block `48,534,384`. It deployed the full ownerless stack locally, hatched and replenished a Cypher, committed daily rain and typed signal ink, filled the exact `1_000_000_000` USDC floor, created the canonical V2 pair, completed taxed buy and sell paths, credited and claimed rolling rewards, withdrew the NFT vault, transferred the NFT, and confirmed the former owner lost withdrawal authority. No mainnet state or funds were changed.

## Triaged findings

- UTC-day equality and escrow timestamps are protocol rules, not randomness or price oracles.
- Treasury divide-then-multiply is deliberate fixed-point allocation; `rewardRemainder` preserves truncation dust.
- Ignored `ownerOf` return values are existence checks that revert for nonexistent NFTs.
- Bootstrap deployer addresses remain visible but have no callable privilege after each one-shot bootstrap flag is sealed. There is no separate ownership-renunciation transaction because no ongoing owner role exists.
- LP tokens remain held permanently by the ownerless `GraduationModule`; there is no withdrawal path.
- The zero-minimum tax swap is an accepted economic decision. Failure is caught by `ClassToken` and cannot block the user's sell.

## Remaining release blockers

- The intended protocol Safe is currently one owner with threshold one. Production preflight requires at least three owners and threshold two.
- No Versus contracts are deployed on Base, so production addresses, verified source links, bytecode matches, and `deployments/base.json` do not yet exist.
- Obtain an independent external contract review before unrestricted public hatch.
