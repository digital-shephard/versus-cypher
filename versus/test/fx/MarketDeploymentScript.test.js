const { expect } = require("chai");
const {
  waitForRuntimeCode,
} = require("../../scripts/fx/deploy-market-v3-testnet");

describe("FX market deployment runtime visibility", function () {
  it("waits through stale empty-code reads after a confirmed deployment", async function () {
    const reads = ["0x", "0x", "0x6000"];
    const provider = {
      getCode: async () => reads.shift(),
    };

    expect(await waitForRuntimeCode(provider, "0x01", {
      attempts: 3,
      delayMs: 0,
    })).to.equal("0x6000");
    expect(reads).to.deep.equal([]);
  });

  it("fails closed when runtime code never becomes visible", async function () {
    const provider = {
      getCode: async () => "0x",
    };

    expect(await waitForRuntimeCode(provider, "0x01", {
      attempts: 3,
      delayMs: 0,
    })).to.equal("0x");
  });
});
