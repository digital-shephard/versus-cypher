const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { Interface, keccak256 } = require("ethers");
const {
  preflightEvmV3Capability,
  validateEvmV3Manifest,
  validateSourceFirstTimeoutsV3,
} = require("../src/fx-evm-v3-adapter");

const HASH = `0x${"11".repeat(32)}`;
const NATIVE_CODE = "0x6001600055";
const NATIVE_INTERFACE = new Interface([
  "function ADAPTER_VERSION() view returns (uint16)",
  "function minimumLockDuration() view returns (uint64)",
  "function maximumLockDuration() view returns (uint64)",
]);

function manifest() {
  return {
    schema: "versus-fx-evm-v3-capabilities",
    schemaVersion: 3,
    settlementMode: "requester-secret-source-first-compact",
    deploymentId: HASH,
    coordinationDomain: `0x${"22".repeat(32)}`,
    builds: {
      native: {
        adapterId: "evm-native-htlc-v3",
        adapterVersion: 3,
        contract: "EvmNativeHtlcV3",
        sourcePath: "versus/contracts/fx/EvmNativeHtlcV3.sol",
        sourceTag: "agentic-fx-requester-secret-v3",
        compiler: "0.8.26",
        evmVersion: "cancun",
        optimizerRuns: 1,
        viaIR: true,
        sourceSha256: HASH,
        creationCodeHash: HASH,
      },
      erc20: {
        adapterId: "evm-htlc-v3",
        adapterVersion: 3,
        contract: "EvmHtlcV3",
        sourcePath: "versus/contracts/fx/EvmHtlcV3.sol",
        sourceTag: "agentic-fx-requester-secret-v3",
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
        runtimeCodeHash: keccak256(NATIVE_CODE),
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
        reorgSafetyBlocks: 12,
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

test("V3 frozen deployment keeps a separate requester-secret coordination domain", () => {
  const filePath = path.resolve(
    __dirname,
    "../../../versus/deployments/fx/phase12-v3-public-testnet.json"
  );
  const frozen = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const validated = validateEvmV3Manifest(frozen);
  assert.equal(
    validated.deploymentId,
    "0x1edf9c4dca5cbcb8b1875f4ce950844237258367d51e5d02dc3de577b3088494"
  );
  assert.equal(
    validated.coordinationDomain,
    "0x6d2d3f9784460521d35605b450e5a46fc1c068df7724265c8f12fec7f1693b2c"
  );
  assert.equal(validated.settlementMode, "requester-secret-source-first-compact");
  assert.equal(validated.capabilities.length, 2);
});

test("V3 adapter preflight binds runtime and timeout immutables", async () => {
  const provider = {
    async getNetwork() {
      return { chainId: 84532n };
    },
    async getCode() {
      return NATIVE_CODE;
    },
    async call({ data }) {
      const selector = data.slice(0, 10);
      for (const [name, value] of [
        ["ADAPTER_VERSION", 3n],
        ["minimumLockDuration", 60n],
        ["maximumLockDuration", 604800n],
      ]) {
        if (selector === NATIVE_INTERFACE.getFunction(name).selector) {
          return NATIVE_INTERFACE.encodeFunctionResult(name, [value]);
        }
      }
      throw new Error("unexpected contract call");
    },
  };
  const capability = await preflightEvmV3Capability(provider, manifest(), {
    chainId: "84532",
    token: "native:eth",
  });
  assert.equal(capability.kind, "native");
  assert.equal(
    capability.adapterAddress,
    "0x1111111111111111111111111111111111111111"
  );
});

test("V3 timeout policy preserves a full executor window", () => {
  const capability = validateEvmV3Manifest(manifest()).capabilities[0];
  const now = 1_800_000_000;
  assert.deepEqual(
    validateSourceFirstTimeoutsV3({
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
    () => validateSourceFirstTimeoutsV3({
      now,
      sourceRefundTimestamp: now + 4_000,
      destinationRefundTimestamp: now + 1_200,
      sourceCapability: capability,
      destinationCapability: capability,
    }),
    { code: "UNSAFE_TIMEOUT_ORDER" }
  );
});
