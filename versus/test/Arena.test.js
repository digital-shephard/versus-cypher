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
    const hatch = await arena.connect(alice).hatch(MIN_RUNWAY);
    await expect(hatch).to.emit(arena, "Hatched");
    const receipt = await hatch.wait();
    expect(await agents.ownerOf(1)).to.equal(alice.address);
    const agent = await agents.getAgent(1);
    const block = await ethers.provider.send("eth_getBlockByNumber", [ethers.toQuantity(receipt.blockNumber), false]);
    const network = await ethers.provider.getNetwork();
    const expectedCypherId = BigInt(ethers.solidityPackedKeccak256(
      ["bytes32", "address", "uint256", "uint256", "uint256", "address"],
      [block.mixHash, alice.address, 1n, receipt.blockNumber, network.chainId, await arena.getAddress()]
    )) % 29n;
    expect(agent.cypherId).to.equal(expectedCypherId);
    expect(agent.cypherId).to.be.lessThan(29n);
    expect(await agents.tokenURI(1)).to.equal(
      `ipfs://bafybeicbtgrjvljtdjgjua6n6vteayl5micu222mbw5ifessrx63xpuyzy/${agent.cypherId}.json`
    );
    await expect(agents.tokenURI(2)).to.be.revertedWithCustomError(agents, "InvalidAgent");
    expect(await arena.runway(1)).to.equal(MIN_RUNWAY);
    expect(await arena.totalRunwayLiability()).to.equal(MIN_RUNWAY);
    expect(await usdc.balanceOf(await arena.getAddress())).to.equal(MIN_RUNWAY);
    expect(await arena.runwaySolvent()).to.equal(true);
    await expect(arena.connect(alice).hatch(MIN_RUNWAY - 1n)).to.be.revertedWithCustomError(
      arena,
      "RunwayBelowMinimum"
    );
  });

  it("blocks safe-mint callbacks from corrupting runway accounting", async function () {
    const { usdc, agents, arena } = await deployVersus();
    const ReentrantHatcher = await ethers.getContractFactory("ReentrantHatcher");
    const receiver = await ReentrantHatcher.deploy(await usdc.getAddress(), await arena.getAddress());
    const replenishAmount = 1_000_000n;
    await usdc.mint(await receiver.getAddress(), MIN_RUNWAY + replenishAmount);

    await receiver.hatch(MIN_RUNWAY, replenishAmount);

    expect(await receiver.reentryBlocked()).to.equal(true);
    expect(await agents.ownerOf(1)).to.equal(await receiver.getAddress());
    expect(await arena.runway(1)).to.equal(MIN_RUNWAY);
    expect(await arena.totalRunwayLiability()).to.equal(MIN_RUNWAY);
    expect(await usdc.balanceOf(await arena.getAddress())).to.equal(MIN_RUNWAY);
    expect(await arena.runwaySolvent()).to.equal(true);
  });

  it("selects species on-chain and always maps the result to immutable metadata", async function () {
    const { alice, usdc, agents, arena } = await deployVersus();
    await usdc.mint(alice.address, ethers.parseUnits("200", 6));
    expect(await agents.CYPHER_COUNT()).to.equal(29n);
    expect(arena.interface.hasFunction("hatch(uint8,uint256)")).to.equal(false);
    for (let index = 0; index < 29; index += 1) {
      await arena.connect(alice).hatch(MIN_RUNWAY);
      const agentId = index + 1;
      const agent = await agents.getAgent(agentId);
      expect(agent.cypherId).to.be.lessThan(29n);
      expect(await agents.tokenURI(agentId)).to.equal(
        `ipfs://bafybeicbtgrjvljtdjgjua6n6vteayl5micu222mbw5ifessrx63xpuyzy/${agent.cypherId}.json`
      );
    }
  });

  it("commits no sooner than 24 hours after its previous penny", async function () {
    const { alice, arena, syndicate, treasury } = await deployVersus();
    await arena.connect(alice).hatch(MIN_RUNWAY);
    const commit = await arena.connect(alice).commit(1);
    const receipt = await commit.wait();
    const block = await ethers.provider.getBlock(receipt.blockNumber);

    const classId = await syndicate.currentClassId();
    const cls = await syndicate.getClass(classId);
    expect(cls.totalCommitted).to.equal(PENNY);
    expect(cls.participantCount).to.equal(1);
    expect(await treasury.tickets(1)).to.equal(1n);
    expect(await arena.committedDays(1, await arena.currentDay())).to.equal(true);
    expect(await arena.nextCommitAt(1)).to.equal(BigInt(block.timestamp + 86400));

    await expect(arena.connect(alice).commit(1)).to.be.revertedWithCustomError(arena, "AlreadyCommitted");
    const dueAt = await arena.nextCommitAt(1);
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(dueAt) - 1]);
    await expect(arena.connect(alice).commit(1)).to.be.revertedWithCustomError(arena, "AlreadyCommitted");
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(dueAt)]);
    await expect(arena.connect(alice).commit(1)).to.emit(arena, "Committed");
  });

  it("staggered hatches retain staggered rolling commit times", async function () {
    const { alice, bob, arena } = await deployVersus();
    await arena.connect(alice).hatch(MIN_RUNWAY);
    await arena.connect(alice).commit(1);
    const aliceDueAt = await arena.nextCommitAt(1);

    await ethers.provider.send("evm_increaseTime", [6 * 60 * 60]);
    await ethers.provider.send("evm_mine");
    await arena.connect(bob).hatch(MIN_RUNWAY);
    await arena.connect(bob).commit(2);
    const bobDueAt = await arena.nextCommitAt(2);

    expect(bobDueAt - aliceDueAt).to.be.closeTo(6n * 60n * 60n, 3n);
  });

  it("levels and streaks across days into the same open class", async function () {
    const { alice, agents, arena, syndicate } = await deployVersus();
    await arena.connect(alice).hatch(MIN_RUNWAY);
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

  it("skips offline backlog and resets the streak after a full missed cadence", async function () {
    const { alice, agents, arena, treasury } = await deployVersus();
    await arena.connect(alice).hatch(MIN_RUNWAY);
    await arena.connect(alice).commit(1);
    const dueAt = await arena.nextCommitAt(1);

    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(dueAt) + 86400]);
    await arena.connect(alice).commit(1);

    const agent = await agents.getAgent(1);
    expect(agent.level).to.equal(2n);
    expect(agent.streak).to.equal(1n);
    expect(await treasury.tickets(1)).to.equal(2n);
    expect(await arena.nextCommitAt(1)).to.be.greaterThan(BigInt(Number(dueAt) + 86400));
  });

  it("daily commit spends one penny from runway and preserves reward vault", async function () {
    const { alice, agents, arena } = await deployVersus();
    await arena.connect(alice).hatch(MIN_RUNWAY);
    await arena.connect(alice).commit(1);

    expect(await arena.runway(1)).to.equal(MIN_RUNWAY - PENNY);
    expect((await agents.getAgent(1)).vault).to.equal(0n);
  });

  it("batches vault rain and awards exactly one ticket per confirmed penny", async function () {
    const { alice, agents, arena, syndicate, treasury } = await deployVersus();
    await arena.connect(alice).hatch(MIN_RUNWAY);
    const classId = await syndicate.currentClassId();

    await expect(arena.connect(alice).rainFromRunway(1, 7))
      .to.emit(arena, "Rained")
      .withArgs(1, classId, alice.address, await arena.currentDay(), 7, PENNY * 7n, PENNY * 7n);

    const agent = await agents.getAgent(1);
    expect(agent.vault).to.equal(0n);
    expect(await arena.runway(1)).to.equal(MIN_RUNWAY - PENNY * 7n);
    expect(agent.level).to.equal(0n);
    expect(agent.streak).to.equal(0n);
    expect(await treasury.tickets(1)).to.equal(7n);
    expect(await treasury.totalTickets()).to.equal(7n);

    const cls = await syndicate.getClass(classId);
    expect(cls.totalCommitted).to.equal(PENNY * 7n);
    expect(cls.participantCount).to.equal(1n);
    expect(await syndicate.commitOf(classId, 1)).to.equal(PENNY * 7n);
  });

  it("rejects empty, oversized, and unfunded rain batches", async function () {
    const { alice, arena } = await deployVersus();
    await arena.connect(alice).hatch(MIN_RUNWAY);
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
    await arena.connect(alice).hatch(MIN_RUNWAY);
    const classId = await syndicate.currentClassId();
    const batchRoot = ethers.id("versus signal batch one");
    const typeCounts = [1, 0, 2, 0, 0, 0, 0, 0];
    const typeCountsHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["uint16[8]"], [typeCounts])
    );

    await expect(arena.connect(alice).settleSignalBatchFromRunway(1, classId, batchRoot, typeCounts))
      .to.emit(arena, "SignalBatchSettled")
      .withArgs(1, classId, batchRoot, 3, 7, PENNY * 7n, PENNY * 7n, typeCountsHash);

    expect(await arena.settledSignalBatches(1, batchRoot)).to.equal(true);
    expect((await agents.getAgent(1)).vault).to.equal(0n);
    expect(await arena.runway(1)).to.equal(MIN_RUNWAY - PENNY * 7n);
    expect((await agents.getAgent(1)).level).to.equal(0n);
    expect(await syndicate.commitOf(classId, 1)).to.equal(PENNY * 7n);
    expect(await treasury.tickets(1)).to.equal(7n);
    await expect(
      arena.connect(alice).settleSignalBatchFromRunway(1, classId, batchRoot, typeCounts)
    ).to.be.revertedWithCustomError(arena, "SignalBatchAlreadySettled");
  });

  it("rejects invalid stale nonowner and unfunded signal batches", async function () {
    const { alice, bob, arena, syndicate } = await deployVersus();
    await arena.connect(alice).hatch(MIN_RUNWAY);
    const classId = await syndicate.currentClassId();
    const root = ethers.id("versus signal batch invalid cases");

    await expect(
      arena.connect(alice).settleSignalBatchFromRunway(1, classId, ethers.ZeroHash, [1, 0, 0, 0, 0, 0, 0, 0])
    ).to.be.revertedWithCustomError(arena, "InvalidSignalBatch");
    await expect(
      arena.connect(alice).settleSignalBatchFromRunway(1, classId, root, [0, 0, 0, 0, 0, 0, 0, 0])
    ).to.be.revertedWithCustomError(arena, "InvalidSignalBatch");
    await expect(
      arena.connect(alice).settleSignalBatchFromRunway(1, classId, root, [101, 0, 0, 0, 0, 0, 0, 0])
    ).to.be.revertedWithCustomError(arena, "InvalidSignalBatch");
    await expect(
      arena.connect(alice).settleSignalBatchFromRunway(1, classId + 1n, root, [1, 0, 0, 0, 0, 0, 0, 0])
    ).to.be.revertedWithCustomError(arena, "WrongClass");
    await expect(
      arena.connect(bob).settleSignalBatchFromRunway(1, classId, root, [1, 0, 0, 0, 0, 0, 0, 0])
    ).to.be.revertedWithCustomError(arena, "NotAgentOwner");
    await expect(
      arena.connect(alice).settleSignalBatchFromRunway(1, classId, root, [0, 0, 0, 0, 0, 0, 101, 0])
    ).to.be.revertedWithCustomError(arena, "InvalidSignalBatch");
  });

  it("scopes settled roots to each Cypher instead of globally burning copied roots", async function () {
    const { alice, arena, syndicate } = await deployVersus();
    await arena.connect(alice).hatch(MIN_RUNWAY);
    await arena.connect(alice).hatch(MIN_RUNWAY);
    const classId = await syndicate.currentClassId();
    const root = ethers.id("same manifest commitment for distinct agents");
    const counts = [1, 0, 0, 0, 0, 0, 0, 0];

    await arena.connect(alice).settleSignalBatchFromRunway(1, classId, root, counts);
    await arena.connect(alice).settleSignalBatchFromRunway(2, classId, root, counts);

    expect(await arena.settledSignalBatches(1, root)).to.equal(true);
    expect(await arena.settledSignalBatches(2, root)).to.equal(true);
  });

  it("transfers control of runway with the NFT while rewards stay separately withdrawable", async function () {
    const { alice, bob, usdc, agents, arena } = await deployVersus();
    await arena.connect(alice).hatch(MIN_RUNWAY);
    await usdc.connect(alice).approve(await agents.getAddress(), ethers.MaxUint256);
    await agents.connect(alice).deposit(1, ethers.parseUnits("10", 6));

    await agents.connect(alice).transferFrom(alice.address, bob.address, 1);
    expect(await agents.ownerOf(1)).to.equal(bob.address);
    await arena.connect(bob).rainFromRunway(1, 1);
    expect(await arena.runway(1)).to.equal(MIN_RUNWAY - PENNY);
    await agents.connect(bob).withdraw(1, ethers.parseUnits("10", 6));
    expect((await agents.getAgent(1)).vault).to.equal(0);
  });

  it("rejects vault credits that cannot fit the immutable uint128 accounting field", async function () {
    const { alice, usdc, agents, arena } = await deployVersus();
    await arena.connect(alice).hatch(MIN_RUNWAY);
    await usdc.connect(alice).approve(await agents.getAddress(), ethers.MaxUint256);
    await expect(agents.connect(alice).deposit(1, 1n << 128n)).to.be.revertedWithCustomError(
      agents,
      "VaultOverflow"
    );
  });

  it("allocates 10% to protocol and 90% to tickets in the fee transaction", async function () {
    const { deployer, alice, bob, usdc, agents, arena, treasury } = await deployVersus();
    await arena.connect(alice).hatch(MIN_RUNWAY);
    await arena.connect(bob).hatch(MIN_RUNWAY);
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
    await treasury.connect(bob).claim(1);
    await treasury.claim(2);
    expect((await agents.getAgent(1)).vault).to.be.gt(0n);
    expect((await agents.getAgent(2)).vault).to.be.gt(0n);
    await expect(agents.connect(bob).withdraw(1, 1)).to.be.revertedWithCustomError(agents, "NotAgentOwner");
  });

  it("makes consecutive fee deposits claimable immediately without a closing transaction", async function () {
    const { deployer, alice, usdc, arena, treasury } = await deployVersus();
    await arena.connect(alice).hatch(MIN_RUNWAY);
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
    await arena.connect(alice).hatch(MIN_RUNWAY);
    await arena.connect(bob).hatch(MIN_RUNWAY);
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
    await arena.connect(alice).hatch(MIN_RUNWAY);
    await arena.connect(alice).commit(1);

    await ethers.provider.send("evm_increaseTime", [86400]);
    await ethers.provider.send("evm_mine");
    const tx = await arena.connect(alice).commit(1);
    const receipt = await tx.wait();
    console.log("      warm commit gas:", receipt.gasUsed.toString());
    expect(receipt.gasUsed).to.be.lt(250_000n);
  });

  it("has no Ownable owner and is bootstrapped", async function () {
    const { agents, syndicate, treasury, arena, missionEscrow, referralPool, graduation } = await deployVersus();
    expect(arena.owner).to.equal(undefined);
    expect(await agents.bootstrapped()).to.equal(true);
    expect(await agents.missionEscrow()).to.equal(await missionEscrow.getAddress());
    expect(missionEscrow.owner).to.equal(undefined);
    expect(referralPool.owner).to.equal(undefined);
    expect(await referralPool.bootstrapped()).to.equal(true);
    expect(await syndicate.graduationFloor()).to.equal(TEST_FLOOR);
    expect(await treasury.protocolRecipient()).to.be.properAddress;
    expect(graduation.owner).to.equal(undefined);
  });
});
