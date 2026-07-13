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

### Defensive: bounded graduated-token conversion

Graduation and sell-triggered conversion use `ReentrancyGuard`. Class-token transfers and approvals use `SafeERC20`. The synchronous sell callback remains intentional and can call only the immutable graduation collector. A sell may convert at most twice its own tax, which clears that tax plus one matching slice of banked buy tax. Conversion uses a nonzero 99% same-transaction quote floor; the permissionless full-bank `harvestTax` entrypoint was removed. Failed conversion cannot block the seller and remains banked for later proportional clearing.

### Defensive: canonical Base deployment dependencies

`deploy:base` now resolves Circle USDC, the official Uniswap V2 factory/router, and the immutable protocol-recipient Safe only from frozen constants. Mismatching environment values and mock flags fail before the first deployment transaction. The deploy command invokes the same chain, bytecode, router binding, WETH, USDC-decimals, recipient, and Safe-policy preflight as the standalone operator check. Base manifest validation and independent post-deploy audit compare all four addresses to those constants instead of trusting internally consistent manifest substitutions.

### Defensive: Treasury fee custody

The unused Arena-only `receiveFee(amount)` path accounted revenue without pulling matching USDC. The deployed Arena had no caller for it, so it was not reachable by users or exploitable in the immutable wiring, but it was unnecessary dangerous surface. It and the stale Arena interface declaration were removed. `depositFees(amount)`, which atomically pulls USDC before allocation, is now the only fee-ingress path.

### High: Treasury fractional-reward solvency

`TrancheTreasury._indexRewards` previously represented fractional ticket entitlement in `accRewardPerTicket` and also reintroduced its apparent whole-unit difference through `rewardRemainder`. Repeated one-unit deposits across three tickets could therefore make aggregate claimable rewards exceed `tranchePot`, allowing early claims while later claims reverted on underflow. `rewardRemainder` is now reserved exclusively for real fees received before the first ticket; ordinary indexed fees are never counted twice. A reproduced micro-deposit regression checks every deposit and multiple claim orders against both accounting and physical USDC custody.

### Medium: post-mint referral ownership

An ERC-721 receiver can transfer a freshly safe-minted Cypher during `onERC721Received`. Arena previously passed the original hatching caller to ReferralPool after that callback, allowing the final owner of both NFTs to evade the same-wallet referral rejection. Arena now re-reads `ownerOf(agentId)` after mint returns and settles referral eligibility against the NFT's current owner. A hostile receiver regression performs the callback transfer and confirms hatching succeeds without an attribution or payout.

The same callback previously left `Hatched.owner` reporting the original caller even when the NFT had already moved. The event now emits that same post-mint `ownerOf(agentId)` value. Indexers and the desktop still reconcile `ownerOf` as canonical state, while the event no longer publishes a contradictory owner.

### Defensive: removed vault pull surface

`AgentNFT.pullFromVault` was callable only by the one-shot-wired Arena, whose immutable bytecode contained no call to it. It was therefore unreachable rather than exploitable, but it remained unnecessary money-moving surface. The function has been removed and its absence is enforced by a contract-interface regression.

### Defensive: bootstrap activation ordering

AgentNFT bootstrap is now the final activation transaction. SyndicateEngine, TrancheTreasury, and ReferralPool are sealed first, so Arena cannot mint during a partially wired deployment window. The stepwise regression proves hatching remains disabled until every dependency is ready and that the first underfunded referred hatch still records its durable attribution.

### High: compiler-input and deployment-evidence binding

Base deployment now performs a clean forced compile and rejects any creation bytecode or compiler-input fingerprint that differs from the committed `deployments/base-build-freeze.json`. The freeze records every imported Solidity source hash, including OpenZeppelin, and every production creation-bytecode hash. Manifest v2 requires a complete sorted source inventory, exact contract/runtime/build key sets, runtime addresses bound to contract addresses, canonical Base dependencies, and the committed build fingerprint. The independent audit compares the manifest source inventory to the local reviewed tree instead of trusting self-consistent manifest substitutions. Schema v2 is executable through AJV and covered alongside the semantic validator.

The immutable Safe check now reads proxy slot zero, the complete module page, guard storage, and fallback-handler storage in addition to owners and threshold. It freezes the Safe L2 singleton `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762`, requires no modules and no guard, and requires the canonical CompatibilityFallbackHandler `0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99` already configured on the recipient Safe.

### Defensive: Arena safe-mint callback

`AgentNFT._safeMint` invokes contract recipients before `Arena.hatch` finishes writing the new Cypher's runway. A recipient could previously re-enter `replenishRunway` during that callback, after which the outer hatch overwrote the per-Cypher runway while leaving `totalRunwayLiability` inflated. Every external Arena runway mutation now shares one `ReentrancyGuard`. A hostile ERC-721 receiver regression test attempts the exact callback, permits the hatch to finish after the blocked call, and verifies that Arena custody, per-Cypher runway, and total liability remain equal.

### Continuous referral pool

`ReferralPool` has no owner, withdrawal, reward setter, or arbitrary recipient. One-shot wiring admits only Arena for referral recording and fixed runway funding. Manual deposits require current ownership of the declared sponsor Cypher. Referral accounting cannot block hatching: Arena catches rejected or unexpectedly failing referral calls, and a valid attribution records with a zero payout when the pool is underfunded. Rewards move only into the existing referrer NFT vault. Arena separately fixes autonomous funding at one penny per Cypher per UTC day and awards no class ticket for it. Tests cover final-reward races, unpaid attribution, same-wallet rejection without hatch failure, exact custody and payout accounting, manual funding authorization, daily nullification, and transfer-independent vault ownership.

### Defensive: client-selectable species

The desktop originally submitted a locally selected `cypherId`, so a modified client could choose any valid species. `Arena.hatch` now accepts runway only and derives the species on-chain from Base's inherited Ethereum `prevrandao` plus owner, next NFT ID, block, chain, and contract context. The confirmed `Hatched` event is the desktop's source of truth. `AgentNFT` independently rejects IDs outside the immutable 29-species collection.

### Protocol correction: staggered 24-hour commitments

The original equality check against `block.timestamp / 1 days` concentrated eligible automatic commits around UTC midnight. `Arena` now initializes a per-Cypher `nextCommitAt` at hatch, rejects early commits, and advances it to 24 hours after each confirmed commit. The timestamp is written before token and accounting calls but remains atomic with their reverts. Offline Cyphers receive no backlog allowance. `AgentNFT` receives only Arena's deterministic indication of whether a complete cadence was missed, so ordinary scheduler delay does not reset a streak while a full missed window does. Unit and production-configuration tests cover early rejection, staggered hatches, skipped backlog, streak reset, the public getter, and the exact next timestamp.

## Base fork rehearsal

The one-command `npm run test:base-fork` rehearsal passed with the final reviewed bytecode against Base block `48,560,000`. It ran the integrated production preflight, independently re-read 70 deployment, dependency, bytecode, metadata, bootstrap, economic, referral, recipient, Safe-configuration, and manifest-binding invariants, and deployed the full ownerless stack locally. It manually funded the pool through canonical Base USDC; completed funded and underfunded referral paths; verified immutable metadata and rolling cadence; replenished runway; committed daily rain and typed signal ink; filled the exact `1_000_000_000` USDC floor; precreated the predicted canonical V2 pair; donated one micro-USDC; proved pre-token `sync()` reverted with zero reserves; and then graduated successfully with `1_000_000_001` USDC locked in the pair. A real-router buy banked `49,357,901,670,982,403,763,495` token units; a deliberately small sell authorized and converted exactly its `977,286,453,085,451,594,516` two-tax cap while leaving `48,869,258,444,439,677,966,237` banked. The run then credited and claimed rolling rewards, withdrew the NFT vault, transferred the NFT, and confirmed the former owner lost withdrawal authority. No mainnet state or funds were changed. The machine-readable evidence is `research/base-fork-runs/2026-07-13T02-22-28-241Z/report.json`.

## Triaged findings

- Per-Cypher `nextCommitAt` cooldowns, UTC voice-day receipts, and escrow timestamps are protocol rules, not randomness or price oracles.
- Treasury fixed-point division is deliberate; sub-precision dust remains excess custody, while `rewardRemainder` represents only real fees received before the first ticket.
- Ignored `ownerOf` return values are existence checks that revert for nonexistent NFTs.
- Bootstrap deployer addresses remain visible but have no callable privilege after each one-shot bootstrap flag is sealed. There is no separate ownership-renunciation transaction because no ongoing owner role exists.
- LP tokens remain held permanently by the ownerless `GraduationModule`; there is no withdrawal path.
- Predicted-pair graduation DoS is not viable. Uniswap V2 `sync()` queries both token balances; before the predicted `ClassToken` exists, its `balanceOf` call returns no ABI data and `sync()` reverts. The attacker can pre-create the pair and donate unsynchronized USDC, but reserves remain zero and graduation treats the donation as additional locked liquidity. Unit and canonical Base-fork regressions execute this exact sequence.
- Spot quotes remain observable and manipulable, but there is no callable full-bank sale: each conversion is bounded to twice the triggering sell tax and uses a nonzero same-transaction floor. An attacker must supply proportional real sell volume, pay token tax and pool fees, and absorb market impact to expose additional banked tax. The Base-fork regression records the enforced cap.
- Temporary referrer-NFT custody is accepted Sybil behavior, not identity proof. One operator can park a referrer Cypher on another wallet during hatch and later return it, but doing so locks at least `$7` of new runway to receive the fixed `$1` referral reward. Ownership-duration rules would add transfer friction while remaining bypassable through older prepared wallets.
- Direct token transfer to the canonical pair followed by `skim()` is treated as pair flow by design. The inbound transfer and outbound skim are both taxed; the caller cannot withdraw LP, collector tokens, or treasury USDC. Tax conversion remains bounded by the newly paid inbound tax and the caller sacrifices token inventory while creating protocol revenue.
- Tickets become active in transaction order. A participant may buy penny tickets before a visible tax-fee transaction and share that future deposit, but cannot claim fees indexed before those tickets exist. Delayed ticket maturity would require a materially different epoch accounting model and is not part of the immutable v1 economics.
- Graduation is an atomic class boundary. Class-bound signal settlement reverts without spending runway when its declared class has closed; the desktop releases the failed batch, shows `CLASS OVER`, and reconciles the ceremony. Daily and manual rain intentionally follow the currently open class. Their canonical class pot and unique-participant count come from `SyndicateEngine`, not Waku timing.
- Underfunded referral attribution is deliberately not an IOU. The hatch succeeds, the immutable edge records, payout is skipped, and later pool funding does not retroactively create a liability.
- The initial `$1,000` Uniswap V2 pool is economically thin and MEV-soft. Locked LP and tax/tranche custody remain intact; this is accepted launch-market behavior rather than an authorization guarantee.

## Remaining release blockers

- The intended protocol Safe is currently one owner with threshold one. Closed-cohort preflight accepts a valid Safe with a published hardening warning; unrestricted-public preflight requires at least three owners and threshold two.
- No Versus contracts are deployed on Base, so production addresses, verified source links, bytecode matches, and `deployments/base.json` do not yet exist.
- Obtain an independent external contract review before unrestricted public hatch.
