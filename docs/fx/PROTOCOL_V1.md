# Versus Agentic FX Protocol V1

Status: Phase 1 executable specification

Protocol: `versus-fx`

Version: `1`

Decision lineage: `FX0-2026-07-25`

This document specifies signed FX coordination messages, deterministic route
selection, and local state transitions. It does not specify or deploy the
conditional-lock contracts. Financial implementation begins only after the
simulator and adapter phases.

Normative implementation:

- Client: `packages/network/src/fx-protocol.js`
- Relay: `versus-waku-relay/src/fx-protocol.mjs`
- Client vectors: `packages/network/fixtures/fx-phase1-v1.json`
- Relay vector: `versus-waku-relay/fixtures/fx-phase1-v1.json`

## Normative Language

The words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY describe protocol
requirements.

## Security Model

- Messages are signed claims, not economic truth.
- Chain evidence determines lock, claim, refund, and finality truth.
- A requester chooses and signs its own route.
- A dealer chooses and signs its own quote and inventory commitment.
- A broker proposes a route but cannot authorize either party.
- A relay transports messages but cannot declare settlement.
- A model may propose a typed action but cannot sign, fund, address, or execute
  a trade; deterministic owner policy and wallet code retain those powers.
- Default and dispute messages are evidence inputs interpreted locally. They do
  not change custody state.

## Canonical Envelope

Every unsigned message contains exactly:

```text
protocol
version
deploymentId
type
tradeId
sender
role
sequence
createdAt
expiresAt
payload
```

Signed envelopes add:

```text
signature
id
```

Unknown fields MUST be rejected.

### Field rules

| Field | Rule |
|---|---|
| `protocol` | exactly `versus-fx` |
| `version` | integer `1` |
| `deploymentId` | lowercase `bytes32` separating deployments |
| `type` | one V1 message type |
| `tradeId` | lowercase `bytes32` generated for one trade |
| `sender` | normalized lowercase EVM address used for message signing |
| `role` | `requester`, `dealer`, `broker`, or `relayer` |
| `sequence` | canonical decimal unsigned-integer string |
| `createdAt` | positive safe Unix timestamp |
| `expiresAt` | positive safe Unix timestamp |
| `payload` | exact schema for the selected type |
| `signature` | 65-byte EVM personal-sign signature |
| `id` | Keccak-256 hash of canonical unsigned bytes |

Addresses are normalized through EIP-55 validation and serialized lowercase.
Amounts and chain IDs are decimal strings with no leading zeroes after
normalization. JavaScript numbers are used only for safe integer timestamps,
durations, BPS, and adapter versions.

## Canonicalization And Signing

1. Validate and normalize the unsigned message.
2. Recursively serialize objects with lexicographically sorted keys.
3. Preserve array order after field-specific normalization.
4. Encode the canonical JSON as UTF-8.
5. Compute:

```text
id = keccak256(utf8(canonicalMessage))
```

6. Sign the canonical message bytes using EVM personal-sign semantics.
7. Verify that the recovered signer equals `sender`.

Input options and evidence IDs are sorted during normalization. Duplicate
chain/token input options and duplicate evidence IDs are rejected.

The frozen interoperability vector is:

```text
id = 0xa79ffb683f60b819beac7a9e07adf69c7d154b9d2642f41bee651fe011cc9fac
```

Both independent implementations MUST produce that ID from their local
`fx-phase1-v1.json` vector.

## Roles By Message

| Message | Allowed roles |
|---|---|
| `fx_rfq` | requester |
| `fx_quote` | dealer |
| `fx_accept` | requester |
| `fx_reserve` | dealer |
| `fx_cancel` | requester |
| `fx_lock_source` | requester |
| `fx_lock_destination` | dealer |
| `fx_claim` | requester, dealer, relayer |
| `fx_refund` | requester, dealer, relayer |
| `fx_complete` | requester, dealer, broker, relayer |
| `fx_default` | requester, dealer |
| `fx_dispute` | requester, dealer |

A role mismatch is invalid even when the signature is cryptographically valid.

## Message Schemas

### `fx_rfq`

Public short-lived request for exact destination output.

```text
outputChainId
outputToken
outputAmountAtomic
inputOptions[]:
  chainId
  token
  maxInputAtomic
quoteDeadline
settlementDeadline
quotePolicy
x402Commitment
```

Rules:

- one to four unique input chain/token options
- positive exact output
- quote deadline inside the RFQ lifetime
- settlement deadline after quote deadline
- policy is `lowest_all_in` or `fastest`
- x402 commitment is lowercase `bytes32` or `null`
- maximum RFQ lifetime is 60 seconds

The RFQ MUST NOT contain source or destination wallet addresses.

### `fx_quote`

Dealer's fixed exact-output offer.

```text
rfqId
inputChainId
inputToken
inputAmountAtomic
outputChainId
outputToken
outputAmountAtomic
quoteType
referenceSource
referencePriceMicros
referenceTimestamp
spreadBps
dealerSettlementCostAtomic
estimatedCompletionSeconds
adapterId
adapterVersion
```

Rules:

- quote type is exactly `fixed_exact_output`
- spread is between 0 and 10,000 BPS
- input amount already includes dealer-charged economics
- quote references one RFQ ID
- maximum quote lifetime is 60 seconds
- route selection rejects stale or future reference prices

The reference price is evidence explaining the quote. The signed exact amounts,
not the reference price, define settlement.

### `fx_accept`

Requester selects one signed quote and commits settlement details privately to
the selected dealer.

```text
rfqId
quoteId
routeId
dealerInputAmountAtomic
brokerFeeAtomic
totalInputAtomic
outputAmountAtomic
secretHash
sourceRefundAddress
destinationClaimAddress
sourceAdapterId
sourceAdapterVersion
destinationAdapterId
destinationAdapterVersion
```

The raw secret MUST NOT appear in any protocol message.

`routeId` is the locally recomputed route hash. The input fields bind the
dealer amount, broker fee, and their exact sum. `totalInputAtomic` MUST equal
`dealerInputAmountAtomic + brokerFeeAtomic`.

### `fx_reserve`

Dealer confirms capacity and counterparty-specific addresses.

```text
acceptId
quoteId
dealerSourceClaimAddress
dealerDestinationRefundAddress
reservationDeadline
```

The reservation deadline MUST be inside the message lifetime.

### `fx_cancel`

Requester releases an accepted dealer reservation before any source lock
exists.

```text
acceptId
reserveId
reason
```

The reason is exactly `owner_cancelled`. The requester signature MUST match the
original RFQ sender, both references MUST belong to the same trade, and the
reservation MUST reference the same acceptance. Cancellation advances only
`quote_accepted -> cancelled`; it is invalid after a source lock exists.

### `fx_lock_source` and `fx_lock_destination`

Signed references to independently verifiable funded locks.

```text
acceptId
chainId
token
amountAtomic
lockAddress
beneficiary
refundAddress
secretHash
timeout
transactionHash
blockNumber
```

The timeout MUST follow the message timestamp. Cross-message verification in
later phases MUST additionally enforce:

- exact accepted amounts and tokens
- exact beneficiary and refund addresses
- identical secret hash
- accepted adapter and bytecode
- source timeout safely longer than destination timeout
- required chain confirmations

### `fx_claim`

Reference to a claim transaction:

```text
lockMessageId
chainId
transactionHash
blockNumber
secretHash
beneficiary
```

The secret itself is extracted from independently verified chain execution.
It is never copied into the Waku envelope.

### `fx_refund`

Reference to a refund transaction:

```text
lockMessageId
chainId
transactionHash
blockNumber
beneficiary
```

### `fx_complete`

Compact completion claim:

```text
acceptId
sourceClaimMessageId
destinationClaimMessageId
```

This message is a convenience index. Clients MUST verify both claim
transactions and their lock lineage.

### `fx_default`

Signed allegation supported by evidence:

```text
acceptId
reason
missingLeg
observedAt
evidenceIds[]
```

Allowed reasons:

- `requester_abandoned`
- `dealer_abandoned`
- `invalid_lock`
- `timeout`
- `chain_unavailable`
- `endpoint_failure`

Allowed missing legs:

- `source_lock`
- `destination_lock`
- `destination_claim`
- `source_claim`
- `endpoint_delivery`

### `fx_dispute`

Counter-evidence for a default allegation:

```text
defaultId
reason
evidenceIds[]
```

The protocol intentionally has no canonical global `fx_resolution`. Each
client evaluates verified evidence under local policy.

## Temporal Rules

| Type | Maximum message lifetime |
|---|---:|
| RFQ | 60 seconds |
| Quote | 60 seconds |
| Accept | 10 minutes |
| Reserve | 10 minutes |
| Cancel | 60 seconds |
| Economic evidence | 30 days |

Normal envelope verification permits at most five minutes of local wall-clock
skew. Route selection is stricter:

- RFQ and quote must be unexpired at the evaluation time
- quote must have been created by the RFQ quote deadline
- reference timestamp must not be in the future
- reference age defaults to at most 60 seconds

Onchain timeout and finality checks MUST use verified chain data rather than
local wall-clock belief.

## Settlement State Machine

Happy path:

```text
idle
  -> rfq_open
  -> quote_accepted
  -> source_locked
  -> destination_locked
  -> destination_claimed
  -> complete
```

Refund paths:

```text
source_locked -> refunded

destination_locked
  -> destination_refunded
  -> refunded
```

Pre-lock cancellation:

```text
quote_accepted -> cancelled
```

An RFQ may expire before acceptance. An accepted quote may be cancelled only
before a source lock is confirmed.

Invalid state transitions MUST fail. A completion message does not advance
state unless its referenced chain evidence passes later-phase verification.

## Case State Machine

Settlement custody and reputation cases are separate:

```text
none
  -> reported
  -> disputed
  -> resolved_upheld | resolved_rejected
```

Local clients may resolve a report directly from `reported` when evidence is
already sufficient. Resolution is local derived state, not a globally signed
network verdict.

## Deterministic Single-Dealer Routing

V1 routing accepts:

- one verified signed RFQ
- one or more verified signed quotes
- an explicit broker fee denominated in the quoted input asset
- an evaluation timestamp
- a route policy

A candidate is excluded when:

- signature or ID is invalid
- deployment or trade differs
- RFQ lineage differs
- quote arrived after the quote deadline
- quote is expired
- reference price is stale or future-dated
- exact output differs
- input chain or token was not offered
- all-in input exceeds requester maximum

All-in input is:

```text
dealer input amount + explicit broker fee
```

The all-in value, not merely the dealer amount, MUST be at or below the
requester's `maxInputAtomic`.

`lowest_all_in` ordering:

1. lowest all-in input
2. shortest estimated completion
3. lexicographically lowest quote ID

`fastest` ordering:

1. shortest estimated completion
2. lowest all-in input
3. lexicographically lowest quote ID

The route result is canonicalized and hashed into `routeId`. The broker's route
is never accepted without local recomputation.

## Privacy Classes

### Public discovery

- envelope routing fields
- desired output
- acceptable input chain/token pairs
- maximum input
- quote policy

### Selected counterparty only

- requester refund address
- requester destination claim address
- dealer source claim address
- dealer destination refund address
- secret hash

### Public after chain broadcast

- lock address
- beneficiary and refund address
- transaction hash and block
- timeout

### Local only

- raw secret
- wallet private keys
- unrelated wallet history
- unallocated dealer inventory

Transport encryption and sealed RFQs are later work. V1 schemas preserve
progressive disclosure but do not claim network-level metadata privacy.

## Replay And Domain Separation

The signed hash binds:

- protocol and version
- deployment ID
- message type
- trade ID
- sender and role
- sender sequence
- timestamps
- exact payload

Stores MUST deduplicate by message ID. Later Phase 2 state handling MUST also
enforce monotonic or previously unused sender sequence within a trade and
reject duplicate economic actions even if wrapped in a newly signed message.

## Explicit V1 Non-Claims

Phase 1 does not provide:

- settlement contracts
- funded swaps
- Waku FX topics
- broker deployment
- multi-dealer routes
- Bitcoin support
- sealed RFQs
- automatic dealer operation
- legal or sanctions clearance

It provides an executable, cross-repository agreement about what future
coordination bytes mean.
