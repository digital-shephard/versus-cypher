# Agentic FX Phase 0 Research Contract

Status: frozen for the first simulator and prototype

Decision ID: `FX0-2026-07-25`

This document defines the actors, authority boundaries, first route, initial
caps, legal questions, and public vocabulary for the first Versus agentic FX
prototype. It is a research and implementation boundary, not a claim that FX
is currently available in the released desktop application.

The longer private design and execution plans remain untracked. This file is
the reviewable Phase 0 contract shared by the client and relay work.

## Research Objective

Prove that an external requester can obtain a fixed cross-chain output from an
independently funded Cypher through signed discovery and conditional onchain
settlement without Versus, a broker, or a relay taking custody of principal.

The first product is intentionally small:

> A personal pennies-sized FX toy whose protocol can later support many
> independent dealers and brokers.

## Frozen First Route

The first mainnet target route is canonical USDC between Base and Arbitrum One.
All contract addresses must be verified against Circle and the target chains
again immediately before deployment.

| Field | Base | Arbitrum One |
|---|---|---|
| Chain ID | `8453` | `42161` |
| Asset | Native USDC | Native USDC |
| Decimals | `6` | `6` |
| Token | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |

Canonical address source:

- https://developers.circle.com/stablecoins/usdc-contract-addresses

Wrapped USDC, bridged USDC variants, arbitrary ERC-20 tokens, fee-on-transfer
tokens, rebasing tokens, and tokens selected only by symbol are out of scope.

Mainnet is not the first execution environment. The order is:

1. deterministic simulation
2. local EVM chains
3. supported test networks or controlled fork tests
4. closed tiny-value mainnet test

## Initial Economic Limits

The first real-value toy is bounded to:

| Limit | Initial value |
|---|---|
| Minimum exact output | `0.10 USDC` |
| Maximum exact output | `1.00 USDC` |
| Maximum active trades per dealer | `1` |
| Maximum active output exposure per dealer | `1.00 USDC` |
| Maximum aggregate configured toy inventory | Owner selected, with a recommended `5.00 USDC` ceiling |
| Quote type | Fixed exact output |
| Target quote lifetime | `20 seconds` |
| Partial fills | Disabled |
| Multi-dealer routes | Disabled |
| Automatic dealing | Disabled |

These are prototype safety limits, not protocol-scale promises. Increasing a
limit requires measured evidence and a new reviewed configuration version.

Network fees remain outside the stated output. The quote must show:

- exact source amount
- exact destination output
- dealer spread
- embedded dealer settlement-cost reserve
- estimated requester-side gas
- broker or relayer fee, when present

## Product Defaults

The FX feature has three distinct states:

### Requester and discovery mode

May be visible by default. It can discover routes, request quotes, and explain
costs. It cannot move funds without the requester's explicit wallet signature.

### Dealer mode

Disabled by default. Enabling it requires the owner to configure:

- approved chains
- exact token contracts
- dedicated inventory budget
- maximum trade size
- maximum total exposure
- minimum spread
- approval threshold

### Automatic dealing

Separately disabled by default. It may only operate inside deterministic owner
limits and may never use daily runway or withdrawable NFT rewards without a
separate explicit inventory allocation.

## Actor Definitions

### Requester

A person or software agent asking for an exact destination output. A requester
does not need a Cypher identity. It chooses the quote, signs its own
transactions, generates the swap secret, and retains its own wallet keys.

### Dealer Cypher

An owner-controlled Cypher using separately approved inventory. It chooses its
own price sources, spread, routes, limits, counterparties, and whether to quote.
It acts as principal with its own inventory and never receives authority over
the requester's wallet.

### Relay

A Waku transport service that delivers signed protocol envelopes and bounded
recovery data. Ordinary packet forwarding is not paid. A relay does not set
prices, select routes, hold funds, sign trades, or declare settlement truth.

### Broker

An optional untrusted route compiler. It gathers independently signed dealer
quotes, proposes a deterministic route, and states an explicit fee. The
requester verifies the quotes and recomputes the route locally before
acceptance.

A broker may be hosted beside a relay, but it is a separate role, service
boundary, identity, and fee.

### Execution relayer

An optional submitter of a specific claim transaction. The settlement
construction fixes the beneficiary, so the relayer cannot redirect output.
Any relayer fee is signed before execution.

### Adapter

Deterministic code and, where required, immutable contracts that construct,
verify, claim, and refund one supported chain family. An adapter never accepts
model-generated arbitrary calldata.

### Versus company services

The official client, company-operated nodes, brokers, and any company or
partner dealer deployments. Each service retains its own legal, sanctions,
security, and operational responsibilities. Open protocol participation does
not erase those responsibilities.

## Authority Matrix

| Capability | Requester | Dealer | Relay | Broker | Execution relayer | Versus operator |
|---|---:|---:|---:|---:|---:|---:|
| Choose requested output | Yes | No | No | No | No | No |
| Choose whether to quote | No | Yes | No | No | No | No |
| Set dealer price and spread | No | Yes | No | No | No | No |
| Select accepted route | Yes | No | No | Proposes only | No | No |
| Sign requester funds | Yes | No | No | No | No | No |
| Sign dealer funds | No | Yes | No | No | No | No |
| Hold trade principal | Own side only | Own side only | No | No | No | No |
| Redirect settlement payout | No | No | No | No | No | No |
| Verify chain truth | Locally | Locally | Observes only | Observes only | Observes only | No canonical authority |
| Set local trust and limits | Yes | Yes | Local service only | Local service only | Local service only | Official defaults only |
| Freeze the open protocol | No | No | No | No | No | No |

## Phase 0 Settlement Shape

The first cross-chain prototype uses:

1. a short-lived signed fixed exact-output RFQ
2. one signed dealer quote
3. one explicit requester acceptance
4. a requester-generated cryptographic secret persisted before funding
5. a source-chain conditional lock
6. an independently verified destination-chain conditional lock
7. requester claim revealing the secret
8. dealer claim using the revealed secret
9. deterministic timeout refunds if either side stops

One dealer fills one trade. Multi-dealer atomization, floating quotes, unsecured
credit, and native Bitcoin are later phases.

## Node And Broker Economics

Ordinary Waku forwarding earns nothing per packet or hop. Forwarding receipts
are not objectively scarce and would permit self-relay Sybil farming.

Only objectively attributable services may charge:

- a selected broker whose route was accepted and completed
- an execution relayer that submitted a required transaction
- a dealer that supplied inventory
- an optional data provider selling useful API access

Self-hosters may route directly without paying a broker fee.

## Privacy Boundary

The initial public RFQ must not disclose:

- source funding address
- destination receiving address
- requester wallet history
- total dealer inventory
- Cypher NFT identity when the requester is external
- unrelated x402 resource details

Initial RFQs use ephemeral request identities. Exact settlement addresses are
progressively disclosed only when required for a selected trade. Dealers
advertise maximum quote size, not wallet balance.

## Security Boundary

The following are mandatory before the first funded transaction:

- operating-system cryptographic secret generation
- encrypted atomic secret persistence
- read-back verification of the stored secret hash
- exact chain ID and token address validation
- exact beneficiary and refund-address validation
- timeout-order validation
- adapter-version commitment
- owner-configured inventory cap
- durable trade journal

Models may recommend interest or silence. They may not construct locks, choose
addresses, set amounts, select adapters, generate secrets, change exposure, or
approve transactions.

## Regulatory And Sanctions Questions

These questions require focused counsel before unrestricted public dealing:

1. When does an independently funded Cypher repeatedly quoting as principal
   become an exchanger or money transmitter under applicable law?
2. When does a Waku service remain only a delivery, communication, or
   network-access provider?
3. Does operating a route compiler for a fee change the broker or node
   classification?
4. Which activities may a licensed liquidity partner perform for the official
   US-facing lane?
5. Which obligations remain with independent dealer operators?
6. How should the official interface restrict jurisdictions?
7. What sanctions screening belongs at the company interface, broker, dealer,
   and execution-relayer layers?
8. What records can be retained without defeating the privacy design?

Company-operated services must not treat a static OFAC address file as complete
sanctions compliance. Required policy may include fresh official lists,
transaction-risk screening, linked-address analysis, geographic controls,
audit records, and a documented stale-data response.

The immutable settlement layer remains technically neutral. The official
interface and each dealer may refuse unsupported counterparties and routes
under their own policies.

Relevant US guidance for counsel review:

- https://www.fincen.gov/system/files/2019-05/FinCEN%20Guidance%20CVC%20FINAL%20508.pdf
- https://ofac.treasury.gov/system/files/126/virtual_currency_guidance_brochure.pdf

## Public Claims Vocabulary

### Safe during research

- "Versus is researching atomic agent-to-agent FX."
- "Independent Cyphers will quote from owner-approved inventory."
- "The first prototype targets tiny fixed USDC swaps between Base and
  Arbitrum."
- "Waku carries signed coordination; supported chains settle conditionally."
- "Versus does not custody trade principal."
- "FX dealer mode will be opt-in."

### Requires executable evidence

- "Atomic Base-to-Arbitrum swaps are live."
- "Either the swap completes or the source becomes refundable after the
  displayed timeout."
- "Multiple brokers can be queried and independently verified."
- "A recovered desktop can resume every active trade."

### Prohibited before broad proof

- "Any asset, any chain" as a current capability
- "Instant native Bitcoin"
- "No regulation"
- "No KYC ever"
- "Fraud-proof"
- "Free swaps"
- "Guaranteed subpenny total cost"
- "Millions of swaps" without measured capacity
- "Versus replaces exchanges or bridges"

## Phase 0 Non-Goals

- Production settlement contracts
- Mainnet deployment
- Native Bitcoin
- Multi-dealer routing
- Floating prices
- Automated hedging
- Shared liquidity
- Unsecured reputation-backed credit
- Public dealer onboarding
- Model-controlled dealing

## Phase 0 Exit Checklist

- [x] Actor terminology is frozen.
- [x] Custody, signing, pricing, routing, and settlement authority are assigned.
- [x] The first route is Base USDC to/from Arbitrum One USDC.
- [x] Canonical chain IDs and token addresses are recorded with an official
  source.
- [x] The first real-value toy range is `0.10-1.00 USDC`.
- [x] Fixed exact-output is the only initial quote type.
- [x] Requester mode and dealer mode are separated.
- [x] Dealer and automatic-dealer modes are opt-in.
- [x] Relay and broker roles are separated.
- [x] Generic Waku forwarding has no per-hop reward.
- [x] Legal and sanctions questions are recorded rather than assumed solved.
- [x] Safe and prohibited public claims are recorded.

Phase 1 may specify the complete message schemas and trade state machine. No
financial implementation is authorized merely by completing this checklist.
