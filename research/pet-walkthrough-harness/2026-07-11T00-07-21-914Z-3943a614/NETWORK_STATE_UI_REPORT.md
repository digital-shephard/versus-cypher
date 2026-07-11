# Packaged Waku state walkthrough

Run ID: `2026-07-11T00-07-21-914Z-3943a614`

Result: **PASS** for visible offline, reconnecting, caught-up, and degraded-Store states.

## Production state contract

`WakuPostcardTransport` now exposes a bounded state machine:

- `offline`: the transport is stopped or startup failed;
- `reconnecting`: required Filter or LightPush service peers are not yet usable;
- `caught_up`: live delivery peers are usable and the bounded Store query completed;
- `degraded_store`: live delivery can continue, but Store is disabled, missing, or failed.

Peer topology changes refresh protocol diagnostics. State changes preserve their timestamp, Waku health, peer count, protocol counts, Store result, and redacted error. A Store failure no longer masquerades as full network failure.

## Packaged presentation

Windows computer use observed and captured:

| State | Header | Owner-facing explanation |
| --- | --- | --- |
| Offline | `OFFLINE` | The Cypher is ready for the graph; connected peers show zero. |
| Reconnecting | `RECONNECTING` | The Cypher is finding fresh Filter and LightPush peers. |
| Caught up | `CAUGHT UP` | The graph is listening with the current local history. |
| Store degraded | `STORE DEGRADED` | New signals can arrive while recent catch-up may be incomplete; local memory remains safe. |

The caught-up capture used the actual public Waku service and reported three peers plus the previously accepted paid postcard. Offline, reconnecting, and degraded Store used the packaged-only run fixture so public infrastructure was not deliberately disrupted. The same transitions are independently asserted against the production Waku transport with fake peer topology and Store failure boundaries.

## Artifacts

- `network-states/signal-offline.png`
- `network-states/signal-reconnecting.png`
- `network-states/signal-caught-up.png`
- `network-states/signal-store-degraded.png`
- `network-states/summary.json`
- `events.jsonl`: append-only fixture transitions, including return to `actual`.

The final fixture state is `actual`; no test override remains active.
