# Agentic FX mainnet-v1 canary — 2026-08-17

Status: **passed**. This is bounded two-device canary evidence, not general
mainnet activation or an uptime claim.

## Frozen cohort

- Contract source commit: `cc99a5acce22df2fd77a288b13cf7bf8a90c6bb1`
- Deployment freeze commit: `3b733243b925179b31d7f10caaf2e367528f17f5`
- Canary/runtime checkpoint: `3d0eb0d`
- Deployment ID: `0x950fecd8a9d624ef88690f9ee455d36437934f5499c2ba3a4c1674df871b57f2`
- Coordination domain: `0xd67858f889c63e8979f846f938ab3089ad7c3defaeb124fdc0bbf269c137e046`
- Shape: six positions, 30 directed routes, ten verified contracts, four exact factories

Immediately before the canary, the desktop mainnet runtime preflight rechecked
all ten deployment receipts, all four exact-factory runtime hashes and wiring,
the complete route shape, current chain heads, and a fresh 2-of-2 signed
ETH/AVAX/EURC price quorum.

## Physical devices and route

- Requester: Windows, `0x84859767a13eecebed772e1cf53db2b344befc71`
- Dealer: separate macOS device, `0xd8a36db2706170df8c6ebafd005a885b442cd9c7`
- Transport: two public Versus Waku peers; requester FX mesh `ready`; dealer
  LightPush, Filter, and Store each reported two peers
- Route: Base native ETH to Avalanche C-Chain native AVAX
- Quote: 5 bps spread, zero broker fee
- Exact source lock: `33838191420600` wei (`0.0000338381914206 ETH`)
- Exact destination delivery: `10000000000000000` wei (`0.01 AVAX`)
- Terminal desktop state: `funds_ready`
- Trade ID: `0x716e96c415c27cbfeb8ef6d0d958ed5268c211892b297754b21cb9098ee3bc67`

After the receipt and dual-RPC audit completed, the macOS operator disarmed the
dealer at HEAD `3b733243b925179b31d7f10caaf2e367528f17f5`. The process remained healthy
with two LightPush, two Filter, and two Store peers and no sanitized error. No
additional transaction was sent during shutdown.

The requester runtime identified itself as `mainnet-v1-candidate`, exposed
`productionFunds: true`, rendered `MAINNET` on both swap surfaces, and bound the
recipient to the requester identity accepted by the prior physical 30-route
testnet matrix. A different preparatory profile/address mismatch was caught
before quote acceptance; it sent no swap or contract transaction.

## Public chain evidence

| Leg | Transaction | Block | Two-RPC result |
| --- | --- | ---: | --- |
| Base source lock | [`0x3a51d36a…e30b5d`](https://basescan.org/tx/0x3a51d36ad1d6c8eb7df9fc075b43a26cadad1e8e1b2eebae3ba38bda94e30b5d) | 50117307 | identical successful receipt |
| Avalanche delivery | [`0x2f91f400…ef4666`](https://snowtrace.io/tx/0x2f91f4002eaa78f5d3d5b3f4a14a90959c05b38bcc6350a77905599490ef4666) | 93074776 | identical successful receipt |

The destination receipt observed the exact required `0.01 AVAX` with three
confirmations and no failure. After settlement, both RPCs per chain agreed on
the requester balances:

- Base: `0.00056572329150655 ETH`
- Avalanche: `0.18 AVAX`

## Reproducibility closeout

After the canary, both reviewed build generators were rerun:

```powershell
npm run fx:freeze:evm-v3 --prefix versus
npm run fx:freeze:exact --prefix versus
```

The regenerated `evm-htlc-v3-build.json` and `evm-exact-build.json` produced
byte-for-byte zero tracked diff. The desktop suite passed all 225 tests at the
runtime-label/preflight checkpoint.

## Residual gates

The canary does not close production service reliability or public-release
governance. General activation still requires:

- independently billed and administered primary/fallback Base RPCs with
  identical preflight behavior;
- normal signed desktop release and rollout controls;
- bounded dealer policy and explicit operator activation; and
- ongoing relay/RPC monitoring rather than treating free public endpoints as
  an SLA.
