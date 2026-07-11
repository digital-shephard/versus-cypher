# Packaged economic failure walkthrough

Run ID: `2026-07-11T00-07-21-914Z-3943a614`

Result: **PASS** for empty runway, insufficient gas, RPC outage, and recovery in the packaged app.

## Failure matrix

| Injected condition | Visible packaged result | Machine evidence | Recovery |
| --- | --- | --- | --- |
| App RPC proxy offline | `Base connection is offline. Try again when it returns.` | The proxy returned HTTP `503` for real `eth_call` requests. | Proxy returned online; Device refresh reported `CHAIN CURRENT`. |
| Agent runway drained from `6,990,000` micros to zero | Raft tap reported `VAULT EMPTY`. | Seven confirmed commits consumed `699` pennies and left exact onchain runway zero. | A sponsor transaction replenished `7,000,000` micros. |
| App wallet native gas balance forced to zero | Raft tap reported `NEEDS GAS`. | The harness recorded the before and after native balances. | Funding `0.003 ETH` allowed the queued rain to settle. |
| Normal operation restored | Two queued pennies completed without duplicate economic state. | Final assertions passed at block `36`. | Runway, tickets, class pot, ownership, and wallet protection all reconciled. |

## Final canonical state

- Agent `1`, Cypher `7`.
- Runway: `6,980,000` USDC micros.
- Tickets: `702`.
- Current class committed: `7,040,000` USDC micros across two participants.
- Wallet file contains `encryptedPrivateKey` and no plaintext `privateKey` field.

## Artifacts

- `events.jsonl`: append-only drain, sponsor, gas-balance, funding, scale, profile, and assertion events.
- `rpc-fixture-events.jsonl`: request methods, mode, response status, body byte count, and latency without RPC payloads.
- `summary.json`: canonical chain and local-state assertions.
- `rpc-fixture-mode.json`: final proxy mode.

The failure labels were observed through Windows computer use. Balance and ticket correctness came from the harness and chain, not visual interpretation.
