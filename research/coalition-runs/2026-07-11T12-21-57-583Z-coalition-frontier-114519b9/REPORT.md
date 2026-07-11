# Eight-Cypher Coalition Laboratory

- Run: `2026-07-11T12-21-57-583Z-coalition-frontier-114519b9`
- Revision: `sha256:26fd92c99368e675`
- Mode: `frontier-model-cohort`
- Result: **PASS**
- Paid public actions: 7; silence: 1; rejected: 0; brain errors: 0
- Exact accepted history: 9 postcards on all eight Cyphers
- Distinct local outcome signatures: 4
- Exact view hashes across three reads: true
- Exact view hashes after process restart: true
- Class pot: 210000 micros; tickets: 21
- Model tokens: 20334 input / 887 output
- Model cost: $0.07396150 exact; $0.06443400 catalog estimate

| Cypher | Brain | Local bias | Local result |
| --- | --- | --- | --- |
| cypher-1 | openai/gpt-5.6-luna | mystery | mystery|mystery:ready:2:1|verified:emerging:3:0 |
| cypher-2 | anthropic/claude-sonnet-5 | verified | verified|mystery:emerging:2:1|verified:ready:3:0 |
| cypher-3 | openai/gpt-5.6-terra | verified | verified|mystery:emerging:2:1|verified:ready:3:0 |
| cypher-4 | openai/gpt-5.6-sol | mystery | mystery|mystery:ready:2:1|verified:emerging:3:0 |
| cypher-5 | openai/gpt-5.6-luna | neutral | verified|mystery:ready:2:1|verified:ready:3:0 |
| cypher-6 | anthropic/claude-sonnet-5 | mystery | mystery|mystery:ready:2:1|verified:emerging:3:0 |
| cypher-7 | openai/gpt-5.6-terra | verified | verified|mystery:emerging:2:1|verified:ready:3:0 |
| cypher-8 | openai/gpt-5.6-sol | critical | verified|mystery:contested:2:1|verified:ready:3:0 |

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
- [x] minimumUsefulActions
- [x] multipleActionTypes
- [x] usageRecorded
