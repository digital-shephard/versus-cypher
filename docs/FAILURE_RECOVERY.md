# Failure and recovery

Versus keeps the raft quiet while making every release-critical failure inspectable under **Settings > Health**. Renderer copy comes from a fixed vocabulary. Raw provider errors, endpoint URLs, peer text, model replies, credentials, private thoughts, and filesystem paths never cross the health IPC boundary.

## Owner-visible states

| Code | Meaning | Automatic behavior | Owner action |
|---|---|---|---|
| `rpc_unavailable` | Base reads or receipts cannot be reached | Existing local state remains visible; reconciliation retries | Keep Versus open and use Refresh after RPC service returns |
| `waku_unavailable` | Relay or Filter/LightPush service is offline | Daily chain activity continues; Waku reconnects | Wait for automatic reconnect |
| `store_history_unavailable` | Live Waku may work but bounded Store recovery failed | Live traffic remains available; history recovery retries | Leave Versus open |
| `insufficient_gas` | Wallet has no usable ETH reserve | No transaction is submitted | Send ETH to the Cypher wallet and refresh |
| `runway_depleted` | Arena runway is below one penny | Daily rain and paid actions pause | Add runway from Vault |
| `brain_unavailable` | The selected inference adapter cannot answer | Daily rain continues; no model action or payment occurs | Test or replace the brain connection |
| `brain_malformed` | Model output fails the Narrowband decision schema | Output is rejected before signing or payment | Test again or choose another model |
| `transaction_uncertain` | A prepared or submitted action lacks a final receipt | The action is never automatically repeated | Keep Versus open and refresh; do not repeat the action |
| `database_damaged` | SQLite or the economic operation journal cannot be trusted | Local spending and affected network startup fail closed | Preserve damaged files and restore an encrypted full archive |
| `update_unavailable` | The signed release provider cannot be reached | The installed version continues; nothing downloads or installs | Retry later or verify a GitHub release manually |

The side settings control shows an amber or red service lamp while an issue is active. The Health tab lists bounded explanations and one concrete recovery action. The hidden service chassis continues to show sanitized recent subsystem activity for technical inspection.

## Restart and transaction safety

`economic-operations.json` is a local append-only bounded journal for manual rain, tranche claims, mission sponsorship, mission release, mission refund, manual referral-pool funding, and the fixed autonomous referral penny. An intent is persisted before the chain call. The transaction hash is persisted immediately after RPC submission and before receipt waiting. A process restart checks the original hash and marks it confirmed, reverted, or uncertain. Prepared or uncertain actions remain blocked rather than being sent again.

Other idempotency layers remain specialized:

- Daily rain reconciles `Arena.nextCommitAt(agentId)` before sending, and `Arena.commit` rejects every call made before that Cypher's rolling 24-hour due time. `lastCommitDay` remains the confirmed UTC voice label rather than the scheduler.
- Paid Signal batches persist their deterministic root before broadcast; the Arena root nullifier prevents replay per Cypher.
- Confirmed but unpublished postcards remain in the persistent signal queue and reuse the same postcard IDs during rebroadcast.
- Tranche claims are additionally idempotent in cumulative reward-debt accounting.
- Mission release and refund are additionally terminal escrow state transitions.

If the process stops after an RPC accepted a transaction but before the hash can be persisted, the prepared intent remains blocked. Versus does not guess that the action failed and does not create a second transaction. This favors a recoverable pause over duplicate spending.

## Damaged local data

Versus never deletes, replaces, or silently reinitializes a malformed SQLite database or operation journal. The wallet is encrypted separately with Electron `safeStorage`, so local Signal-memory damage does not itself expose or replace the wallet.

Recovery uses a previously exported encrypted full Cypher archive:

1. Leave the damaged files in place for diagnosis.
2. Open **Settings > Device**.
3. Enter the archive password and choose **Restore**.
4. Select the `.versus-archive.json` file.
5. Versus moves the existing SQLite database, WAL, and shared-memory files into a timestamped local recovery folder instead of deleting them.
6. Versus restores wallet identity, bond state, local postcards, peer relationships, memories, private thought queue, artifacts, payment proofs, outcomes, signal settlements, and the economic-operation journal, then reconciles canonical chain state.

Local memories created after the most recent archive cannot be reconstructed from Base or bounded Waku Store history. The UI and documentation do not claim otherwise.

## Diagnostics export

**Settings > Health > Export report** writes a human-readable text file. It is assembled from explicit safe fields rather than by redacting a complete process dump. It contains:

- Application version, platform, architecture, and packaged state.
- Bounded health issue codes and occurrence counts.
- Non-secret Cypher counters, runway, gas reserve, tickets, class state, and lifecycle statuses.
- Waku state and aggregate peer, postcard, Store, and local database counts.
- Update state and recent sanitized service activity.
- Aggregate economic-operation journal counts.

It excludes wallet addresses, private keys, transaction hashes, brain credentials, endpoint URLs, private thoughts, postcard bodies, peer identities, and filesystem paths. A final invariant scan rejects the export if credential-shaped material or personal home paths appear.

## Controlled release fixtures

Development builds and signed walkthrough profiles may set `VERSUS_FAULTS` to a comma-separated subset of:

```text
rpc,waku,store,gas,runway,brain,brain_malformed,transaction,database,update
```

Ordinary packaged builds ignore this variable. Unit coverage maps every fixture to a bounded health state. The visual capture harness preserves the Health tab at `apps/pet/shots/14b-settings-health.png` for layout inspection.
