# Chain-backed packaged walkthrough

Run ID: `2026-07-10T23-45-33-642Z-dc541f91`

Result: **PASS** for the packaged local-chain economic path.

## Scope

- Electron `36.9.5` unpacked Windows package.
- Fresh disposable profile selected by a packaged-only marker.
- Persistent Hardhat RPC on chain `31337`.
- Ownerless Versus contracts deployed by the harness.
- TCP-only local network transport for this economic UI run.
- Windows interactions performed through computer use.

## Proven UI path

1. Launched the dormant egg from a clean profile.
2. Funded the generated wallet with `0.003 ETH` on the local chain.
3. Opened the Base funding QR and confirmed the deposit.
4. Observed the crack ritual and a random Kamakasu reveal.
5. Confirmed the first daily penny, one ticket, and `$6.99` runway.
6. Opened the Vault runway QR, copied the address, funded another `0.003 ETH`, and confirmed the refill.
7. Observed runway rise to `$13.99` and about `1.4K` rain days.
8. Seeded and finalized a `$10.00` tranche; the UI showed `$9.00` claimable after the 10 percent protocol cut.
9. Claimed through the ready and received presentations, then observed `$9.00` in the NFT reward vault.
10. Withdrew the reward and observed the visible reward balance return to `$0.00`.
11. Injected stale local runway `14,113,456`, restarted the same profile, and observed startup reconciliation restore canonical `13,990,000`.
12. Reopened runway funding without a new deposit and verified the readable retry sentence `Deposit not found yet. Check again in a moment.` without changing runway.

## Machine assertions

`summary.json` passed every assertion at block `29`:

- the Agent NFT owner equals the packaged wallet;
- random Cypher `17` matches local state;
- runway is exactly `13,990,000` micros;
- ticket count is exactly `1`;
- NFT vault and claimable balances are both zero after withdrawal;
- the wallet received exactly `9,000,000` USDC micros;
- class 1 contains one participant and exactly one confirmed penny;
- the wallet file contains an OS-encrypted private key and no plaintext private-key field.

## Evidence

- `deployment.json`: local ownerless contract addresses and economics.
- `events.jsonl`: funding, tranche seed, and assertion events.
- `hardhat.log`: chain calls with standard development keys redacted.
- `summary.json`: final exact chain/local-state comparison.
- `full-test.log`: complete repository suite ending `ALL GREEN`.
- `shots/`: 27 deterministic stable-state PNGs generated from the same packaged renderer revision.

## Defects found and fixed

- non-Base RPCs were incorrectly constructed as Base mainnet providers;
- the packaged ETH path could not use the repo's local mock deployment;
- ethers' 250 ms provider cache reused stale nonces on synchronous external test chains;
- the runway retry surface leaked Electron IPC error prefixes;
- transparent Windows restores needed a delayed compositor refresh.

## Remaining acceptance work

- controlled nwaku faults remain blocked until WSL is updated with administrator rights;
- the complete brain endpoint matrix and live second-Cypher Signal presentation remain open;
- backup/restore through native dialogs, login launch verification, and 125/150 percent display scaling remain open;
- the final blur/refocus check was stopped when Windows reported user input in the target window;
- owner visual acceptance remains open.

No API key, private key, or plaintext backup is present in this run directory.
