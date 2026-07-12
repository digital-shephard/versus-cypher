const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployLocalStack } = require("../scripts/lib/deployOwnerless");

const PENNY = 10_000n;
const MIN_RUNWAY = 7_000_000n;
const REFERRAL_REWARD = 1_000_000n;
const PROPOSAL_ID = ethers.id("refill the permanent referral pool");

async function deployReferralStack() {
  const [deployer, alice, bob, carol] = await ethers.getSigners();
  const stack = await deployLocalStack(ethers, {
    protocolRecipient: deployer.address,
    graduationFloor: 30_000n,
    referralReward: REFERRAL_REWARD,
  });
  for (const signer of [alice, bob, carol]) {
    await stack.usdc.mint(signer.address, ethers.parseUnits("100", 6));
    await stack.usdc.connect(signer).approve(await stack.arena.getAddress(), ethers.MaxUint256);
    await stack.usdc.connect(signer).approve(await stack.referralPool.getAddress(), ethers.MaxUint256);
  }
  return { deployer, alice, bob, carol, ...stack };
}

describe("Versus continuous referral pool (ownerless)", function () {
  it("accepts explicit tagged funding only from a current Cypher owner", async function () {
    const { alice, bob, usdc, arena, referralPool } = await deployReferralStack();
    await arena.connect(alice).hatch(MIN_RUNWAY);

    await expect(referralPool.connect(alice).fund(1, PROPOSAL_ID, REFERRAL_REWARD))
      .to.emit(referralPool, "ReferralPoolFunded")
      .withArgs(1, PROPOSAL_ID, alice.address, REFERRAL_REWARD, REFERRAL_REWARD);

    expect(await referralPool.totalFunded()).to.equal(REFERRAL_REWARD);
    expect(await referralPool.availableRewards()).to.equal(1n);
    expect(await usdc.balanceOf(await referralPool.getAddress())).to.equal(REFERRAL_REWARD);
    await expect(referralPool.connect(bob).fund(1, PROPOSAL_ID, PENNY))
      .to.be.revertedWithCustomError(referralPool, "NotAgentOwner");
    await expect(referralPool.connect(alice).fund(1, PROPOSAL_ID, 0))
      .to.be.revertedWithCustomError(referralPool, "InvalidAmount");
  });

  it("pays a successful referred hatch immediately into the referrer NFT vault", async function () {
    const { alice, bob, usdc, agents, arena, referralPool } = await deployReferralStack();
    await arena.connect(alice).hatch(MIN_RUNWAY);
    await referralPool.connect(alice).fund(1, PROPOSAL_ID, REFERRAL_REWARD);

    await expect(arena.connect(bob)["hatch(uint256,uint256)"](MIN_RUNWAY, 1))
      .to.emit(referralPool, "ReferralRewardPaid")
      .withArgs(2, 1, bob.address, REFERRAL_REWARD);

    expect(await referralPool.referredBy(2)).to.equal(1n);
    expect(await referralPool.totalPaid()).to.equal(REFERRAL_REWARD);
    expect(await referralPool.availableRewards()).to.equal(0n);
    expect((await agents.getAgent(1)).vault).to.equal(REFERRAL_REWARD);
    expect((await agents.getAgent(2)).vault).to.equal(0n);
    expect(await usdc.balanceOf(await referralPool.getAddress())).to.equal(0n);
  });

  it("never blocks hatching when a referral is invalid or the final reward is already spent", async function () {
    const { alice, bob, carol, agents, arena, referralPool } = await deployReferralStack();
    await arena.connect(alice).hatch(MIN_RUNWAY);
    await referralPool.connect(alice).fund(1, PROPOSAL_ID, REFERRAL_REWARD);

    await expect(arena.connect(alice)["hatch(uint256,uint256)"](MIN_RUNWAY, 1))
      .to.emit(arena, "ReferralAttempted")
      .withArgs(2, 1, false, 0);
    expect(await agents.ownerOf(2)).to.equal(alice.address);
    expect(await referralPool.referredBy(2)).to.equal(0n);

    await expect(arena.connect(bob)["hatch(uint256,uint256)"](MIN_RUNWAY, 1))
      .to.emit(arena, "ReferralAttempted")
      .withArgs(3, 1, true, REFERRAL_REWARD);
    expect(await referralPool.referredBy(3)).to.equal(1n);
    expect((await agents.getAgent(1)).vault).to.equal(REFERRAL_REWARD);

    await expect(arena.connect(carol)["hatch(uint256,uint256)"](MIN_RUNWAY, 1))
      .to.emit(referralPool, "ReferralRewardSkipped")
      .withArgs(4, 1, carol.address, 0);
    expect(await agents.ownerOf(4)).to.equal(carol.address);
    expect(await referralPool.referredBy(4)).to.equal(1n);
    expect(await referralPool.totalPaid()).to.equal(REFERRAL_REWARD);
    expect(await agents.nextId()).to.equal(5n);
  });

  it("lets a Cypher contribute exactly one runway penny per UTC day without earning a ticket", async function () {
    const { alice, arena, syndicate, treasury, referralPool } = await deployReferralStack();
    await arena.connect(alice).hatch(MIN_RUNWAY);
    const classBefore = await syndicate.getClass(await syndicate.currentClassId());

    await expect(arena.connect(alice).fundReferralPoolFromRunway(1, PROPOSAL_ID))
      .to.emit(arena, "ReferralPoolFunded")
      .withArgs(1, PROPOSAL_ID, await arena.currentDay(), PENNY);

    expect(await arena.runway(1)).to.equal(MIN_RUNWAY - PENNY);
    expect(await arena.totalRunwayLiability()).to.equal(MIN_RUNWAY - PENNY);
    expect(await referralPool.totalFunded()).to.equal(PENNY);
    expect(await treasury.tickets(1)).to.equal(0n);
    expect((await syndicate.getClass(await syndicate.currentClassId())).totalCommitted).to.equal(classBefore.totalCommitted);
    await expect(arena.connect(alice).fundReferralPoolFromRunway(1, PROPOSAL_ID))
      .to.be.revertedWithCustomError(arena, "ReferralAlreadyFunded");

    await ethers.provider.send("evm_increaseTime", [86400]);
    await ethers.provider.send("evm_mine");
    await expect(arena.connect(alice).fundReferralPoolFromRunway(1, PROPOSAL_ID))
      .to.emit(arena, "ReferralPoolFunded");
    expect(await referralPool.totalFunded()).to.equal(PENNY * 2n);
  });

  it("seals both bootstrap links without creating an owner role", async function () {
    const { deployer, arena, agents, referralPool } = await deployReferralStack();
    expect(await referralPool.bootstrapped()).to.equal(true);
    expect(await referralPool.arena()).to.equal(await arena.getAddress());
    expect(await agents.referralPool()).to.equal(await referralPool.getAddress());
    await expect(referralPool.connect(deployer).bootstrap(await arena.getAddress()))
      .to.be.revertedWithCustomError(referralPool, "AlreadyBootstrapped");
  });
});
