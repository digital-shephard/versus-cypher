# Phase 5: Cross-Chain EVM Testnet

Phase 5 proves the settlement core of a tiny cross-chain FX trade. It does not
enable FX in the desktop client, connect FX to production Waku, or accept
production funds.

## Frozen Scope

- Base Sepolia and Arbitrum Sepolia
- one requester, one dealer, and one permissionless transaction relayer
- test-only six-decimal ERC-20 assets deployed independently on each chain
- fixed exact-output amount of 10,000 atomic units (0.01 test tokens)
- 10-minute source timeout
- 3-minute destination timeout
- 2 confirmations per public testnet action
- direct signed discovery before broker or Waku integration

The route requires:

- `enabledByDefault: false`
- `productionWaku: false`
- `productionFunds: false`
- two distinct chain IDs
- exact chain, token, adapter, bytecode, decimal, and timeout manifest matches

## Discovery And Address Disclosure

The accepted route begins with the Phase 1 signed message sequence:

1. An RFQ advertises chains, assets, amount, deadline, and quote policy.
2. Dealer quotes contain price and cost fields but no settlement addresses.
3. The requester selects one quote and discloses its refund and claim
   addresses to that selected dealer.
4. The selected dealer reserves inventory and discloses its claim and refund
   addresses to the requester.
5. Funded lock fields become public when each transaction is broadcast.

The Phase 5 testnet runner starts after this direct selection. Phase 6 moves
discovery and coordination messages onto dedicated Waku topics. Waku never
decides whether a lock, claim, or refund is valid.

## Atomic Settlement

1. The requester creates an encrypted recovery packet containing the secret.
2. The packet is flushed to disk before any transaction is signed.
3. The requester approves and funds the longer source lock.
4. The dealer verifies every source-lock field and then funds the shorter
   destination lock.
5. The requester claims the destination asset and publishes the secret in the
   destination-chain event.
6. The dealer extracts that secret from the confirmed receipt and claims the
   source asset.

Each `EvmHtlcV1` lock fixes the asset, amount, beneficiary, refund address,
secret hash, and timeout. Anyone may submit a claim or refund transaction, but
the contract pays only the address fixed in the lock.

## Durable Recovery

Every trade has:

- an AES-256-GCM encrypted secret packet
- a SQLite journal using WAL and `synchronous=FULL`
- explicit owner approval before the first transaction
- an authenticated encrypted envelope for every signed raw transaction
- a recorded transaction hash before broadcast
- immutable confirmed or reverted action states
- exact-byte rebroadcast only after another explicit owner confirmation
- frozen-route verification on every resume

The signed destination claim is encrypted because its calldata contains the
HTLC secret. A damaged database, damaged recovery packet, wrong key, changed
route, changed lock field, changed chain, or changed runtime bytecode fails
closed.

## Refund Paths

- If the dealer disappears after the source lock, the requester waits for the
  advertised source timeout and receives the source asset back.
- If the requester disappears after the destination lock, the dealer first
  refunds the destination asset after its shorter timeout. The requester then
  refunds the source asset after the longer timeout.
- The command-line runner displays the remaining on-chain seconds. It never
  describes a refund as instant.

## Local Evidence

Run:

```powershell
cd versus
npm run test:fx:phase5:protocol
npm run test:fx:phase5:local
```

The dual-chain lab starts two independent Hardhat nodes and runs:

- successful A to B settlement
- successful B to A settlement
- restart after each major settlement state
- dealer disappearance and source refund
- requester disappearance and both refunds
- destination RPC stall
- fee ceiling rejection before signing
- wrong lock rejection
- wrong-chain RPC rejection

The July 26, 2026 baseline completed all eight scenarios:

- 2 successful swaps
- 3 safe refund scenarios
- 3 fail-closed scenarios
- approximately 220,000 gas per lock
- approximately 54,000 gas per claim
- approximately 51,000 gas per refund

Evidence is written under ignored `.local/fx-phase5-dual-chain-lab/`
directories. Evidence includes transaction hashes, terminal states, timing, and
gas. It excludes secrets, private keys, recovery passwords, and raw signed
transactions.

## Public Testnet Runbook

Read-only compatibility check:

```powershell
cd versus
npm run fx:phase5:preflight
```

Generate isolated encrypted test identities once:

```powershell
npm run fx:phase5:identities
```

Deploy one chain at a time after the testnet deployer is funded:

```powershell
$env:FX_PHASE5_NETWORK = "base-sepolia"
npm run fx:phase5:deploy

$env:FX_PHASE5_NETWORK = "arbitrum-sepolia"
npm run fx:phase5:deploy

npm run fx:phase5:routes
```

Run each evidence scenario separately:

```powershell
$env:FX_PHASE5_SCENARIO = "success-base-to-arbitrum"
npm run fx:phase5:scenario

$env:FX_PHASE5_SCENARIO = "success-arbitrum-to-base"
npm run fx:phase5:scenario

$env:FX_PHASE5_SCENARIO = "dealer-disappears"
npm run fx:phase5:scenario

$env:FX_PHASE5_SCENARIO = "requester-disappears"
npm run fx:phase5:scenario
```

The disappearance scenarios intentionally wait for real on-chain timeouts.

To resume an interrupted scenario from its existing encrypted journal:

```powershell
$env:FX_PHASE5_SCENARIO = "dealer-disappears"
$env:FX_PHASE5_RESUME_RUN_DIRECTORY = "<absolute testnet-runs directory>"
npm run fx:phase5:scenario
```

The resume directory must belong to this test identity's ignored
`testnet-runs` directory. A per-identity execution lock prevents two terminals
from driving the same test identities concurrently.

## Public Testnet Evidence

The July 26, 2026 public campaign deployed the same reviewed bytecode on both
networks:

| Network | Chain ID | Test token | HTLC adapter |
|---|---:|---|---|
| Base Sepolia | 84532 | `0xcba3d9354dd4c30bb6961abb4473a6340486e01b` | `0xe7a02dd38f9191d8ee20daa24b4feee911da334d` |
| Arbitrum Sepolia | 421614 | `0xcba3d9354dd4c30bb6961abb4473a6340486e01b` | `0xe7a02dd38f9191d8ee20daa24b4feee911da334d` |

The matching addresses are a consequence of using the same dedicated
deployer at the same starting nonce. Chain IDs remain part of every capability,
route, lock, signature, provider, and journal record.

| Scenario | Terminal state | Elapsed | Result |
|---|---|---:|---|
| Base Sepolia to Arbitrum Sepolia | `completed` | 56.1 s | destination claim published the secret; source claim completed |
| Arbitrum Sepolia to Base Sepolia | `completed` | 54.5 s | destination claim published the secret; source claim completed |
| dealer disappears after source lock | `refunded` | 610.2 s | process was killed, resumed from encrypted disk state, and source refunded |
| requester disappears after both locks | `refunded` | 611.2 s | destination refunded first; source refunded after the longer timeout |

All four scenarios used 0.01 test-token units and two confirmations per action.
Observed gas remained consistent with the local baseline: approximately
220,000 gas per lock, 54,000 per claim, and 51,000-56,000 per refund. The
successful directions each used six journaled transactions. The
dealer-disappearance recovery used three; requester disappearance used six.

Deployment records and scrubbed run evidence remain under ignored
`.local/fx-phase5-testnet/`. They contain public addresses, transaction hashes,
gas, timing, and terminal states, but exclude secrets, private keys, recovery
passwords, and raw signed transactions.

## No-Go Boundaries

Do not:

- reuse production Cypher wallet keys
- use mainnet RPCs or assets
- connect the runner to production Waku
- expose the encrypted identity directory
- publish raw journals or recovery packets
- infer settlement from a peer or node assertion
- rebroadcast a replacement transaction without owner approval
- add a desktop FX entry point before its later UI phase
