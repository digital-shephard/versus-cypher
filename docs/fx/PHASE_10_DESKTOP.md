# Phase 10 Desktop FX

Phase 10 puts the proven Agentic FX requester and dealer workflows inside the
Cypher desktop client. It remains a public-testnet cohort laboratory and is
disabled by default.

## Requester Flow

1. Pick the source and destination assets.
2. Enter the exact amount to receive.
3. Enter the destination address.
4. Request a route and inspect its principal, spread, relay and gas cost,
   all-in input, expected time, and expiry.
5. Explicitly accept the quote.
6. Receive a signed dealer reservation while the dealer commits the exact
   destination output plus a paid execution bounty.
7. Wait for the app to independently confirm that destination lock and verify
   that its bounty still covers current destination gas.
8. Either cancel before source funding or send the exact source asset to the
   displayed local requester address.
9. Let the app confirm the post-baseline transfer, fund the source lock, and
   independently verify the final recipient payout.

The destination may be any valid address selected by the requester. It is
signed into the acceptance and bound into the destination HTLC. The external
source wallet is not connected to Versus and is never inferred. If the source
HTLC must be refunded, funds return to the displayed local requester wallet.

The destination recipient never submits a transaction and does not need the
destination chain's native gas token. The dealer owns the settlement secret.
Claiming the requester source lock publishes that secret onchain; any executor
can then claim the destination lock. The contract pays the fixed recipient
amount first and pays the successful transaction sender a separately quoted
executor bounty. Neither payout can be redirected by Waku, a broker, or the
executor.

The requester route picker is built from the frozen adapter catalog, not from
the local dealer's enabled inventory bays. A device can therefore request any
supported route without stocking or dealing either asset. Inventory toggles
only control which quotes that device may supply as a dealer.

Quote discovery accepts any positive representable exact-output amount. The
requester's local dealer minimum and maximum do not reject the RFQ. Every
dealer independently applies its own trade-size, inventory, gas, and exposure
policy, so an unsupported size returns no quote instead of a local policy
error.

The desktop runs its zero-fee self-routing broker internally. Owners never
start or configure a broker sidecar for ordinary desktop swaps. Concurrent
requests share one startup operation, and a failed startup remains retryable
instead of leaving a half-started broker cached in the app.

Versus stops at `fundsReady`. It never spends those funds on an x402 endpoint.

## Dealer Flow

- Dealer mode is disabled by default.
- The owner explicitly enables the FX lab and then separately arms dealing.
- Supported inventory positions are selected on the Stock page.
- Enabling, disabling, funding, or draining a supported chain while dealing is
  armed rebuilds the live dealer route set when its usable-position topology
  changes. Repeated balance polls with the same routes do not restart the
  dealer, and the owner does not need to restart or cycle the dealer switch.
- Native ETH is a genuine inventory asset on Base Sepolia and Arbitrum
  Sepolia, not merely a gas-readiness indicator. A chain toggle enables its
  native ETH bay; the owner may then enable the chain's ERC-20 bay separately.
- Native positions reserve configured operating ETH plus the estimated
  transaction fee before advertising inventory, locking, or withdrawing.
  `MAX GAS` remains a USD risk/cost limit, not a separate balance.
- Route admission treats source support and destination inventory separately.
  The destination asset must have enough unreserved stock; the source asset
  only needs to be enabled with dealer-role gas on its chain so the dealer can
  claim the requester's lock.
- Both the dealer and requester role wallets must still satisfy the displayed
  native-gas readiness threshold before ERC-20 positions on that chain become
  usable. A quoteable native-only position can arm dealing without a USDC bay.
- The Assets screen exposes the chain and token toggles, role-specific gas
  deposit addresses, optional local custom RPC URLs, and the less common
  requester, asset, gas, overhead, and inventory-premium limits.
- The Risk page bounds trade size, aggregate exposure, requester exposure,
  per-asset exposure, gas, overhead, spread, quote lifetime, and reservation
  lifetime.
- The Phase 8 exposure journal records V2 destination liability before the
  dealer broadcasts the funding transaction. `destination_pending` therefore
  consumes global, requester, and asset capacity and survives restart.
- The Tape page shows local receipts and terminal outcomes.
- Stock refreshes use bounded single-flight reads while the relevant FX screen
  is visible. They do not continuously poll every enabled chain in the
  background. The refresh control performs an explicit fresh read.
- Inventory withdrawals are confirmed native or ERC-20 transfers from the
  dealer role wallet. Native withdrawals preserve the operating reserve and
  estimated fee. Dealing must be disarmed first so an accepted quote cannot
  race an owner withdrawal.
- An abandoned destination lock reappears on the Tape after restart. Once
  chain time reaches its short timeout, the owner can submit its deterministic
  dealer refund there; exposure is released only after confirmation.

The dealer, requester, broker, and coordination-relayer identities are
domain-separated keys derived from the backed-up Cypher wallet. Temporary
requester funding is never counted as dealer inventory.

## Settlement Truth

Waku carries signed RFQs, quotes, acceptance, reservation, lock notices, and
claim notices. It is not settlement truth. The desktop independently checks
the applicable frozen testnet asset and adapter contracts before recognizing:

- source funding
- source lock
- destination lock
- destination claim
- source claim
- refund eligibility

Event recovery starts at the frozen adapter deployment blocks, not chain
genesis. Inventory reads are cached and invalidated when dealer funds move.
Each quote binds the adapter ID and version independently for its source and
destination legs. V1 and V2 messages cannot share a trade journal. The zero
address is the canonical wire identifier for native ETH and is never treated
as an ERC-20 address.

V2 settlement is destination-first:

1. The dealer encrypts its settlement secret and signs only its hash.
2. The dealer durably reserves output plus executor bounty.
3. The dealer funds the destination V2 adapter for the exact recipient,
   refund address, hash, timeout, output, and executor liabilities.
4. The requester independently checks every onchain field and current relay
   gas coverage before funding source.
5. The dealer claims source, publishing the secret onchain.
6. A permissionless executor claims destination. The recipient gets the exact
   output and the transaction sender gets the fixed bounty.

The current public-testnet V2 deployment is frozen by deployment ID
`0x361d43afddce9c272db9d4131c6b6b228693b603924de8f7dc09cc67b58bc5df`.
On Base Sepolia and Arbitrum Sepolia, the native adapter is
`0x1e933ccffaa2cd384d3df751ff7a25183682dc61` and the manifested ERC-20
adapter is `0x0fa1152f8c51ce05cd61d1ca98515a409ed23c14`.

Verified explorer links:

| Chain | Adapter | Explorer |
|---|---|---|
| Base Sepolia | Native V2 `0x1e933c…dc61` | [code](https://sepolia.basescan.org/address/0x1e933ccffaa2cd384d3df751ff7a25183682dc61#code) |
| Base Sepolia | ERC-20 V2 `0x0fa115…3c14` | [code](https://sepolia.basescan.org/address/0x0fa1152f8c51ce05cd61d1ca98515a409ed23c14#code) |
| Arbitrum Sepolia | Native V2 `0x1e933c…dc61` | [code](https://sepolia.arbiscan.io/address/0x1e933ccffaa2cd384d3df751ff7a25183682dc61#code) |
| Arbitrum Sepolia | ERC-20 V2 `0x0fa115…3c14` | [code](https://sepolia.arbiscan.io/address/0x0fa1152f8c51ce05cd61d1ca98515a409ed23c14#code) |

Native atomic amounts use a signed relay ETH/USD reference for quote and risk
calculation. The desktop caches a valid reference for no more than three
minutes and fails native routes closed if no currently valid signed quote is
available. The hatch service's longer stale fallback is not accepted for FX.
Stablecoin-only ERC-20 routes remain independent of ETH pricing.

## Recovery

- The dealer settlement secret is encrypted to disk before its quote is
  published. The requester recovery file contains a separate local
  authentication nonce, never the settlement secret.
- An explicit pre-funding cancellation is signed by the requester, releases
  the requester flow over Waku, and prevents source funding. A V2 destination
  lock that already exists remains dealer exposure until its deterministic
  refund timeout.
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

Automated desktop, network, Hardhat, and Foundry suites cover exact recipient
payout, executor bounty payout, requester destination-gas independence,
reserve-before-fund exposure, gas-spike refusal before source funding, adapter
version separation, timeout ordering, role separation, funding verification,
recovery, refund, policy, and RPC boundaries.
The preview harness proves layout and deterministic screen transitions only; it
is not settlement evidence.

The desktop now has a real V2 requester path from quote discovery through
destination reservation, independent destination verification, fresh executor
gas coverage, source-funding verification, permissionless completion,
cancellation, status reconciliation, and refund. Dealer arming, bounded
inventory refresh, native-gas readiness, real withdrawal, owner-visible
policy, restart resume, persisted trade journals, and scrubbed settlement
evidence are connected to the FX runtime.

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
