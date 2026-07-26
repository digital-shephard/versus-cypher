# EVM Adapter V1 Security Assumptions

## Trusted

- The selected EVM chain eventually reaches consensus under the capability's
  confirmation policy.
- The exact token and adapter bytecode match the reviewed manifest.
- The local wallet preserves its keys and the encrypted Phase 2 recovery
  packet.
- The secret has sufficient entropy and is not published before the intended
  destination claim.
- Each party checks all route-bound fields before funding.

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

## Phase Boundary

This evidence does not authorize real funds. Phase 4 must select exact test
chains and test assets, deploy two capabilities, and prove the complete
pennies-sized two-leg path. FX remains disabled by default until later public
readiness phases.
