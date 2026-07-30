# Agentic FX x402 Swap Endpoint

Status: public-testnet implementation

The endpoint lets an external agent request and complete a Versus V3 atomic
swap without owning a Cypher or joining Waku directly. It uses standard x402
HTTP response mechanics with a Versus-specific payment scheme:

`versus-atomic-fx-v3`

This is not Coinbase's generic EVM `exact` scheme. A generic x402 client will
see the challenge but needs the Versus requester SDK to understand the
reservation and HTLC stages.

## What The Caller Does

The caller invokes one SDK method with:

- source chain, asset, and maximum input
- destination chain, asset, and exact output
- destination address
- a local EVM signer for the source chain
- an encrypted recovery-file password

The SDK performs the HTTP exchanges, signs the source lock locally, monitors
status, and reveals the secret only after the destination lock is confirmed.
The endpoint never possesses the requester's signing key.

## HTTP Sequence

1. `POST /v1/fx/swaps`

   The body contains a requester-signed V3 RFQ, destination address, source
   refund address, and secret hash. The signed RFQ commits to all four values.
   The endpoint publishes the RFQ through its Waku broker and returns `402`
   with an `accept` requirement containing the signed best route.

2. Retry with `PAYMENT-SIGNATURE`, stage `accept`

   The SDK verifies the broker proposal and signs `fx_accept`. The endpoint
   publishes it and waits for the selected dealer's matching `fx_reserve`.
   It returns another `402`, this time with an exact source-HTLC transaction
   template.

3. Retry with `PAYMENT-SIGNATURE`, stage `fund`

   The SDK independently checks the frozen V3 manifest, signs exactly that
   funding transaction, and sends the serialized signed transaction. The
   endpoint verifies chain, signer, adapter, calldata, and value before
   broadcasting. A changed recipient, value, hashlock, beneficiary, timeout,
   or adapter is rejected.

4. `POST /v1/fx/swaps/:tradeId/source-lock`

   After confirmation, the SDK signs the resulting `fx_lock_source` envelope.
   The endpoint publishes it to Waku.

5. `GET /v1/fx/swaps/:tradeId`

   The SDK polls the public trade status. Once the dealer's destination lock
   arrives, the endpoint exposes its message ID.

6. `POST /v1/fx/swaps/:tradeId/reveal`

   The SDK signs `fx_reveal` locally and submits it. The endpoint validates
   that it names the confirmed destination lock, then publishes it. At this
   point the secret is intentionally public on Waku and both HTLC claims are
   enabled.

7. The SDK waits for `fx_complete`.

The endpoint returns a `PAYMENT-RESPONSE` header when source funding confirms.
The final method result is returned only after the atomic swap completes.

## Safety Properties

- The requester secret is encrypted locally before any RFQ is sent.
- The endpoint sees only the secret hash until the destination HTLC exists.
- The source refund address must equal the source transaction signer.
- The source transaction can fund only the frozen V3 adapter with exact
  calldata and value.
- The endpoint cannot redirect funds or sign a replacement transaction.
- Raw signed transactions and plaintext secrets are excluded from the x402
  swap journal.
- A repeated funding request broadcasts the same transaction at most once.
- Acceptance, reservation, transaction hash, block, and public coordination
  message IDs survive restart.
- Broker fees must be zero in this version because V3 has no safe broker split
  in its source lock. Dealer spread and executor bounty remain in the quote.
- Native ETH works directly. ERC-20 input requires an existing sufficient
  allowance to the frozen source adapter.

## Runtime

The existing broker process hosts both route and swap endpoints. x402 swaps
are off by default.

Required configuration when enabling the public-testnet endpoint:

```text
FX_X402_SWAP_ENABLED=1
FX_X402_BASE_SEPOLIA_RPC_URL=<read-write Base Sepolia RPC>
FX_X402_ARBITRUM_SEPOLIA_RPC_URL=<read-write Arbitrum Sepolia RPC>
```

The normal Phase 7 broker identity, Waku, deployment, data-directory, host,
and port settings are still required. The deployment ID must match
`versus/deployments/fx/phase12-v3-public-testnet.json`.

Launch:

```powershell
npm run fx:x402:broker --prefix packages/network
```

The process refuses manifests containing chains other than Base Sepolia and
Arbitrum Sepolia. Mainnet enablement is a later acceptance gate.

The test requester uses an encrypted keystore and refuses to run without an
explicit testnet flag:

```text
FX_X402_TESTNET_ONLY=1
FX_X402_ENDPOINT=http://127.0.0.1:8787/v1/fx/swaps
FX_X402_REQUESTER_KEYSTORE=<encrypted keystore path>
FX_X402_REQUESTER_KEYSTORE_PASSWORD=<local password>
FX_X402_RECOVERY_DIR=<private recovery directory>
FX_X402_RECOVERY_PASSWORD=<local recovery password>
FX_X402_INPUT_CHAIN_ID=84532
FX_X402_OUTPUT_CHAIN_ID=421614
FX_X402_MAX_INPUT_ATOMIC=<maximum source wei>
FX_X402_OUTPUT_AMOUNT_ATOMIC=<exact destination wei>
```

The two RPC variables used by the broker are also required by the requester.
Native ETH is the default input and output asset. Run:

```powershell
npm run fx:x402:request --prefix packages/network
```

## Operational Notes

- Put the public endpoint behind HTTPS and request-body logging controls.
- Protect it with IP/request concurrency limits before public exposure.
- Keep RPC credentials server-side and out of Waku messages.
- Monitor reservation timeouts, broadcast failures, and terminal defaults.
- A source lock can still require an onchain refund if settlement stalls.
