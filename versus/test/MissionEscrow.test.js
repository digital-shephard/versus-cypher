const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployLocalStack } = require("../scripts/lib/deployOwnerless");
const MIN_RUNWAY = 7_000_000n;

const PENNY = 10_000n;

async function deployEscrowStack() {
  const [deployer, alice, bob, carol] = await ethers.getSigners();
  const stack = await deployLocalStack(ethers, {
    protocolRecipient: deployer.address,
    graduationFloor: PENNY * 100n,
  });
  for (const signer of [alice, bob, carol]) {
    await stack.usdc.mint(signer.address, ethers.parseUnits("100", 6));
    await stack.usdc.connect(signer).approve(await stack.arena.getAddress(), ethers.MaxUint256);
    await stack.usdc.connect(signer).approve(await stack.missionEscrow.getAddress(), ethers.MaxUint256);
  }
  await stack.arena.connect(alice).hatch(MIN_RUNWAY);
  await stack.arena.connect(bob).hatch(MIN_RUNWAY);
  return { deployer, alice, bob, carol, ...stack };
}

describe("Versus MissionEscrow (ownerless)", function () {
  it("locks sponsorship behind a signed mission ID and releases into the recipient NFT vault", async function () {
    const { alice, bob, carol, usdc, agents, missionEscrow } = await deployEscrowStack();
    const missionId = ethers.id("signed mission postcard");
    const amount = ethers.parseUnits("5", 6);
    const block = await ethers.provider.getBlock("latest");
    const deadline = BigInt(block.timestamp + 86400);

    await expect(missionEscrow.connect(alice).sponsorMission(missionId, 7, 1, 2, amount, deadline))
      .to.emit(missionEscrow, "MissionSponsored")
      .withArgs(1, missionId, 7, 1, 2, alice.address, amount, deadline);
    expect(await usdc.balanceOf(await missionEscrow.getAddress())).to.equal(amount);
    await expect(missionEscrow.connect(bob).release(1)).to.be.revertedWithCustomError(
      missionEscrow,
      "NotSponsor"
    );

    await agents.connect(bob).transferFrom(bob.address, carol.address, 2);
    await expect(missionEscrow.connect(alice).release(1))
      .to.emit(missionEscrow, "MissionReleased")
      .withArgs(1, missionId, 2, amount);
    expect((await agents.getAgent(2)).vault).to.equal(amount);
    await agents.connect(carol).withdraw(2, amount);
    expect((await agents.getAgent(2)).vault).to.equal(0n);
    expect((await missionEscrow.escrows(1)).state).to.equal(1n);
    await expect(missionEscrow.connect(alice).release(1)).to.be.revertedWithCustomError(
      missionEscrow,
      "EscrowNotActive"
    );
  });

  it("returns an expired unapproved mission budget to its original sponsor", async function () {
    const { alice, bob, usdc, missionEscrow } = await deployEscrowStack();
    const missionId = ethers.id("expired mission postcard");
    const amount = ethers.parseUnits("2", 6);
    const block = await ethers.provider.getBlock("latest");
    const deadline = BigInt(block.timestamp + 3601);
    const balanceBefore = await usdc.balanceOf(alice.address);
    await missionEscrow.connect(alice).sponsorMission(missionId, 8, 1, 2, amount, deadline);

    await expect(missionEscrow.connect(alice).refund(1)).to.be.revertedWithCustomError(
      missionEscrow,
      "EscrowNotExpired"
    );
    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine");
    await expect(missionEscrow.connect(alice).refund(1))
      .to.emit(missionEscrow, "MissionRefunded")
      .withArgs(1, missionId, alice.address, amount);
    expect(await usdc.balanceOf(alice.address)).to.equal(balanceBefore);
    expect((await missionEscrow.escrows(1)).state).to.equal(2n);
    await expect(missionEscrow.connect(bob).refund(1)).to.be.revertedWithCustomError(
      missionEscrow,
      "EscrowNotActive"
    );
  });

  it("rejects nonexistent missions invalid deadlines and sponsorship from another Cypher", async function () {
    const { alice, bob, missionEscrow } = await deployEscrowStack();
    const block = await ethers.provider.getBlock("latest");
    await expect(
      missionEscrow.connect(alice).sponsorMission(ethers.ZeroHash, 1, 1, 2, 1, block.timestamp + 3600)
    ).to.be.revertedWithCustomError(missionEscrow, "InvalidMission");
    await expect(
      missionEscrow.connect(alice).sponsorMission(ethers.id("mission"), 1, 1, 2, 0, block.timestamp + 3600)
    ).to.be.revertedWithCustomError(missionEscrow, "InvalidAmount");
    await expect(
      missionEscrow.connect(alice).sponsorMission(ethers.id("mission"), 1, 1, 2, 1, block.timestamp + 3599)
    ).to.be.revertedWithCustomError(missionEscrow, "InvalidDeadline");
    await expect(
      missionEscrow.connect(bob).sponsorMission(ethers.id("mission"), 1, 1, 2, 1, block.timestamp + 3600)
    ).to.be.revertedWithCustomError(missionEscrow, "NotAgentOwner");
  });
});
