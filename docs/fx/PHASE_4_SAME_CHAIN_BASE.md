# Agentic FX Phase 4: Same-Chain Base Prototype

Phase 4 proves the smallest useful payment path without production funds,
production Waku, or cross-chain timing.

## Frozen Route

- Network: Base (`eip155:8453`)
- Buyer input: canonical Base EURC, 6 decimals
- Dealer output: canonical Base USDC, 6 decimals
- Exact output range: `0.100000` through `1.000000 USDC`
- Maximum total buyer input: `2.000000 EURC`
- Maximum quote lifetime: 20 seconds
- Settlement deployment: none

The checked route is recorded in
`packages/network/fixtures/fx-phase4-base-route.json`. It is development-only
and explicitly declares production Waku, production funds, and mainnet
deployment false.

The direct discovery laboratory queries one to eight explicitly configured
dealer endpoints, requires HTTPS outside localhost, verifies each EIP-712
signature locally, ignores failed or forged responses, and selects the cheapest
valid fixed quote deterministically. It does not use the production Waku fleet.

## Atomic Settlement

`SameChainSettlementV1` is one ownerless settlement contract for the reviewed
token pair. It is not deployed once per trade.

The dealer signs:

- buyer
- dealer compensation
- exact endpoint output
- endpoint recipient
- quote lifetime and nonce
- a commitment to the payment requirement

The buyer separately signs:

- the dealer quote digest
- maximum all-in input
- optional broker and exact broker fee
- acceptance lifetime and nonce

Any account may submit the transaction. Signatures prevent that submitter from
changing a party or amount. The contract then executes three fixed transfers:

1. buyer EURC to dealer
2. buyer EURC to the optional broker
3. dealer USDC to the endpoint

Every balance delta must equal the signed amount. Fee-on-transfer behavior,
insufficient approval, insufficient inventory, stale signatures, replay, and
partial execution all revert the complete transaction. The contract has no
owner, proxy, pause, sweep, arbitrary call, or native-asset path.

## Desktop Boundary

The public client does not import the Phase 4 controller. The development
toggle appears only when `VERSUS_FX_DEVELOPMENT=1` is present at launch and is
off initially.

Even then:

- preparing a route returns dealer compensation, broker fee, exact output,
  all-in input, and the buyer maximum
- execution requires a distinct `owner_ui` approval transition
- model output, thoughts, postcards, and Waku messages cannot approve
- the deterministic executor, not a model, constructs transaction calldata
- the raw signed transaction and hash are journaled before broadcast
- repeated execution is rejected
- restart reconciliation checks the recorded hash without rebroadcasting
- a dropped transaction can be owner-approved for rebroadcast only as the
  identical journaled raw transaction
- FX code has no import or call into rain, runway, vault, brain, or Waku code

The final FX screen is intentionally deferred. Phase 4 exposes the development
gate and headless proof without presenting an unfinished financial interface.

## Controlled x402 Demonstration

The fixture uses x402 v2 headers and CAIP-2 network identifiers, but its scheme
is deliberately named `versus-atomic-exact`. It is a controlled extension, not
a claim that arbitrary existing x402 servers understand Versus settlement.

The demonstrated flow is:

1. endpoint replies `402` with `PAYMENT-REQUIRED`
2. the requirement includes a unique payment identifier
3. the dealer quote commits to that exact requirement
4. the local EVM settles the signed route
5. the client retries with `PAYMENT-SIGNATURE`
6. the endpoint independently parses the confirmed `FxSettled` event from the
   exact frozen settlement address
7. the resource is released only when recipient, commitment, and exact output
   all match

Because all payment legs share one atomic transaction, failure has no funded
half-state to refund. The Phase 4 recovery equivalent is durable
submitted-transaction reconciliation. Cross-chain refunds remain a Phase 5
requirement.

## Evidence

Focused Hardhat:

```text
14 passing
```

Foundry invariants:

```text
2 passing
1,000 runs / 128,000 calls per invariant
0 handler reverts
```

The invariant campaign checks exact aggregate leg accounting and permanent zero
custody in the settlement contract.

Measured local fixture:

- settlement: `207,641` gas units
- deployment: `1,405,281` gas units
- dealer compensation: `0.510000 EURC`
- broker fee: `0.005000 EURC`
- exact endpoint output: `0.500000 USDC`
- all-in buyer input: `0.515000 EURC`
- settlement contract residue: zero EURC and zero USDC

The 2% dealer premium and 1% broker fee are illustrative fixture pricing, not a
live EURC/USDC market quote. Fiat gas cost depends on the live Base fee and ETH
price.

Machine-readable evidence:

- `versus/deployments/fx/same-chain-settlement-v1-build.json`
- `versus/deployments/fx/phase4-local-measurement.json`
- `packages/network/fixtures/fx-phase4-base-route.json`

## Remaining Boundary

Phase 4 does not prove:

- a Base mainnet deployment
- live dealer capital
- arbitrary x402 compatibility
- cross-chain locks, secrets, claims, or refunds
- Waku RFQ discovery
- a public requester interface

Those are later phases. Nothing in this phase should be marketed as a live FX
service.

## Primary References

- Circle EURC addresses:
  `https://developers.circle.com/stablecoins/eurc-contract-addresses`
- Circle USDC addresses:
  `https://developers.circle.com/stablecoins/usdc-contract-addresses`
- Coinbase x402 payment flow:
  `https://docs.cdp.coinbase.com/x402/core-concepts/how-it-works`
- Coinbase x402 v2 headers and extensions:
  `https://docs.cdp.coinbase.com/x402/support/faq`
