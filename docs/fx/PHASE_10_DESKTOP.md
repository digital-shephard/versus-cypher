# Phase 10 Desktop FX

Phase 10 puts the proven Agentic FX requester and dealer workflows inside the
Cypher desktop client. It remains a public-testnet cohort laboratory and is
disabled by default.

## Requester Flow

1. Pick the source and destination assets.
2. Enter the exact amount to receive.
3. Enter the destination address.
4. Request a route and inspect its input, spread, broker fee, expected time,
   and expiry.
5. Explicitly accept the quote.
6. Receive a signed dealer reservation with a separate funding countdown.
7. Either cancel the unfunded reservation or send the exact source asset to
   the displayed local requester address.
8. Let the app confirm the post-baseline transfer, execute the atomic locks,
   and independently verify the destination claim.

The destination may be any valid address selected by the requester. It is
signed into the acceptance and bound into the destination HTLC. The external
source wallet is not connected to Versus and is never inferred. If the source
HTLC must be refunded, funds return to the displayed local requester wallet.

Versus stops at `fundsReady`. It never spends those funds on an x402 endpoint.

## Dealer Flow

- Dealer mode is disabled by default.
- The owner explicitly enables the FX lab and then separately arms dealing.
- Supported inventory positions are selected on the Stock page.
- Each supported chain is a first-class native-gas position. Both the dealer
  and requester role wallets must hold at least the displayed USD minimum in
  the native coin before token positions on that chain become usable.
- The Assets screen exposes the chain and token toggles, role-specific gas
  deposit addresses, optional local custom RPC URLs, and the less common
  requester, asset, gas, overhead, and inventory-premium limits.
- The Risk page bounds trade size, aggregate exposure, requester exposure,
  per-asset exposure, gas, overhead, spread, quote lifetime, and reservation
  lifetime.
- The Phase 8 guard and exposure journal decide whether a reservation can
  become firm.
- The Tape page shows local receipts and terminal outcomes.
- Stock refreshes use bounded single-flight reads while the relevant FX screen
  is visible. They do not continuously poll every enabled chain in the
  background. The refresh control performs an explicit fresh read.
- Inventory withdrawals are confirmed ERC-20 transfers from the dealer role
  wallet. Dealing must be disarmed first so an accepted quote cannot race an
  owner withdrawal.
- An abandoned destination lock reappears on the Tape after restart. Once
  chain time reaches its short timeout, the owner can submit its deterministic
  dealer refund there; exposure is released only after confirmation.

The dealer, requester, and broker identities are domain-separated keys derived
from the backed-up Cypher wallet. Temporary requester funding is never counted
as dealer inventory.

## Settlement Truth

Waku carries signed RFQs, quotes, acceptance, reservation, lock notices, and
claim notices. It is not settlement truth. The desktop independently checks
the frozen testnet token and adapter contracts before recognizing:

- source funding
- source lock
- destination lock
- destination claim
- source claim
- refund eligibility

Event recovery starts at the frozen adapter deployment blocks, not chain
genesis. Inventory reads are cached and invalidated when dealer funds move.

## Recovery

- The HTLC secret is encrypted to disk before acceptance.
- An explicit pre-funding cancellation is signed by the requester, releases
  the dealer reservation over Waku, and becomes terminal before any lock.
- Closing the screen is non-destructive; it resumes the reservation instead of
  silently cancelling an order.
- An uncertain write is reconciled and never automatically replayed.
- History persists interrupted swaps and offers an explicit status check. It
  reconciles the existing trade instead of creating a new RFQ or replaying a
  transaction.
- A quote that expires before any lock exists stops cleanly; source funds
  remain in the local requester wallet.
- Refund is an explicit owner action after contract time declares it eligible.
- Dealer refund checks are throttled and reuse one chain head per network, so
  recovery does not become a public-RPC polling storm.
- Diagnostics and cohort exports exclude keys, secrets, passwords, private
  endpoint details, custom RPC URLs, role addresses, and exact unpublished
  inventory. They retain scrubbed public route, state, timing, confirmation,
  and transaction-hash evidence.
- A dealer that was explicitly armed resumes after restart only when its
  persisted chain and inventory prerequisites still pass. Temporary failures
  fail closed.

## Completion Gate

Automated desktop and network suites cover the requester, dealer, role
separation, funding verification, recovery, refund, policy, and RPC boundaries.
The preview harness proves layout and deterministic screen transitions only; it
is not settlement evidence.

The desktop now has a real requester path from quote discovery through
reservation, source-funding verification, HTLC settlement, cancellation,
status reconciliation, and refund. Dealer arming, bounded inventory refresh,
native-gas readiness, real withdrawal, owner-visible policy, restart resume,
persisted trade journals, and scrubbed settlement evidence are connected to
the FX runtime.

The code-completion portion of Phase 10 is complete. Physical acceptance
remains open.

Phase 10 is complete only after a Windows requester and an independently run
macOS dealer complete a full public-testnet swap through the desktop UI. The
same acceptance pass must prove restart recovery during uncertain settlement,
one timeout and refund through the UI, and correct inventory movement without
duplicate economic action.

Phase 10.5 starts after that physical public-testnet acceptance. It introduces
tiny real balances to a closed cohort; it is not where basic desktop wiring is
first proven.
