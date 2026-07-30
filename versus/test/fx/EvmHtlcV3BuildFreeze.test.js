const { expect } = require("chai");
const path = require("node:path");
const {
  buildV3FreezeRecord,
} = require("../../scripts/fx/v3-build-freeze");

describe("EVM HTLC V3 reproducible build freeze", function () {
  it("recomputes identical native and ERC-20 build evidence", function () {
    const root = path.resolve(__dirname, "..", "..");
    const first = buildV3FreezeRecord(root);
    expect(buildV3FreezeRecord(root)).to.deep.equal(first);
    expect(first).to.deep.include({
      schema: "versus-fx-evm-v3-build-freeze",
      schemaVersion: 3,
      settlementMode: "requester-secret-source-first-compact",
    });
    expect(first.builds.native).to.deep.include({
      adapterId: "evm-native-htlc-v3",
      adapterVersion: 3,
      contract: "EvmNativeHtlcV3",
      evmVersion: "cancun",
      optimizerRuns: 1,
      viaIR: true,
    });
    expect(first.builds.erc20).to.deep.include({
      adapterId: "evm-htlc-v3",
      adapterVersion: 3,
      contract: "EvmHtlcV3",
      evmVersion: "cancun",
      optimizerRuns: 1,
      viaIR: true,
    });
    for (const build of Object.values(first.builds)) {
      expect(build.sourceSha256).to.match(/^0x[0-9a-f]{64}$/);
      expect(build.creationCodeHash).to.match(/^0x[0-9a-f]{64}$/);
      expect(build.runtimeTemplateHash).to.match(/^0x[0-9a-f]{64}$/);
      expect(build.creationCodeBytes).to.be.greaterThan(0);
      expect(build.runtimeTemplateBytes).to.be.greaterThan(0);
    }
  });
});
