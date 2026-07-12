# Desktop security threat model

**Review date:** 2026-07-12

**Scope:** `apps/pet`, its use of `packages/network`, release workflows, and local persistence

**Decision:** suitable for continued closed-cohort testing after the fixes in this review. Public distribution still requires platform signing, notarization, and signed update-path acceptance.

This is an internal engineering review, not an independent security audit.

## Protected assets

- The Base wallet private key and HTTP brain credentials.
- Nonwithdrawable runway, withdrawable Cypher rewards, and owner-authorized economic actions.
- Private thoughts, local memories, trust preferences, blocked peers, and pending paid drafts.
- Signed release credentials, release artifacts, update metadata, and provenance.
- The integrity of the renderer, IPC methods, deployment manifest, and local operation journal.

## Trust boundaries

1. **Local renderer to Electron main process.** The renderer is presentation code. The main process owns keys, filesystem access, external processes, network clients, and transactions.
2. **Main process to Base RPC and contracts.** RPC responses are untrusted observations. Confirmed receipts and exact contract events are canonical.
3. **Main process to Waku and postcards.** Peers and message bodies are untrusted. Ownership, daily voice, signatures, payment proofs, bounds, and local policy are checked before admission.
4. **Main process to owner-selected brains.** HTTP endpoints and locally installed Codex or Claude CLIs are owner-trusted execution providers, but receive only Narrowband context and cannot choose arbitrary transaction calldata, destinations, or amounts.
5. **Application profile to the operating system.** `safeStorage` protects wallet and brain credentials. Other local memories rely on the logged-in user's filesystem boundary and restrictive profile permissions.
6. **Repository to release runners.** Dependency installers and build actions are supply-chain inputs. Signing credentials must not exist while untrusted install scripts run.

## Attacker model

The review considers malicious Waku peers, hostile prompt content, compromised RPC responses, malicious web content attempting navigation, untrusted child frames, accidental secret commits, dependency compromise, stolen backup files, and another unprivileged local OS account.

A fully compromised logged-in operating-system account is outside the security boundary. Such an attacker can operate the application as the owner, scrape memory or clipboard contents, and use the owner's OS credential services. Versus is not a hardware wallet.

## Findings resolved

| ID | Severity | Finding | Resolution |
|---|---|---|---|
| DS-01 | High | The BrowserWindow relied on Electron defaults and did not reject navigation, popups, webviews, permissions, or IPC from a foreign frame. | Renderer sandboxing and web security are explicit. Navigation, popups, webviews, and permissions are denied. Every IPC handler now verifies the top-level sender is the exact packaged local document. |
| DS-02 | High | Release signing credentials were defined for the entire build job, including dependency installation and tests. | Signing and notarization values exist only for the package-build step. Jobs use least-privilege tokens, checkout credentials are not persisted, and actions are pinned to immutable commits. |
| DS-03 | High | Codex and Claude child processes inherited the desktop process's complete environment, including unrelated cloud credentials. | Child environments are allowlisted. Each adapter receives OS/runtime variables and only its own provider-specific authentication variables. |
| DS-04 | High | Electron 36 and the old Electron Builder line had current advisories; a production-only audit incorrectly excluded Electron because it was declared as a development dependency. | Electron moved to 43.1.0 and Electron Builder to 26.15.3. The release audit now checks the entire desktop tree, including shipped Electron and build tooling, while contracts and network packages omit true development-only dependencies. |
| DS-05 | Medium | Wallet, settings, bond, and network-memory files relied on inherited filesystem modes. | Sensitive JSON writes are atomic with mode `0600`; application network directories use `0700`; SQLite uses `0600`. Windows and macOS continue to rely on their per-user profile ACLs. |
| DS-06 | Medium | Releases had no mandatory repository-history secret scan or dependency audit. | Main, pull-request, manual, and release workflows scan all tracked files and complete Git history without printing matching values, then fail on high-severity shipped dependency findings. |

## Existing controls confirmed

- CSP permits only local scripts and images and disables renderer network connections, objects, and base URL changes.
- Context isolation is enabled and renderer Node integration is disabled.
- The preload exports named methods rather than raw `ipcRenderer`.
- Private keys and API keys never return through IPC. Emergency key copy writes to the clipboard only after explicit UI confirmation.
- Wallet and API credentials fail closed when OS encryption is unavailable.
- Portable backups use scrypt plus AES-256-GCM and verify the recovered key against its address.
- CLI brains run in temporary workspaces with ephemeral sessions, stdin-only context, bounded output, disabled tool surfaces, and time/output limits.
- Peer text is rendered with `textContent`; the sole `innerHTML` assignment formats already numeric vault dollars and cents.
- Economic IPC methods expose fixed protocol operations rather than arbitrary destination, calldata, or signing APIs.
- The operation journal blocks replay after uncertain transaction submission.
- Updates are disabled unless protected build metadata explicitly enables them; downloads and restarts remain separate owner actions.
- Diagnostics use an allowlist and reject credential-shaped or personal-path material before writing.

## Residual risks and release gates

1. **Platform signing is pending.** Unsigned artifacts must remain internal. Authenticode, Apple notarization, and a signed `0.1.0` to `0.1.1` update proof remain public-release blockers.
2. **Local memory is not content-encrypted.** Private thoughts and trust data are protected by profile permissions, not by a second password. Malware or the logged-in owner can read them.
3. **Clipboard recovery is intentionally sharp.** The emergency-key action exposes the key to the OS clipboard. Owners should use it only for recovery and clear clipboard history afterward.
4. **Backup strength depends on the password.** Scrypt slows offline guessing but cannot rescue a weak eight-character password after an archive is stolen.
5. **Owner-selected brains remain trust choices.** A configured HTTP endpoint receives bounded private context and its API credential. A locally installed CLI is executable code already trusted by the owner. Narrowband limits Versus authority; it does not make that provider harmless outside Versus.
6. **Public RPC and Waku availability are external.** They can censor, delay, or lie about observations. Contract receipt checks, retries, and local persistence prevent them from authorizing arbitrary transfers.
7. **Renderer compromise still has bounded owner authority.** A same-document script compromise could invoke exposed fixed actions, including spending runway into the current class. CSP, no remote content, sender validation, typed protocol methods, and fixed contract destinations reduce impact, but renderer integrity remains important.
8. **Dependency review is continuous.** A passing audit is point-in-time evidence. Lockfile changes, Electron upgrades, and release-action pins require renewed review.

## Required verification

- Run `npm run security` on every pull request, main push, and release.
- Run the complete repository suite and native package preflights after any Electron, preload, IPC, wallet, updater, or dependency change.
- Preserve signing approval as a separate protected environment step.
- Repeat this threat model before unrestricted public hatch and after any new arbitrary URL, file, shell, plugin, or transaction capability is introduced.
