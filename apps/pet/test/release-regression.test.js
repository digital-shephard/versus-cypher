const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const repositoryRoot = path.join(root, "..", "..");

test("macOS releases stay signed notarized updateable and step scoped", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const workflow = fs.readFileSync(
    path.join(repositoryRoot, ".github", "workflows", "release.yml"),
    "utf8"
  );
  const macJobStart = workflow.indexOf("  macos:");
  const publishJobStart = workflow.indexOf("  publish:", macJobStart);
  const macJob = workflow.slice(macJobStart, publishJobStart);
  const signedAppStep = macJob.slice(
    macJob.indexOf("      - name: Build and sign resumable app"),
    macJob.indexOf("      - name: Verify Developer ID signature before submission")
  );
  const submitStep = macJob.slice(
    macJob.indexOf("      - name: Submit app to Apple notarization service"),
    macJob.indexOf("      - name: Preserve resumable notarization state")
  );
  const waitStep = macJob.slice(
    macJob.indexOf("      - name: Wait for the existing Apple submission"),
    macJob.indexOf("      - name: Staple ticket and build distributable packages")
  );

  assert.deepEqual(packageJson.build.mac.target, ["dmg", "zip"]);
  assert.equal(packageJson.build.mac.hardenedRuntime, true);
  assert.equal(packageJson.build.mac.notarize, true);
  assert.equal(packageJson.build.mac.entitlements, "entitlements.mac.plist");
  assert.equal(packageJson.build.mac.entitlementsInherit, "entitlements.mac.inherit.plist");

  assert.match(workflow, /name: Build macos-universal/);
  assert.match(macJob, /electron-builder --mac --dir --universal[\s\S]*--config\.mac\.notarize=false/);
  assert.match(macJob, /notarytool submit[\s\S]*--output-format json/);
  assert.match(macJob, /notarytool info/);
  assert.doesNotMatch(macJob, /notarytool submit[^\n]*--wait/);
  assert.match(macJob, /github\.run_attempt > 1/);
  assert.match(workflow, /macos_notarization_run_id:/);
  assert.match(macJob, /github\.run_attempt > 1 \|\| inputs\.macos_notarization_run_id != ''/);
  assert.match(macJob, /run-id: \$\{\{ inputs\.macos_notarization_run_id \|\| github\.run_id \}\}/);
  assert.match(macJob, /if ! xcrun notarytool info/);
  assert.match(macJob, /Apple status check failed transiently; retrying without creating a new submission/);
  assert.match(macJob, /name: macos-notarization-state/);
  assert.match(macJob, /electron-builder --mac dmg zip --universal --prepackaged/);
  assert.match(macJob, /mkdir -p dist\/verification[\s\S]*ditto -x -k "\$zip_path" dist\/verification/);
  assert.match(workflow, /Authority=Developer ID Application: DIGITAL SHEPARD LLC \(HN89TZMX7Z\)/);
  assert.match(workflow, /TeamIdentifier=HN89TZMX7Z/);
  assert.match(workflow, /spctl --assess --type execute/);
  assert.match(workflow, /xcrun stapler validate/);
  assert.match(signedAppStep, /secrets\.MAC_CSC_LINK/);
  assert.match(signedAppStep, /secrets\.MAC_CSC_KEY_PASSWORD/);
  assert.doesNotMatch(signedAppStep, /secrets\.APPLE_/);
  for (const name of ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]) {
    assert.match(submitStep, new RegExp(`secrets\\.${name}`));
    assert.match(waitStep, new RegExp(`secrets\\.${name}`));
  }
  assert.doesNotMatch(macJob.slice(0, macJob.indexOf("      - name: Build and sign resumable app")), /secrets\.(?:MAC_CSC|APPLE_)/);
});

test("packaged deployment verification accepts macOS Resources casing", (t) => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "versus-macos-deployment-"));
  t.after(() => fs.rmSync(dist, { recursive: true, force: true }));
  const bundled = path.join(
    dist,
    "Versus Cypher.app",
    "Contents",
    "Resources",
    "deployment",
    "base.json"
  );
  fs.mkdirSync(path.dirname(bundled), { recursive: true });
  fs.copyFileSync(path.join(repositoryRoot, "versus", "deployments", "base.json"), bundled);

  execFileSync(process.execPath, [
    path.join(root, "scripts", "verify-packaged-deployment.js"),
    dist,
  ]);
});

test("Windows uninstall offers an explicit wallet deletion choice but not during updates", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const include = packageJson.build.nsis.include;
  const script = fs.readFileSync(path.join(root, include), "utf8");
  assert.equal(include, "installer.nsh");
  assert.match(script, /\$\{ifNot\} \$\{isUpdated\}/);
  assert.match(script, /Delete all Versus Cypher data, including the wallet/);
  assert.match(script, /RMDir \/r "\$APPDATA\\Versus Cypher"/);
});

test("Windows launch on login verifies the named Run entry instead of Electron readback", () => {
  const main = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");
  assert.match(main, /name: WALKTHROUGH_PROFILE \? "Versus Cypher Walkthrough" : "Versus Cypher"/);
  assert.match(main, /\["Versus", "fun\.versus\.pet"\]/);
  assert.match(main, /readWindowsRunValue\(options\.name\)/);
  assert.match(main, /windowsRunEntryAccepted\(options\.openAtLogin, windowsRunValue, process\.execPath\)/);
  assert.doesNotMatch(main, /matchingItems\.some\(\(item\) => item\.enabled\)/);
});

test("hatch funding uses dynamic Base ETH copy and never exposes broken QR alt text", () => {
  const html = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");
  const renderer = fs.readFileSync(path.join(root, "renderer", "pet.js"), "utf8");
  assert.match(html, /id="fund-title"/);
  assert.match(html, /id="address-qr" alt=""/);
  assert.doesNotMatch(html, /FUND ABOUT \$10 IN ETH/);
  assert.match(renderer, /FUND ABOUT \$\{eth\.toFixed\(5\)\} BASE ETH/);
  assert.match(renderer, /QR unavailable\. Copy the address instead\./);
});

test("startup does not expose the hatch screen before Cypher identity is known", () => {
  const html = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");
  const renderer = fs.readFileSync(path.join(root, "renderer", "pet.js"), "utf8");
  const preload = fs.readFileSync(path.join(root, "src", "preload.js"), "utf8");
  const main = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");

  assert.match(html, /id="view-boot" class="view view-boot"/);
  assert.match(html, /id="view-deposit" class="view hidden"/);
  assert.match(renderer, /bond = await window\.versus\.loadLocalBond\(\)/);
  assert.match(renderer, /show\("view-boot"\)/);
  assert.match(preload, /loadLocalBond: \(\) => ipcRenderer\.invoke\("bond:loadLocal"\)/);
  assert.match(main, /registerIpcHandle\("bond:loadLocal", \(\) => loadState\(\)\)/);
});

test("archive restore reveals the local Cypher while remote recovery continues", () => {
  const renderer = fs.readFileSync(path.join(root, "renderer", "pet.js"), "utf8");
  const main = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");
  const preload = fs.readFileSync(path.join(root, "src", "preload.js"), "utf8");
  const rendererHandler = renderer.slice(
    renderer.indexOf('$("btn-restore-wallet")?.addEventListener'),
    renderer.indexOf('$("btn-copy-key")?.addEventListener')
  );
  const restoreHandler = main.slice(
    main.indexOf("async function restoreCypherPayload"),
    main.indexOf('registerIpcHandle("wallet:createBackup"')
  );

  assert.match(restoreHandler, /saveState\(payload\.bond\)[\s\S]*const state = structuredClone\(loadState\(\)\)/);
  assert.match(restoreHandler, /pendingRestoreRecovery = async \(\) =>/);
  assert.match(restoreHandler, /reloadRendererAfterRestore\(\)/);
  assert.match(restoreHandler, /return \{ canceled: false, address: recovered\.address, state \}/);
  assert.match(main, /async function resumePendingRestoreRecovery\(\)[\s\S]*await recovery\(\)/);
  assert.match(main, /function reloadRendererAfterRestore\(\)[\s\S]*did-finish-load[\s\S]*resumePendingRestoreRecovery\(\)[\s\S]*loadFile\(RENDERER_PATH\)/);
  assert.match(preload, /loadLocalBond: \(\) => ipcRenderer\.invoke\("bond:loadLocal"\)/);
  assert.match(renderer, /function activateRestoredBond[\s\S]*showClass\(\)/);
  assert.match(renderer, /bond = await window\.versus\.loadLocalBond\(\)[\s\S]*activateRestoredBond\(bond\)/);
  assert.match(rendererHandler, /const result = await window\.versus\.restoreVersusBackup/);
  assert.match(rendererHandler, /bond = result\.state \|\| await window\.versus\.loadBond\(\)/);
  assert.match(rendererHandler, /if \(bond\?\.phase === "active"\)[\s\S]*showClass\(\)/);
});

test("a healthy restored journal and SQLite database clear stale recovery health", () => {
  const main = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");
  const healthRefresh = main.slice(
    main.indexOf("function refreshHealthSnapshot"),
    main.indexOf("async function exportDiagnostics")
  );

  assert.match(healthRefresh, /const databaseIntegrity = status\?\.localDatabase\?\.integrity/);
  assert.match(healthRefresh, /databaseIntegrity === "failed"[\s\S]*DATABASE_DAMAGED/);
  assert.match(healthRefresh, /!operationJournal\.damaged && databaseIntegrity === "ok"[\s\S]*healthMonitor\.resolve\("database_damaged"\)/);
});

test("Cypher card reveals its graph on first flip and wheel-scrolls overflowing field notes", () => {
  const html = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");
  const renderer = fs.readFileSync(path.join(root, "renderer", "pet.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "renderer", "pet.css"), "utf8");

  assert.match(html, /id="cypher-field-note-copy"[\s\S]*id="cypher-card-description"/);
  assert.match(renderer, /const pending = Boolean\(!profile \|\| profile\.archivePending\)/);
  assert.match(renderer, /const nextFieldNote = fieldNoteText\(profile\?\.description\)/);
  assert.match(renderer, /if \(description\.textContent !== nextFieldNote\)/);
  assert.match(renderer, /\$\("cypher-field-note-copy"\)\?\.addEventListener\("wheel"/);
  assert.match(renderer, /viewport\.scrollTop \+= clamp\(rawDelta \* 0\.45, -30, 30\)/);
  assert.match(renderer, /if \(!cypherFlipped\) resetFieldNoteScroll\(\)/);
  assert.doesNotMatch(css, /#shell\[data-mode="cypher"\] \.radar-shape/);
  assert.match(css, /\.cypher-flip-card\.is-flipped \.radar-shape/);
  assert.match(css, /\.cypher-field-note-copy[\s\S]*overflow-y: auto/);
  assert.doesNotMatch(css, /@keyframes field-note-pan/);
});

test("confirmed manual rain returns from its receipt before background reconciliation", () => {
  const main = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");
  const handler = main.slice(
    main.indexOf('registerIpcHandle("wallet:rainFromRunway"'),
    main.indexOf('registerIpcHandle("wallet:runOnboardPipeline"')
  );

  assert.match(handler, /result\.state = state;[\s\S]*acceptConfirmedLocalRain\(chain\.rainEvent\);\s+reconcileChainState\(\)\.catch/);
  assert.doesNotMatch(handler, /await reconcileChainState\(\)/);
  assert.doesNotMatch(handler, /state = result\.state/);
});
