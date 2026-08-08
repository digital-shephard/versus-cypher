const { expect } = require("chai");
const fs = require("node:fs");
const path = require("node:path");
const Ajv2020 = require("ajv/dist/2020");
const { keccak256, toUtf8Bytes } = require("ethers");
const { buildNativeFreezeRecord } = require("../../scripts/fx/native-build-freeze");
const { canonicalJson } = require("../../../packages/network/src/fx-protocol");
const {
  validateEvmNativeAdapterManifest,
} = require("../../../packages/network/src/fx-evm-native-adapter");

describe("EvmNativeHtlcV1 reproducible build freeze", function () {
  it("recomputes identical bytecode and source evidence", function () {
    const root = path.resolve(__dirname, "..", "..");
    const first = buildNativeFreezeRecord(root);
    expect(buildNativeFreezeRecord(root)).to.deep.equal(first);
    expect(first.adapter).to.deep.include({
      id: "evm-native-htlc",
      version: 1,
      contract: "EvmNativeHtlcV1",
    });
    expect(first.compiler).to.deep.include({
      version: "0.8.26",
      evmVersion: "cancun",
      viaIR: true,
    });
    expect(first.creationCodeHash).to.match(/^0x[0-9a-f]{64}$/);
  });

  it("validates a native capability independently from ERC-20", function () {
    const repositoryRoot = path.resolve(__dirname, "..", "..", "..");
    const schema = JSON.parse(fs.readFileSync(
      path.join(repositoryRoot, "docs", "fx", "schemas", "native-adapter-capability-v1.schema.json"),
      "utf8"
    ));
    const fixture = {
      schema: "versus-fx-native-adapter-capabilities",
      schemaVersion: 1,
      adapter: {
        id: "evm-native-htlc",
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
        sourceSha256: `0x${"11".repeat(32)}`,
        creationCodeHash: `0x${"22".repeat(32)}`,
      },
      capabilities: [{
        chainId: "84532",
        adapterAddress: `0x${"aa".repeat(20)}`,
        runtimeCodeHash: `0x${"33".repeat(32)}`,
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
      }],
    };
    const validate = new Ajv2020({ allErrors: true }).compile(schema);
    expect(validate(fixture), JSON.stringify(validate.errors)).to.equal(true);
    expect(validateEvmNativeAdapterManifest(fixture).adapter.id)
      .to.equal("evm-native-htlc");
  });

  it("binds both live native deployments into the Phase 9 domain", function () {
    const contractsRoot = path.resolve(__dirname, "..", "..");
    const repositoryRoot = path.resolve(contractsRoot, "..");
    const deployment = JSON.parse(fs.readFileSync(
      path.join(contractsRoot, "deployments", "fx", "phase9-public-testnet.json"),
      "utf8"
    ));
    const native = validateEvmNativeAdapterManifest(deployment.nativeManifest);
    expect(native.capabilities).to.have.length(2);
    for (const capability of native.capabilities) {
      expect(capability.adapterAddress)
        .to.equal("0x7c917f09e1de03977acc14575b56932aa55da543");
      expect(capability.runtimeCodeHash)
        .to.equal("0x752e5fe73aed992241e138ff550d4ab7fc127230b802e70b9c87239fec60f082");
    }
    const adapters = [
      ...deployment.erc20Manifest.capabilities.map((capability) => ({
        chainId: capability.chainId,
        assetId: `erc20:${capability.asset.address}`,
        adapterId: "evm-htlc-v1",
        adapterAddress: capability.adapterAddress,
        runtimeCodeHash: capability.runtimeCodeHash,
      })),
      ...native.capabilities.map((capability) => ({
        chainId: capability.chainId,
        assetId: capability.asset.assetId,
        adapterId: "evm-native-htlc-v1",
        adapterAddress: capability.adapterAddress,
        runtimeCodeHash: capability.runtimeCodeHash,
      })),
    ].sort((left, right) =>
      `${left.chainId}:${left.assetId}`.localeCompare(
        `${right.chainId}:${right.assetId}`
      )
    );
    expect(
      keccak256(toUtf8Bytes(canonicalJson({
        protocol: "versus-fx-phase9",
        environment: "public-testnet",
        adapters,
      })))
    ).to.equal(deployment.deploymentId);
    const desktopNetwork = fs.readFileSync(
      path.join(repositoryRoot, "apps", "pet", "src", "fx-desktop-network.js"),
      "utf8"
    );
    expect(desktopNetwork).to.include(deployment.deploymentId);
  });
});
