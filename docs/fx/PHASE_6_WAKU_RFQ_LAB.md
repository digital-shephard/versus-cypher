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
- Store recovery is bounded to 15 minutes and 512 messages by default.
- Per-sender, global, active-RFQ, pending-dependency, and replay-memory limits
  fail closed.
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

On 2026-07-26 a requester published while the deterministic dealer was offline.
The dealer later joined through the two public relays, recovered the RFQ from
Waku Store, published a quote, and completed signed acceptance and reservation.
Both journals converged to:

`0x630d7062d7655cf6a67c44fbe15c87c38d0b58a10a6e3e902b2c2e128fae4ee7`

Waku was then deliberately closed before settlement. The same trade ID,
`0xf3a9f5b111aaa1bcb213c10ef931185271fecd0d537d7e11086e40e650b32c7b`,
completed through the Phase 5 adapters on Base Sepolia and Arbitrum Sepolia:

| Action | Chain | Transaction |
| --- | --- | --- |
| Source approval | Base Sepolia | `0x4b199c2a3d0c91a7d7183610a5f28a84c89b4af03366c0304ae9ed9915a2b6c0` |
| Source lock | Base Sepolia | `0x9aa4cb30a660ec71989c661c35b697943c3f68f38a620f82575ac287231513c4` |
| Destination approval | Arbitrum Sepolia | `0xa26a35dba4ac34a4cf6cab9c15b1c791bb4ccb64dceda4887ceba7b0694b62ee` |
| Destination lock | Arbitrum Sepolia | `0xd93df6480f131274f8280a87e26e0bdc748c155d99590c7f3cd37c90dfcbd596` |
| Destination claim | Arbitrum Sepolia | `0xcb22ee12b28f7135244e2f5c3d3931f47b6e3dc4db17302383f2afa3da48edf1` |
| Source claim | Base Sepolia | `0x452f668e10a9ebf6e00ddac3402527f2acda79ff23fefa62dac178f004d8ecbd` |

The encrypted recovery packet was written before either lock transaction. No
swap secret appears in Waku messages or this report.

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
- peer loss and subscription reconstruction after resume;
- settlement completion after all Waku notifications stop.

The public proof also demonstrated independent connectivity to both relays:
each light client observed two LightPush, Filter, Store, and Relay peers.
