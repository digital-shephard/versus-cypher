# Agentic FX Public-Testnet V1 Adversarial Review

Date: 2026-08-07

Result: **accepted for the frozen artifacts and the single-workstation
Base Sepolia/Avalanche Fuji live-chain cohort**. The separate physical gates
subsequently passed on 2026-08-09. Neither checkpoint authorizes mainnet,
production funds, or an unrestricted release.

## Scope

The review followed the complete trust path from the frozen market candidate
through the two explorer-verified chain records, build freezes, assembled
deployment, desktop loader, runtime preflight, and generic exact-factory
configuration. It considered accidental and adversarial mutation of:

- market, release-stage, chain, asset, timeout, and confirmation policy;
- V3 adapter address, runtime, deployment block, and asset metadata;
- exact-factory count, duplicates, token metadata, HTLC wiring, fee, recipient,
  runtime, and deployment block;
- build-freeze identity and per-contract explorer-verification evidence;
- deployment ID and Waku coordination-domain linkage.

No private deployment journal, deployer key, mainnet RPC transaction, or
unrelated workspace file was read or changed.

## Frozen Inputs

| Artifact | SHA-256 |
| --- | --- |
| `public-testnet-v1-market-candidate.json` | `10d2856e55226b9d51cfac6b615032a53eadbe646cfbaf7365aaa6cc4cb30052` |
| `baseSepolia-84532-market-v1-testnet.json` | `ef6ba61e945579c82ec1fde27c23952d9309d20b6dd670e016d8cb0526b4afd4` |
| `avalancheFuji-43113-market-v1-testnet.json` | `84349b5ff8a0b5552639cdbdd9680d675e0015818687357fd20666deebf8d432` |
| `public-testnet-v1-market-deployment.json` | `75c9397a52df2b721ee1a431fc45182354cd825c020e4e9f68a98e372feb3b32` |
| `evm-htlc-v3-build.json` | `db41a2619e1565e1ef98959a4361287f1d97dd571da6dbda76453fad25cd3758` |
| `evm-exact-build.json` | `4ef358f79dbe7b144bc7c735e80dcdcceab64f7e5870b746847669accb8eca55` |

The assembled deployment remains:

- deployment ID `0x8cd9ede68d18e52213372ed6041bdb83867c5846119461c860d95f74e689ed54`;
- coordination domain `0x50aea8e208dd1de883d5f8b50eefe71f328b6b9aea996388d402f87ef4415ed9`;
- six positions, 30 directed routes, two native V3 adapters, four ERC-20
  V3 adapters, and four exact factories.

## Findings And Remediation

### F-01: desktop exact-factory linkage was incomplete

Severity: **medium** for the explicitly configured development/testnet loader.

The loader required one factory lookup per market token but did not reject
extra or duplicate entries and did not independently bind the factory's
symbol, token name/version, V3 HTLC, facilitator fee, or null recipient back to
the frozen market. A locally modified assembled JSON could therefore remain
structurally loadable while presenting internally divergent exact metadata.

Remediation: the loader now requires exactly four unique factories and
normalizes every chain, token, address, runtime hash, and deployment block. It
requires token metadata from the market, the matching V3 adapter as `htlc`, the
frozen fee, and a null artifact-level facilitator recipient. Mutation tests
cover extra factories, fee drift, HTLC drift, and token-name drift.

### F-02: assembly trusted aggregate record labels too broadly

Severity: **medium** for release evidence integrity.

Assembly previously required only the aggregate `verificationStatus` string
before extracting addresses. It did not require the record schema, exact V3
and exact build freezes, chain name, timeout/confirmation policy, complete
asset evidence, or each adapter/factory explorer result to match the reviewed
inputs.

Remediation: assembly now rejects any drift in those fields and accepts only
`verified` or `already-verified` per-contract explorer results under an
aggregate verified record. Mutation tests cover build, policy, asset, and
per-contract verification drift.

### F-03: runtime cross-object checks and operator preflight were incomplete

Severity: **low**.

The desktop ignored top-level release-stage drift, allowed extra V3
capabilities, and did not derive-check the coordination domain. The operator
preflight also used the interactive 2.5-second relay timeout and bypassed the
documented endpoint override parser, producing intermittent false negatives
despite two valid signed public responses.

Remediation: the loader now requires exact market/V3 chain counts, asset
runtime metadata, timeout and confirmation policies, top-level release-stage
agreement, and the deterministic coordination domain. The operator preflight
uses the reviewed endpoint parser and a 10-second diagnostic timeout while
retaining the two-distinct-signer, freshness, source, and divergence checks.

## Residual Boundaries

- The deployment ID is the V3 coordination identity, not a digest of the
  complete JSON file. Exact-factory safety is enforced by strict cross-object
  validation, onchain runtime/immutable preflight, reproducible assembly, and
  the published file hash above. A future mainnet release should preserve that
  distinction explicitly or introduce a separately reviewed full-artifact
  commitment without reusing this testnet domain.
- Explorer verification proves published source correspondence; it is not an
  external security audit.
- Public RPC and signed price-relay availability remain operational
  dependencies and must fail closed during the physical cohort.
- No automated result substitutes for funded two-machine settlement and
  recovery evidence.

## Acceptance Evidence

The review checkpoint passed:

- all 254 network tests;
- all 221 desktop tests;
- both focused deployment-script tests;
- the market/deployment/runtime mutation cases added by this review;
- the live runtime preflight at Fuji block `57622092` and Base Sepolia block
  `45188031`, with heads no more than two seconds old, all ten deployment
  receipts, four exact factories, and a fresh two-distinct-signer
  AVAX/ETH/EURC price quorum.

These block and price observations are time-specific evidence, not a promise
that public infrastructure will remain available.

### Funded live-chain cohort

On 2026-08-07 the Circle faucet supplied official testnet USDC and EURC to the
requester and dealer on Base Sepolia and Avalanche Fuji. A guarded
single-workstation runner then exercised the production V3 protocol and real
deployed contracts with deterministic in-process Waku coordination. The
runner deliberately labels this scope and does not call it a physical
two-machine result.

The following live-chain exercises completed:

- all 30 frozen directed routes, including every same-chain and cross-chain
  native/USDC/EURC permutation, with 30 distinct destination transaction
  hashes;
- zero-destination-gas delivery in both directions, with each fresh recipient
  remaining at exactly zero native balance while receiving the requested
  stablecoin;
- a mid-swap restart after destination claim, followed by a durable-journal
  source-claim recovery;
- real-time USDC timeout/refund transactions on both chains;
- stale-price rejection before the EVM funding boundary and unavailable-RPC
  rejection before preflight;
- deterministic relay disconnect/reconnect followed by a completed live-chain
  route;
- four stock `@x402/fetch` exact payments: USDC and EURC as inputs on each
  chain, with a real CREATE2 exact escrow, facilitator fee, V3 destination
  settlement, reveal, and terminal completion for every case.

The local evidence directories and their SHA-256 digests are intentionally not
release artifacts because they contain encrypted recovery packets and SQLite
coordination journals. The sanitized transaction IDs and scenario summaries
are printed by `npm run acceptance:fx-public-testnet --prefix apps/pet` and
were reviewed before this checkpoint.

The run exposed two shutdown races where SQLite journals could close while a
recovery or dealer-envelope callback was still active. The runtime now blocks
new recovery work during close and awaits recovery, settlement, relayer, and
envelope operations before closing journals. Two focused regressions cover the
fixed lifecycle. The restart run also emitted harmless replay warnings after
the source claim completed; these remain review evidence rather than being
silently relabeled.

### Physical boundary follow-up

A diagnostic public-Waku coordination run connected to both Versus relays with
two LightPush, two Filter, and two Store peers. It recovered the RFQ through
Store, completed quote/accept/reserve coordination, and produced matching
requester/dealer state hashes. Read-only SSM checks also found both nwaku nodes
ready and the Caddy, Versus node, nwaku, and FX broker containers running.

One earlier explicit attempt returned a transient Filter-subscription failure.
That was not an EC2 outage, but it exposed a client cleanup gap: a startup
failure after partial subscription did not close the node. The transport now
tears down partial subscriptions and the node before a retry; a regression test
covers rejection followed by a clean successful start.

The diagnostic did not itself convert the single workstation into a physical
two-device result. That boundary was closed by the later Windows-requester and
macOS-dealer campaign: 30 unique route pairs reached `funds_ready`, public Waku
recovered from `wait` to `ready` and `caught_up`, and stock x402 exact payments
completed with USDC and EURC as inputs on both chains. See
[`PUBLIC_TESTNET_V1_PHYSICAL_ACCEPTANCE_2026-08-09.md`](./PUBLIC_TESTNET_V1_PHYSICAL_ACCEPTANCE_2026-08-09.md).
Mainnet remains blocked pending its separate final ceremony and explicit
authorization.

After the physical-acceptance fixes, all 259 network tests and all 225 desktop
tests pass.
