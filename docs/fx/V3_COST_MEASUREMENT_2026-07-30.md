# V3 Cost Measurement — 2026-07-30

This is the reproducible cost checkpoint for the requester-secret V3
candidate. No transaction was broadcast and no real or test funds moved.

## Benchmark Swap

- Source: Base Sepolia native ETH
- Destination: Arbitrum Sepolia native ETH
- Source lock: `0.000898750299839876 ETH`
- Exact destination output: `0.00085 ETH`
- Destination executor bounty in the fixture: `0.000003 ETH`
- USD reference: `$1,902 / ETH`
- Four transactions: source fund, destination fund, destination claim, source
  claim
- No batching

The USD reference is an explicit reproducibility input, not an onchain oracle
read. Change `ETH_USD_REFERENCE` when rerunning the estimator.

## Local Gas Measurement

Hardhat mined the same successful four-transaction native swap through V2 and
V3.

| Leg | V2 gas | Compact V3 gas | Change |
|---|---:|---:|---:|
| Source fund | 188,195 | 49,959 | -73.45% |
| Source claim | 48,828 | 38,954 | -20.22% |
| Destination fund | 208,131 | 49,995 | -75.98% |
| Destination claim | 58,257 | 48,421 | -16.88% |

Compact V3 funding calldata is 132 bytes. Compact claim calldata is 164
bytes. V2 claim calldata is shorter, but V3 eliminates three persistent lock
storage slots and makes the requester—not the dealer—the secret owner.

Command:

```bash
npm run fx:measure:v3 --prefix versus
```

## Live Public-Testnet Fee State

The read-only estimator injected the frozen runtime into state-overridden
calls. It used current `eth_estimateGas` results, Base's exact
`GasPriceOracle.getL1Fee(signedTransaction)` result, Base's operator-fee
result, and Arbitrum's Nitro gas estimate. Ephemeral identities and secrets
existed only in memory and were never printed or submitted.

Evidence point:

- Generated: `2026-07-30T00:59:08.907Z`
- Base Sepolia block: `44,802,429`
- Arbitrum Sepolia block: `292,754,538`

Base Sepolia source legs:

| Leg | Gas estimate | Total fee |
|---|---:|---:|
| Source fund | 50,349 | `0.000000313376698668 ETH` |
| Source claim | 39,322 | `0.000000248323252021 ETH` |

Arbitrum Sepolia destination legs:

| Leg | Gas estimate | Total fee |
|---|---:|---:|
| Destination fund | 60,374 | `0.000001290071632 ETH` |
| Destination claim | 84,742 | `0.000001815682092 ETH` |

Base to Arbitrum four-transaction gas:

- `0.000003667453674689 ETH`
- `$0.006975496889258478` at the recorded USD reference

Reverse Arbitrum to Base gas:

- `0.000003124746370295 ETH`
- `$0.0059432675963010904`

Command:

```bash
npm run fx:estimate:v3:live --prefix versus
```

The command is read-only but requires access to the two public RPC endpoints.

## Sub-Penny Result

For the benchmark's approximately `$1.6167` output:

| Route | Spread | Spread cost | Gas + spread |
|---|---:|---:|---:|
| Base → Arbitrum | 5 bps | `$0.00080835` | **`$0.00778385`** |
| Base → Arbitrum | 25 bps | `$0.00404175` | `$0.01101725` |
| Base → Arbitrum | 18 bps | `$0.00291006` | `$0.00988556` |
| Base → Arbitrum | 12 bps | `$0.00194004` | **`$0.00891554`** |
| Arbitrum → Base | 5 bps | `$0.00080835` | **`$0.00675162`** |
| Arbitrum → Base | 25 bps | `$0.00404175` | **`$0.00998502`** |
| Arbitrum → Base | 12 bps | `$0.00194004` | **`$0.00788331`** |

The honest conclusion is:

- V3 gets the four trustless transactions themselves below one penny.
- Base → Arbitrum does **not** stay below one penny at the old 25 bps spread.
- The integer equivalent of halving that spread, 12 bps, produces a measured
  estimate of about **0.89 cents** for this benchmark.
- At this fee point, 18 bps is the largest whole Base → Arbitrum spread that
  remains below one penny, but it leaves almost no volatility margin. Twelve
  bps is the safer candidate.
- The initial dealer default is 5 bps for same-asset low-cost L2 routes. At
  this evidence point that produces about 0.78 cents all-in for the benchmark.
  With the same fixed gas estimate, the total is about `$0.01198` for `$10`,
  `$0.05698` for `$100`, and `$0.50698` for `$1,000` of output.
- Five bps is an offchain quoting default, not a contract fee or promise. The
  dealer may configure 1-25 bps, and measured execution plus necessary
  inventory/rebalancing cost remains part of the all-inclusive quote.

This is not a promise that every swap of every size costs less than one penny.
Gas is mostly fixed; spread scales with trade size. At 12 bps and this gas
point, the all-in charge remains below one penny only up to roughly `$2.52` of
output. A `$10` output would cost about `$0.01898`; a `$100` output would cost
about `$0.12698`. Those are still low percentage costs, but they are not one
penny.

## What Is And Is Not Proven

Proven locally:

- exact requester-secret happy path
- exact recipient and executor payouts
- permissionless claim and refund
- domain separation and complete term binding
- wrong-secret, replay, deadline, callback, fee-token, rejecting-recipient,
  forced-donation, and reentrancy behavior
- stateful solvency invariants
- reproducible creation and runtime bytecode evidence
- EIP-1153 execution support on both target public testnets
- current public-testnet read-only fee estimates

Still required:

- independent contract review
- deployed public-testnet V3 runtime and constructor evidence
- mined four-transaction cost receipts
- desktop and network adapter integration
- two-machine settlement, restart recovery, and timeout/refund acceptance
- physical validation that the 5 bps starting default covers measured failure
  and inventory/rebalancing economics
- a new deployment and coordination ID that cannot mix with V2
