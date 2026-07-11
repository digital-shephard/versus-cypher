# Controlled Waku capacity

- Run: `2026-07-11T11-29-17-505Z-waku-capacity-1727885b`
- Acceptance result through 100 clients: **PASS**
- Stages: 2 pass, 8 pass, 32 pass, 100 pass, 500 fail
- Sharding result: introduce neighborhood or interest sharding above 100 concurrent launch clients before retrying 500

| Clients | Result | Delivery | p95 | Peak RSS |
| ---: | --- | ---: | ---: | ---: |
| 2 | pass | 100.000% | 67 ms | 120.0 MiB |
| 8 | pass | 100.000% | 174 ms | 155.1 MiB |
| 32 | pass | 100.000% | 1112 ms | 247.4 MiB |
| 100 | pass | 100.000% | 2111 ms | 343.8 MiB |
| 500 | fail | n/a | n/a ms | 427.4 MiB |
