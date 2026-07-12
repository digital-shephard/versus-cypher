# Linux AppImage preflight

The Linux preflight is a packaging and launch gate, not a substitute for the final clean-machine walkthrough on a mainstream desktop distribution.

## Automated proof

From a native Linux checkout with Node.js 22 and the Electron runtime libraries installed:

```sh
cd apps/pet
npm ci
npx electron-builder --linux AppImage --x64 --publish never
cd ../..
chmod +x apps/pet/dist/Versus-Cypher-*.AppImage
bash scripts/linux/appimage-preflight.sh apps/pet/dist/Versus-Cypher-*.AppImage
```

The script verifies:

- the artifact is an executable 64-bit Linux image;
- AppRun, desktop metadata, and the V-gem icon are embedded correctly;
- packaged metadata keeps auto-update disabled for unsigned Linux builds;
- the packaged application remains alive through a smoke window;
- a second launch reuses the same isolated application profile.

GitHub Actions runs the same build and check on Ubuntu 24.04 and retains the AppImage and text report as workflow artifacts.

## 2026-07-12 local evidence

- Environment: Ubuntu 24.04.4 LTS under WSL2, Node.js 22.23.1.
- Artifact: `Versus-Cypher-0.1.0-linux-x86_64.AppImage`.
- Runtime: Electron 43.1.0, packaged by Electron Builder 26.15.3.
- SHA-256: `52fad4e268d8c4f5b248e422ce9f4daf345e716d78f4668cb89928afa5e25999`.
- Package result: embedded desktop entry and V-gem icon valid; unsigned updater metadata off; two isolated-profile launches passed.
- Visual result: the transparent device, hatch screen, shell controls, and Linux window rendered correctly through WSLg.
- Regression result: all 58 desktop tests and the repository's complete five-layer suite passed; the production-only desktop dependency audit reported zero vulnerabilities.

WSL's minimal userspace does not provide a desktop secret-service keyring by default. Electron therefore refused wallet creation during the WSLg visual check, as designed. Wallet encryption and first-run hatching still require proof on a clean Linux desktop with a normal login keyring.

## Remaining acceptance work

Before a public Linux release, install the artifact on a clean mainstream desktop distribution and visually inspect transparency, dragging, side controls, tray behavior, launch at login, suspend/resume, desktop integration, archive backup and recovery, uninstall, and reinstall. AppImage desktop-menu registration depends on the user's desktop integration tool and cannot be proven by an Xvfb or WSL smoke test alone.
