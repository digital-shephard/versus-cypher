const { expect } = require("chai");
const path = require("node:path");
const {
  buildSettlementFreeze,
} = require("../../scripts/fx/settlement-build-freeze");

describe("SameChainSettlementV1 reproducible build freeze", function () {
  it("recomputes identical bytecode and source evidence", function () {
    const root = path.resolve(__dirname, "..", "..");
    const first = buildSettlementFreeze(root);
    const second = buildSettlementFreeze(root);
    expect(second).to.deep.equal(first);
    expect(first.settlement).to.deep.include({
      id: "same-chain-exact-output",
      version: 1,
      contract: "SameChainSettlementV1",
    });
    expect(first.compiler).to.deep.include({
      version: "0.8.26",
      evmVersion: "cancun",
      viaIR: true,
    });
    expect(first.creationCodeHash).to.match(/^0x[0-9a-f]{64}$/);
    expect(first.runtimeTemplateHash).to.match(/^0x[0-9a-f]{64}$/);
    expect(first.sourceSha256).to.match(/^0x[0-9a-f]{64}$/);
  });
});
