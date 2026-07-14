# Desktop releases

Versus Cypher uses one tagged source commit for every public desktop release. GitHub Actions builds the signed Windows installer, notarized universal macOS disk image and update ZIP, and Linux AppImage on their native runners. The macOS target must not be approved for its first public tag until the protected manual build and installed signed-to-signed update proof below pass. Release assets include updater metadata, SHA-256 checksums, and GitHub build-provenance attestations.

## Release identity

- Product: `Versus Cypher`
- Application ID: `network.versus.cypher`
- Publisher: `Digital Shephard`
- Update source: `digital-shephard/versus-cypher` GitHub Releases
- Canonical icon: `apps/pet/assets/brand/v_gem.png`

Do not change the application ID after public release. Electron retains an existing installation's profile identity across upgrades; installers must never delete, relocate, or duplicate wallet and Cypher state. A clean public installation starts with the `Versus Cypher` product profile.

## Local packages

From `apps/pet`:

```sh
npm ci
npm run dist:win
npm run dist:mac
npm run dist:linux
```

The public Windows artifact is the NSIS installer. `npm run dist:win:portable` creates an explicitly named advanced portable build and is not part of the default release.

## Internal update proof

1. Build and install version `0.1.0` with NSIS.
2. Confirm the app uses the V-gem icon and preserves wallet, Cypher, settings, and network memory.
3. Publish a test release at `0.1.1` from a temporary update repository or prerelease channel.
4. In Device settings, check for the update, download it, and explicitly restart.
5. Confirm the installed version changed and all persistent state survived.
6. Repeat after Windows signing and macOS signing/notarization are configured.

Development, walkthrough, Linux, and unsigned builds never contact the update provider. Only protected, signed Windows and macOS release builds check after startup and every six hours. Downloads and restarts require explicit owner actions.

## Publishing

1. Update `apps/pet/package.json` and its lockfile to the intended version.
2. Run the complete repository test suite and package smoke tests.
3. Commit the version change.
4. Create and push a matching tag, for example `v0.1.1`.
5. Review the GitHub Actions release environment before approving signing and publication.

The workflow rejects a tag that does not match the desktop package version.

## Signing gate

Unsigned packages are internal test artifacts only. Auto-update is fail-closed in source and unsigned packages: packaged metadata must explicitly identify a signed update build. The protected `release` GitHub environment is the only workflow permitted to set that metadata, and Windows/macOS builds fail unless Authenticode or Apple signing/notarization validation succeeds. Before the first public release:

- Windows uses the managed Azure Artifact Signing profile `versus-cypher-public` in account
  `versuscyphersigning`. GitHub authenticates without a stored credential through the protected
  `release` environment's OIDC identity, which has signer access only to that certificate profile.
- macOS uses the protected `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` environment secrets only during the package-build step. The workflow requires the `DIGITAL SHEPARD LLC` Developer ID identity with Team ID `HN89TZMX7Z`, Hardened Runtime, a stapled notarization ticket, and Gatekeeper acceptance.
- Restrict signing secrets to the protected GitHub `release` environment.
- Require manual approval for stable releases.
- Complete an installed signed-to-signed update test on Windows. Repeat the same gate on macOS before approving its first public release.

Before approving the first public macOS tag, run the workflow manually from `main` and retain the successful `macos-universal` attestation. Install the DMG on a clean Mac account, confirm Gatekeeper identifies `DIGITAL SHEPARD LLC` without an override, then prove an update to a higher signed version preserves wallet, Cypher, settings, and network memory. A successful build alone does not satisfy this release gate.

Never commit certificates, private keys, API tokens, or notarization credentials. The repository ignores common signing-key formats.

## Verification

Users can compare the published SHA-256 digest and verify GitHub provenance:

```sh
gh attestation verify PATH_TO_DOWNLOADED_FILE -R digital-shephard/versus-cypher
```

Building from source should use the exact tag shown beside the download, followed by `npm ci`, the test suite, and the relevant platform package command.
