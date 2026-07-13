# Versus Cypher Base Deployment Verification

- Manifest version: 2
- Release stage: closed-cohort
- Chain: Base (8453)
- Source commit: `932d297b919d30d1cf5520b09c5abb97e13dd7fe`
- Source tree SHA-256: `13d0fe2832e021737526ff9e906ae39d77d70748844af31c0d481c79b9fb9b7b`
- Manifest SHA-256: `bd12cfe4744c8c1f5af0f9922a699a03182735e8fcfe663394fe7694278417f4`
- Independently checked: 2026-07-13T18:43:52.559Z
- Safe: 1 owner(s), threshold 1
- Unrestricted-public ready: no
- Safe hardening required: yes

## Ownerless Wiring

The deployed core has no admin upgrade, pause, or ownership surface. One-time bootstrap bindings were independently read from Base and are sealed.

| Result | Invariant |
| --- | --- |
| PASS | chain id |
| PASS | agents.usdc |
| PASS | agents.arena |
| PASS | agents.treasury |
| PASS | agents.missionEscrow |
| PASS | agents.referralPool |
| PASS | syndicate.usdc |
| PASS | syndicate.arena |
| PASS | syndicate.graduation |
| PASS | treasury.usdc |
| PASS | treasury.arena |
| PASS | treasury.agents |
| PASS | treasury.protocolRecipient |
| PASS | arena.usdc |
| PASS | arena.agents |
| PASS | arena.syndicate |
| PASS | arena.treasury |
| PASS | arena.referralPool |
| PASS | graduation.usdc |
| PASS | graduation.router |
| PASS | graduation.factory |
| PASS | graduation.syndicate |
| PASS | graduation.treasury |
| PASS | missionEscrow.usdc |
| PASS | missionEscrow.agents |
| PASS | referralPool.usdc |
| PASS | referralPool.agents |
| PASS | referralPool.arena |
| PASS | agents bootstrapped |
| PASS | syndicate bootstrapped |
| PASS | treasury bootstrapped |
| PASS | referral pool bootstrapped |
| PASS | graduation floor |
| PASS | penny |
| PASS | minimum runway |
| PASS | referral reward |
| PASS | protocol tranche bps |
| PASS | basis points |
| PASS | cypher species count |
| PASS | metadata base URI |
| PASS | usdc runtime address binding |
| PASS | usdc runtime bytecode |
| PASS | v2Factory runtime address binding |
| PASS | v2Factory runtime bytecode |
| PASS | v2Router runtime address binding |
| PASS | v2Router runtime bytecode |
| PASS | agents runtime address binding |
| PASS | agents runtime bytecode |
| PASS | arena runtime address binding |
| PASS | arena runtime bytecode |
| PASS | syndicate runtime address binding |
| PASS | syndicate runtime bytecode |
| PASS | treasury runtime address binding |
| PASS | treasury runtime bytecode |
| PASS | missionEscrow runtime address binding |
| PASS | missionEscrow runtime bytecode |
| PASS | referralPool runtime address binding |
| PASS | referralPool runtime bytecode |
| PASS | graduation runtime address binding |
| PASS | graduation runtime bytecode |
| PASS | canonical Base USDC |
| PASS | canonical Base V2 factory |
| PASS | canonical Base V2 router |
| PASS | canonical Base protocol recipient |
| PASS | router factory |
| PASS | router WETH |
| PASS | safe singleton |
| PASS | safe modules empty |
| PASS | safe guard zero |
| PASS | safe fallback handler |

## Source Verification

Basescan status: **verified**.
