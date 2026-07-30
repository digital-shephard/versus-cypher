# EVM Adapter V3 Security Assumptions

V3 changes the settlement secret owner and the onchain storage model without
introducing an administrator. It is deployed, source-verified, frozen into its
own public-testnet coordination domain, and wired into the desktop. It is not
production-approved. Physical two-machine settlement, restart recovery, and
timeout/refund acceptance remain required before any production decision.

The Waku discovery, trade, and evidence topics are scoped by the frozen V3
coordination domain. Signed messages remain independently bound to the frozen
V3 deployment ID, so topic isolation does not replace message verification.

The candidate families are:

- `evm-native-htlc-v3` for native ETH
- `evm-htlc-v3` for one exact manifested ERC-20

## Requester-Secret Settlement

1. The requester generates a cryptographically random 32-byte secret, persists
   it encrypted, and gives the dealer only its hash.
2. The requester funds the longer source lock. The lock commits the trade,
   requester funder, dealer beneficiary, hash, timeout, exact source amount,
   and a zero source executor bounty.
3. The dealer independently verifies the canonical source lock and required
   confirmations before funding destination.
4. The destination lock commits the same hash, dealer funder, exact recipient,
   shorter timeout, exact output, and exact permissionless-executor bounty.
5. The requester independently verifies every destination term and its
   confirmations. Only then may it disclose the secret to the executor
   network.
6. Any executor may reveal the secret onchain. The contract atomically pays
   the fixed recipient and the fixed bounty to the successful submitter.
7. The dealer observes the revealed secret and claims the source lock.

The dealer cannot claim source before the requester reveals the secret. The
requester does not reveal it until a correct, confirmed destination lock
exists. A dealer and executor that collude after disclosure still cannot
redirect the destination payment: any caller can complete it, but the
beneficiary and amount are commitment-bound.

The source timeout must remain safely later than the destination timeout by
the configured confirmation, relay, claim, reorganization, and recovery
margin. V3 does not make an unsafe timeout ordering safe.

## Commitment-Only Custody

Persistent state is one enum value per domain-separated lock digest:

`EMPTY -> FUNDED -> CLAIMED | REFUNDED`

The digest binds:

- chain and exact adapter address
- trade ID
- funder
- beneficiary
- requester secret hash
- refund timestamp
- beneficiary amount
- executor amount

Callers resupply those terms for settlement or refund. Changing any term
selects a different, unfunded digest. The complete original terms are emitted
by `LockFunded`, so an indexer can reconstruct them without treating Waku as
truth.

`totalLocked` is intentionally absent. It is not needed to authorize a claim
or prove solvency:

1. Funding changes an empty digest to funded and accepts exactly its new
   liability.
2. Claim or refund changes the digest out of funded before transferring
   exactly that liability.
3. A failed external transfer reverts both state and balances.
4. Direct or forced donations can create surplus but cannot create a claim.

Stateful Foundry invariants recompute every active liability from recorded
terms and prove adapter balance equals active liability plus donations across
arbitrary funding, claiming, refunding, donation, and time-warp sequences.

## Compact Happy Path

The canonical V3 selectors reduce rollup data cost without removing a bound
term:

- funder is `msg.sender`
- `uint64 refundTimestamp | uint96 beneficiaryAmount | uint96 executorAmount`
  occupy one canonical 256-bit settlement word
- claim derives the committed hash from the supplied requester secret

The compact amount ceiling is `2^96 - 1` atomic units per payout. The helper
rejects larger values rather than truncating them. The reference struct
selectors remain semantically equivalent and are useful for recovery and
auditing, but production clients should use the compact funding and claim
selectors.

## Contract Authority

Both contracts are immutable, ownerless, and non-upgradeable. They contain no:

- owner or admin
- pause key
- proxy
- sweep method
- arbitrary external call
- mutable fee or recipient

The native adapter follows checks-effects-interactions. Same-lock reentrancy
cannot settle twice, and cross-lock reentrancy cannot consume another lock's
liability. The ERC-20 adapter additionally uses OpenZeppelin's transient
reentrancy guard. Public Base Sepolia and Arbitrum Sepolia RPC execution checks
accepted EIP-1153 transient storage before this candidate was frozen.

## Exact Assets And Payouts

Native funding requires exact `msg.value`.

ERC-20 funding and payout measure adapter and recipient balance deltas. Tokens
with fees, rebases, callbacks, freezes, or other non-exact behavior are
unsupported unless their exact manifested behavior has been separately
reviewed. One ERC-20 deployment is bound to one token and its expected
decimals.

The executor chooses only whether to submit. It cannot change the recipient,
recipient amount, refund destination, timeout, or bounty. A zero-bounty source
lock remains permissionlessly claimable but normally is claimed by its dealer
beneficiary.

## Trusted

- The requester generates the secret with a cryptographically secure source,
  persists it before source funding, and does not disclose it early.
- Both clients independently read the exact frozen contracts and wait for
  their configured confirmation depth.
- At least one executor can submit the destination claim before its timeout.
- The source timeout leaves enough margin after destination settlement for the
  dealer to claim or recover.
- A contract recipient can accept the manifested native or ERC-20 payout.
- The manifested ERC-20 contract itself behaves as reviewed.

## Untrusted

- requester
- dealer
- broker
- Waku peers and relays
- executor
- RPC responses until corroborated
- transaction ordering and replacement
- model output

Waku transports signed coordination evidence. It never establishes funding,
claim, refund, balance, contract code, or finality.

## No-Go Conditions

Do not reveal the requester secret when:

- the destination lock is absent, unconfirmed, reorganized, expired, or
  different from the accepted terms
- its hash differs from the confirmed source lock
- its recipient, exact output, bounty, adapter, token, or timeout differs
- its timeout lacks the required executor and recovery margin
- the recipient cannot accept the payout
- adapter or token runtime code differs from the frozen manifest
- encrypted requester recovery state is missing or corrupt

Do not enable V3 for production solely because the included tests pass or its
public-testnet contracts are verified. It still requires a two-machine
successful settlement, restart recovery, timeout/refund acceptance, and a
separately approved production decision.

