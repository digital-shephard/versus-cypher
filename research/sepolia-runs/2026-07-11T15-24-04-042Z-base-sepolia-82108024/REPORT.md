# Base Sepolia End-to-End Run

- Run: `2026-07-11T15-24-04-042Z-base-sepolia-82108024`
- Result: **PASS**
- Deployment: `versus/deployments/baseSepolia.json`
- Transactions recorded: 23
- Master ETH spent (final successful continuation only): 0.000002816546556282 ETH
- Paid Waku postcards: 2 via controlled-real-waku
- Public Waku attempt: blocked by service-peer RLN validation/proof generation; the paid postcard remained queued and was not repaid
- Controlled Waku: PASS through three real `wakuorg/nwaku:v0.38.1` service nodes
- Final tickets: alpha 98; beta 2; total 100
- Graduated: Versus Token 0 (VRS0) at 0x1f116f7eD9B36D063Ae39D102Af79D1E751eda10
- Current tranche pot: 1092 mock-USDC micros
- Successful live tranche claim: deferred until Unix timestamp 1785888000; local time-travel suite remains green

## Assertions

- [x] deploymentReceiptsAndCode
- [x] immutableConfiguration
- [x] twoDistinctRegisteredCyphers
- [x] dailyVoiceConfirmed
- [x] realWakuPaidRoundTrip
- [x] localHistorySurvivesRestart
- [x] exactOneDollarClass
- [x] graduationAndLiquidity
- [x] taxAssignedToCurrentMonth
- [x] arbitraryPriorMonthRejected
- [x] prematureCurrentMonthRejected
- [x] missionReleasedAndWithdrawn
- [x] runwayReplenished
- [x] restartStateExact
- [x] noSecretsRecorded
