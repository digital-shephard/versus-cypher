# Controlled Waku reliability

- Run: `2026-07-11T11-17-35-466Z-waku-reliability-aefed9fe`
- Result: **PASS**
- Relay kill with live failover: true
- Filter peer loss with resubscription path: true
- Publisher crash after confirmed local staging: true
- No crash double settlement: true
- Drop, delay, duplicate, and reorder convergence: true
- Partition blocked delivery before heal: true
- Partition healed with stable-ID retry: true
- Exact histories after disk restart: true
- RPC outage spent nothing and recovered once: true
- Final accepted records: alpha 11, beta 11, partitionAlpha 11, partitionBeta 8
- Final tickets/class pot: 15/150000 micros
