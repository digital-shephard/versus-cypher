# Agentic FX x402 Swap Endpoint

Status: public-testnet implementation

The endpoint lets an external agent request and complete a Versus V3 atomic
swap without owning a Cypher or joining Waku directly. Two ingress modes are
supported.

The original native-asset and advanced requester flow uses the Versus-specific
payment scheme:

`versus-atomic-fx-v3`

Generic EVM agents can instead call `/v1/fx/exact` with an ERC-20 that supports
EIP-3009. That endpoint emits the standard x402 v2 `exact` challenge and works
with ordinary x402 clients. It does not require the Versus SDK, a Cypher, or a
Waku connection.

## Generic `exact` Flow

The caller generates a 32-byte secret locally and submits only its hash with:

- a unique request ID
- payer address
- input EVM network and EIP-3009 token
- maximum source input
- output network, asset, and exact amount
- arbitrary destination address

The public relay signs and broadcasts the RFQ over Waku, selects a signed
dealer quote, and obtains a matching inventory reservation. It then returns a
normal x402 `402 Payment Required` response. The requirement identifies a
deterministic CREATE2 `payTo` escrow and the exact all-in source amount. The
response separately discloses dealer principal and the relay's facilitator
fee. Both must fit under the caller's signed maximum input.

An ordinary `@x402/fetch` client signs `TransferWithAuthorization` and retries
the same request. The relay submits the authorization to an ownerless factory.
In one atomic transaction the factory:

1. creates the precommitted one-trade escrow;
2. transfers the exact payment from the payer to that escrow; and
3. pays the disclosed facilitator fee; and
4. activates the frozen V3 source HTLC with dealer principal only.

Any failure rolls back all three operations, including use of the EIP-3009
authorization. The escrow address changes if the payer, canonical source lock
ID, dealer beneficiary, facilitator recipient or fee, secret hash, timeout, or
amount changes. The facilitator payment and HTLC activation share one atomic
transaction, so a failed source lock also rolls the fee back.

The caller polls `GET /v1/fx/exact/:tradeId`. Once the destination lock is
confirmed, it submits its secret to `POST /v1/fx/exact/:tradeId/reveal`. The
relay publishes the normal V3 reveal and the existing dealer/executor path
finishes both claims. If settlement times out, anyone can execute the escrow
refund and dealer principal returns to the original generic payer. A
facilitator fee already earned for successful source activation is not
refunded because the relay has already submitted and paid for that work.

The relay fee is separate from the dealer spread. The spread pays the dealer
for inventory and price risk. The disclosed facilitator fee pays the selected
relay for source-chain gas and may include a competitive profit margin. The
standard x402 amount is the all-in maximum the caller signs; the factory splits
the facilitator fee before activating the source HTLC with dealer principal.

Example request body:

```json
{
  "requestId": "0x<32-byte-unique-id>",
  "payer": "0x<payer>",
  "input": {
    "network": "eip155:84532",
    "asset": "0x<eip-3009-token>"
  },
  "maximumInputAtomic": "1005000",
  "output": {
    "network": "eip155:421614",
    "asset": "0x<destination-asset>",
    "amountAtomic": "1000000"
  },
  "destinationAddress": "0x<recipient>",
  "secretHash": "0x<keccak256-secret>"
}
```

First-version boundaries are deliberate:

- source assets must be ERC-20 tokens implementing EIP-3009;
- the standard payment signer must be an EOA with a 65-byte signature;
- native source assets continue to use `versus-atomic-fx-v3`;
- Permit2 and smart-contract-wallet signature adapters are not yet accepted;
- every chain, V3 adapter, token, and exact factory must appear in frozen
  operator configuration.

The relay is a facilitator and coordination adapter, not a custodian. Its
public settlement identity may earn a disclosed fixed fee for submitting the
atomic source transaction. It never receives authority to redirect dealer
principal, and its settlement signer can only submit the payer's authorization
to the deterministic ownerless factory. Competing relays may advertise
different fees; the caller's maximum remains authoritative.

## What The Caller Does

The following section describes the original `versus-atomic-fx-v3` requester
SDK path, which remains available for native assets and advanced clients.

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
- Completion requires both source and destination claim messages. Their
  arrival order does not matter, and a redundant completion postcard is not
  required for the requester to recognize final settlement.
- The custom V3 endpoint still requires a zero broker fee because it has no
  generic payment escrow. The generic exact endpoint instead pays its separate
  disclosed facilitator fee atomically before locking dealer principal.
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

To enable the generic exact endpoint alongside it:

```text
FX_X402_EXACT_ENABLED=1
FX_X402_EXACT_FACTORIES=<phase13 exact factory manifest>
FX_X402_EXACT_SETTLER_KEY_FILE=<dedicated low-balance relay key>
FX_X402_EXACT_FACILITATOR_FEE_ATOMIC=<fixed source-token fee>
```

The exact endpoint is `POST /v1/fx/exact`. Its first frozen public-testnet
cohort uses official Circle USDC on Base Sepolia and Arbitrum Sepolia. Native
assets and tokens without EIP-3009 continue through the custom endpoint.

The normal Phase 7 broker identity, Waku, deployment, data-directory, host,
and port settings are still required. A broker process has one deployment ID
and one Waku coordination domain. Enabling generic exact therefore moves that
whole process, including its custom native endpoint, to
`versus/deployments/fx/phase13-v3-exact-public-testnet.json` and
`phase13-x402-exact-factories.json`. A separate legacy process may retain the
Phase 12 domain during migration, but one process never mixes the two.
When x402 swaps are enabled, the broker derives its Waku coordination domain
from its frozen manifest. Startup fails if
`FX_PHASE7_COORDINATION_DOMAIN` conflicts with the manifest, preventing a
healthy-looking endpoint from publishing RFQs onto a topic the live desktop
dealers do not subscribe to.

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

The generic acceptance requester uses an encrypted payer keystore and a
separate encrypted crash-recovery record for its secret:

```text
FX_X402_TESTNET_ONLY=1
FX_X402_EXACT_ENDPOINT=https://relay-a.versuscypher.com/v1/fx/exact
FX_X402_EXACT_PAYER_KEYSTORE=<encrypted EOA keystore>
FX_X402_EXACT_PAYER_KEYSTORE_PASSWORD=<local password>
FX_X402_EXACT_RECOVERY_DIR=<private directory>
FX_X402_EXACT_RECOVERY_PASSWORD=<local password>
FX_X402_EXACT_INPUT_NETWORK=eip155:84532
FX_X402_EXACT_INPUT_ASSET=0x036cbd53842c5426634e7929541ec2318f3dcf7e
FX_X402_EXACT_MAXIMUM_INPUT_ATOMIC=12000
FX_X402_EXACT_OUTPUT_NETWORK=eip155:421614
FX_X402_EXACT_OUTPUT_ASSET=0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d
FX_X402_EXACT_OUTPUT_AMOUNT_ATOMIC=10000
FX_X402_EXACT_DESTINATION_ADDRESS=<arbitrary recipient>
```

Run `npm run fx:x402:exact:request --prefix packages/network`. It uses the
stock `@x402/fetch` client, waits for the independently observed destination
lock, reveals only then, and prints public evidence without credentials or the
secret.

## Public Testnet Acceptance

On 2026-07-30, a non-Cypher requester used the local HTTP endpoint to route a
Base Sepolia ETH to Arbitrum Sepolia ETH swap through public Waku and an
independent Mac dealer. Trade
`0x749ff8f9985118afeff864b26a1ddb5baf2838738477d6569ae14fe88a639ddf`
completed in approximately 64 seconds with exact destination output of
`100000000000000` wei.

Public settlement evidence:

- [Base source lock](https://sepolia.basescan.org/tx/0x480a0d37994cd1e464ce0a4fe1d8afe497474c754e9eee70469ed8a797308106):
  `0x480a0d37994cd1e464ce0a4fe1d8afe497474c754e9eee70469ed8a797308106`
  at block `44840300`
- [Arbitrum destination lock](https://sepolia.arbiscan.io/tx/0x834f2f5ada37074e7f9ff9387cd0d3304f8285105288346b9965d2e7c2a322fd):
  `0x834f2f5ada37074e7f9ff9387cd0d3304f8285105288346b9965d2e7c2a322fd`
  at block `293058975`
- [Arbitrum destination claim](https://sepolia.arbiscan.io/tx/0xa8415dca15d801e38168a3ceefd6efdceecacdcdcc0d7d6de5d74496a1c049cd):
  `0xa8415dca15d801e38168a3ceefd6efdceecacdcdcc0d7d6de5d74496a1c049cd`
  at block `293059019`
- [Base source claim](https://sepolia.basescan.org/tx/0x0f4e6c5a7277811bf009717dbb8a69efe0b223e35fa0319d4ec41d113fffc803):
  `0x0f4e6c5a7277811bf009717dbb8a69efe0b223e35fa0319d4ec41d113fffc803`
  at block `44840320`

The endpoint reported `complete` only after observing both claim messages.
The acceptance run used public testnets only.

### Generic exact acceptance

On 2026-07-31, an independent EOA using the stock `@x402/fetch` client called
the public Relay A `exact` endpoint. It had no Cypher identity and no Waku
connection. The public endpoint discovered and reserved a Windows desktop
dealer over Waku, returned a standard x402 v2 EIP-3009 challenge, atomically
split the disclosed facilitator fee, and activated the V3 source HTLC.

Trade
`0x9c70def6a1b8a92c2b8e29ababef734d1e86c8ef2373df3e0aeca15ae8cb9ed1`
completed in approximately 54 seconds:

- payer: `0xa4ac9532bf09d1992663b031e2ee15847f4f0a50`
- Base Sepolia input: `11,010` atomic USDC (`$0.01101`)
- relay facilitator fee: `1,000` atomic USDC (`$0.001`)
- dealer source amount: `10,010` atomic USDC (`$0.01001`)
- Arbitrum Sepolia output: exactly `10,000` atomic USDC (`$0.01`)
- destination recipient: the payer address above, which began with no
  Arbitrum gas and made no destination transaction

Public settlement evidence:

- [Base exact factory settlement](https://sepolia.basescan.org/tx/0xda1f0774cde518af311eb873329071897b314f7202c95412ff563e1a42033cef):
  `0xda1f0774cde518af311eb873329071897b314f7202c95412ff563e1a42033cef`
  at block `44880910`
- [Arbitrum destination lock](https://sepolia.arbiscan.io/tx/0x65a921c209cfba680dae6b1f5979a6171802868a2c0b4baebdbb33a0ecbe9553):
  `0x65a921c209cfba680dae6b1f5979a6171802868a2c0b4baebdbb33a0ecbe9553`
  at block `293383372`
- [Arbitrum destination claim](https://sepolia.arbiscan.io/tx/0x2edae797aeb6d3271826aec272470b7bb44db1476b4d68426f713680e23ea59a):
  `0x2edae797aeb6d3271826aec272470b7bb44db1476b4d68426f713680e23ea59a`
  at block `293383419`
- [Base source claim](https://sepolia.basescan.org/tx/0xa13529f455411367b58185fae2aafcaa3e04e963514af33a4b735e66639b3a45):
  `0xa13529f455411367b58185fae2aafcaa3e04e963514af33a4b735e66639b3a45`
  at block `44880928`

Post-settlement token balances independently reproduced the factory split:
the payer decreased by `11,010`, Relay A increased by `1,000`, the dealer
increased by `10,010` on Base and decreased by `10,000` on Arbitrum, and the
recipient increased by exactly `10,000` on Arbitrum. The endpoint reported
`complete` only after both claims.

## Operational Notes

- Put the public endpoint behind HTTPS and request-body logging controls.
- Protect it with IP/request concurrency limits before public exposure.
- Keep RPC credentials server-side and out of Waku messages.
- Monitor reservation timeouts, broadcast failures, and terminal defaults.
- A source lock can still require an onchain refund if settlement stalls.
