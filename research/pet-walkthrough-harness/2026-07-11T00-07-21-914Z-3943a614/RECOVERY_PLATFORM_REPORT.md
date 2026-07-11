# Packaged recovery and Windows integration walkthrough

Run ID: `2026-07-11T00-07-21-914Z-3943a614`

Result: **PASS** for encrypted full-Cypher backup, clean-profile restore, canonical reconciliation, and launch-on-login enable/disable.

## Encrypted archive

Computer use entered a backup password and saved `versus-cypher-full-cCf2b7.versus-archive.json` through the native Windows Save dialog.

The `5,976` byte archive exposes only these envelope fields:

`format`, `version`, `kdf`, `cipher`, `salt`, `iv`, `tag`, and `data`.

Its format is `versus-cypher-archive` version `1`, with `scrypt-n32768-r8-p1` key derivation and `aes-256-gcm` authenticated encryption. No plaintext private key, postcard, peer note, or thought appears at the top level.

## Clean restore

A second disposable profile began on the dormant hatch screen. Computer use selected the archive through the native Open dialog, entered its password, and observed `RESTORED`. The active Raft appeared immediately without restarting the process.

Machine verification after restore found:

- the same wallet address, agent `1`, and Cypher `7`;
- canonical runway `6,980,000`, tickets `702`, vault zero, and claimable zero;
- one accepted postcard and one peer profile in the restored SQLite database;
- the private thought retained in `seen` state with its `seenAt` timestamp;
- an encrypted wallet field and no plaintext `privateKey` field;
- all ownership, Cypher, economic, and claim assertions passing at block `36`.

The restore flow also exposed and fixed a real presentation defect: a successful restore had left the dormant hatch view underneath the toast. The renderer now switches immediately to the canonical active view after import.

## Launch on login

Device settings enabled and then disabled `Start Versus at login`. Main-process evidence recorded the Windows-specific launch item rather than trusting the checkbox:

- enabled: one user-scoped item named `Versus Walkthrough`, targeting the exact `dist-walkthrough` executable, with `executableWillLaunchAtLogin: true`;
- disabled: no launch items and `executableWillLaunchAtLogin: false`.

The final state is disabled so the test package does not persist on the owner's machine.

## Artifacts

- `versus-cypher-full-cCf2b7.versus-archive.json`: encrypted archive envelope.
- `summary.json`: post-restore canonical assertions.
- `login-item-events.jsonl`: main-process Windows launch-item observations.
- `events.jsonl`: isolated profile transitions and final assertion.

No archive password, API key, plaintext private key, or prompt body is recorded.
