# Agentic FX Phase 8

Phase 8 hardens one requester and one dealer. It does not add aggregate
multi-dealer settlement, desktop UI, production funds, or a Versus
adjudicator.

## Firming order

1. A requester publishes a signed RFQ.
2. A dealer publishes a fixed exact-output quote with a timestamped price
   reference and coarse capacity.
3. The requester signs one acceptance with one secret hash.
4. The dealer signs a reservation. This reserves a quote, not inventory.
5. The requester funds the source HTLC and publishes its signed lock message.
6. The dealer independently reads the source chain.
7. Only a canonical, sufficiently confirmed lock with exact route amount,
   token, beneficiary, refund address, secret hash, timeout, transaction hash,
   and deterministic lock ID can enter the dealer's durable exposure journal.
8. Only then may the dealer create the destination lock.

A broker statement, requester callback, Waku message, or transaction hash by
itself never firms a trade.

## Refund asymmetry

The EVM laboratory policy uses:

- requester source refund: 7,200 seconds
- dealer destination refund: 600 seconds
- minimum source/destination timeout delta: 3,600 seconds
- minimum source time remaining at dealer firming: 6,600 seconds

The happy path does not wait for either timeout. If the requester abandons
after destination funding, the dealer recovers its inventory after about ten
minutes while the requester retains the longer source-side penalty. Other
chain families must define their own confirmation and timeout policies.

## Economic admission

The dealer refuses:

- trades below or above its configured size range
- requester gas above its configured bound
- all-in overhead above its configured basis-point bound
- stale price references
- chain readers that fail or exceed the bounded verification timeout
- source locks arriving too late to leave a safe response window
- exposure above global, per-requester, or per-destination-asset limits

Global exposure is never calculated by adding unrelated token atomic units.
The independent pricing layer must provide `exposureValueMicros`. Global and
per-requester limits use that normalized value. Per-asset counters are keyed
by exact destination chain and token.

Free RFQs can consume bounded parsing and Waku bandwidth. They cannot reserve
dealer inventory or reveal exact balances. Capacity advertisements use fixed
lower-bound bands.

## Durable state

`FxPhase8ExposureJournal` persists:

- the exact signed RFQ, quote, acceptance, reservation, and source lock
- independently observed source-chain facts
- deterministic source and destination lock IDs
- source and destination refund timestamps
- normalized exposure value
- current lock state and terminal evidence

Admission uses a SQLite `BEGIN IMMEDIATE` transaction. Replaying the exact
package is idempotent. A different package for the same trade fails closed.
Active exposure survives process restart and is released only by a locally
verified terminal transition.

## Abandonment evidence

Dealer no-show evidence binds:

- dealer quote and reservation
- requester acceptance
- timely canonical source lock
- promised destination-lock deadline
- deterministic destination lock ID
- canonical destination block proving the lock was absent

Requester abandonment evidence additionally binds the actual destination
lock and a canonical post-timeout observation proving it remained unclaimed.

The observer signs the evidence bundle, but that signature is not authority.
Every receiving client replays signatures and chain reads before changing its
own local reputation. Evidence uses a separate sharded Waku content-topic
lane with bounded Store recovery. Relays transport and retain evidence
without scoring either party. Raw verified outcome counts remain auditable,
while local policy weights decay on a fixed half-life.

Cross-chain griefing is bounded, not eliminated. A funded requester can still
force temporary lockup. The asymmetric timeout makes the dealer's maximum
wait shorter and measurable.

## Independent slicing

A client may split intent into several ordinary swaps. Every slice requires:

- a unique trade ID
- a unique secret
- an independent RFQ and quote
- independent source and destination locks
- independent claim and refund paths

`atomicAcrossSlices` is permanently `false`. One slice may complete while
another refunds. No route or UI may present those outcomes as aggregate
atomic settlement.

## Physical proof

Run an independent dealer on another machine:

```bash
git pull origin agentic-fx/phase-8
npm run fx:phase6:mac-dealer-lab --prefix packages/network
```

Then run the external requester and public broker:

```powershell
cmd /c npm run fx:phase8:public-proof --prefix packages/network
```

The requester calls localhost HTTP and never joins Waku. The broker publishes
the RFQ to the public Versus Waku fleet, collects the remote dealer quote, and
writes a locally ignored evidence bundle. Settlement remains disabled.

## Explicit exclusions

- no real mainnet funds
- no production enablement
- no global reputation score
- no relay-authored guilt
- no mandatory broker
- no exact inventory disclosure
- no claim that funded griefing is impossible
- no coupled multi-dealer atomic route
