const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

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
