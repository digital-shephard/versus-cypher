const assert = require("node:assert/strict");
const fs = require("node:fs");
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
  const buildStepStart = workflow.indexOf("      - name: Build packages");
  const nextStepStart = workflow.indexOf("      - name: Sign in to Azure", buildStepStart);
  const buildStep = workflow.slice(buildStepStart, nextStepStart);
  const beforeBuildStep = workflow.slice(0, buildStepStart);

  assert.deepEqual(packageJson.build.mac.target, ["dmg", "zip"]);
  assert.equal(packageJson.build.mac.hardenedRuntime, true);
  assert.equal(packageJson.build.mac.notarize, true);
  assert.equal(packageJson.build.mac.entitlements, "entitlements.mac.plist");
  assert.equal(packageJson.build.mac.entitlementsInherit, "entitlements.mac.inherit.plist");

  assert.match(workflow, /platform: macos-universal/);
  assert.match(workflow, /electron-builder --mac dmg zip --universal/);
  assert.match(workflow, /Authority=Developer ID Application: DIGITAL SHEPARD LLC \(HN89TZMX7Z\)/);
  assert.match(workflow, /TeamIdentifier=HN89TZMX7Z/);
  assert.match(workflow, /spctl --assess --type execute/);
  assert.match(workflow, /xcrun stapler validate/);
  assert.doesNotMatch(beforeBuildStep, /secrets\.(?:MAC_CSC|APPLE_)/);
  for (const name of [
    "MAC_CSC_LINK",
    "MAC_CSC_KEY_PASSWORD",
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID",
  ]) {
    assert.match(buildStep, new RegExp(`secrets\\.${name}`));
  }
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
