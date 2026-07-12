const { expect } = require("chai");
const fs = require("fs");
const { ethers, network } = require("hardhat");
const { deployOwnerlessVersus } = require("../scripts/lib/deployOwnerless");
const CONSTANTS = require("../scripts/lib/constants");

const WETH = "0x4200000000000000000000000000000000000006";
const SAFE = "0x93645ce5BCF0009026D8100aea5901cDd52217bF";
const FLOOR = 1_000_000_000n;
const MIN_RUNWAY = 7_000_000n;

describe("Versus Base mainnet fork rehearsal", function () {
  before(function () {
    if (network.name !== "baseFork") this.skip();
  });

  it("runs the exact ownerless lifecycle against canonical Base dependencies", async function () {
    this.timeout(120_000);
    const [deployer] = await ethers.getSigners();
    const alice = ethers.Wallet.createRandom().connect(ethers.provider);
    const bob = ethers.Wallet.createRandom().connect(ethers.provider);
    const buyer = ethers.Wallet.createRandom().connect(ethers.provider);
    for (const wallet of [alice, bob, buyer]) {
      await (await deployer.sendTransaction({ to: wallet.address, value: ethers.parseEther("10") })).wait();
      expect(await ethers.provider.getCode(wallet.address)).to.equal("0x");
    }
    const usdc = await ethers.getContractAt("IERC20", CONSTANTS.base.usdc);
    const factory = new ethers.Contract(
      CONSTANTS.base.uniswapV2Factory,
      ["function getPair(address,address) view returns (address)"],
      ethers.provider
    );
    const fundingPair = await factory.getPair(CONSTANTS.base.usdc, WETH);
    expect(fundingPair).to.not.equal(ethers.ZeroAddress);
    await network.provider.send("anvil_setBalance", [fundingPair, "0x56BC75E2D63100000"]);
    await network.provider.send("anvil_impersonateAccount", [fundingPair]);
    const funder = await ethers.getSigner(fundingPair);

    const stack = await deployOwnerlessVersus(ethers, {
      usdcAddress: CONSTANTS.base.usdc,
      routerAddress: CONSTANTS.base.uniswapV2Router,
      protocolRecipient: SAFE,
      graduationFloor: FLOOR,
    });
    const { agents, arena, syndicate, treasury, graduation } = stack;

    await (await usdc.connect(funder).transfer(alice.address, MIN_RUNWAY)).wait();
    await (await usdc.connect(funder).transfer(bob.address, 1_000_000n)).wait();
    await (await usdc.connect(funder).transfer(buyer.address, 10_000_000n)).wait();
    expect(await usdc.balanceOf(alice.address)).to.equal(MIN_RUNWAY);
    await (await usdc.connect(alice).approve(await arena.getAddress(), MIN_RUNWAY)).wait();
    expect(await usdc.allowance(alice.address, await arena.getAddress())).to.equal(MIN_RUNWAY);
    await (await arena.connect(alice).hatch(0, MIN_RUNWAY)).wait();
    await (await arena.connect(alice).commit(1)).wait();
    await (await arena.connect(alice).rainFromRunway(1, 100)).wait();
    await (await usdc.connect(bob).approve(await arena.getAddress(), 1_000_000n)).wait();
    await (await arena.connect(bob).replenishRunway(1, 1_000_000n)).wait();
    const classId = await syndicate.currentClassId();
    const signalRoot = ethers.id("base fork signal batch");
    await (await arena.connect(alice).settleSignalBatchFromRunway(
      1, classId, signalRoot, [1, 0, 1, 0, 0, 0, 0, 0]
    )).wait();
    expect(await arena.settledSignalBatches(1, signalRoot)).to.equal(true);

    const committed = (await syndicate.getClass(classId)).totalCommitted;
    const remainder = FLOOR - committed;
    const arenaAddress = await arena.getAddress();
    await (await usdc.connect(funder).transfer(arenaAddress, remainder)).wait();
    await network.provider.send("anvil_setBalance", [arenaAddress, "0x56BC75E2D63100000"]);
    await network.provider.send("anvil_impersonateAccount", [arenaAddress]);
    const arenaSigner = await ethers.getSigner(arenaAddress);
    await (await usdc.connect(arenaSigner).transfer(await syndicate.getAddress(), remainder)).wait();
    await (await syndicate.connect(arenaSigner).receiveCommit(1, await arena.currentDay(), remainder)).wait();
    await network.provider.send("anvil_stopImpersonatingAccount", [arenaAddress]);

    expect((await syndicate.getClass(classId)).totalCommitted).to.equal(FLOOR);
    await (await graduation.connect(bob).graduate()).wait();
    const [tokenAddress, pairAddress, , seeded] = await graduation.getGraduation(classId);
    const token = await ethers.getContractAt("ClassToken", tokenAddress);
    expect(await factory.getPair(tokenAddress, CONSTANTS.base.usdc)).to.equal(pairAddress);
    expect(seeded).to.equal(FLOOR);

    const router = new ethers.Contract(
      CONSTANTS.base.uniswapV2Router,
      ["function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)"],
      buyer
    );
    await (await usdc.connect(buyer).approve(CONSTANTS.base.uniswapV2Router, 10_000_000n)).wait();
    let deadline = (await ethers.provider.getBlock("latest")).timestamp + 600;
    await (await router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
      10_000_000n, 0, [CONSTANTS.base.usdc, tokenAddress], buyer.address, deadline,
      { gasLimit: 1_000_000n }
    )).wait();
    const bought = await token.balanceOf(buyer.address);
    await (await token.connect(buyer).approve(CONSTANTS.base.uniswapV2Router, bought)).wait();
    deadline = (await ethers.provider.getBlock("latest")).timestamp + 600;
    await (await router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
      bought / 2n, 0, [tokenAddress, CONSTANTS.base.usdc], buyer.address, deadline,
      { gasLimit: 1_000_000n }
    )).wait();

    expect(await treasury.claimable(1)).to.be.gt(0n);
    await (await treasury.connect(bob).claim(1)).wait();
    const reward = (await agents.getAgent(1)).vault;
    expect(reward).to.be.gt(0n);
    await (await agents.connect(alice).withdraw(1, reward)).wait();
    await (await agents.connect(alice).transferFrom(alice.address, bob.address, 1)).wait();
    await expect(agents.connect(alice).withdraw(1, 1)).to.be.revertedWithCustomError(agents, "NotAgentOwner");

    console.log("      fork block:", process.env.VERSUS_BASE_FORK_BLOCK);
    console.log("      token:", tokenAddress);
    console.log("      pair:", pairAddress);
    console.log("      seeded USDC:", seeded.toString());
    console.log("      claimed vault reward:", reward.toString());
    if (process.env.VERSUS_BASE_FORK_REPORT) {
      const report = {
        kind: "versus-base-mainnet-fork-rehearsal",
        passed: true,
        forkBlock: Number(process.env.VERSUS_BASE_FORK_BLOCK),
        chainId: 8453,
        dependencies: {
          usdc: CONSTANTS.base.usdc,
          factory: CONSTANTS.base.uniswapV2Factory,
          router: CONSTANTS.base.uniswapV2Router,
          weth: WETH,
          protocolRecipient: SAFE,
        },
        contracts: {
          agents: await agents.getAddress(),
          arena: await arena.getAddress(),
          syndicate: await syndicate.getAddress(),
          treasury: await treasury.getAddress(),
          graduation: await graduation.getAddress(),
          token: tokenAddress,
          pair: pairAddress,
        },
        assertions: {
          exactFloorUSDC: seeded.toString(),
          signalSettled: await arena.settledSignalBatches(1, signalRoot),
          nextClassId: (await syndicate.currentClassId()).toString(),
          claimedVaultRewardMicros: reward.toString(),
          finalAgentVaultMicros: (await agents.getAgent(1)).vault.toString(),
          nftOwner: await agents.ownerOf(1),
        },
        completedAt: new Date().toISOString(),
      };
      fs.writeFileSync(process.env.VERSUS_BASE_FORK_REPORT, JSON.stringify(report, null, 2));
    }
    await network.provider.send("anvil_stopImpersonatingAccount", [fundingPair]);
  });
});
