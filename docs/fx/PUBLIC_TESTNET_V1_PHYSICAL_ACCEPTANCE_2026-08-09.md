# Agentic FX Public-Testnet V1 Physical Acceptance

Date: 2026-08-09

Result: **accepted for the physical two-device and public-relay gates**. This
checkpoint does not authorize mainnet deployment, production funds, or an
unrestricted release.

## Scope

The requester ran on Windows and the dealer ran on a separate macOS device.
They used the frozen Base Sepolia/Avalanche Fuji deployment
`0x8cd9ede68d18e52213372ed6041bdb83867c5846119461c860d95f74e689ed54`
and the two public Versus Waku relays. The physical campaign spanned commits
`e25bbd0` through `5343cfe`; the final 30-route matrix used Windows requester
commit `5343cfe` and macOS dealer commit `6a1044d`.

The macOS device also connected from an IPv6-only T-Mobile hotspot. Both
dual-stack relay peers connected over IPv6 with two LightPush, two Filter, and
two Store peers. This exercises a materially different network path from the
Windows requester instead of treating two processes on one workstation as two
devices.

## Results

- All 30 directed market routes reached `funds_ready` with 30 unique route
  pairs and 30 unique trade IDs. This includes all 12 same-chain routes and all
  18 cross-chain routes among ETH, AVAX, USDC, and EURC.
- The public Waku transport moved from `wait` back to `ready`; the combined
  client state returned to `caught_up`. The dealer remained armed with two
  LightPush, Filter, and Store peers after reconnect.
- Four stock generic x402 exact payments reached terminal `complete`: USDC and
  EURC as inputs on Base Sepolia and USDC and EURC as inputs on Avalanche Fuji.
  Each case created the source escrow, paid the facilitator fee, settled the V3
  destination, revealed the secret, and completed over the public relay path.
- One trade interrupted during the campaign reached the expected
  destination-refunded/requester-`refund_wait` state. A fresh replacement for
  that route then reached `funds_ready`; it was not relabeled as the timed-out
  trade.
- Regenerating the committed V3 and exact build freezes at `5343cfe` produced
  byte-for-byte identical files. Their Git blob IDs remained
  `12ce2c8490fb42529a1575bde1bee43189d49828` and
  `bca57af8d5c989dc7746fde2c2cd7f1bbe94259d`, respectively.

The complete network suite passes 259/259 tests and the complete desktop suite
passes 225/225 tests at the accepted requester commit.

## Public transaction evidence

| Input | Output | Trade ID | Source transaction | Destination transaction |
| --- | --- | --- | --- | --- |
| Base Sepolia USDC | Fuji EURC | `0x3eeac54fd1fde38b56bffc7a21dab7bc128d65e0252aa1fe1797f309dfff547f` | `0x9f2c04503ebc95b0eef56403d356b3143aff1ff94afb26298c43b5eb06ac9747` | `0x6a0501baa99f569474776d877eab0422255c950bbde1c0ba22ad627778799b71` |
| Base Sepolia EURC | Fuji USDC | `0xcfbdcc97d179e26266f2d6ac2ca59056e8abb464a704ab665ee4ba56caed0fce` | `0xda0ae76b7d74d5309e8ca1b02aa669e53def11dde74ce5ba6b4d3cdeb0c9c245` | `0xcd68111df00cf0ceeb695dd72124691b069cfe5c82173b84079576592df112eb` |
| Fuji USDC | Base Sepolia EURC | `0xecdce3a481d037a72276a8892305c2bd1cd820204c95f7f1bf86b55734aba104` | `0xe5df146cd31633a25957d57f61734f8c7ef1e4bb818310f74402e5130ba2ae23` | `0x6ee1a3002fbcc0c870fd72f2730579ea770b9d7483437305cbb354f18e305027` |
| Fuji EURC | Base Sepolia USDC | `0xc455c805e3b56b3ba2157d2ec47e5a056f8f03ea59053a419c90cb6e5f078e18` | `0x58789ab3e04b07afe8a2223661f63c034ff6d85807d049b2997b8e25e758af48` | `0xa83d33fa12fb39d323f561cad19ffa6a83f82c0b9298e137c1b5e5ddfc269c64` |

## Evidence handling

The complete two-device matrix evidence has SHA-256 digest
`640073084c7d7d015cfa9f8fe7e4c9a335204939c1abeb5cae0f44b9480e98c5`.
The four completed x402 recovery records have SHA-256 digests, in table order:

- `4cf33455cd78f0d87bd5bfcb385b0870423032c86b2c1d6bb1cb39f587dad1de`
- `eb97e918755ab324a51b0dc010a865b2f62b35d39bbe528c82adefa66bf40e85`
- `46b05efc23480ddfcb729372c3133c04d38e088211b44d7668ba612d536ac06a`
- `3e6a870ac75ef74933e48f61b0f1b4b0a965ef79a0aaa4c3a1642aa32e167ff4`

The raw files remain untracked because the x402 recovery records contain
encrypted secret-recovery material and the matrix includes local diagnostic
details. This document preserves only sanitized public evidence.

## Boundary

The physical testnet acceptance gates are closed. Mainnet remains blocked on
the separate final ceremony: review and merge the accepted commit, regenerate
freezes with zero diff from that merge, inspect every address and bytecode hash,
and obtain explicit authorization before one tiny mainnet canary. Nothing in
this checkpoint authorizes a mainnet transaction.
