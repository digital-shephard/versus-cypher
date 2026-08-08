# EVM Adapter V1 Security Assumptions

These assumptions cover two deliberately separate adapter families:

- `evm-htlc-v1` for one exact manifested ERC-20
- `evm-native-htlc-v1` for the native ETH of one exact manifested chain

Neither capability implies support for the other.

## Trusted

- The selected EVM chain eventually reaches consensus under the capability's
  confirmation policy.
- The exact token and adapter bytecode match the reviewed manifest.
- The local wallet preserves its keys and the encrypted Phase 2 recovery
  packet.
- The secret has sufficient entropy and is not published before the intended
  destination claim.
- Each party checks all route-bound fields before funding.
- A native-asset route uses a sufficiently fresh signed ETH/USD reference and
  binds the native adapter ID on the applicable route leg.

## Untrusted

- requester, dealer, broker, execution relayer, Waku peers, and RPC responses
- transaction submitter identity
- transaction ordering and replacement
- model output
- signed messages that are not corroborated by chain state

An untrusted relayer may reveal the right secret or submit an expired refund,
but cannot choose either payout destination.

## Token Assumptions

Version 1 supports only an exact manifested ERC-20 with:

- stable integer balances
- no transfer fee
- no rebase
- no transfer callback behavior
- working `balanceOf`, `transfer`, `transferFrom`, and `decimals`

The contract verifies exact balance changes on ingress and egress. This catches
common fee-on-transfer behavior, but it is not a universal token-behavior
oracle. Admission must reject unreviewed assets before approval.

Issuer controls are a separate route risk. A canonical token issuer may freeze
an address or change an implementation. Any future capability using such a
token must say so, pin the observable runtime, monitor changes, and explain that
issuer action can delay or prevent settlement. Phase 3's local capability has
no issuer control.

## Native ETH Assumptions

`EvmNativeHtlcV1` accepts only exact-value payable funding. The contract amount
is `msg.value`; there is no separately supplied amount that can disagree with
custody. Beneficiary, refund address, hashlock, and timeout are immutable for
the life of a lock.

Direct ETH transfers and arbitrary calldata revert. ETH forced into the
contract can make its balance exceed `totalLocked`, but cannot create a lock,
alter a liability, or be swept. Claim and refund update state before the fixed
payout and revert completely if that payout fails.

Dealer inventory excludes active native reservations, temporary requester
funding, a configured operating gas reserve, and the estimated fee for the
transaction being submitted.

The gas reserve is an availability guard, not settlement principal. `MAX GAS`
is a local USD risk/cost ceiling and must not be presented as a second wallet
balance.

Native atomic amounts are converted to USD risk values only through a
currently valid signed relay quote. Native quoting fails closed when the
reference is missing, expired, or stale. ERC-20 stablecoin-only routes do not
depend on that ETH reference.

## Residual Risks

- A chain reorganization can invalidate a previously observed action before
  configured finality.
- Gas can become uneconomic while a lock is active.
- A malicious counterparty can waste time by forcing the refund path.
- Direct token donations can make contract balance exceed liabilities; they do
  not create a claim.
- A leaked secret allows anyone to submit the claim, but payout still goes to
  the fixed beneficiary.
- A bad beneficiary or refund address can make funds inaccessible to the
  intended human. Clients must compare addresses to the accepted route.
- An issuer-controlled token can strand funds through issuer action.
- Native gas prices can move between estimation and inclusion. A transaction
  may fail even though the preflight reserve was sufficient when quoted.
- ETH/USD price movement can make a still-atomic quote economically poor.
  Short expiries and fresh signed references limit but do not remove this
  market risk.
- A rejecting fixed beneficiary or refund contract can prevent its payout
  until the other state transition becomes eligible; the adapter cannot
  redirect value.

## No-Go Conditions

Do not admit or deploy a route when:

- the adapter permits arbitrary target calls
- an owner, pause key, proxy admin, or sweep authority can seize active locks
- asset address, adapter address, runtime code, decimals, or feature declaration
  differs from the manifest
- source timeout is not safely later than destination timeout
- either timeout is outside its deployment's bounds
- recovery material was not durably encrypted before the first funding
  transaction
- the token transfer mechanics are unreviewed
- a native route omits its native adapter binding or uses the ERC-20 adapter ID
- a native ETH/USD reference is absent, stale, future-dated, or unsigned by a
  configured trusted relay signer
- native inventory would consume the configured operating gas reserve or the
  estimated transaction fee

## Phase Boundary

This evidence authorizes only the frozen Base Sepolia and Arbitrum Sepolia
cohort laboratory. It does not authorize mainnet or production funds. FX
remains disabled by default until later public-readiness phases.
