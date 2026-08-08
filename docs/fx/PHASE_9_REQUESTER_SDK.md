# Phase 9 Requester Funding SDK

> The original Phase 9 SDK intentionally stops after preparing requester
> funds. The later public-testnet x402 composition that performs the complete
> V3 atomic swap is documented in
> [`X402_SWAP_ENDPOINT.md`](./X402_SWAP_ENDPOINT.md).

Phase 9 lets an ordinary wallet request exact-output Agentic FX funding without
hatching a Cypher. It does not let Versus spend the resulting funds.

## Boundary

The SDK performs one job:

1. Read an x402 `PAYMENT-REQUIRED` challenge locally.
2. Extract only the required EVM chain, token, and amount.
3. Sign an exact-output Versus RFQ with the requester's wallet.
4. Query one or more brokers and reproduce the selected route locally.
5. Bind settlement output to the same requester-owned address.
6. Persist the encrypted HTLC secret before any settlement action.
7. Sign an `fx_accept` binding the route, secret hash, source refund address,
   and destination claim address.
8. Run an injected settlement executor.
9. Independently verify the destination transaction.
10. Return a `versus-fx-funds-ready` receipt.
11. Stop.

The requester's x402 client may then pay the endpoint itself. That later
payment is not a Versus settlement action and is not represented as one.

## Privacy

The public RFQ contains:

- destination chain
- destination token
- exact output amount
- acceptable input assets and maximum inputs
- short deadlines and route policy

It does not contain:

- endpoint URL
- resource path
- endpoint payment recipient
- resource description
- wallet private key
- HTLC secret

The SDK computes a digest of the complete x402 requirement for local
correlation, but sets the network RFQ's `x402Commitment` to `null`. Brokers and
dealers therefore cannot use Versus traffic to learn which resource caused the
funding request.

## Wallet and destination

The signer implements only:

```ts
interface WalletSigner {
  getAddress(): Promise<string>;
  signMessage(message: string | Uint8Array): Promise<string>;
}
```

The requested destination must equal that signer's address. The accepted
route and eventual HTLC acceptance bind the destination again. A broker,
dealer, or relayer cannot replace it and still obtain a `fundsReady` receipt.

Phase 9 does not ask for, export, or persist a raw wallet private key.

## Recovery

Before the settlement executor is called, the SDK writes an AES-256-GCM
recovery packet using the existing crash-safe recovery format. The packet is
scoped to:

- deployment ID
- trade ID
- secret hash

The plaintext HTLC secret is never returned in the quote, result, or receipt.
Recovery re-runs independent destination verification before returning
`fundsReady`.

## Receipt

`fundsReady` requires an independently confirmed destination observation whose:

- chain matches the selected output chain
- token matches the selected output token
- amount is at least the required exact output
- beneficiary is the requester-bound destination
- transaction hash is valid
- confirmation count is positive

The receipt explicitly records:

```json
{
  "status": "funds_ready",
  "endpointPaymentAuthorized": false,
  "endpointPaymentSubmitted": false
}
```

An endpoint failure after this receipt does not turn a completed FX settlement
into a failed swap. Endpoint payment and resource delivery belong to the
requester's own client and produce their own evidence.

## Integration

Use the typed subpath:

```ts
import {
  FxRequesterFundingSdk,
  parseX402PaymentRequiredHeader
} from "@versus/network/fx-requester";
```

The settlement executor is injected so applications can compose the SDK with
the reviewed EVM coordinator or a future chain-family adapter. The destination
verifier is independently injected and is mandatory.

Run the controlled handoff:

```bash
npm run fx:phase9:handoff --prefix packages/network
```

Run the focused tests:

```bash
node --test packages/network/test/fx-phase9.test.js
```

The controlled handoff uses no production funds and performs no endpoint
payment.

## Explicit exclusions

- no mainnet funds
- no desktop UI
- no automatic x402 payment
- no endpoint credentials or resource fetch
- no Versus social identity
- no custodial account
- no arbitrary destination
- no claim that an endpoint delivered a resource
