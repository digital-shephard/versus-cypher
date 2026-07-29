# EVM Adapter V2 Security Assumptions

V2 exists to deliver an exact destination amount without requiring the
recipient to hold destination-chain gas. It is intentionally incompatible
with V1 settlement messages and contracts.

The frozen public-testnet families are:

- `evm-native-htlc-v2` for native ETH
- `evm-htlc-v2` for one exact manifested ERC-20

## Settlement Order

1. The dealer creates and durably encrypts the settlement secret.
2. The dealer quote commits the secret hash, exact output, executor bounty,
   adapters, gas estimate, gas ceiling, spread, and operating cost.
3. The dealer reserves destination liability before broadcasting funds.
4. The dealer funds destination for the exact recipient amount plus executor
   bounty.
5. The requester independently verifies the destination lock and current
   executor-gas coverage before funding source.
6. The dealer claims source and reveals the secret onchain.
7. Any transaction sender may use that secret to claim destination. The
   contract pays the fixed recipient and the fixed executor bounty atomically.

The requester recovery nonce is not the settlement secret and cannot claim
either lock.

## Contract Authority

Both V2 contracts are ownerless and non-upgradeable. They contain no:

- owner or admin
- pause key
- proxy
- sweep method
- arbitrary call
- mutable fee recipient

Beneficiary, refund address, hash, timeout, recipient amount, and executor
amount are immutable after funding. Claim and refund update state before
external transfers and are protected against reentrancy.

## Exact Payouts

Native funding requires exact `msg.value`.

ERC-20 funding and payout measure contract and recipient balances. Tokens with
fees, rebases, callbacks, or other non-exact behavior are unsupported. Only an
exact manifested token may be admitted.

`beneficiaryAmount + executorAmount` must equal the lock's total liability.
The executor cannot reduce the recipient amount or replace either address.

## Trusted

- The frozen chain eventually reaches the configured confirmation depth.
- Adapter runtime code, constructor policy, token code, and token decimals
  match the frozen deployment manifest.
- The dealer preserves its encrypted secret until source funding is firm.
- The requester checks the destination lock and current execution economics
  before source funding.
- At least one executor can acquire enough destination gas to submit a claim
  while its bounty remains economical.

## Untrusted

- requester
- dealer
- broker
- Waku peers and relays
- execution submitter
- RPC responses until corroborated
- transaction ordering and replacement
- model output

Waku transports signed coordination evidence but never establishes settlement
truth. Each client reads the frozen contracts independently.

## Exposure And Recovery

The dealer journal counts `destination_pending` as active exposure before the
funding transaction is broadcast. Pending, funded, claimed, and refundable
states survive restart.

If the requester cancels or never funds source, the dealer cannot immediately
withdraw destination funds. The fixed destination timeout remains the bound on
that griefing cost. After timeout, anyone may submit the refund, but funds
always return to the fixed dealer refund address.

If the dealer claims source, the secret is public chain data. Any executor may
finish destination delivery. A stale or inadequate bounty is rejected by the
requester before source funding; gas can still move after that check.

## Residual Risks

- Gas can spike after source funding and delay destination execution.
- A complete destination outage can delay claim until recovery.
- A chain reorganization can invalidate evidence observed before configured
  finality.
- A malicious requester can consume dealer time until the destination refund.
- A malicious dealer can lock destination and never proceed; the dealer, not
  the requester, bears that locked capital before source funding.
- A rejecting native recipient contract can make its fixed payout fail.
- An issuer-controlled ERC-20 can freeze or strand funds.
- A leaked dealer secret before source funding lets someone claim destination,
  but cannot redirect its fixed recipient payout.
- Direct donations can make contract balance exceed liabilities but create no
  claim and cannot be swept.

## No-Go Conditions

Do not fund source when:

- destination lock fields differ from the signed acceptance
- destination timeout differs from independently read chain state
- destination refund address differs from the dealer reservation
- executor bounty does not cover the current bounded gas estimate
- source timeout is not safely earlier than destination timeout
- adapter or token code differs from the manifest
- required recovery state is missing or corrupt
- either chain lacks the configured confirmation evidence

## Frozen Testnet Deployment

Deployment ID:
`0x361d43afddce9c272db9d4131c6b6b228693b603924de8f7dc09cc67b58bc5df`

Base Sepolia:

- Native: `0x1e933ccffaa2cd384d3df751ff7a25183682dc61`
- ERC-20: `0x0fa1152f8c51ce05cd61d1ca98515a409ed23c14`
- Deployment blocks: `44781959`, `44781962`

Arbitrum Sepolia:

- Native: `0x1e933ccffaa2cd384d3df751ff7a25183682dc61`
- ERC-20: `0x0fa1152f8c51ce05cd61d1ca98515a409ed23c14`
- Deployment blocks: `292589965`, `292589984`

This authorizes only the disabled-by-default public-testnet laboratory. It does
not authorize mainnet or production funds.
