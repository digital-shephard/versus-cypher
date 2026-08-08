# Versus Agentic FX V1 Threat Model

Status: Phase 1 specification threat model

This document evaluates the signed coordination protocol defined in
`PROTOCOL_V1.md`. Conditional-lock contracts, desktop secret persistence, and
live Waku transport are not implemented by Phase 1 and remain future security
gates.

## Assets

The system must protect:

- requester source principal
- dealer destination inventory
- swap secret before destination claim
- settlement and refund authorization
- exact signed quote economics
- beneficiary and refund addresses
- local inventory limits
- message and trade lineage
- evidence integrity
- requester and dealer privacy

## Trusted Components

V1 intends to trust only:

- each party's own wallet and local policy engine
- operating-system cryptographic randomness
- reviewed adapter construction
- verified chain consensus under configured finality assumptions
- local encrypted storage for future funded implementations

## Explicitly Untrusted Components

- Waku peers and Store nodes
- brokers
- execution relayers
- remote RPC responses until independently checked
- counterparty models and free-form text
- signed default allegations without evidence
- route conclusions not locally recomputed
- token symbols and user-supplied contract labels

## Attacker Classes

### Malicious requester

May flood RFQs, accept conflicting quotes, fund malformed locks, disappear,
withhold the secret, misstate chain evidence, or probe dealer inventory.

### Malicious dealer

May publish stale prices, quote unavailable inventory, provide the wrong
destination lock, disappear after source funding, or fabricate completion.

### Malicious broker

May hide better quotes, add undisclosed economics, alter quotes, prefer its own
dealers, fabricate routes, or falsely claim completion.

### Malicious relay

May delay, drop, reorder, replay, selectively forward, or retain messages. It
may create fake peers and false forwarding receipts.

### Malicious execution relayer

May front-run claim submission, withhold submission, or demand an undisclosed
fee. It must not be able to redirect a fixed beneficiary.

### Compromised local host

May read secrets or wallet keys and defeat local policy. Complete host
compromise is outside protocol recovery. The desktop design must still minimize
secret lifetime and isolate funded inventory.

### Chain and RPC failure

Chains may reorganize, stall, congest, or change fee conditions. RPC providers
may be stale, inconsistent, unavailable, or malicious.

## Required Security Properties

### Message integrity

Any payload mutation changes the message ID and invalidates the signature.

### Role binding

A valid signature does not authorize a sender to use a message type forbidden
to its declared role.

### Exact economics

The accepted route hash, dealer input, broker fee, all-in input, exact output,
spread evidence, adapters, and expiry are signed. The all-in value is checked
against the requester's maximum. Models and brokers cannot add economics later.

### Route reproducibility

Given the same verified RFQ, candidate quotes, explicit fees, policy, and
evaluation time, independent clients select the same route and route ID.

### Secret non-disclosure

The raw secret is not a valid field in any V1 message. Claim messages contain
only the secret hash and chain reference.

### Evidence separation

Waku messages cannot make an unfunded lock funded, an unconfirmed claim final,
or an allegation true. Clients verify chain evidence.

### Custody and reputation separation

A default or dispute changes local case interpretation only. It cannot alter a
settlement beneficiary, timeout, or principal.

## Threats And Mitigations

| Threat | Phase 1 mitigation | Later requirement |
|---|---|---|
| Payload tampering | canonical ID and sender signature | authenticated storage and transport |
| Cross-deployment replay | signed deployment ID | deployment-specific topics and stores |
| Cross-trade replay | signed trade ID | durable per-trade nullifiers |
| Role confusion | role/type allowlist | actor eligibility policy |
| Stale quote | expiry and reference timestamp | independent price-source policy |
| Broker price modification | dealer signature | local quote verification |
| Broker route manipulation | deterministic recomputation | multi-broker comparison |
| Hidden broker quote | cannot be proven from one view | query independent brokers and commitments |
| Secret published through Waku | unknown secret field rejected | encrypted pre-broadcast persistence |
| Fake lock or claim | message is only a reference | chain and adapter verification |
| Relayer redirects claim | fixed beneficiary in schema | fixed-beneficiary lock contract |
| Waku replay | stable message ID | durable deduplication |
| Waku suppression | no settlement truth assigned to Waku | multi-node discovery and chain recovery |
| Per-hop reward farming | no hop payment exists | monetize objective services only |
| RFQ flooding | short lifetime and narrow schema | rate limits, fees, and bonds |
| Inventory probing | no exact balance field | ephemeral RFQs and progressive disclosure |
| Clock skew | bounded message skew | chain-derived timeout checks |
| RPC lies | no single RPC is canonical | quorum or independent verification |
| Unsupported token | exact token address | adapter allowlist and bytecode checks |
| Crash after funding | not solved by Phase 1 | atomic encrypted journal before broadcast |

## Malformed Message Policy

Clients and relays MUST reject:

- unknown envelope or payload fields
- absent required fields
- noncanonical hashes and addresses
- unsupported protocol versions
- role/type mismatches
- unsafe message lifetimes
- duplicate evidence
- duplicate input chain/token options
- zero positive amounts
- spreads above 10,000 BPS
- RFQ deadlines outside message lifetime
- reserve deadlines outside message lifetime
- lock timeouts before message creation
- raw secret fields

Rejection happens before storage, routing, model exposure, or economic scoring.

## Broker Limits

Phase 1 does not solve quote suppression by one broker. It makes manipulation
detectable when the underlying quote is supplied.

The public design therefore requires:

- multiple broker queries
- direct routing as an alternative
- signed dealer quotes
- explicit broker fees
- local route recomputation
- no broker custody
- no mandatory company gateway

## Privacy Limits

Phase 1 prevents broad RFQs from requiring settlement addresses, but Waku
metadata may still reveal:

- timing
- approximate requested size
- desired chains and assets
- network source patterns

Sealed RFQs, private information retrieval, traffic analysis resistance, and
dealer-set encryption are not claimed.

## State-Machine Risks

The settlement state machine is deterministic but does not itself verify chain
events. Later state persistence must:

- accept only events proven against the expected adapter
- journal intent before broadcast
- reconcile uncertain submissions after restart
- avoid duplicate locks, claims, and refunds
- preserve both settlement and case state independently
- reject terminal-state regression

## Phase 1 Verification Evidence

Client tests prove:

- all eleven message types normalize
- canonical input ordering
- frozen hash vector
- protocol, deployment, trade, and type domain separation
- role-bound signing
- payload tamper rejection
- unknown and secret-field rejection
- accepted-fee arithmetic and requester all-in caps
- settlement and case transitions
- deterministic route selection
- stale and manipulated quote rejection

Relay tests independently prove:

- the same frozen hash vector
- all eleven schemas
- the same domain separation
- role-bound signing
- secret and unknown-field rejection
- the same accepted-fee and all-in cap enforcement
- the same state transitions
- the same route decisions

A cross-repository parity run feeds all eleven client fixtures through both
implementations and requires identical canonical bytes and message IDs.

## Remaining High-Risk Work

Before real funds:

1. Build the deterministic simulator.
2. Specify durable sequence and action nullifiers.
3. Implement encrypted secret persistence and recovery.
4. Design and audit conditional-lock contracts.
5. Prove timeout ordering and chain finality.
6. Exercise refund paths.
7. Add Waku rate limits and bounded recovery.
8. Complete focused legal and sanctions review before unrestricted dealing.

## Stop Conditions

Development stops before funded testing if:

- independent validators disagree on canonical bytes
- any message permits the raw secret
- a broker can change a signed quote without rejection
- settlement and case state become coupled
- a future adapter permits arbitrary destination calls
- recovery depends on reconstructing a lost secret
