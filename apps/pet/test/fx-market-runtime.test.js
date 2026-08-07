const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { loadFxMarketRuntime } = require("../src/fx-market-runtime");

test("market runtime stays disabled without an explicit deployment", () => {
  assert.equal(loadFxMarketRuntime({}), null);
});

test("market runtime rejects relative deployment paths", () => {
  assert.throws(
    () => loadFxMarketRuntime({ VERSUS_FX_MARKET_DEPLOYMENT: "deployment.json" }),
    /must be an absolute path/
  );
});

test("market runtime rejects a candidate market without verified deployments", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-fx-market-"));
  const candidate = path.join(directory, "candidate.json");
  fs.copyFileSync(
    path.resolve(
      __dirname,
      "../../../versus/deployments/fx/public-testnet-v1-market-candidate.json"
    ),
    candidate
  );
  assert.throws(
    () => loadFxMarketRuntime({ VERSUS_FX_MARKET_DEPLOYMENT: candidate }),
    /market deployment schema is unsupported/
  );
});
