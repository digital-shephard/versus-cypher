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

test("hatch waits in a black incubation scene until confirmed class state is ready", () => {
  const html = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "renderer", "pet.css"), "utf8");
  const renderer = fs.readFileSync(path.join(root, "renderer", "pet.js"), "utf8");
  const preload = fs.readFileSync(path.join(root, "src", "preload.js"), "utf8");
  const main = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");
  const preview = fs.readFileSync(path.join(root, "scripts", "preview-hatch.js"), "utf8");
  const onboard = main.slice(
    main.indexOf('registerIpcHandle("wallet:runOnboardPipeline"'),
    main.indexOf('registerIpcHandle("window:close"')
  );

  assert.match(html, /id="hatch-incubation"[\s\S]*A CYPHER IS HATCHING HERE SOON\.\.\./);
  assert.match(html, /hatch-layers\/hatch-backplate\.png/);
  assert.match(html, /id="hatch-egg-asset"[\s\S]*hatch-layers\/hatch-egg\.png/);
  assert.match(html, /hatch-layers\/hatch-ground\.png/);
  assert.match(html, /hatch-layers\/hatch-foreground\.png/);
  assert.match(css, /data-hatch-state="incubating"[\s\S]*\.hatch-incubation/);
  assert.match(css, /\.incubation-sparkles i[\s\S]*incubation-sparkle-fall/);
  assert.match(css, /data-hatch-state="lifting"[\s\S]*\.hatch-egg-asset/);
  assert.match(css, /@keyframes incubation-egg-twitch/);
  assert.match(renderer, /confirm\.textContent = "CHECKING\.\.\."/);
  assert.match(renderer, /const onboardPipeline = window\.versus\.runOnboardPipeline[\s\S]*setHatchState\("lifting"\)[\s\S]*setHatchState\("incubating"\)[\s\S]*await onboardPipeline/);
  assert.match(preview, /wallet:simulateDeposit[\s\S]*await sleep\(3_400\)/);
  assert.match(renderer, /await sleep\(480\)[\s\S]*showClass\(\)/);
  assert.match(preload, /onHatchProgress:[\s\S]*hatch:progress/);
  assert.match(preload, /onBondChanged:[\s\S]*bond:changed/);
  assert.match(onboard, /publishHatchProgress\("joining_class"\)[\s\S]*await ensureDailyRainForAgent\(\)[\s\S]*state = await reconcileChainState\(\)[\s\S]*publishHatchProgress\("ready"\)/);
});

test("hatch quote checks share a warm quote and fetch balance in parallel", () => {
  const main = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");
  assert.match(main, /const HATCH_QUOTE_MAX_AGE_MS = 120_000/);
  assert.match(main, /async function getCachedHatchQuote\(\)[\s\S]*hatchQuoteInFlight/);
  assert.match(main, /Promise\.all\(\[\s*getCachedHatchQuote\(\),\s*chainRainService\.getEthBalance/);
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

test("foreground recovery reconciles Base and replays missed verified rain", () => {
  const renderer = fs.readFileSync(path.join(root, "renderer", "pet.js"), "utf8");
  const preload = fs.readFileSync(path.join(root, "src", "preload.js"), "utf8");
  const main = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");
  const network = fs.readFileSync(path.join(root, "src", "network.js"), "utf8");
  const foreground = main.slice(
    main.indexOf("function refreshForegroundServices"),
    main.indexOf("function startStateSync")
  );

  assert.match(network, /async catchUpRain\(\)[\s\S]*transport\.catchUpRain\(\)/);
  assert.match(foreground, /Promise\.allSettled\(\[[\s\S]*reconcileChainState\(\)[\s\S]*catchUpRain/);
  assert.match(foreground, /rainInbox\.pending\(\)[\s\S]*rain:available/);
  assert.match(main, /mainWindow\.on\("restore"[\s\S]*refreshForegroundServices\(\)/);
  assert.match(main, /powerMonitor\.on\("resume"[\s\S]*refreshForegroundServices\(\)/);
  assert.match(main, /registerIpcHandle\("service:foreground", \(\) => refreshForegroundServices\(\)\)/);
  assert.match(preload, /refreshForeground: \(\) => ipcRenderer\.invoke\("service:foreground"\)/);
  assert.match(renderer, /visibilitychange[\s\S]*refreshForegroundState\(\)/);
  assert.match(renderer, /function networkNowMs\(\)[\s\S]*networkClockOffsetMs/);
  assert.match(renderer, /Math\.floor\(networkNowMs\(\) \/ 86_400_000\)/);
  assert.match(renderer, /nextCommitAt \|\| 0\) - networkNowMs\(\) \/ 1000/);
});

test("public weather is signed cached and private state is one block-pinned Multicall", () => {
  const chain = fs.readFileSync(path.join(root, "src", "chain.js"), "utf8");
  const main = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");
  const readState = chain.slice(
    chain.indexOf("async readState"),
    chain.indexOf("async hatchWithEth")
  );
  const reconcile = main.slice(
    main.indexOf("async function reconcileChainStateOnce"),
    main.indexOf("function refreshForegroundServices")
  );

  assert.match(chain, /readPublicClassState[\s\S]*fetchNodeClassState/);
  assert.match(chain, /readBatchedBaseState[\s\S]*aggregate3/);
  assert.match(chain, /provider\.call\(\{ to: BASE_MULTICALL3, data, blockTag: Number\(classState\.blockNumber\) \}\)/);
  assert.match(readState, /nodeClassStateEnabled[\s\S]*readPublicClassState\(\)[\s\S]*readBatchedBaseState/);
  assert.match(main, /function startStateSync\(\)[\s\S]*refreshPublicClassState\(\)/);
  assert.doesNotMatch(main.slice(main.indexOf("function startStateSync"), main.indexOf("async function ensureNetworkService")), /reconcileChainState\(\)/);
  assert.match(main, /transportNow: networkNowMs/);
  assert.match(main, /app\.whenReady\(\)\.then\(\(\) => \{\s*updateNetworkClockOffset\(loadState\(\)\?\.networkClockOffsetMs\)/);
  assert.match(reconcile, /if \(chainReconcileInFlight\) return chainReconcileInFlight/);
  assert.match(reconcile, /chain\.blockNumber[\s\S]*state\.chainBlockNumber[\s\S]*return state/);
  assert.match(main, /state\.chainBlockNumber = Math\.max[\s\S]*receipt\.blockNumber/);
  assert.match(main, /state\.chainBlockNumber = Math\.max[\s\S]*chain\.blockNumber/);
});

test("paid test postcards are hidden behind an explicit local launch flag", () => {
  const html = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");
  const renderer = fs.readFileSync(path.join(root, "renderer", "pet.js"), "utf8");
  const preload = fs.readFileSync(path.join(root, "src", "preload.js"), "utf8");
  const main = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");

  assert.match(html, /id="btn-test-signal"[^>]*class="[^"]*hidden/);
  assert.match(main, /buildMetadata\.versusSignedUpdates !== true/);
  assert.match(main, /buildMetadata\.versusTestSignal === true/);
  assert.match(main, /app\.commandLine\.hasSwitch\("versus-test-signal"\)/);
  assert.match(main, /if \(!TEST_SIGNAL_ENABLED\) throw new Error\("test signal mode is disabled"\)/);
  assert.match(main, /body: "can another cypher hear this signal"/);
  assert.match(main, /queueSignalSettlement\(service, launchId, 1, \[postcard\]\)/);
  assert.match(main, /SIGNAL_PUBLICATION_RETRY_DELAYS_MS = \[5_000, 15_000, 45_000, 120_000\]/);
  assert.match(main, /scheduleSignalPublicationRetry\(service, confirmed\.batch\.root\)/);
  assert.match(main, /service\.unpublishedSignalBatches\(\)\.find/);
  assert.match(preload, /agentSendTestSignal: \(\) => ipcRenderer\.invoke\("agent:sendTestSignal"\)/);
  assert.match(renderer, /classList\.toggle\("hidden", !status\.testSignalEnabled\)/);
});

test("manual brain ticks lock their controls before invoking the brain", () => {
  const renderer = fs.readFileSync(path.join(root, "renderer", "pet.js"), "utf8");
  assert.match(renderer, /if \(brainThinkPending \|\| button\?\.disabled\) return/);
  assert.match(renderer, /brainThinkPending = true;\s+renderNetworkScreen\(\);\s+try \{\s+await window\.versus\.agentTick\(\)/);
  assert.match(renderer, /think\.textContent = brainThinkPending \? "THINKING" : "THINK"/);
  assert.match(renderer, /finally \{\s+brainThinkPending = false;\s+renderNetworkScreen\(\)/);
});

test("the FX wheel is sandwiched between the chassis and removable faceplate", () => {
  const html = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "renderer", "pet.css"), "utf8");
  const renderer = fs.readFileSync(path.join(root, "renderer", "pet.js"), "utf8");
  const main = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");

  assert.ok(html.indexOf('id="service-chassis"') < html.indexOf('id="fx-wheel-layer"'));
  assert.ok(html.indexOf('id="fx-wheel-layer"') < html.indexOf('id="faceplate-layer"'));
  assert.match(html, /id="fx-wheel-layer"[\s\S]*fx-side-wheel\.png/);
  assert.match(css, /#fx-wheel-layer[\s\S]*z-index: 3/);
  assert.match(css, /#faceplate-layer[\s\S]*z-index: 4/);
  assert.match(css, /#btn-fx-wheel[\s\S]*z-index: 5/);
  assert.match(css, /#shell \{[\s\S]*width: 390px[\s\S]*height: 640px[\s\S]*overflow: visible/);
  assert.match(main, /const WIN_W = 454/);
  assert.match(renderer, /function wireFxWheel\(\)[\s\S]*direction < 0 \? -90 : 90/);
  assert.match(renderer, /const overshoot = target \+ Math\.sign\(step\) \* 11/);
  assert.match(renderer, /const rebound = target - Math\.sign\(step\) \* 3/);
  assert.match(renderer, /image\.animate\(\[[\s\S]*duration: 320/);
  assert.match(renderer, /button\.addEventListener\("click", \(\) => \{[\s\S]*toggleFxSurface\(\)/);
  assert.match(renderer, /button\.addEventListener\("wheel"[\s\S]*passive: false/);
});

test("the FX wheel opens a dedicated surface while MODE keeps cycling its tabs", () => {
  const html = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "renderer", "pet.css"), "utf8");
  const renderer = fs.readFileSync(path.join(root, "renderer", "pet.js"), "utf8");

  assert.match(html, /id="fx-screen"[\s\S]*data-fx-panel="desk"[\s\S]*data-fx-panel="stock"[\s\S]*data-fx-panel="tape"[\s\S]*data-fx-panel="risk"/);
  assert.match(html, /fx-dock-background[\s\S]*fx-booth-background[\s\S]*id="fx-desk-cypher"[\s\S]*fx-booth-foreground/);
  assert.match(renderer, /const FX_MODES = \["desk", "stock", "tape", "risk"\]/);
  assert.match(renderer, /let activeSurface = "cypher"/);
  assert.match(renderer, /function setSurface\(next\)[\s\S]*activeSurface = next[\s\S]*renderFxScreen\(\)/);
  assert.match(renderer, /if \(activeSurface === "fx"\) \{[\s\S]*setFxMode\(FX_MODES/);
  assert.match(css, /#shell\[data-surface="fx"\] #fx-screen \{ display: block; \}/);
  assert.match(css, /\.fx-dock-background \{ z-index: 0; \}/);
  assert.match(css, /\.fx-booth-background \{[\s\S]*?z-index: 1;/);
  assert.match(css, /\.fx-agent-station \{[\s\S]*z-index: 3/);
  assert.match(css, /\.fx-booth-foreground \{[\s\S]*?z-index: 4;/);
  assert.match(html, /fx-booth-foreground[\s\S]*fx-desk-shutter/);
  assert.match(html, /fx-desk-shutter[\s\S]*fx-closed-sign\.png/);
  assert.match(html, /fx-printer[\s\S]*fx-printer-slot/);
  assert.doesNotMatch(html, /class="fx-printer"[^>]*><i>/);
  assert.match(css, /\.fx-desk-shutter \{[\s\S]*z-index: 7/);
  assert.match(css, /#fx-screen\[data-armed="true"\] \.fx-desk-shutter \{[\s\S]*translateY\(calc\(-100% \+ 14px\)\)/);
  assert.match(css, /\.fx-printer-slot \{[\s\S]*linear-gradient\(180deg/);
  assert.match(css, /\.fx-roll\.is-feeding \.fx-roll-paper[\s\S]*fx-paper-kick/);
  assert.match(renderer, /screen\.dataset\.armed = armed/);
  assert.match(renderer, /function pushFxReceipt\(receipt\)[\s\S]*fxTape\.unshift\(receipt\)[\s\S]*roll\.classList\.add\("is-feeding"\)/);
  assert.match(renderer, /function playFxTapeDemo\(intervalMs = 850\)[\s\S]*pushFxReceipt\(receipt\)/);
  assert.match(html, /QUOTE LIFE[\s\S]*LOCK WINDOW/);
  assert.match(renderer, /steps: \[1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500\]/);
  assert.match(renderer, /steps: \[1, 5, 10, 15, 25, 40, 60, 100\]/);
  assert.match(renderer, /function setFxRiskValue\(key, value\)[\s\S]*value > fxRisk\.maxExposureUsd[\s\S]*fxRisk\.maxExposureUsd = value[\s\S]*value < fxRisk\.maxTradeUsd[\s\S]*fxRisk\.maxTradeUsd = value/);
  assert.match(renderer, /REFUND: DEALER 10m \\u00b7 REQUESTER 2h/);
  assert.doesNotMatch(html, /id="fx-risk-assets"[^>]*>ASSETS/);
  assert.doesNotMatch(renderer, /fx-risk-assets/);
  assert.doesNotMatch(html, /fx-risk-chains|fx-risk-allow/);
  assert.match(css, /\.fx-position-card \{[\s\S]*min-height: 0;[\s\S]*overflow: hidden;/);
  assert.match(css, /\.fx-position-options \{[\s\S]*flex: 1 1 auto;[\s\S]*overflow-y: auto;[\s\S]*-webkit-overflow-scrolling: touch;/);
  assert.doesNotMatch(renderer, /FX_RISK_CHAINS|FX_RISK_ASSETS|renderFxChips/);
  assert.match(css, /#shell\[data-view="view-class"\] #mode-dots span\.active/);
});

test("FX stock uses a canonical supported-asset catalog instead of manual token configuration", () => {
  const html = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "renderer", "pet.css"), "utf8");
  const renderer = fs.readFileSync(path.join(root, "renderer", "pet.js"), "utf8");
  const main = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");

  assert.match(html, /id="fx-add-position"[\s\S]*data-fx-stock-filter="all"[\s\S]*data-fx-stock-filter="funded"[\s\S]*data-fx-stock-filter="active"/);
  assert.match(html, /<small>STOCK VALUE<\/small>/);
  assert.match(html, /id="fx-add-position-sheet"[\s\S]*fx-position-back[\s\S]*SUPPORTED ASSETS[\s\S]*id="fx-position-options"/);
  assert.match(html, /data-fx-panel="risk"[\s\S]*PER REQUESTER[\s\S]*PER ASSET[\s\S]*MAX GAS[\s\S]*INVENTORY PREMIUM/);
  assert.doesNotMatch(html, /MAX OVERHEAD|fx-risk-overhead/);
  assert.doesNotMatch(html, /id="fx-position-done"|id="fx-position-note"/);
  assert.doesNotMatch(html, /id="fx-position-contract"|id="fx-position-capacity"/);
  assert.match(renderer, /const FX_SUPPORTED_POSITIONS = \[[\s\S]*id: "base-sepolia-usdc"[\s\S]*id: "arbitrum-sepolia-usdc"/);
  assert.match(renderer, /const gasInventory = fxChains[\s\S]*kind: "gas"[\s\S]*fxInventory = \[\.\.\.gasInventory, \.\.\.tokenInventory\]/);
  assert.match(renderer, /const gasInventory = fxChains[\s\S]*chain\.enabled === true[\s\S]*dealerBalanceAtomic/);
  assert.match(renderer, /function fxGasBayNode\(bay\)[\s\S]*fxAssetAmount\(dealerAtomic[\s\S]*"ADD ETH"[\s\S]*openFxChainDepositSheet\(bay\.chainId, "dealer"\)/);
  assert.doesNotMatch(renderer, /"FUND DEALER"|"FUND SWAP"|\["SWAP", requesterAtomic/);
  assert.doesNotMatch(renderer, /`\$\{bay\.chain\} \$\{MIDDOT\} GAS`|fxNode\("small", null, "DEPOSITED"\)/);
  assert.match(renderer, /function fxVisibleInventory\(\)[\s\S]*fxStockFilter === "funded"[\s\S]*fxStockFilter === "active"/);
  assert.match(renderer, /function fxPositionOptionNode\(position\)[\s\S]*toggle\.setAttribute\("role", "switch"\)/);
  assert.match(renderer, /function fxChainOptionNode\(chain\)[\s\S]*fx-chain-group-head[\s\S]*fx-native-option/);
  assert.match(renderer, /function fxPositionOptionNode\(position\)[\s\S]*fx-token-option/);
  assert.match(renderer, /const nodes = fxChains\.map\(fxChainOptionNode\)/);
  assert.match(renderer, /let fxExpandedChains = new Set\(\)/);
  assert.doesNotMatch(renderer, /fxChainExpansionInitialized|initiallyExpanded|fundedChain/);
  assert.match(renderer, /aria-expanded[\s\S]*fxExpandedChains\.add\(chain\.chainId\)[\s\S]*fxExpandedChains\.delete\(chain\.chainId\)/);
  assert.match(renderer, /body\.inert = !willExpand[\s\S]*body\.inert = !expanded/);
  assert.match(renderer, /bay\.availableMicros \+ bay\.reservedMicros > 0[\s\S]*bay\.reservedMicros > 0 \|\| bay\.inFlight > 0/);
  assert.match(renderer, /toggle\.disabled = locked \|\| \(!selected && !chain\?\.dealerGasReady\)/);
  assert.match(renderer, /function fxChainOptionNode\(chain\)[\s\S]*DEPOSITED[\s\S]*CUSTOM RPC \(OPTIONAL\)/);
  assert.doesNotMatch(renderer, /fx-chain-funding|`FUND \$\{label\}`/);
  assert.match(renderer, /function renderFxPositionOptions\(\)[\s\S]*host\.replaceChildren\(\.\.\.nodes\)/);
  assert.doesNotMatch(renderer, /function fxAdvancedLimitNode|fx-position-section-label", "LIMITS"/);
  assert.match(renderer, /const policyKey = control\.policyKey \|\|/);
  assert.match(main, /DEMO_DEPOSIT_USD_MICROS = 10_000_000n[\s\S]*!app\.isPackaged && process\.env\.VERSUS_FX_DEVELOPMENT === "1"/);
  assert.match(renderer, /setFxDemo\(on = true\)[\s\S]*fxStockFilter = "all";\s*fxOpenBay = null;/);
  assert.match(renderer, /window\.versus\.fxSetPositionEnabled\(position\.id, !selected\)/);
  assert.match(css, /\.fx-stock-filters \{[\s\S]*grid-template-columns: repeat\(3, 1fr\)/);
  assert.match(css, /\.fx-bays \{[\s\S]*overflow-y: auto/);
  assert.match(css, /\.fx-icon-action \{[\s\S]*border-radius: 50%/);
  assert.match(css, /\.fx-stock-panel \.fx-title-actions \{[\s\S]*margin-right: 14px/);
  assert.match(css, /\.fx-stock-panel \.fx-icon-action \{[\s\S]*width: 18px;[\s\S]*height: 18px/);
  assert.match(css, /#fx-add-position-sheet \{[\s\S]*padding: 0;[\s\S]*place-items: stretch/);
  assert.match(css, /\.fx-position-card \{[\s\S]*width: 100%;[\s\S]*height: 100%;[\s\S]*border-radius: 0/);
  assert.match(css, /\.fx-position-toggle\[aria-checked="true"\][\s\S]*transform: translateX\(16px\)/);
  assert.match(css, /\.fx-chain-group \{[\s\S]*border-radius: 7px[\s\S]*box-shadow:/);
  assert.match(css, /\.fx-chain-group-head \{[\s\S]*border-bottom:/);
  assert.match(css, /\.fx-chain-group-body \{[\s\S]*grid-template-rows: 1fr/);
  assert.match(css, /\.fx-chain-group\.is-collapsed \.fx-chain-group-body \{[\s\S]*grid-template-rows: 0fr/);
});

test("Phase 10 keeps the requester flow simple and the economic runtime fail closed", () => {
  const html = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");
  const renderer = fs.readFileSync(path.join(root, "renderer", "pet.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "renderer", "pet.css"), "utf8");
  const main = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");
  const preload = fs.readFileSync(path.join(root, "src", "preload.js"), "utf8");
  const service = fs.readFileSync(path.join(root, "src", "fx-desktop-service.js"), "utf8");
  const cohort = fs.readFileSync(path.join(root, "src", "fx-evm-cohort.js"), "utf8");
  const roles = fs.readFileSync(path.join(root, "src", "fx-role-wallet.js"), "utf8");
  const capture = fs.readFileSync(path.join(root, "scripts", "capture-views.js"), "utf8");

  assert.match(html, /YOU PAY WITH[\s\S]*YOU RECEIVE EXACTLY[\s\S]*RECIPIENT[\s\S]*GET QUOTES/);
  assert.match(html, /id="fx-asset-picker"[\s\S]*id="fx-asset-picker-options"/);
  assert.match(html, /id="fx-swap-source"[^>]*aria-haspopup="dialog"/);
  assert.match(html, /id="fx-swap-destination"[^>]*aria-haspopup="dialog"/);
  assert.doesNotMatch(html, /<select id="fx-swap-(?:source|destination)"/);
  assert.match(html, /id="fx-requester-status" role="status"/);
  assert.match(html, /BEST VERIFIED QUOTE[\s\S]*YOU SEND[\s\S]*YOU RECEIVE[\s\S]*TOTAL COST[\s\S]*FEE DETAILS[\s\S]*ACCEPT QUOTE[\s\S]*SEND EXACTLY[\s\S]*I SENT IT[\s\S]*CANCEL SWAP/);
  assert.match(html, /fx-funding-address-row[\s\S]*fx-copy-icon/);
  assert.match(html, /id="fx-settlement-done">DONE/);
  assert.match(html, /id="fx-requester-compose"/);
  assert.match(html, /id="fx-requester-title" aria-label="Back to swap form">SWAP/);
  assert.doesNotMatch(html, /id="fx-copy-funding"[^>]*>COPY ADDRESS/);
  assert.doesNotMatch(html, /CONNECT WALLET/i);
  assert.match(renderer, /function fxShortAddress[\s\S]*\u2026/);
  assert.match(renderer, /fxDesktopSnapshot\?\.supportedPositions/);
  assert.match(renderer, /fxDesktopSnapshot\?\.requesterAddress/);
  assert.doesNotMatch(renderer, /SET UP ASSETS/);
  assert.doesNotMatch(html, /Enable FX laboratory|setting-fx-development/);
  assert.doesNotMatch(preload, /fxSetEnabled|fx:setEnabled/);
  assert.doesNotMatch(main, /fx:setEnabled/);
  assert.match(service, /function supportedPositionOf[\s\S]*FX_DEFAULT_POSITIONS\.find/);
  assert.doesNotMatch(service, /function positionOf/);
  assert.match(service, /FX_QUOTE_DISCOVERY_MAX_INPUT_ATOMIC[\s\S]*maxInputAtomic: FX_QUOTE_DISCOVERY_MAX_INPUT_ATOMIC/);
  assert.doesNotMatch(service, /snapshot\.policy\.maximumOverheadBps/);
  assert.match(renderer, /destinationAddress: fxAddressInputValue/);
  assert.match(renderer, /function openFxAssetPicker[\s\S]*fx-asset-picker-options/);
  assert.match(renderer, /sourcePositionId: \$\("fx-swap-source"\)\.dataset\.positionId/);
  assert.match(renderer, /destinationPositionId: \$\("fx-swap-destination"\)\.dataset\.positionId/);
  assert.doesNotMatch(renderer, /TURN ON FX/);
  const requesterSubmit = renderer.slice(
    renderer.indexOf("async function submitFxQuoteRequest"),
    renderer.indexOf("async function acceptFxQuote")
  );
  assert.match(requesterSubmit, /fxRequestQuote/);
  assert.doesNotMatch(requesterSubmit, /fxSetEnabled|fxSetPolicy/);
  const dealerToggle = renderer.slice(
    renderer.indexOf('$("fx-risk-armed")?.addEventListener'),
    renderer.indexOf('for (const button of document.querySelectorAll("[data-fx-step]")')
  );
  assert.match(dealerToggle, /fxSetPolicy\(\{ armed: targetArmed \}\)/);
  assert.doesNotMatch(dealerToggle, /fxSetEnabled/);
  assert.doesNotMatch(service, /Enable the FX lab before requesting a quote/);
  assert.match(renderer, /SEARCHING ONLINE DEALERS \\u00b7 THIS CAN TAKE A FEW SECONDS/);
  assert.match(main, /brokerObservationWindowMs: 5_000/);
  assert.match(main, /brokerQuoteSettleWindowMs: 1_250/);
  assert.match(main, /dealerObservationWindowMs: 250/);
  assert.match(main, /fxNetworkRuntime\.warmRequester\(\)/);
  assert.match(renderer, /fxRequesterTrade\.state === "refund_wait"[\s\S]*fxRefund/);
  assert.match(renderer, /function cancelFxTrade[\s\S]*window\.versus\.fxCancel/);
  assert.match(renderer, /function scrollFxRequesterToBottom[\s\S]*scroll\.scrollHeight/);
  assert.match(renderer, /function finishFxRequester[\s\S]*fxRequesterTrade = null[\s\S]*closeFxRequester/);
  assert.match(renderer, /fx-settlement-done"\)\?\.addEventListener\("click", finishFxRequester\)/);
  assert.match(renderer, /fx-requester-compose"\)\.classList\.toggle\("hidden", Boolean\(fxRequesterTrade\)\)/);
  assert.match(renderer, /function returnToFxSwapMain[\s\S]*state === "quoted"[\s\S]*renderFxRequester/);
  assert.match(renderer, /fx-requester-title"\)\?\.addEventListener\("click", returnToFxSwapMain\)/);
  assert.match(renderer, /function navigateBackFromFxRequester[\s\S]*fxRequesterView === "history"[\s\S]*closeFxRequester\(\)[\s\S]*state === "quoted"[\s\S]*returnToFxSwapMain/);
  assert.match(renderer, /fx-requester-back"\)\?\.addEventListener\("click", navigateBackFromFxRequester\)/);
  assert.match(css, /\.fx-funding-address-row \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) 21px/);
  assert.match(service, /fundingBaseline,[\s\S]*\.\.\.safe/);
  assert.match(service, /endpointPaymentAuthorized: false[\s\S]*endpointPaymentSubmitted: false/);
  assert.match(main, /sourceFundingVerifier[\s\S]*settlementReconciler[\s\S]*refundExecutor/);
  assert.match(main, /registerIpcHandle\("fx:refund"/);
  assert.match(main, /registerIpcHandle\("fx:cancel"/);
  assert.match(preload, /fxRefund: \(tradeId\) => ipcRenderer\.invoke\("fx:refund"/);
  assert.match(preload, /fxCancel: \(tradeId\) => ipcRenderer\.invoke\("fx:cancel"/);
  assert.match(preload, /fxSetChainSettings[\s\S]*fxWithdrawPosition/);
  assert.match(main, /registerIpcHandle\("fx:setChainSettings"[\s\S]*registerIpcHandle\("fx:withdrawPosition"/);
  assert.match(service, /async withdrawPosition[\s\S]*DEALER_ACTIVE[\s\S]*withdrawInventory/);
  assert.match(service, /async resumeDealer[\s\S]*armDealer/);
  assert.match(renderer, /function renderFxHistory[\s\S]*fxReconcile/);
  assert.match(capture, /ipcMain\.handle\("fx:cancel"/);
  assert.match(roles, /requester[\s\S]*dealer[\s\S]*broker/);
  assert.match(cohort, /adapterDeploymentBlock: 44662322/);
  assert.match(cohort, /adapterDeploymentBlock: 291630348/);
  assert.doesNotMatch(cohort, /fromBlock: 0/);
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
