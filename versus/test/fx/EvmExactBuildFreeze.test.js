const { expect } = require("chai");
const path = require("node:path");
const {
  buildExactFreezeRecord,
} = require("../../scripts/fx/exact-build-freeze");

describe("EVM generic x402 exact reproducible build freeze", function () {
  it("recomputes identical ownerless factory and escrow evidence", function () {
    const root = path.resolve(__dirname, "..", "..");
    const first = buildExactFreezeRecord(root);
    expect(buildExactFreezeRecord(root)).to.deep.equal(first);
    expect(first).to.deep.include({
      schema: "versus-fx-evm-exact-build-freeze",
      schemaVersion: 1,
      settlementMode: "x402-exact-eip3009-to-v3",
      sourceTag: "generic-x402-exact-v1",
    });
    for (const [name, build] of Object.entries(first.builds)) {
      expect(build.contract).to.equal(name);
      expect(build.evmVersion).to.equal("cancun");
      expect(build.optimizerRuns).to.equal(1);
      expect(build.viaIR).to.equal(true);
      expect(build.sourceSha256).to.match(/^0x[0-9a-f]{64}$/);
      expect(build.creationCodeHash).to.match(/^0x[0-9a-f]{64}$/);
      expect(build.runtimeTemplateHash).to.match(/^0x[0-9a-f]{64}$/);
      expect(build.creationCodeBytes).to.be.greaterThan(0);
      expect(build.runtimeTemplateBytes).to.be.greaterThan(0);
    }
  });
});
