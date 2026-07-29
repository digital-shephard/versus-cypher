# Agentic FX Phase 3: EVM Adapter

Status: the ERC-20 and native-ETH adapter families are frozen and deployed to
the Base Sepolia / Arbitrum Sepolia cohort. FX remains disabled by default and
these deployments are not authorized for mainnet or production funds.

## Scope

Phase 3 introduces one narrowly reusable EVM settlement family:

- adapter ID: `evm-htlc`
- adapter version: `1`
- contract: `EvmHtlcV1`
- asset model: one immutable ERC-20 per deployment
- settlement model: hash-locked claim before expiry, fixed-address refund at
  or after expiry

Phase 9 adds a separate native-asset family without weakening or pretending to
extend the ERC-20 contract:

- adapter ID: `evm-native-htlc`
- adapter version: `1`
- contract: `EvmNativeHtlcV1`
- asset model: the native ETH of the exact manifested EVM chain
- funding model: exact `msg.value`, with no amount parameter that can disagree
  with custody

This is not a router. It cannot call arbitrary targets, swap assets, bridge
assets, change beneficiaries, or alter a funded lock.

## Contract Behavior

`fund` records a unique lock ID, exact asset amount, beneficiary, refund
address, secret hash, and refund timestamp. It verifies the inbound token
balance delta before recording custody.

`claim` may be submitted by any address before expiry. The supplied secret must
hash to the stored commitment. The entire amount is always paid to the stored
beneficiary.

`refund` may be submitted by any address at or after expiry. The entire amount
is always paid to the stored refund address.

Claim and refund update state before the ERC-20 transfer and are protected by
`ReentrancyGuard`. Outbound contract and recipient balance deltas must match the
stored amount. A failed transfer reverts the complete state change.

There is no owner, pause key, upgrade proxy, sweep function, arbitrary call,
native-asset receiver, or mutable asset configuration.

`EvmNativeHtlcV1` has the same fixed-party claim/refund state machine but is a
separate payable contract. Direct transfers and arbitrary calldata revert.
State and `totalLocked` update before payout, `ReentrancyGuard` protects every
value-moving path, and a failed fixed-address payout rolls the complete state
change back. Forced ETH may create harmless surplus but never a claim or admin
withdrawal.

## Capability Manifest

The machine-readable schema is
[`schemas/adapter-capability-v1.schema.json`](./schemas/adapter-capability-v1.schema.json).
Every admitted capability pins:

- exact chain ID
- exact adapter address and runtime code hash
- exact token address and runtime code hash
- token decimals and transfer-mechanic declarations
- required confirmations and reorganization safety depth
- minimum and maximum lock durations
- minimum cross-chain timeout delta
- compiler, source digest, and creation bytecode digest

Fee-on-transfer, rebasing, and callback-heavy tokens are rejected by policy
before any provider call, approval, or funding. Issuer controls are represented
separately as `none` or `documented`; a future route may accept a canonical
issuer-controlled stablecoin only with an explicit route-specific assumption.

Native capabilities use the independent
[`schemas/native-adapter-capability-v1.schema.json`](./schemas/native-adapter-capability-v1.schema.json).
They pin `native:eth`, 18 decimals, deployment block, runtime bytecode,
immutables, confirmation policy, and timeout policy. Protocol messages use the
canonical zero address only as native ETH's wire identifier; it is never
treated as an ERC-20 contract.

## Timeout Rule

For two EVM legs:

```text
source refund timestamp
  >= destination refund timestamp
   + max(source minimum delta, destination minimum delta)
```

Each leg must also fall within its adapter deployment's own duration bounds.
This keeps the source refund later than the destination refund and prevents one
timeout configuration from trapping both participants.

## Confirmation And Replacement Policy

An observed receipt is not final until its capability's
`requiredConfirmations` is reached. The adapter journal keeps the block number
and block hash:

- a disappearing receipt is `reorged`
- a receipt moving to another block/hash is `reorged`
- a replacement transaction is acceptable only when it proves the same
  route-bound lock or settlement action
- transaction hash alone is never settlement identity

The fee helper records gas estimate, maximum fee per gas, and their explicit
worst-case native product. It does not silently deduct gas from principal.

## Local Tooling

From `versus/`:

```bash
npm run test:fx:phase3
npm run fx:freeze:evm-v1
npx hardhat node
npm run fx:deploy:local

# In a second shell:
FX_ADAPTER_MANIFEST=deployments/fx/localhost-31337-evm-htlc-v1.json \
  npx hardhat run scripts/fx/verify-evm-htlc-v1.js --network localhost
```

Set `FX_EXPLORER_VERIFY=true` only for an explicitly selected non-local network.
The deploy script refuses to invent a token outside Hardhat; an exact
`FX_TOKEN_ADDRESS` is mandatory.

The deterministic build freeze is
`versus/deployments/fx/evm-htlc-v1-build.json`.
Its source identity is the local `agentic-fx-phase3-v1` tag; checking out that
tag and running `npm run fx:freeze:evm-v1` must reproduce the committed source
and creation-bytecode hashes.

The native freeze is
`versus/deployments/fx/evm-native-htlc-v1-build.json`. The combined cohort is
`versus/deployments/fx/phase9-public-testnet.json`, whose deployment ID binds
both adapter families on both chains.

## Native Public-Testnet Deployments

Both chains contain identical runtime bytecode:

`0x752e5fe73aed992241e138ff550d4ab7fc127230b802e70b9c87239fec60f082`

| Chain | Address | Block | Explorer |
| --- | --- | ---: | --- |
| Base Sepolia | `0x7c917f09e1de03977acc14575b56932aa55da543` | `44762481` | [contract](https://sepolia.basescan.org/address/0x7c917f09e1de03977acc14575b56932aa55da543) |
| Arbitrum Sepolia | `0x7c917f09e1de03977acc14575b56932aa55da543` | `292433456` | [contract](https://sepolia.arbiscan.io/address/0x7c917f09e1de03977acc14575b56932aa55da543) |

The frozen source SHA-256 is
`0xea81dd22c015e56d4e631e340fab5593397952fca5470635fc8d4b2bdb922ad4`;
the creation-code hash is
`0xda6b8e42b4b22c07cda53b08db6091e78ea3a884905703c69f18e9494e7f2244`.
Both explorer links above display the verified source and constructor
arguments.

## Evidence

The Phase 3 suite covers:

- correct and wrong-secret claims
- third-party claim/refund submission with fixed payout
- early and valid refunds
- exact timeout boundary behavior
- lock replay
- decimal mismatch
- fee-on-transfer rejection
- callback reentrancy
- invalid/self payout addresses
- arbitrary calldata and native value rejection
- exact asset preflight before provider access
- runtime bytecode and immutable matching
- quote/lock manifest admission
- replacement and reorganization classification
- deterministic build reproduction
- Foundry fuzz and stateful custody invariants
- native exact-value funding and fixed-payout behavior
- native payout failure rollback and callback reentrancy
- native active-liability equality and solvency across 32,768 invariant calls

The relay implements an independent manifest validator, but production
`src/main.mjs` does not import it. Phase 3 therefore adds evidence without
activating public FX traffic.
