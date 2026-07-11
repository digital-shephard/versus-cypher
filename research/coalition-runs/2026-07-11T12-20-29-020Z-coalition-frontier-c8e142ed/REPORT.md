# Eight-Cypher Coalition Laboratory

- Run: `2026-07-11T12-20-29-020Z-coalition-frontier-c8e142ed`
- Revision: `sha256:a257a05a2cb4e02a`
- Mode: `frontier-model-cohort`
- Result: **FAIL**
- Paid public actions: 4; silence: 1; rejected: 2; brain errors: 1
- Exact accepted history: 6 postcards on all eight Cyphers
- Distinct local outcome signatures: 2
- Exact view hashes across three reads: true
- Exact view hashes after process restart: true
- Class pot: 180000 micros; tickets: 18
- Model tokens: 20348 input / 1032 output
- Model cost: $0.07523425 exact; $0.06562800 catalog estimate

| Cypher | Brain | Local bias | Local result |
| --- | --- | --- | --- |
| cypher-1 | openai/gpt-5.6-luna | mystery | verified|mystery:contested:0:1|verified:emerging:3:0 |
| cypher-2 | anthropic/claude-sonnet-5 | verified | verified|mystery:contested:0:1|verified:ready:3:0 |
| cypher-3 | openai/gpt-5.6-terra | verified | verified|mystery:contested:0:1|verified:ready:3:0 |
| cypher-4 | openai/gpt-5.6-sol | mystery | verified|mystery:contested:0:1|verified:emerging:3:0 |
| cypher-5 | openai/gpt-5.6-luna | neutral | verified|mystery:contested:0:1|verified:ready:3:0 |
| cypher-6 | anthropic/claude-sonnet-5 | mystery | verified|mystery:contested:0:1|verified:emerging:3:0 |
| cypher-7 | openai/gpt-5.6-terra | verified | verified|mystery:contested:0:1|verified:ready:3:0 |
| cypher-8 | openai/gpt-5.6-sol | critical | verified|mystery:contested:0:1|verified:ready:3:0 |

## Assertions

- [x] eightIndependentProcesses
- [x] eightInstrumentedContexts
- [x] eightInstrumentedDecisions
- [x] exactHistories
- [x] deterministicInProcess
- [x] exactRestartViews
- [x] divergentLocalViews
- [x] chainExact
- [ ] noRejectedDecisions
- [ ] noBrainErrors
- [x] minimumUsefulActions
- [x] multipleActionTypes
- [x] usageRecorded
