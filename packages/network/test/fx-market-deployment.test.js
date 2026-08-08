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
const EXACT_BUILD = {
  schema: "versus-fx-evm-exact-build-freeze",
  schemaVersion: 1,
  settlementMode: "x402-exact-eip3009-to-v3",
  sourceTag: "generic-x402-exact-v1",
  builds: Object.fromEntries([
    "EvmExactHtlcEscrow",
    "EvmExactHtlcFactory",
  ].map((contract) => [contract, {
    contract,
    sourcePath: "versus/contracts/fx/EvmExactHtlcFactory.sol",
    compiler: "0.8.26",
    evmVersion: "cancun",
    optimizerRuns: 1,
    viaIR: true,
    sourceSha256: HASH,
    creationCodeHash: HASH,
    runtimeTemplateHash: HASH,
  }])),
};
const V3_BUILDS = {
  native: { ...BUILD, adapterId: "evm-native-htlc-v3", contract: "EvmNativeHtlcV3" },
  erc20: { ...BUILD, adapterId: "evm-htlc-v3", contract: "EvmHtlcV3" },
};

function fixture() {
  const root = path.resolve(__dirname, "..", "..", "..");
  const market = JSON.parse(fs.readFileSync(
    path.join(root, "versus", "deployments", "fx", "public-testnet-v1-market-candidate.json"),
    "utf8"
  ));
  const records = market.chains.map((chain, chainIndex) => ({
    schema: "versus-fx-market-v1-testnet-chain",
    schemaVersion: 1,
    chainId: chain.chainId,
    name: chain.name,
    marketId: market.marketId,
    builds: structuredClone({ v3: V3_BUILDS, exact: EXACT_BUILD }),
    native: {
      address: `0x${String(chainIndex + 1).repeat(40)}`,
      runtimeCodeHash: HASH,
      deploymentBlock: 100 + chainIndex,
    },
    erc20s: chain.assets.filter((asset) => asset.kind === "erc20").map((asset, tokenIndex) => ({
      symbol: asset.symbol,
      asset: structuredClone(asset),
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
    confirmationPolicy: {
      requiredConfirmations: chain.requiredConfirmations,
      reorgSafetyBlocks: chain.reorgSafetyBlocks,
    },
    timeoutPolicy: market.timeoutPolicy,
    evidence: {
      verificationStatus: "verified",
      nativeVerification: "verified",
      erc20Verification: Object.fromEntries(
        chain.assets.filter((asset) => asset.kind === "erc20").map((asset) => [
          asset.symbol,
          { adapterStatus: "verified", exactFactoryStatus: "verified" },
        ])
      ),
    },
  }));
  return { market, records };
}

test("assembled market deployment binds two native and four stablecoin capabilities", () => {
  const { market, records } = fixture();
  const deployment = buildFxMarketDeployment({
    market,
    chainRecords: records,
    v3Builds: V3_BUILDS,
    exactBuild: EXACT_BUILD,
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
    v3Builds: V3_BUILDS,
    exactBuild: EXACT_BUILD,
  }), /not fully explorer verified/);
});

test("assembly rejects frozen chain-record drift", () => {
  for (const [mutate, expected] of [
    [(records) => { records[0].builds.exact.sourceTag = "changed"; }, /exact build freeze differs/],
    [(records) => { records[0].confirmationPolicy.requiredConfirmations += 1; }, /confirmation policy differs/],
    [(records) => { records[0].erc20s[0].asset.token = records[0].erc20s[1].asset.token; }, /asset evidence differs/],
    [(records) => { records[0].evidence.erc20Verification.USDC.exactFactoryStatus = "pending"; }, /not fully explorer verified/],
  ]) {
    const { market, records } = fixture();
    mutate(records);
    assert.throws(() => buildFxMarketDeployment({
      market,
      chainRecords: records,
      v3Builds: V3_BUILDS,
      exactBuild: EXACT_BUILD,
    }), expected);
  }
});

test("desktop rejects exact factories that diverge from the frozen market or V3 adapter", () => {
  const root = path.resolve(__dirname, "..", "..", "..");
  const frozen = JSON.parse(fs.readFileSync(
    path.join(root, "versus", "deployments", "fx", "public-testnet-v1-market-deployment.json"),
    "utf8"
  ));

  for (const [mutate, expected] of [
    [(deployment) => deployment.exact.factories.push({ ...deployment.exact.factories[0] }), /count differs/],
    [(deployment) => { deployment.exact.factories[0].facilitatorFeeAtomic = "1"; }, /differs from the frozen market/],
    [(deployment) => { deployment.exact.factories[0].htlc = deployment.v3.capabilities[1].erc20s[0].adapterAddress; }, /differs from the frozen market/],
    [(deployment) => { deployment.exact.factories[0].tokenName = "USD Coin"; }, /differs from the frozen market/],
  ]) {
    const deployment = structuredClone(frozen);
    mutate(deployment);
    assert.throws(() => buildFxDesktopMarket(deployment), expected);
  }
});

test("desktop rejects market, capability, and coordination-domain drift", () => {
  const root = path.resolve(__dirname, "..", "..", "..");
  const frozen = JSON.parse(fs.readFileSync(
    path.join(root, "versus", "deployments", "fx", "public-testnet-v1-market-deployment.json"),
    "utf8"
  ));

  for (const [mutate, expected] of [
    [(deployment) => { deployment.releaseStage = "mainnet-v1-candidate"; }, /release stage differs/],
    [(deployment) => { deployment.v3.capabilities[0].erc20s[0].asset.runtimeCodeHash = HASH; }, /capability differs/],
    [(deployment) => { deployment.v3.capabilities[0].timeoutPolicy.minimumSeconds = 61; }, /timeout policy differs/],
    [(deployment) => {
      deployment.coordinationDomain = HASH;
      deployment.v3.coordinationDomain = HASH;
    }, /not derived from its deployment/],
  ]) {
    const deployment = structuredClone(frozen);
    mutate(deployment);
    assert.throws(() => buildFxDesktopMarket(deployment), expected);
  }
});
