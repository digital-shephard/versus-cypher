const { expect } = require("chai");
const { ethers } = require("hardhat");
const { runInvariantCampaign } = require("./campaign");

describe("Versus stateful invariant fuzz", function () {
  this.timeout(600_000);

  it("preserves custody invariants across a seeded random campaign", async function () {
    const report = await runInvariantCampaign(ethers, {
      steps: Number(process.env.VERSUS_INVARIANT_STEPS || 150),
      seed: process.env.VERSUS_INVARIANT_SEED || "versus-public-1",
      graduationFloor: 50_000n,
    });
    console.log("invariant campaign:", JSON.stringify(report));
    expect(report.executed).to.be.gt(0);
  });

  it("keeps the previously failing stress seed fully collateralized", async function () {
    const report = await runInvariantCampaign(ethers, {
      steps: 200,
      seed: 4132986438,
      graduationFloor: 50_000n,
    });
    console.log("invariant repro seed:", JSON.stringify(report));
    expect(report.executed).to.be.gt(0);
    expect(report.overClaimableEvents).to.equal(0);
    expect(BigInt(report.maxOverClaimableWei)).to.equal(0n);
  });

  it("survives a longer stress campaign when enabled", async function () {
    // `npm run test:invariants:long` uses 2,000 steps; callers may override the count explicitly.
    const npmLongRun = process.env.npm_lifecycle_event === "test:invariants:long" ? 2000 : 0;
    const steps = Number(process.env.VERSUS_INVARIANT_STEPS_LONG || npmLongRun);
    if (!steps) {
      this.skip();
    }
    const report = await runInvariantCampaign(ethers, {
      steps,
      seed: process.env.VERSUS_INVARIANT_SEED_B || "versus-stress-1k",
      graduationFloor: 40_000n,
    });
    console.log("invariant campaign long:", JSON.stringify(report));
    expect(report.executed).to.be.gt(0);
  });
});
