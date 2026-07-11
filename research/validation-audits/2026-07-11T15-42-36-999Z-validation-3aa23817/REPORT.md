# End-to-End Validation Audit

- Run: `2026-07-11T15-42-36-999Z-validation-3aa23817`
- Audit integrity: **PASS**
- Sepolia decision: **GO**
- Current repository tests: pass
- Credential scan: pass

## Required Evidence

- [x] local economic E2E: `research/network-runs/2026-07-10T22-00-58-592Z-866c571a/summary.json`
- [x] public Waku E2E: `research/network-runs/2026-07-10T22-15-00-248Z-waku-4cfda859/summary.json`
- [x] controlled Waku baseline: `research/network-runs/2026-07-11T10-50-17-605Z-waku-controlled-bc9b583c/summary.json`
- [x] controlled Waku reliability: `research/network-runs/2026-07-11T11-17-35-466Z-waku-reliability-aefed9fe/summary.json`
- [x] Store expiry and Cypher recovery: `research/network-runs/2026-07-11T11-24-25-017Z-waku-controlled-ec489d40/summary.json`
- [x] compaction scale: `research/compaction-runs/2026-07-10T22-30-49-630Z-3908c60c/summary.json`
- [x] controlled capacity: `research/capacity-runs/2026-07-11T11-29-17-505Z-waku-capacity-1727885b/summary.json`
- [x] eight-Cypher reproducibility control: `research/coalition-runs/2026-07-11T11-53-14-630Z-coalition-control-11b48b89/summary.json`
- [x] production HTTP brain fixture: `research/coalition-runs/2026-07-11T12-05-00-654Z-coalition-http-fixture-0af81dc3/summary.json`
- [x] live frontier-model coalition: `research/coalition-runs/2026-07-11T12-21-57-583Z-coalition-frontier-114519b9/summary.json`
- [x] stable-state visual bounds: `research/visual-audits/2026-07-11T12-00-24-833462Z-stable-baseline/summary.json`
- [x] packaged SQLite smoke: `research/package-smoke/20260710-180329-result.json`
- [x] packaged brain effects: `research/pet-walkthrough-harness/2026-07-11T00-07-21-914Z-3943a614/brain-fixture-summary.json`
- [x] packaged economic failures: `research/pet-walkthrough-harness/2026-07-11T00-07-21-914Z-3943a614/economic-failure-summary.json`
- [x] packaged recovery: `research/pet-walkthrough-harness/2026-07-11T00-07-21-914Z-3943a614/recovery-summary.json`
- [x] packaged display scaling: `research/pet-walkthrough-harness/2026-07-11T00-07-21-914Z-3943a614/scaling/summary.json`
- [x] packaged network states: `research/pet-walkthrough-harness/2026-07-11T00-07-21-914Z-3943a614/network-states/summary.json`

## Remaining Gates

- [x] Live frontier-model coalition
- [x] Owner visual acceptance bound to the current visual audit
