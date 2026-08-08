# Agentic FX Phase 2: Deterministic Local Simulator

Status: complete local research slice
Date: 2026-07-25
Production FX: disabled

## Boundary

Phase 2 moves no real funds, contacts no RPC, publishes no Waku message, and is
not imported by the desktop application. It models the signed Phase 1 protocol
with four deterministic actors:

- requester
- dealer
- broker
- execution relayer

The simulator uses virtual Base USDC and Arbitrum USDC inventory. Its purpose is
to make settlement, replay, recovery, and refund behavior falsifiable before an
adapter or contract exists.

## Components

| Component | Responsibility |
|---|---|
| `fx-simulator.js` | Inventory, fixed quotes, confirmations, locks, claims, refunds, fees, actors, and scientific events |
| `fx-journal.js` | SQLite settlement state, accepted sequence history, outbound sequence reservations, and action nullifiers |
| `fx-recovery.js` | AES-256-GCM secret packet with scrypt, deployment/trade AAD, atomic write, and fail-closed restore |
| `fx-phase2-transcript.json` | Frozen signed transcript and expected state hash shared with the relay |
| `fx-admission-journal.mjs` | Independent relay implementation of admission, lineage, sequence, and nullifier checks |

The state checkpoint contains no raw secret or private key. A recovery packet is
durably written before source funding. The simulator checkpoints prepared
messages before journal admission and reconciles them after restart. This
covers a crash on either side of admission without repeating principal movement
or a broker payment.

## Deterministic Route

The first route is one dealer and fixed exact output:

1. Requester signs an RFQ with maximum input.
2. Dealer signs an inventory-backed fixed quote.
3. Client recomputes the route from signed quote fields.
4. The all-in input equals dealer input plus the disclosed broker fee.
5. Requester persists the encrypted secret, then signs acceptance.
6. Source and destination locks are verified against the accepted route.
7. Destination claim reveals the secret.
8. Any relayer can use the revealed secret to complete the source claim.

A broker can omit a quote from its own answer, but it cannot modify one. The
test client combines responses from independent sources and selects locally.
The route algorithm remains deterministic and open.

## Replay Domains

Economic actions reserve one slot under:

`protocol + version + deploymentId + tradeId + action slot`

Examples include `trade:accept`, `lock:source`, and
`settle-lock:<lockMessageId>`. An identical message is idempotent. A different
message attempting the same action is rejected. Outbound sequence numbers are
reserved in SQLite before signing, so a restart cannot reuse a sequence that
may already have left the process.

## Exercised Campaign

The automated campaign covers:

- successful exact settlement and disclosed broker fee
- restart after every protocol transition
- crash before admission and crash after admission
- duplicate delivery, sequence persistence, and duplicate acceptance
- deployment- and trade-scoped nullifiers
- requester/dealer disappearance before and after the counter-lock
- destination and source timeout refunds
- dealer disappearance after counter-lock with relayed completion
- wrong chain, token, amount, beneficiary, refund address, hash, timeout,
  adapter, and adapter version on both lock legs
- insufficient confirmations
- stale and modified quotes
- broker quote hiding defeated by combining independently received quotes
- encrypted recovery, wrong password, packet corruption, and scope binding
- deterministic scientific report hashes across identical seeds
- exact client/relay snapshot parity across process restarts

## Evidence

Run:

```powershell
node --test packages/network/test/fx-phase2.test.js
node packages/network/scripts/fx-simulate.js $env:TEMP\versus-fx-phase2
$env:FX_BENCHMARK_SAMPLES = "40"
node packages/network/scripts/fx-benchmark.js
```

The 2026-07-25 Windows x64 baseline on Node 25.2.1:

| Scenario | Samples | p50 | p95 | Max |
|---|---:|---:|---:|---:|
| Successful settlement | 40 | 179.986 ms | 196.122 ms | 220.761 ms |
| Source refund | 40 | 68.888 ms | 71.813 ms | 73.396 ms |

These numbers measure synchronous local durability, signatures, and scrypt.
They are not network, chain, or production throughput claims.

## Limits

- Virtual locks are not production contracts.
- The broker fee transfer is simulated accounting, not a payment mechanism.
- The relay journal rewrites a bounded JSON file and is a Phase 2 parity tool,
  not the eventual high-volume store.
- The client SQLite journal is single-writer by design.
- No chain reorganization, fee market, RPC disagreement, or adapter bytecode is
  modeled yet.
- No desktop controls or production entrypoint can enable this work.

Phase 2 exits only as a simulator. EVM adapter and lock work belongs to later
phases and must retain the same exact-beneficiary and refund evidence.
