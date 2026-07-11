# Packaged Windows walkthrough

Run ID: `2026-07-10T22-36-41-198Z`

Status: partial acceptance pass. The core fresh-user and device paths passed. The economic, live-network, backup/restore, display-scaling, and complete brain-error matrix still require dedicated fixtures or operator review.

## Environment

- Packaged app: `apps/pet/dist-walkthrough/win-unpacked/Versus.exe`
- Electron: `36.9.5`
- Disposable user data: `%LOCALAPPDATA%/Temp/versus-walkthrough-2026-07-10T22-36-41-198Z`
- Production profile and the separately running `dist-verify` app were not used.
- The packaged-only marker selected the disposable profile and left normal builds unchanged.

## Computer-use results

Passed:

- launched a clean profile and observed the dormant egg screen;
- opened funding, rendered the QR code, and verified Copy changed to Copied;
- ran the demo-funded hatch through crack, whiteout, random reveal, and raft arrival;
- cycled Raft, Cypher, Vault, and Signal with the hardware Mode control;
- flipped the Cypher card and read the stat back;
- opened and flipped help while hardware controls remained present;
- opened the generated side settings control and exercised Brain and Device tabs;
- tested an unreachable local brain endpoint and received the human-readable error `Could not reach that brain endpoint. Check the address and try again.`;
- restarted the packaged app with the same profile and observed the same Cypher;
- minimized and restored the transparent window after adding a delayed DWM/Chromium surface refresh;
- moved focus away without reproducing the Electron 36 title strip.

Partial or pending:

- a post-blur automated refocus capture intermittently returned the transparent window's underlying desktop even though the app process and window remained present; the clean-launch and minimize/restore captures succeeded after the compositor refresh;
- funding retry and failure presentation;
- real local-chain runway replenishment, claim, withdrawal, stale-state reconciliation, and chain/RPC failure recovery;
- successful, bad-key, timeout, and malformed brain endpoints plus cloud/external modes;
- a real second-Cypher Waku update and one-time private thought in the packaged UI;
- native backup/restore, launch-on-login verification, and 100/125/150 percent display scaling;
- owner visual acceptance.

## Deterministic visual evidence

`shots/` contains 27 PNG states covering dormant funding, QR, every hatch phase, four day phases, thought presentation, water-fill bounds, graduation proximity, Cypher front/back, Vault claim states, Signal front/back, help front/back, Brain and Device settings, and runway funding.

The sampled dormant, reveal, Cypher-back, and Device images were visually inspected after capture. No clipping or dead critical control was found in those samples.

## Code changes discovered by the walkthrough

- the hardware minus control now minimizes instead of leaving a hidden, hard-to-recover window;
- restoring a transparent Electron window schedules a delayed bounds pulse, hide/show, focus, and `webContents.invalidate()` so Windows rebuilds the transparent compositor surface;
- settings errors use a temporary readable detail banner rather than clipping technical IPC text into the header;
- common endpoint failures and timeouts are translated into human-facing copy.

## Machine assertions

`full-test.log` records the complete repository test run after the walkthrough fixes. It ended with `ALL GREEN`:

- 24 contract and local-chain E2E tests;
- full-day graduation and tranche simulation;
- 66 network tests;
- 2 SDK tests;
- 30 packaged-app supporting tests.

The Hardhat warning about Node.js 25 being outside its supported matrix remains non-fatal and should be removed by pinning a supported Node LTS before release qualification.

## Secret handling

No private key, API key, or plaintext wallet backup is included in this report or its screenshots. The disposable profile contains a generated test wallet and must be deleted after no further packaged walkthrough work depends on this run.
