const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployLocalStack } = require("../scripts/lib/deployOwnerless");

const PENNY = 10_000n;
const MIN_RUNWAY = 7_000_000n;
const TEST_FLOOR = 30_000n; // $0.03 — three pennies graduate in tests

async function deployVersus() {
  const [deployer, alice, bob] = await ethers.getSigners();
  const stack = await deployLocalStack(ethers, {
    protocolRecipient: deployer.address,
    graduationFloor: TEST_FLOOR,
  });

  await stack.usdc.mint(alice.address, ethers.parseUnits("100", 6));
  await stack.usdc.mint(bob.address, ethers.parseUnits("100", 6));
  await stack.usdc.connect(alice).approve(await stack.arena.getAddress(), ethers.MaxUint256);
  await stack.usdc.connect(bob).approve(await stack.arena.getAddress(), ethers.MaxUint256);

  return { deployer, alice, bob, ...stack };
}

describe("Versus Arena (ownerless)", function () {
  it("hatches an agent with Arena-held nonwithdrawable runway", async function () {
    const { alice, usdc, agents, arena } = await deployVersus();
    await expect(arena.connect(alice).hatch(0, MIN_RUNWAY))
      .to.emit(arena, "Hatched")
      .withArgs(1, alice.address, 0, MIN_RUNWAY);
    expect(await agents.ownerOf(1)).to.equal(alice.address);
    expect(await arena.runway(1)).to.equal(MIN_RUNWAY);
    expect(await arena.totalRunwayLiability()).to.equal(MIN_RUNWAY);
    expect(await usdc.balanceOf(await arena.getAddress())).to.equal(MIN_RUNWAY);
    expect(await arena.runwaySolvent()).to.equal(true);
    await expect(arena.connect(alice).hatch(0, MIN_RUNWAY - 1n)).to.be.revertedWithCustomError(
      arena,
      "RunwayBelowMinimum"
    );
  });

  it("commits once per day and auto-awards a ticket", async function () {
    const { alice, arena, syndicate, treasury } = await deployVersus();
    await arena.connect(alice).hatch(1, MIN_RUNWAY);
    await arena.connect(alice).commit(1);

    const classId = await syndicate.currentClassId();
    const cls = await syndicate.getClass(classId);
    expect(cls.totalCommitted).to.equal(PENNY);
    expect(cls.participantCount).to.equal(1);
    expect(await treasury.tickets(1)).to.equal(1n);
    expect(await arena.committedDays(1, await arena.currentDay())).to.equal(true);

    await expect(arena.connect(alice).commit(1)).to.be.revertedWithCustomError(arena, "AlreadyCommitted");
  });

  it("levels and streaks across days into the same open class", async function () {
    const { alice, agents, arena, syndicate } = await deployVersus();
    await arena.connect(alice).hatch(2, MIN_RUNWAY);
    await arena.connect(alice).commit(1);

    await ethers.provider.send("evm_increaseTime", [86400]);
    await ethers.provider.send("evm_mine");
    await arena.connect(alice).commit(1);

    const agent = await agents.getAgent(1);
    expect(agent.level).to.equal(2);
    expect(agent.streak).to.equal(2);

    const classId = await syndicate.currentClassId();
    expect((await syndicate.getClass(classId)).totalCommitted).to.equal(PENNY * 2n);
  });

  it("daily commit spends one penny from runway and preserves reward vault", async function () {
    const { alice, agents, arena } = await deployVersus();
    await arena.connect(alice).hatch(0, MIN_RUNWAY);
    await arena.connect(alice).commit(1);

    expect(await arena.runway(1)).to.equal(MIN_RUNWAY - PENNY);
    expect((await agents.getAgent(1)).vault).to.equal(0n);
  });

  it("batches vault rain and awards exactly one ticket per confirmed penny", async function () {
    const { alice, agents, arena, syndicate, treasury } = await deployVersus();
    await arena.connect(alice).hatch(0, MIN_RUNWAY);

    await expect(arena.connect(alice).rainFromRunway(1, 7))
      .to.emit(arena, "Rained")
      .withArgs(1, alice.address, await arena.currentDay(), 7, PENNY * 7n);

    const agent = await agents.getAgent(1);
    expect(agent.vault).to.equal(0n);
    expect(await arena.runway(1)).to.equal(MIN_RUNWAY - PENNY * 7n);
    expect(agent.level).to.equal(0n);
    expect(agent.streak).to.equal(0n);
    expect(await treasury.tickets(1)).to.equal(7n);
    expect(await treasury.totalTickets()).to.equal(7n);

    const classId = await syndicate.currentClassId();
    const cls = await syndicate.getClass(classId);
    expect(cls.totalCommitted).to.equal(PENNY * 7n);
    expect(cls.participantCount).to.equal(1n);
    expect(await syndicate.commitOf(classId, 1)).to.equal(PENNY * 7n);
  });

  it("rejects empty, oversized, and unfunded rain batches", async function () {
    const { alice, arena } = await deployVersus();
    await arena.connect(alice).hatch(0, MIN_RUNWAY);
    await expect(arena.connect(alice).rainFromRunway(1, 0)).to.be.revertedWithCustomError(
      arena,
      "InvalidRainAmount"
    );
    await expect(arena.connect(alice).rainFromRunway(1, 101)).to.be.revertedWithCustomError(
      arena,
      "InvalidRainAmount"
    );
    await arena.connect(alice).rainFromRunway(1, 100);
    await arena.connect(alice).rainFromRunway(1, 100);
  });

  it("settles a nonreplayable batch of durable signals from the Cypher vault", async function () {
    const { alice, agents, arena, syndicate, treasury } = await deployVersus();
    await arena.connect(alice).hatch(0, MIN_RUNWAY);
    const classId = await syndicate.currentClassId();
    const batchRoot = ethers.id("versus signal batch one");

    await expect(arena.connect(alice).settleSignalBatchFromRunway(1, classId, batchRoot, 3, 7))
      .to.emit(arena, "SignalBatchSettled")
      .withArgs(1, classId, batchRoot, 3, 7, PENNY * 7n);

    expect(await arena.settledSignalBatches(batchRoot)).to.equal(true);
    expect((await agents.getAgent(1)).vault).to.equal(0n);
    expect(await arena.runway(1)).to.equal(MIN_RUNWAY - PENNY * 7n);
    expect((await agents.getAgent(1)).level).to.equal(0n);
    expect(await syndicate.commitOf(classId, 1)).to.equal(PENNY * 7n);
    expect(await treasury.tickets(1)).to.equal(7n);
    await expect(
      arena.connect(alice).settleSignalBatchFromRunway(1, classId, batchRoot, 3, 7)
    ).to.be.revertedWithCustomError(arena, "SignalBatchAlreadySettled");
  });

  it("rejects invalid stale nonowner and unfunded signal batches", async function () {
    const { alice, bob, arena, syndicate } = await deployVersus();
    await arena.connect(alice).hatch(0, MIN_RUNWAY);
    const classId = await syndicate.currentClassId();
    const root = ethers.id("versus signal batch invalid cases");

    await expect(
      arena.connect(alice).settleSignalBatchFromRunway(1, classId, ethers.ZeroHash, 1, 1)
    ).to.be.revertedWithCustomError(arena, "InvalidSignalBatch");
    await expect(
      arena.connect(alice).settleSignalBatchFromRunway(1, classId, root, 0, 1)
    ).to.be.revertedWithCustomError(arena, "InvalidSignalBatch");
    await expect(
      arena.connect(alice).settleSignalBatchFromRunway(1, classId, root, 101, 101)
    ).to.be.revertedWithCustomError(arena, "InvalidSignalBatch");
    await expect(
      arena.connect(alice).settleSignalBatchFromRunway(1, classId + 1n, root, 1, 1)
    ).to.be.revertedWithCustomError(arena, "WrongClass");
    await expect(
      arena.connect(bob).settleSignalBatchFromRunway(1, classId, root, 1, 1)
    ).to.be.revertedWithCustomError(arena, "NotAgentOwner");
    await expect(
      arena.connect(alice).settleSignalBatchFromRunway(1, classId, root, 2, 1)
    ).to.be.revertedWithCustomError(arena, "InvalidSignalBatch");
  });

  it("transfers control of runway with the NFT while rewards stay separately withdrawable", async function () {
    const { alice, bob, usdc, agents, arena } = await deployVersus();
    await arena.connect(alice).hatch(0, MIN_RUNWAY);
    await usdc.connect(alice).approve(await agents.getAddress(), ethers.MaxUint256);
    await agents.connect(alice).deposit(1, ethers.parseUnits("10", 6));

    await agents.connect(alice).transferFrom(alice.address, bob.address, 1);
    expect(await agents.ownerOf(1)).to.equal(bob.address);
    await arena.connect(bob).rainFromRunway(1, 1);
    expect(await arena.runway(1)).to.equal(MIN_RUNWAY - PENNY);
    await agents.connect(bob).withdraw(1, ethers.parseUnits("10", 6));
    expect((await agents.getAgent(1)).vault).to.equal(0);
  });

  it("allocates 10% to protocol and 90% to tickets in the fee transaction", async function () {
    const { deployer, alice, bob, usdc, agents, arena, treasury } = await deployVersus();
    await arena.connect(alice).hatch(0, MIN_RUNWAY);
    await arena.connect(bob).hatch(1, MIN_RUNWAY);
    await arena.connect(alice).commit(1);
    await arena.connect(bob).commit(2);

    const oil = ethers.parseUnits("1000", 6);
    await usdc.mint(deployer.address, oil);
    await usdc.approve(await treasury.getAddress(), oil);
    const protocolBefore = await treasury.totalProtocolPaid();
    await treasury.depositFees(oil);
    const protocolAfter = await treasury.totalProtocolPaid();

    const expectedCut = (oil * 1000n) / 10000n;
    expect(protocolAfter - protocolBefore).to.equal(expectedCut);
    expect(await treasury.tranchePot()).to.equal(oil - expectedCut);

    expect(await treasury.claimable(1)).to.equal((oil - expectedCut) / 2n);
    expect(await treasury.claimable(2)).to.equal((oil - expectedCut) / 2n);
    await treasury.claim(1);
    await treasury.claim(2);
    expect((await agents.getAgent(1)).vault).to.be.gt(0n);
    expect((await agents.getAgent(2)).vault).to.be.gt(0n);
  });

  it("makes consecutive fee deposits claimable immediately without a closing transaction", async function () {
    const { deployer, alice, usdc, arena, treasury } = await deployVersus();
    await arena.connect(alice).hatch(0, MIN_RUNWAY);
    await arena.connect(alice).commit(1);

    const firstFees = ethers.parseUnits("10", 6);
    await usdc.mint(deployer.address, firstFees * 2n);
    await usdc.approve(await treasury.getAddress(), ethers.MaxUint256);
    await treasury.depositFees(firstFees);
    const firstClaimable = await treasury.claimable(1);
    expect(firstClaimable).to.equal((firstFees * 9000n) / 10000n);
    await treasury.depositFees(firstFees);
    expect(await treasury.claimable(1)).to.equal(firstClaimable * 2n);
    expect(await treasury.tranchePot()).to.equal(firstClaimable * 2n);
  });

  it("keeps tickets forever without letting new tickets claim prior rolling rewards", async function () {
    const { deployer, alice, bob, usdc, arena, treasury } = await deployVersus();
    await arena.connect(alice).hatch(0, MIN_RUNWAY);
    await arena.connect(bob).hatch(1, MIN_RUNWAY);
    await arena.connect(alice).commit(1);
    await arena.connect(bob).commit(2);

    const firstOil = ethers.parseUnits("90", 6);
    await usdc.mint(deployer.address, firstOil);
    await usdc.approve(await treasury.getAddress(), ethers.MaxUint256);
    await treasury.depositFees(firstOil);

    const aliceFirst = await treasury.claimable(1);
    const bobFirst = await treasury.claimable(2);
    expect(aliceFirst).to.equal(bobFirst);

    await ethers.provider.send("evm_increaseTime", [86400]);
    await ethers.provider.send("evm_mine");
    await arena.connect(alice).commit(1);
    expect(await treasury.tickets(1)).to.equal(2n);
    expect(await treasury.claimable(1)).to.equal(aliceFirst);

    const secondOil = ethers.parseUnits("90", 6);
    await usdc.mint(deployer.address, secondOil);
    await treasury.depositFees(secondOil);

    const aliceSecond = (await treasury.claimable(1)) - aliceFirst;
    const bobSecond = (await treasury.claimable(2)) - bobFirst;
    expect(aliceSecond).to.be.closeTo(bobSecond * 2n, 2n);
  });

  it("keeps warm commit reasonably thin", async function () {
    const { alice, arena } = await deployVersus();
    await arena.connect(alice).hatch(0, MIN_RUNWAY);
    await arena.connect(alice).commit(1);

    await ethers.provider.send("evm_increaseTime", [86400]);
    await ethers.provider.send("evm_mine");
    const tx = await arena.connect(alice).commit(1);
    const receipt = await tx.wait();
    console.log("      warm commit gas:", receipt.gasUsed.toString());
    expect(receipt.gasUsed).to.be.lt(250_000n);
  });

  it("has no Ownable owner and is bootstrapped", async function () {
    const { agents, syndicate, treasury, arena, missionEscrow, graduation } = await deployVersus();
    expect(arena.owner).to.equal(undefined);
    expect(await agents.bootstrapped()).to.equal(true);
    expect(await agents.missionEscrow()).to.equal(await missionEscrow.getAddress());
    expect(missionEscrow.owner).to.equal(undefined);
    expect(await syndicate.graduationFloor()).to.equal(TEST_FLOOR);
    expect(await treasury.protocolRecipient()).to.be.properAddress;
    expect(graduation.owner).to.equal(undefined);
  });
});
