# Eight-Cypher Coalition Laboratory

- Run: `2026-07-11T12-17-08-388Z-coalition-frontier-68491e37`
- Revision: `sha256:67baa742c63d8479`
- Mode: `frontier-model-cohort`
- Result: **FAIL**
- Paid public actions: 2; silence: 1; rejected: 4; brain errors: 1
- Exact accepted history: 4 postcards on all eight Cyphers
- Distinct local outcome signatures: 2
- Exact view hashes across three reads: true
- Exact view hashes after process restart: true
- Class pot: 180000 micros; tickets: 18
- Model tokens: 18549 input / 805 output
- Model cost: $0.07161150 exact; $0.06237700 catalog estimate

| Cypher | Brain | Local bias | Local result |
| --- | --- | --- | --- |
| cypher-1 | openai/gpt-5.6-luna | mystery | 0x1ea32569bcfc80c958c5705acb785ce39efd20d9bc66b5b1e382c811d606410b|0x1ea32569bcfc80c958c5705acb785ce39efd20d9bc66b5b1e382c811d606410b:emerging:0:0|mystery:emerging:0:0|verified:emerging:1:0 |
| cypher-2 | anthropic/claude-sonnet-5 | verified | verified|0x1ea32569bcfc80c958c5705acb785ce39efd20d9bc66b5b1e382c811d606410b:emerging:0:0|mystery:emerging:0:0|verified:emerging:1:0 |
| cypher-3 | openai/gpt-5.6-terra | verified | verified|0x1ea32569bcfc80c958c5705acb785ce39efd20d9bc66b5b1e382c811d606410b:emerging:0:0|mystery:emerging:0:0|verified:emerging:1:0 |
| cypher-4 | openai/gpt-5.6-sol | mystery | 0x1ea32569bcfc80c958c5705acb785ce39efd20d9bc66b5b1e382c811d606410b|0x1ea32569bcfc80c958c5705acb785ce39efd20d9bc66b5b1e382c811d606410b:emerging:0:0|mystery:emerging:0:0|verified:emerging:1:0 |
| cypher-5 | openai/gpt-5.6-luna | neutral | verified|0x1ea32569bcfc80c958c5705acb785ce39efd20d9bc66b5b1e382c811d606410b:emerging:0:0|mystery:emerging:0:0|verified:emerging:1:0 |
| cypher-6 | anthropic/claude-sonnet-5 | mystery | 0x1ea32569bcfc80c958c5705acb785ce39efd20d9bc66b5b1e382c811d606410b|0x1ea32569bcfc80c958c5705acb785ce39efd20d9bc66b5b1e382c811d606410b:emerging:0:0|mystery:emerging:0:0|verified:emerging:1:0 |
| cypher-7 | openai/gpt-5.6-terra | verified | verified|0x1ea32569bcfc80c958c5705acb785ce39efd20d9bc66b5b1e382c811d606410b:emerging:0:0|mystery:emerging:0:0|verified:emerging:1:0 |
| cypher-8 | openai/gpt-5.6-sol | critical | verified|0x1ea32569bcfc80c958c5705acb785ce39efd20d9bc66b5b1e382c811d606410b:emerging:0:0|mystery:emerging:0:0|verified:emerging:1:0 |

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
- [ ] minimumUsefulActions
- [x] multipleActionTypes
- [x] usageRecorded
