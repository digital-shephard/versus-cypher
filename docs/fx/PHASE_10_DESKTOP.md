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
7. Either cancel before source funding or send at least the displayed funding
   target to the local requester address. For native assets this target
   includes the signed source amount plus a conservative transaction allowance
   and the local refund gas reserve.
8. Let the app confirm the post-baseline transfer and fund the source lock
   first. The dealer independently verifies that lock before funding the
   destination.
9. After independently verifying the destination lock, the requester reveals
   its persisted secret. A permissionless executor completes the destination
   payout, then the dealer uses the same onchain secret to claim the source.

The destination may be any valid address selected by the requester. It is
signed into the acceptance and bound into the destination HTLC. The external
source wallet is not connected to Versus and is never inferred. If the source
HTLC must be refunded, funds return to the displayed local requester wallet.
Unused native funding allowance remains in that local wallet; it is not paid
to the dealer. If gas changes before broadcast, the funding screen requests
only the missing top-up instead of leaving the trade stuck in a pending state.

The destination recipient never submits a transaction and does not need the
destination chain's native gas token. The requester owns the settlement
secret and persists it encrypted before source funding. The requester reveals
it only after independently confirming the exact destination lock. Any
executor can then claim that lock; the contract atomically pays the fixed
recipient amount and the separately quoted bounty to the successful
transaction sender. The dealer reads the disclosed secret and claims source.
Neither payout can be redirected by Waku, a broker, or the executor.

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
- The owner explicitly arms FX DEALING. Requesting a quote never enables local
  dealing.
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
- The Phase 8 exposure journal records destination liability before the
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
destination legs. V1, V2, and V3 messages cannot share a trade journal. The
zero address is the canonical wire identifier for native ETH and is never
treated as an ERC-20 address.

V3 settlement is requester-secret and source-first:

1. The requester encrypts a random settlement secret before source funding and
   signs only its hash.
2. The dealer durably reserves output plus executor bounty.
3. The requester funds the longer source V3 lock for the exact signed input.
4. The dealer independently verifies the exact source funding transaction,
   lock digest, terms, runtime, and confirmations before funding destination.
5. The requester independently verifies the exact destination funding
   transaction, recipient, output, bounty, hash, and shorter timeout.
6. The requester reveals the secret. A permissionless executor atomically
   pays the fixed recipient and receives the fixed bounty.
7. The dealer extracts the same secret from the destination claim and claims
   source. Restart recovery and refunds remain bound to the exact original
   funding transaction and lock digest.

In the current desktop cohort, the dealer app also runs the permissionless
destination execution service. Its dealer wallet submits that claim and earns
the fixed executor bounty. The recipient does not run the app, sign a
transaction, or hold destination-chain gas.

The current public-testnet V3 deployment is frozen by deployment ID
`0x1edf9c4dca5cbcb8b1875f4ce950844237258367d51e5d02dc3de577b3088494`
and coordination domain
`0x6d2d3f9784460521d35605b450e5a46fc1c068df7724265c8f12fec7f1693b2c`.
On Base Sepolia and Arbitrum Sepolia, the native adapter is
`0x9ff9e978801b7819fa4169638814543028d0c0f2` and the manifested ERC-20
adapter is `0xb9c06839b81421e0899510706300d1f1b2623a18`.

V2 contracts and deployment records remain frozen for historical recovery.
They are not admitted to the V3 coordination domain.

Verified explorer links:

| Chain | Adapter | Explorer |
|---|---|---|
| Base Sepolia | Native V3 `0x9ff9e9...c0f2` | [code](https://sepolia.basescan.org/address/0x9ff9e978801b7819fa4169638814543028d0c0f2#code) |
| Base Sepolia | ERC-20 V3 `0xb9c068...3a18` | [code](https://sepolia.basescan.org/address/0xb9c06839b81421e0899510706300d1f1b2623a18#code) |
| Arbitrum Sepolia | Native V3 `0x9ff9e9...c0f2` | [code](https://sepolia.arbiscan.io/address/0x9ff9e978801b7819fa4169638814543028d0c0f2#code) |
| Arbitrum Sepolia | ERC-20 V3 `0xb9c068...3a18` | [code](https://sepolia.arbiscan.io/address/0xb9c06839b81421e0899510706300d1f1b2623a18#code) |

Native atomic amounts use a signed relay ETH/USD reference for quote and risk
calculation. The desktop caches a valid reference for no more than three
minutes and fails native routes closed if no currently valid signed quote is
available. The hatch service's longer stale fallback is not accepted for FX.
Stablecoin-only ERC-20 routes remain independent of ETH pricing.

## Recovery

- The requester settlement secret is encrypted to disk before source funding.
  Recovery refuses to reveal, claim, or refund when that encrypted state is
  missing, corrupt, or bound to another deployment or trade.
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
source-first funding, reserve-before-fund exposure, gas-spike refusal before
source funding, automatic exactly-once recovery, adapter
version separation, timeout ordering, role separation, funding verification,
recovery, refund, policy, and RPC boundaries.
The preview harness proves layout and deterministic screen transitions only; it
is not settlement evidence.

The desktop now has a real V3 requester path from quote discovery through
source funding, dealer-side source verification, independent destination
verification, requester-secret disclosure, permissionless paid execution,
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
