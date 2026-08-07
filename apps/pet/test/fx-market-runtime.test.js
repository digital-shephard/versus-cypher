const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { loadFxMarketRuntime } = require("../src/fx-market-runtime");
const {
  buildFxMarketDeployment,
} = require("../../../packages/network/src/fx-market-deployment");

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

test("market runtime loads the frozen Base Sepolia and Fuji deployment in an isolated domain", () => {
  const root = path.resolve(__dirname, "..", "..", "..");
  const deploymentPath = path.join(
    root,
    "versus",
    "deployments",
    "fx",
    "public-testnet-v1-market-deployment.json"
  );
  const runtime = loadFxMarketRuntime({
    VERSUS_FX_MARKET_DEPLOYMENT: deploymentPath,
  });

  assert.equal(runtime.positions.length, 6);
  assert.equal(runtime.routes.length, 30);
  assert.equal(runtime.exactFactories.length, 4);
  assert.deepEqual(runtime.nativePriceSymbols, ["AVAX", "ETH"]);
  assert.deepEqual(
    runtime.chains.map((chain) => chain.chainId),
    ["43113", "84532"]
  );

  const priorDeployments = fs
    .readdirSync(path.dirname(deploymentPath))
    .filter((name) => name.endsWith(".json") && name !== path.basename(deploymentPath))
    .map((name) => {
      try {
        return JSON.parse(
          fs.readFileSync(path.join(path.dirname(deploymentPath), name), "utf8")
        );
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  assert(
    priorDeployments.every(
      (deployment) =>
        deployment.deploymentId !== runtime.deploymentId &&
        deployment.coordinationDomain !== runtime.coordinationDomain
    )
  );
});

test("frozen Base Sepolia and Fuji deployment is reproducible from reviewed inputs", () => {
  const root = path.resolve(__dirname, "..", "..", "..");
  const deploymentRoot = path.join(root, "versus", "deployments", "fx");
  const readJson = (fileName) => JSON.parse(
    fs.readFileSync(path.join(deploymentRoot, fileName), "utf8")
  );
  const market = readJson("public-testnet-v1-market-candidate.json");
  const chainRecords = [
    readJson("baseSepolia-84532-market-v1-testnet.json"),
    readJson("avalancheFuji-43113-market-v1-testnet.json"),
  ];
  const v3Freeze = readJson("evm-htlc-v3-build.json");
  const exactFreeze = readJson("evm-exact-build.json");
  const frozenDeployment = readJson("public-testnet-v1-market-deployment.json");

  assert.deepEqual(
    buildFxMarketDeployment({
      market,
      chainRecords,
      v3Builds: v3Freeze.builds,
      exactBuild: exactFreeze,
    }),
    frozenDeployment
  );
});
