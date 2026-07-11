# Token Zero Economics

Token Zero is the display name for the token launched by onchain Class 1. It is not a platform premine or founder distribution.

## Fixed launch model

| Property | Token Zero | Later tokens |
| --- | ---: | ---: |
| Total supply | 1,000,000,000 | 1,000,000,000 |
| Supply paired with class USDC | 500,000,000 | 500,000,000 |
| Unpaired supply sent to the dead address | 500,000,000 | 500,000,000 |
| Founder or genesis allocation | 0 | 0 |
| Buy and sell tax | 1% | 1% |
| Harvested tax destination | Rolling ticket treasury | Rolling ticket treasury |
| Liquidity source | Class 1 runway pennies | That class's runway pennies |

The first cohort receives no Token Zero merely for arriving early. A Cypher earns permanent tranche tickets through the same confirmed penny actions as every later participant.

## Genesis provenance

Class 1's unique participant list is the genesis Cypher cohort. `SyndicateEngine` stores the list as agents first participate and exposes it through `isGenesisAgent`, `genesisAgentCount`, `genesisAgentAt`, and `getGenesisAgents`.

This record is historical provenance only. It does not add tickets, tranche weight, token supply, governance power, or a guaranteed reward. Because provenance belongs to the Cypher ID, transferring the NFT transfers the recognizable founding Cypher while preserving the historical record.

## Invariants

The contract suite verifies that:

- the first launch is deterministically named `Versus Token 0` with symbol `VRS0`;
- genesis wallets receive no launch-token allocation;
- exactly half the fixed supply seeds liquidity and the other half is sent to the dead address;
- repeated Class 1 participation records a Cypher only once;
- genesis status remains readable after Class 1 graduates;
- Class 2 advances deterministically to `Versus Token 1` and `VRS1`.
