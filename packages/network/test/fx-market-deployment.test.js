const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  buildFxDesktopMarket,
  buildFxMarketDeployment,
} = require("../src/fx-market-deployment");

const HASH = `0x${"11".repeat(32)}`;
const BUILD = {
  adapterVersion: 3,
  sourcePath: "source.sol",
  sourceTag: "agentic-fx-requester-secret-v3",
  compiler: "0.8.26",
  evmVersion: "cancun",
  optimizerRuns: 1,
  viaIR: true,
  sourceSha256: HASH,
  creationCodeHash: HASH,
};

function fixture() {
  const root = path.resolve(__dirname, "..", "..", "..");
  const market = JSON.parse(fs.readFileSync(
    path.join(root, "versus", "deployments", "fx", "public-testnet-v1-market-candidate.json"),
    "utf8"
  ));
  const records = market.chains.map((chain, chainIndex) => ({
    chainId: chain.chainId,
    marketId: market.marketId,
    native: {
      address: `0x${String(chainIndex + 1).repeat(40)}`,
      runtimeCodeHash: HASH,
      deploymentBlock: 100 + chainIndex,
    },
    erc20s: chain.assets.filter((asset) => asset.kind === "erc20").map((asset, tokenIndex) => ({
      symbol: asset.symbol,
      asset,
      adapter: {
        address: `0x${String(chainIndex + 3 + tokenIndex).repeat(40)}`,
        runtimeCodeHash: HASH,
        deploymentBlock: 200 + tokenIndex,
      },
      exactFactory: {
        address: `0x${String(chainIndex + 6 + tokenIndex).repeat(40)}`,
        runtimeCodeHash: HASH,
        deploymentBlock: 300 + tokenIndex,
      },
    })),
    evidence: { verificationStatus: "verified" },
  }));
  return { market, records };
}

test("assembled market deployment binds two native and four stablecoin capabilities", () => {
  const { market, records } = fixture();
  const deployment = buildFxMarketDeployment({
    market,
    chainRecords: records,
    v3Builds: {
      native: { ...BUILD, adapterId: "evm-native-htlc-v3", contract: "EvmNativeHtlcV3" },
      erc20: { ...BUILD, adapterId: "evm-htlc-v3", contract: "EvmHtlcV3" },
    },
    exactBuild: { schema: "test" },
  });
  assert.equal(deployment.v3.capabilities.length, 2);
  assert.deepEqual(
    deployment.v3.capabilities.map((item) => item.native.assetId),
    ["native:avax", "native:eth"]
  );
  assert.equal(deployment.v3.capabilities.flatMap((item) => item.erc20s).length, 4);
  assert.equal(deployment.exact.factories.length, 4);
  assert.equal(deployment.market.routes.length, 30);
  const desktop = buildFxDesktopMarket(deployment);
  assert.equal(desktop.positions.length, 6);
  assert.equal(desktop.releaseStage, "public-testnet-v1-candidate");
  assert.equal(desktop.exactFactories.length, 4);
  assert.deepEqual(desktop.nativePriceSymbols, ["AVAX", "ETH"]);
  assert.equal(desktop.configurations["43113"].tokenCapabilities.length, 2);
  assert.equal(
    desktop.configurations["43113"].nativeGasReserveWei,
    "50000000000000000"
  );
});

test("assembly fails closed before explorer verification", () => {
  const { market, records } = fixture();
  records[1].evidence.verificationStatus = "pending";
  assert.throws(() => buildFxMarketDeployment({
    market,
    chainRecords: records,
    v3Builds: {
      native: { ...BUILD, adapterId: "evm-native-htlc-v3", contract: "EvmNativeHtlcV3" },
      erc20: { ...BUILD, adapterId: "evm-htlc-v3", contract: "EvmHtlcV3" },
    },
    exactBuild: { schema: "test" },
  }), /not verified/);
});
