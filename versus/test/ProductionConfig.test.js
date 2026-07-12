const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { deployLocalStack } = require("../scripts/lib/deployOwnerless");
const CONSTANTS = require("../scripts/lib/constants");

const FLOOR = 1_000_000_000n;
const MIN_RUNWAY = 7_000_000n;
const PENNY = 10_000n;

describe("Versus frozen production configuration rehearsal", function () {
  it("binds the reviewed Base dependencies and immutable economics", async function () {
    expect(CONSTANTS.GRADUATION_FLOOR).to.equal(FLOOR);
    expect(CONSTANTS.PROTOCOL_TRANCHE_BPS).to.equal(1000);
    expect(CONSTANTS.PENNY).to.equal(PENNY);
    expect(CONSTANTS.base.chainId).to.equal(8453);
    expect(CONSTANTS.base.usdc).to.equal("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(CONSTANTS.base.uniswapV2Factory).to.equal("0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6");
    expect(CONSTANTS.base.uniswapV2Router).to.equal("0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24");
  });

  it("rehearses the exact floor from bootstrap through transfer-restricted withdrawal", async function () {
    const [protocol, alice, bob, buyer] = await ethers.getSigners();
    const stack = await deployLocalStack(ethers, {
      protocolRecipient: protocol.address,
      graduationFloor: FLOOR,
    });
    const { usdc, v2Router, agents, arena, syndicate, treasury, graduation } = stack;

    expect(await agents.bootstrapped()).to.equal(true);
    expect(await syndicate.bootstrapped()).to.equal(true);
    expect(await treasury.bootstrapped()).to.equal(true);
    expect(await syndicate.graduationFloor()).to.equal(FLOOR);
    expect(await arena.MIN_RUNWAY()).to.equal(MIN_RUNWAY);
    expect(await treasury.PROTOCOL_TRANCHE_BPS()).to.equal(1000n);
    await expect(
      agents.bootstrap(await arena.getAddress(), await treasury.getAddress(), await stack.missionEscrow.getAddress())
    ).to.be.revertedWithCustomError(agents, "AlreadyBootstrapped");
    await expect(
      syndicate.bootstrap(await arena.getAddress(), await graduation.getAddress())
    ).to.be.revertedWithCustomError(syndicate, "AlreadyBootstrapped");
    await expect(
      treasury.bootstrap(await arena.getAddress(), await agents.getAddress())
    ).to.be.revertedWithCustomError(treasury, "AlreadyBootstrapped");

    await usdc.mint(alice.address, MIN_RUNWAY);
    await usdc.connect(alice).approve(await arena.getAddress(), MIN_RUNWAY);
    await arena.connect(alice).hatch(MIN_RUNWAY);
    await arena.connect(alice).commit(1);
    await arena.connect(alice).rainFromRunway(1, 100);

    const replenishment = 1_000_000n;
    await usdc.mint(bob.address, replenishment);
    await usdc.connect(bob).approve(await arena.getAddress(), replenishment);
    await arena.connect(bob).replenishRunway(1, replenishment);

    const classId = await syndicate.currentClassId();
    const signalRoot = ethers.id("production rehearsal typed signal batch");
    await arena.connect(alice).settleSignalBatchFromRunway(
      1,
      classId,
      signalRoot,
      [1, 0, 1, 0, 0, 0, 0, 0]
    );
    expect(await arena.settledSignalBatches(1, signalRoot)).to.equal(true);
    expect(await treasury.tickets(1)).to.equal(105n);
    const alreadyCommitted = await syndicate.commitOf(classId, 1);
    const remainder = FLOOR - alreadyCommitted;

    const arenaAddress = await arena.getAddress();
    await network.provider.send("hardhat_setBalance", [arenaAddress, "0x56BC75E2D63100000"]);
    await network.provider.send("hardhat_impersonateAccount", [arenaAddress]);
    const arenaSigner = await ethers.getSigner(arenaAddress);
    await usdc.mint(arenaAddress, remainder);
    await usdc.connect(arenaSigner).transfer(await syndicate.getAddress(), remainder);
    await syndicate.connect(arenaSigner).receiveCommit(1, await arena.currentDay(), remainder);
    await network.provider.send("hardhat_stopImpersonatingAccount", [arenaAddress]);

    expect((await syndicate.getClass(classId)).totalCommitted).to.equal(FLOOR);
    expect(await syndicate.canGraduate(classId)).to.equal(true);
    await graduation.connect(bob).graduate();

    const [tokenAddress, pairAddress, , seeded, active] = await graduation.getGraduation(classId);
    const token = await ethers.getContractAt("ClassToken", tokenAddress);
    expect(active).to.equal(true);
    expect(seeded).to.equal(FLOOR);
    expect(await usdc.balanceOf(pairAddress)).to.equal(FLOOR);

    const buyAmount = 10_000_000n;
    await usdc.mint(buyer.address, buyAmount);
    await usdc.connect(buyer).approve(await v2Router.getAddress(), buyAmount);
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 600;
    await v2Router.connect(buyer).swapExactTokensForTokensSupportingFeeOnTransferTokens(
      buyAmount, 0, [await usdc.getAddress(), tokenAddress], buyer.address, deadline
    );
    const bought = await token.balanceOf(buyer.address);
    await token.connect(buyer).approve(await v2Router.getAddress(), bought);
    await v2Router.connect(buyer).swapExactTokensForTokensSupportingFeeOnTransferTokens(
      bought / 2n, 0, [tokenAddress, await usdc.getAddress()], buyer.address, deadline
    );

    expect(await treasury.claimable(1)).to.be.gt(0n);
    await treasury.connect(bob).claim(1);
    const reward = (await agents.getAgent(1)).vault;
    expect(reward).to.be.gt(0n);
    await agents.connect(alice).withdraw(1, reward / 2n);

    await agents.connect(alice).transferFrom(alice.address, bob.address, 1);
    await expect(agents.connect(alice).withdraw(1, 1)).to.be.revertedWithCustomError(agents, "NotAgentOwner");
    await agents.connect(bob).withdraw(1, (await agents.getAgent(1)).vault);
    expect((await agents.getAgent(1)).vault).to.equal(0n);
  });
});
