# Agentic FX Phase 6: Waku RFQ laboratory

Phase 6 moves signed RFQ discovery and coordination onto the public Versus Waku
fleet. It does not make Waku, a relay, or a broker economic truth.

## Boundary

- One deployment-scoped discovery topic carries short-lived RFQs.
- Four deterministic trade shards carry quotes, acceptance, reservation, and
  later typed settlement observations.
- FX traffic never enters postcard memory or model context.
- Every message is signed, role bound, deployment bound, trade bound,
  sequenced, expiring, and journaled.
- RFQs are signed by encrypted, short-lived coordination identities rather
  than the settlement wallet. Restart reuses the active encrypted identity;
  expiration fails closed instead of silently rotating an active trade.
- Store recovery is bounded to 15 minutes and 512 messages by default.
- Per-sender, global, RFQ, dealer-quote, active-RFQ, pending-dependency, and
  replay-memory limits fail closed. Live dealers default to at most 12 signed
  quotes per minute, independently of the broader message ceiling.
- The relay does not inspect payloads, select quotes, hold secrets, or attest
  completion.
- Phase 5 chain adapters and receipts remain settlement truth.
- Regression tests inspect the complete coordination wire payload and reject
  raw swap secrets, private keys, mnemonics, keystores, balances, or inventory.
  Public coordination necessarily reveals the signer and, only after route
  acceptance, the settlement addresses needed to bind the atomic swap.

The desktop FX feature remains disabled by default and has no public UI in this
phase.

## Public proof

On 2026-07-26 commit `0c772f2` ran a requester with a fresh coordination
identity while the deterministic dealer was offline. The dealer later joined
through the two public relays, recovered the RFQ from Waku Store, published a
quote, and completed signed acceptance and reservation. Both light clients
observed two LightPush, Filter, Store, and Relay peers. Both journals converged
to:

`0xcabefafed80d1e38d1887f0cdc4ef25feb0f389f5f204b14eacb4901d9b3a635`

Waku was then deliberately closed before settlement. The same trade ID,
`0x2403c514cea4021abda3afd80d3149b2f501ea7807173cedcddf9e97576cc2b8`,
completed through the Phase 5 adapters on Base Sepolia and Arbitrum Sepolia:

| Action | Chain | Transaction |
| --- | --- | --- |
| Source approval | Base Sepolia | `0x08ffa3df16240f49d93236c9fd7fa1220fd55ff7e1bde126bd703cf45226f1c4` |
| Source lock | Base Sepolia | `0xbca758a69d8e83a14d9d11be850cda86e0e7e5e162e6e422b18c10c776ae71ab` |
| Destination approval | Arbitrum Sepolia | `0x867cf75c0fa0da5001a3fb1e1951e5f4b94b47fded2a0bea45d46bd49493dd98` |
| Destination lock | Arbitrum Sepolia | `0xf6c5b948db0ec3b88b4681b3cf62defe5b3a468821500d441b19097a05d2a2f8` |
| Destination claim | Arbitrum Sepolia | `0x0529856b889afc75b70ebd94240d18c3f4395c1ed0bd3d9835832e0755b2a7ec` |
| Source claim | Base Sepolia | `0xec3040115f781977ca9e7dd166f951322cef5cd6ae6f3ebd791c70abae2bf825` |

The encrypted recovery packet was written before either lock transaction. No
swap secret appears in Waku messages or this report. The complete run took
69.3 seconds. Current-trade-only instrumentation observed eight local/remote
admissions; the late Store recovery completed 5.855 seconds after the RFQ's
second-resolution creation timestamp.

### Relay independence

The late-join coordination campaign was then repeated sequentially with each
client configured to exactly one bootstrap relay and chain settlement disabled:

| Bootstrap | Trade | Converged state hash | Store recovery |
| --- | --- | --- | --- |
| `relay-a.versuscypher.com` | `0xbd81a0a9defbbcaf921372607bb23fe537d50df259de974ccf7abf4c7ae084f2` | `0x50ba442e7a5201e8d5f3b4adc775b2995e69f5188ab74cb779a594fd26389f64` | yes |
| `relay-b.versuscypher.com` | `0x29dc4f3c58fde2463cacf78c86257c9c6ccedc9c3536263f9f07b9d7ceb4d29d` | `0x33feb8bc93ed2cc82d24a6e9ae5de78dfa2b14fc44906fd4321bcfd003c9c2c9` | yes |

Each requester and dealer observed exactly one LightPush, Filter, Store, and
Relay peer. The smoke gate also required the accepted quote signer to equal
that campaign's generated dealer identity, preventing another active test
dealer on the shared discovery topic from satisfying the proof accidentally.
Neither relay is individually required for recovery.

### Independent Windows and macOS proof

On 2026-07-27 commit `121bd53` completed the coordination campaign across two
physical machines. A Windows requester published the RFQ through both public
relays while every macOS dealer process was offline. The macOS dealer started
20 seconds later with a fresh encrypted coordination identity and admitted the
exact RFQ from Store with `history: true`.

| Record | Identifier |
| --- | --- |
| Trade | `0xf73dc5f0c17626dc67f8794c9b54a622da88e237fd18f008d1b96611e40a0409` |
| RFQ | `0x080652ecef83f0f3b2ff7fc379c533532e085af9a7086afb65521e07184e497e` |
| Quote | `0x5876cc454793d0c3513cb16e6c41ebf7ed322c68c2e4e7bdc3c00906a370725c` |
| Acceptance | `0x6cd9724a72042a2ff9ea143897e797cc31a2b61e0daaa6ab69ea96e0c5d96795` |
| Reservation | `0xfa3613509c0eb3952a841db88e2960d9870ce211b858551b18dbe5fcc2b5d7c4` |
| Converged state hash | `0x4d272cf792b1cb8639ba199a3eb050058786a862721520fd299795945921b68c` |

The RFQ was published at `02:12:06.699Z`; macOS admitted it from Store at
`02:12:30.286Z`. After the required 15-second dealer and requester observation
windows, both independently persisted the same reservation and state hash.
Settlement was disabled for this coordination-only proof. The separate public
proof above establishes Phase 5 settlement after Waku shutdown.

## Headless roles

The headless runner accepts either an encrypted keystore or a dedicated
coordination private key:

```powershell
npm run fx:phase6:headless --prefix packages/network
```

Required settings are documented by the fail-closed `FX_PHASE6_*` environment
validation in `packages/network/scripts/fx-phase6-headless.js`. Use dedicated
testnet identities. Do not put a Cypher owner key or production funds into a
shell command.

When no operator coordination key is supplied, the runner creates an encrypted
24-hour coordination identity inside its data directory. Settlement addresses
are separate required inputs and do not appear in the public RFQ. The
independent Windows/macOS procedure is documented in
`docs/fx/PHASE_6_TWO_MACHINE_RUNBOOK.md`.

The dealer defaults to a 15-second observation window. Quote policy is
deterministic: exact input, route manifest, reference timestamp, spread,
settlement cost, and completion estimate are all explicit. Model output does
not set prices or addresses.

## Recovery and abuse tests

Automated coverage includes:

- duplicate delivery;
- dependency reordering;
- Store recovery after late start;
- bounded fake-RFQ floods;
- third-party acceptance hijacking;
- selected-dealer reservation binding;
- a late dealer refusing to quote an RFQ already reserved with another dealer;
- peer loss and subscription reconstruction after resume;
- settlement completion after all Waku notifications stop.

The public proof also demonstrated independent connectivity to both relays:
each light client observed two LightPush, Filter, Store, and Relay peers.
