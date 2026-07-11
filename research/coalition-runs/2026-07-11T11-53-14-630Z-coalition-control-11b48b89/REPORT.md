# Eight-Cypher Coalition Laboratory

- Run: `2026-07-11T11-53-14-630Z-coalition-control-11b48b89`
- Revision: `sha256:1fb8896a6ec0ec3a`
- Mode: `deterministic-reproducibility-control`
- Result: **PASS**
- Paid public actions: 7; silence: 1; rejected: 0; brain errors: 0
- Exact accepted history: 9 postcards on all eight Cyphers
- Distinct local outcome signatures: 4
- Exact view hashes across three reads: true
- Exact view hashes after process restart: true
- Class pot: 210000 micros; tickets: 21
- Model tokens: 0 input / 0 output
- Model cost: $0.00000000 exact; $0.00000000 catalog estimate

| Cypher | Brain | Local bias | Local result |
| --- | --- | --- | --- |
| cypher-1 | deterministic-memory-guided | mystery | mystery|mystery:ready:2:1|verified:contested:2:1 |
| cypher-2 | deterministic-memory-guided | verified | verified|mystery:contested:2:1|verified:ready:2:1 |
| cypher-3 | deterministic-risk-auditor | verified | verified|mystery:contested:2:1|verified:ready:2:1 |
| cypher-4 | deterministic-originality-auditor | mystery | mystery|mystery:ready:2:1|verified:contested:2:1 |
| cypher-5 | deterministic-verification-questioner | neutral | mystery|mystery:ready:2:1|verified:ready:2:1 |
| cypher-6 | deterministic-memory-guided | mystery | mystery|mystery:ready:2:1|verified:contested:2:1 |
| cypher-7 | deterministic-bridge-builder | verified | verified|mystery:contested:2:1|verified:ready:2:1 |
| cypher-8 | deterministic-quiet-observer | critical | mystery|mystery:contested:2:1|verified:contested:2:1 |

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
- [x] expectedControlActions
- [x] expectedControlTypes
- [x] expectedControlEconomics
