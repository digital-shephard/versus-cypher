# Eight-Cypher Coalition Laboratory

- Run: `2026-07-11T12-05-00-654Z-coalition-http-fixture-0af81dc3`
- Revision: `sha256:67baa742c63d8479`
- Mode: `openai-compatible-provider-fixture`
- Result: **PASS**
- Paid public actions: 7; silence: 1; rejected: 0; brain errors: 0
- Exact accepted history: 9 postcards on all eight Cyphers
- Distinct local outcome signatures: 4
- Exact view hashes across three reads: true
- Exact view hashes after process restart: true
- Class pot: 210000 micros; tickets: 21
- Model tokens: 13846 input / 474 output
- Model cost: $0.01479400 exact; $0.01479400 catalog estimate

| Cypher | Brain | Local bias | Local result |
| --- | --- | --- | --- |
| cypher-1 | fixture-memory-guided | mystery | mystery|mystery:ready:2:1|verified:contested:2:1 |
| cypher-2 | fixture-memory-guided | verified | verified|mystery:contested:2:1|verified:ready:2:1 |
| cypher-3 | fixture-risk-auditor | verified | verified|mystery:contested:2:1|verified:ready:2:1 |
| cypher-4 | fixture-originality-auditor | mystery | mystery|mystery:ready:2:1|verified:contested:2:1 |
| cypher-5 | fixture-verification-questioner | neutral | mystery|mystery:ready:2:1|verified:ready:2:1 |
| cypher-6 | fixture-memory-guided | mystery | mystery|mystery:ready:2:1|verified:contested:2:1 |
| cypher-7 | fixture-bridge-builder | verified | verified|mystery:contested:2:1|verified:ready:2:1 |
| cypher-8 | fixture-quiet-observer | critical | mystery|mystery:contested:2:1|verified:contested:2:1 |

## Assertions

- [x] eightIndependentProcesses
- [x] eightInstrumentedContexts
- [x] eightInstrumentedDecisions
- [x] exactHistories
- [x] deterministicInProcess
- [x] exactRestartViews
- [x] divergentLocalViews
- [x] chainExact
- [x] noRejectedDecisions
- [x] noBrainErrors
- [x] expectedFixtureActions
- [x] expectedFixtureTypes
- [x] fixtureUsageRecorded
- [x] eightFixtureRequests
- [x] expectedFixtureEconomics
