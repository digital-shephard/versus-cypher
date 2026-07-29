const assert = require("node:assert/strict");
const test = require("node:test");
const {
  EVM_NATIVE_ADAPTER_ID,
  FxEvmNativeAdapterError,
  selectEvmNativeCapability,
  validateEvmNativeAdapterManifest,
} = require("../src/fx-evm-native-adapter");

const HASH_A = `0x${"11".repeat(32)}`;
const HASH_B = `0x${"22".repeat(32)}`;
const ADDRESS_A = `0x${"aa".repeat(20)}`;

function manifest(overrides = {}) {
  return {
    schema: "versus-fx-native-adapter-capabilities",
    schemaVersion: 1,
    adapter: {
      id: EVM_NATIVE_ADAPTER_ID,
      version: 1,
      contract: "EvmNativeHtlcV1",
      sourcePath: "versus/contracts/fx/EvmNativeHtlcV1.sol",
    },
    build: {
      compiler: "0.8.26",
      evmVersion: "cancun",
      sourceTag: "agentic-fx-native-v1",
      optimizerRuns: 1,
      viaIR: true,
      sourceSha256: HASH_A,
      creationCodeHash: HASH_B,
    },
    capabilities: [{
      chainId: "84532",
      adapterAddress: ADDRESS_A,
      runtimeCodeHash: HASH_A,
      deploymentBlock: 1,
      asset: {
        assetId: "native:eth",
        symbol: "ETH",
        decimals: 18,
        standard: "NATIVE",
      },
      confirmationPolicy: {
        requiredConfirmations: 2,
        reorgSafetyBlocks: 6,
      },
      timeoutPolicy: {
        minimumSeconds: 60,
        maximumSeconds: 604800,
        minimumCrossChainDeltaSeconds: 120,
      },
      ...overrides,
    }],
  };
}

test("validates and selects a frozen native ETH capability", () => {
  const normalized = validateEvmNativeAdapterManifest(manifest());
  assert.equal(normalized.adapter.id, EVM_NATIVE_ADAPTER_ID);
  assert.deepEqual(
    selectEvmNativeCapability(normalized, {
      chainId: 84532,
      assetId: "native:eth",
    }),
    normalized.capabilities[0]
  );
});

test("native validator cannot admit ERC-20 or another native symbol", () => {
  for (const asset of [
    { assetId: "erc20:0x1234", symbol: "ETH", decimals: 18, standard: "ERC20" },
    { assetId: "native:eth", symbol: "WETH", decimals: 18, standard: "NATIVE" },
    { assetId: "native:eth", symbol: "ETH", decimals: 6, standard: "NATIVE" },
  ]) {
    const input = manifest();
    input.capabilities[0].asset = asset;
    assert.throws(
      () => validateEvmNativeAdapterManifest(input),
      FxEvmNativeAdapterError
    );
  }
});

test("native validator rejects duplicate chains and unsupported adapter identity", () => {
  const duplicate = manifest();
  duplicate.capabilities.push(structuredClone(duplicate.capabilities[0]));
  assert.throws(
    () => validateEvmNativeAdapterManifest(duplicate),
    /repeats a native chain/
  );
  const wrong = manifest();
  wrong.adapter.id = "evm-htlc";
  assert.throws(
    () => validateEvmNativeAdapterManifest(wrong),
    /identity is unsupported/
  );
});
