const assert = require("node:assert/strict");
const test = require("node:test");
const {
  validateDestinationFirstTimeouts,
  validateEvmV2Manifest,
} = require("../src/fx-evm-v2-adapter");

const HASH = `0x${"11".repeat(32)}`;

function manifest() {
  return {
    schema: "versus-fx-evm-v2-capabilities",
    schemaVersion: 2,
    settlementMode: "dealer-secret-destination-first",
    builds: {
      native: {
        adapterId: "evm-native-htlc-v2",
        adapterVersion: 2,
        contract: "EvmNativeHtlcV2",
        sourcePath: "versus/contracts/fx/EvmNativeHtlcV2.sol",
        sourceTag: "agentic-fx-settlement-v2",
        compiler: "0.8.26",
        evmVersion: "cancun",
        optimizerRuns: 1,
        viaIR: true,
        sourceSha256: HASH,
        creationCodeHash: HASH,
      },
      erc20: {
        adapterId: "evm-htlc-v2",
        adapterVersion: 2,
        contract: "EvmHtlcV2",
        sourcePath: "versus/contracts/fx/EvmHtlcV2.sol",
        sourceTag: "agentic-fx-settlement-v2",
        compiler: "0.8.26",
        evmVersion: "cancun",
        optimizerRuns: 1,
        viaIR: true,
        sourceSha256: HASH,
        creationCodeHash: HASH,
      },
    },
    capabilities: [{
      chainId: "84532",
      native: {
        adapterAddress: "0x1111111111111111111111111111111111111111",
        runtimeCodeHash: HASH,
        deploymentBlock: 100,
        assetId: "native:eth",
      },
      erc20: {
        adapterAddress: "0x2222222222222222222222222222222222222222",
        runtimeCodeHash: HASH,
        deploymentBlock: 101,
        asset: {
          address: "0x3333333333333333333333333333333333333333",
          runtimeCodeHash: HASH,
          symbol: "tUSDC",
          decimals: 6,
          standard: "ERC20",
        },
      },
      confirmationPolicy: {
        requiredConfirmations: 2,
        reorgSafetyBlocks: 4,
      },
      timeoutPolicy: {
        minimumSeconds: 60,
        maximumSeconds: 604800,
        minimumCrossChainDeltaSeconds: 3600,
        minimumDestinationRelayWindowSeconds: 3600,
      },
    }],
  };
}

test("V2 capability freezes adapter identity and destination-first settlement mode", () => {
  const validated = validateEvmV2Manifest(manifest());
  assert.equal(validated.settlementMode, "dealer-secret-destination-first");
  assert.equal(validated.builds.native.adapterVersion, 2);
  assert.equal(validated.builds.erc20.adapterVersion, 2);
});

test("V2 timeout policy requires the destination refund after the source refund", () => {
  const capability = validateEvmV2Manifest(manifest()).capabilities[0];
  const now = 1_800_000_000;
  assert.deepEqual(
    validateDestinationFirstTimeouts({
      now,
      sourceRefundTimestamp: now + 1_200,
      destinationRefundTimestamp: now + 7_200,
      sourceCapability: capability,
      destinationCapability: capability,
    }),
    {
      sourceRefundTimestamp: now + 1_200,
      destinationRefundTimestamp: now + 7_200,
      deltaSeconds: 6_000,
    }
  );
  assert.throws(
    () => validateDestinationFirstTimeouts({
      now,
      sourceRefundTimestamp: now + 7_200,
      destinationRefundTimestamp: now + 1_200,
      sourceCapability: capability,
      destinationCapability: capability,
    }),
    { code: "UNSAFE_TIMEOUT_ORDER" }
  );
});
