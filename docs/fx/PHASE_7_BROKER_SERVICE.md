# Agentic FX Phase 7: Public Broker Service

## Status

Phase 7 is a headless reference implementation. It does not appear in the
desktop UI, move production funds, or change the deployed Versus relay
process. It proves that a wallet outside the Cypher network can submit one
signed RFQ to an optional broker, receive a route assembled from dealer-signed
quotes, and reject any broker modification locally.

The broker is useful, not trusted:

- it never receives a requester or dealer settlement key
- it never holds principal
- it cannot sign an RFQ, quote, acceptance, claim, or refund for either party
- it cannot hide its fee inside a dealer price
- it cannot make an unverifiable completion claim payable
- it is not required for direct Waku discovery or self-routing

Ordinary Waku forwarding remains unpaid.

## Route Proposal

`fx-broker-protocol.js` defines the signed
`versus-fx-broker-route` envelope. A proposal contains:

1. the original requester-signed RFQ
2. every dealer-signed quote considered by that broker
3. the deterministic route policy
4. an explicit input-asset broker fee and recipient
5. the locally reproducible selected route
6. the broker service identity, expiry, proposal hash, and signature

`verifyBrokerRouteProposal` verifies every included signature and recomputes
the route with `selectSingleDealerRoute`. Route, fee, recipient, quote set,
asset, amount, lifetime, and broker-signature changes fail closed.

`compileSelfRoutedProposal` uses the same compiler with a zero broker fee.
`queryBrokerRoutes` queries up to eight independent HTTPS brokers
concurrently, verifies each response, and compares only valid all-in routes.
Atomic amounts are compared only within one input chain and token; when an RFQ
offers unlike input assets, the requester must choose the asset before ranking
brokers.
The requester can therefore bypass a broker or reduce quote-hiding risk by
combining several independent observations.

## Completion-Coupled Fee

The requester signs a separate `versus-fx-broker-fee-voucher` after selecting
a proposal. It binds:

- proposal and trade IDs
- requester and broker identities
- fee chain, token, amount, and recipient
- nonce and expiry

`verifyBrokerFeeClaim` requires the matching signed acceptance, both signed
claim observations, the completion message that references those claims, and
an independent chain verifier for each claim transaction. A route proposal or
broker-authored completion message by itself is insufficient.

`FxBrokerFeeLedger` is the no-real-funds Phase 7 escrow model. It proves
single-use completion coupling and rejects nonexistent, incomplete,
unconfirmed, mismatched, or replayed trades. A production chain adapter or
payment rail must preserve this exact condition before real broker fees are
enabled.

## Public API

The reference HTTP service exposes:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/fx/routes` | Publish a signed RFQ to Waku, collect quotes, return a signed route proposal |
| `GET` | `/health` | Bounded service and transport availability |
| `GET` | `/metrics` | Signed objective broker metrics |
| `GET` | `/v1/fx/data/metrics` | Optional x402-gated metrics data |

The route endpoint accepts at most 128 KiB, has bounded concurrency, and
rate-limits each source address. Public non-local endpoints require HTTPS in
the requester library. The x402 data endpoint is disabled unless an operator
supplies a requirement and an independent payment verifier.

Metrics disclose aggregate requests, routes, quote validation, completion
proofs, dealer reach, and latency percentiles. They do not disclose RFQs,
wallet relationships, balances, inventory, secrets, or individual dealer
performance. The snapshot is signed by the broker identity.

## Self-Hosting

The broker is a separate sidecar, not the relay executable:

```powershell
$env:FX_PHASE7_DEPLOYMENT_ID = "0x..."
$env:FX_PHASE7_DATA_DIR = "C:\versus\fx-broker"
$env:FX_PHASE7_BROKER_KEYSTORE = "C:\versus\broker-keystore.json"
$env:FX_PHASE7_BROKER_KEYSTORE_PASSWORD = "..."
$env:FX_PHASE7_BROKER_FEE_ATOMIC = "100"
$env:FX_PHASE7_BROKER_HOST = "127.0.0.1"
$env:FX_PHASE7_BROKER_PORT = "8787"
npm run fx:phase7:broker --prefix packages/network
```

Terminate TLS and apply an outer connection limit in Caddy or an equivalent
reverse proxy before exposing the loopback service. The broker identity is a
service signing key only. Never reuse a Cypher owner, dealer, deployer,
protocol recipient, rain attestor, Waku node, or settlement wallet.

Setting `FX_PHASE7_BROKER_FEE_ATOMIC=0` is allowed for testing. Self-routing
always remains independently available with no broker fee.

The headless comparison command accepts either several brokers:

```powershell
$env:FX_PHASE7_RFQ_FILE = "C:\versus\rfq.json"
$env:FX_PHASE7_BROKER_URLS = "https://broker-a.example,https://broker-b.example"
npm run fx:phase7:compare --prefix packages/network
```

or an independently collected quote file:

```powershell
$env:FX_PHASE7_RFQ_FILE = "C:\versus\rfq.json"
$env:FX_PHASE7_QUOTES_FILE = "C:\versus\quotes.json"
npm run fx:phase7:compare --prefix packages/network
```

The second path never contacts or pays a broker.

## Evidence

```powershell
node --test packages/network/test/fx-phase7.test.js
npm test --prefix packages/network
```

The focused suite proves:

- every included quote is independently verified
- quotes for another RFQ cannot poison an active broker request
- route and fee tampering are rejected
- unlike input assets cannot be compared without an explicit asset selection
- the signed `fastest` policy is honored independently of all-in price
- self-routing has no broker fee
- multiple brokers are queried concurrently
- no fee leaves escrow without two confirmed claims
- duplicate fee claims fail
- a non-Cypher requester can use public ingress
- metrics are signed and bounded
- optional x402 data access is payment-gated
- route ingress has body, rate, and concurrency bounds

Validation checkpoint, 2026-07-26:

- focused Phase 7 client tests: 10/10 passed
- complete client network suite: 150/150 passed
- complete relay suite, including the independent route verifier: 48/48 passed
