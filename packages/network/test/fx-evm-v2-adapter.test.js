const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { keccak256, toUtf8Bytes } = require("ethers");
const { canonicalJson } = require("../src/fx-protocol");
const {
  validateSourceFirstTimeouts,
  validateEvmV2Manifest,
} = require("../src/fx-evm-v2-adapter");

const HASH = `0x${"11".repeat(32)}`;

function manifest() {
  return {
    schema: "versus-fx-evm-v2-capabilities",
    schemaVersion: 2,
    settlementMode: "dealer-secret-source-first",
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

test("V2 capability freezes adapter identity and source-first settlement mode", () => {
  const validated = validateEvmV2Manifest(manifest());
  assert.equal(validated.settlementMode, "dealer-secret-source-first");
  assert.equal(validated.builds.native.adapterVersion, 2);
  assert.equal(validated.builds.erc20.adapterVersion, 2);
});

test("V2 timeout policy requires the source refund after the destination refund", () => {
  const capability = validateEvmV2Manifest(manifest()).capabilities[0];
  const now = 1_800_000_000;
  assert.deepEqual(
    validateSourceFirstTimeouts({
      now,
      sourceRefundTimestamp: now + 7_200,
      destinationRefundTimestamp: now + 1_200,
      sourceCapability: capability,
      destinationCapability: capability,
    }),
    {
      sourceRefundTimestamp: now + 7_200,
      destinationRefundTimestamp: now + 1_200,
      deltaSeconds: 6_000,
    }
  );
  assert.throws(
    () => validateSourceFirstTimeouts({
      now,
      sourceRefundTimestamp: now + 1_200,
      destinationRefundTimestamp: now + 7_200,
      sourceCapability: capability,
      destinationCapability: capability,
    }),
    { code: "UNSAFE_TIMEOUT_ORDER" }
  );
});

test("source-first public-testnet deployment ID binds the reused V2 capabilities", () => {
  const filePath = path.resolve(
    __dirname,
    "../../../versus/deployments/fx/phase11-v2-source-first-public-testnet.json"
  );
  const frozen = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const manifest = validateEvmV2Manifest(frozen);
  assert.equal(
    keccak256(toUtf8Bytes(canonicalJson(manifest))),
    frozen.deploymentId
  );
  assert.equal(
    frozen.reusesContractDeploymentId,
    "0x361d43afddce9c272db9d4131c6b6b228693b603924de8f7dc09cc67b58bc5df"
  );
});
