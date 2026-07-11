const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployLocalStack } = require("../scripts/lib/deployOwnerless");

const MIN_RUNWAY = 7_000_000n;
const PENNY = 10_000n;
const TEST_FLOOR = 30_000n;

describe("Versus Uniswap graduation E2E (ownerless)", function () {
  it("graduates at floor and makes the seller atomically swap tax into rolling rewards", async function () {
    const [deployer, alice, bob, humanBuyer] = await ethers.getSigners();
    const { usdc, v2Router, agents, arena, syndicate, treasury, graduation } = await deployLocalStack(ethers, {
      protocolRecipient: deployer.address,
      graduationFloor: TEST_FLOOR,
    });

    for (const who of [alice, bob]) {
      await usdc.mint(who.address, ethers.parseUnits("10", 6));
      await usdc.connect(who).approve(await arena.getAddress(), ethers.MaxUint256);
    }
    await arena.connect(alice).hatch(0, MIN_RUNWAY);
    await arena.connect(bob).hatch(1, MIN_RUNWAY);
    await arena.connect(alice).commit(1);
    await arena.connect(bob).commit(2);
    await ethers.provider.send("evm_increaseTime", [86400]);
    await ethers.provider.send("evm_mine");
    await arena.connect(alice).commit(1);

    const classId = await syndicate.currentClassId();
    expect(await syndicate.canGraduate(classId)).to.equal(true);
    expect(await graduation.tokenNameForClass(classId)).to.equal("Versus Token 0");
    expect(await graduation.tokenSymbolForClass(classId)).to.equal("VRS0");
    await graduation.connect(bob).graduate();
    await expect(graduation.graduateClass(classId)).to.be.revertedWithCustomError(graduation, "AlreadyGraduated");

    const [tokenAddr, pairAddr, , usdcSeeded, active] = await graduation.getGraduation(classId);
    const classToken = await ethers.getContractAt("ClassToken", tokenAddr);
    expect(active).to.equal(true);
    expect(usdcSeeded).to.equal(PENNY * 3n);
    expect(await usdc.balanceOf(pairAddr)).to.equal(PENNY * 3n);
    expect(await classToken.name()).to.equal("Versus Token 0");
    expect(await classToken.symbol()).to.equal("VRS0");
    expect(await classToken.totalSupply()).to.equal(ethers.parseEther("1000000000"));
    expect(await classToken.balanceOf(await graduation.DEAD())).to.equal(ethers.parseEther("500000000"));
    expect(await classToken.tradingEnabled()).to.equal(true);
    expect(await graduation.classIdForToken(tokenAddr)).to.equal(classId);

    const buyUsdc = ethers.parseUnits("0.01", 6);
    await usdc.mint(humanBuyer.address, buyUsdc);
    await usdc.connect(humanBuyer).approve(await v2Router.getAddress(), ethers.MaxUint256);
    await v2Router.connect(humanBuyer).swapExactTokensForTokensSupportingFeeOnTransferTokens(
      buyUsdc, 0, [await usdc.getAddress(), tokenAddr], humanBuyer.address,
      (await ethers.provider.getBlock("latest")).timestamp + 600
    );

    const accumulatedBuyTax = await classToken.balanceOf(await graduation.getAddress());
    expect(accumulatedBuyTax).to.be.gt(0n);
    expect(await treasury.tranchePot()).to.equal(0n);

    const humanTokens = await classToken.balanceOf(humanBuyer.address);
    await classToken.connect(humanBuyer).approve(await v2Router.getAddress(), ethers.MaxUint256);
    const protocolBefore = await usdc.balanceOf(deployer.address);
    const sell = await v2Router.connect(humanBuyer).swapExactTokensForTokensSupportingFeeOnTransferTokens(
      humanTokens / 2n, 0, [tokenAddr, await usdc.getAddress()], humanBuyer.address,
      (await ethers.provider.getBlock("latest")).timestamp + 600
    );
    const sellReceipt = await sell.wait();

    expect(await classToken.balanceOf(await graduation.getAddress())).to.equal(0n);
    expect(await treasury.tranchePot()).to.be.gt(0n);
    expect(await treasury.claimable(1)).to.be.gt(0n);
    expect(await treasury.claimable(2)).to.be.gt(0n);
    expect(await usdc.balanceOf(deployer.address)).to.be.gt(protocolBefore);

    const taxSwaps = sellReceipt.logs.flatMap((log) => {
      try { return [graduation.interface.parseLog(log)]; } catch (_) { return []; }
    }).filter((event) => event?.name === "TaxHarvested");
    expect(taxSwaps).to.have.length(1);
    expect(taxSwaps[0].args.tokenTax).to.be.gt(accumulatedBuyTax);
    expect(taxSwaps[0].args.usdcOut).to.be.gt(0n);

    await treasury.claim(1);
    await treasury.claim(2);
    expect((await agents.getAgent(1)).vault).to.be.gt(0n);
    expect((await agents.getAgent(2)).vault).to.be.gt(0n);

    // A microscopic sell whose tax quotes to zero must remain sellable; its dust banks for later.
    await expect(classToken.connect(humanBuyer).transfer(pairAddr, 100n)).to.not.be.reverted;
    expect(await classToken.balanceOf(await graduation.getAddress())).to.equal(1n);
  });

  it("keeps permissionless harvest as a fallback when buys accumulate without a sell", async function () {
    const [deployer, alice, buyer] = await ethers.getSigners();
    const { usdc, v2Router, arena, syndicate, treasury, graduation } = await deployLocalStack(ethers, {
      protocolRecipient: deployer.address,
      graduationFloor: PENNY,
    });
    await usdc.mint(alice.address, MIN_RUNWAY);
    await usdc.connect(alice).approve(await arena.getAddress(), ethers.MaxUint256);
    await arena.connect(alice).hatch(0, MIN_RUNWAY);
    await arena.connect(alice).commit(1);
    const classId = await syndicate.currentClassId();
    await graduation.graduate();
    const [tokenAddr] = await graduation.getGraduation(classId);
    const token = await ethers.getContractAt("ClassToken", tokenAddr);

    await usdc.mint(buyer.address, PENNY);
    await usdc.connect(buyer).approve(await v2Router.getAddress(), ethers.MaxUint256);
    await v2Router.connect(buyer).swapExactTokensForTokensSupportingFeeOnTransferTokens(
      PENNY, 0, [await usdc.getAddress(), tokenAddr], buyer.address,
      (await ethers.provider.getBlock("latest")).timestamp + 600
    );
    expect(await token.balanceOf(await graduation.getAddress())).to.be.gt(0n);

    await graduation.harvestTax(classId);
    expect(await token.balanceOf(await graduation.getAddress())).to.equal(0n);
    expect(await treasury.claimable(1)).to.be.gt(0n);
  });

  it("refuses to graduate below the floor", async function () {
    const [, alice] = await ethers.getSigners();
    const { usdc, arena, syndicate, graduation } = await deployLocalStack(ethers, {
      graduationFloor: TEST_FLOOR,
    });
    await usdc.mint(alice.address, MIN_RUNWAY);
    await usdc.connect(alice).approve(await arena.getAddress(), ethers.MaxUint256);
    await arena.connect(alice).hatch(0, MIN_RUNWAY);
    await arena.connect(alice).commit(1);

    const classId = await syndicate.currentClassId();
    expect(await syndicate.canGraduate(classId)).to.equal(false);
    await expect(graduation.graduate()).to.be.revertedWithCustomError(graduation, "NotReady");
  });
});
