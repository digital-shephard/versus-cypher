const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { deployLocalStack } = require("../scripts/lib/deployOwnerless");

const PENNY = 10_000n;
const MIN_RUNWAY = 7_000_000n;
const TEST_FLOOR = 30_000n;
const REFERRAL_REWARD = 1_000_000n;

async function fundAndApprove(usdc, arena, signers, amount = ethers.parseUnits("100", 6)) {
  for (const who of signers) {
    await usdc.mint(who.address, amount);
    await usdc.connect(who).approve(await arena.getAddress(), ethers.MaxUint256);
  }
}

async function aggregateClaimable(treasury, agentIds) {
  let total = 0n;
  for (const id of agentIds) total += await treasury.claimable(id);
  return total;
}

describe("audit action plan regressions", function () {
  describe("A1 reward-remainder solvency", function () {
    it("keeps micro-deposit liabilities solvent and conserves every claim order", async function () {
      const [deployer, a, b, c] = await ethers.getSigners();
      const { usdc, agents, arena, treasury } = await deployLocalStack(ethers, {
        protocolRecipient: deployer.address,
        graduationFloor: TEST_FLOOR,
      });
      await fundAndApprove(usdc, arena, [a, b, c]);
      await arena.connect(a).hatch(MIN_RUNWAY);
      await arena.connect(b).hatch(MIN_RUNWAY);
      await arena.connect(c).hatch(MIN_RUNWAY);
      await arena.connect(a).commit(1);
      await arena.connect(b).commit(2);
      await arena.connect(c).commit(3);

      await usdc.mint(deployer.address, 100n);
      await usdc.approve(await treasury.getAddress(), ethers.MaxUint256);
      for (let i = 0; i < 40; i += 1) {
        await treasury.depositFees(1n);
        const pot = await treasury.tranchePot();
        const claimable = await aggregateClaimable(treasury, [1, 2, 3]);
        expect(claimable).to.be.lte(pot);
        expect(await usdc.balanceOf(await treasury.getAddress())).to.be.gte(pot);
      }

      const orderings = [
        [1, 2, 3],
        [3, 1, 2],
        [2, 3, 1],
      ];
      for (const order of orderings) {
        const snapshot = await ethers.provider.send("evm_snapshot");
        const initialPot = await treasury.tranchePot();
        const initialTreasuryBalance = await usdc.balanceOf(await treasury.getAddress());
        let expectedPaid = 0n;
        let vaultPaid = 0n;
        for (const agentId of order) {
          const amount = await treasury.claimable(agentId);
          if (amount === 0n) continue;
          const potBefore = await treasury.tranchePot();
          const expected = amount < potBefore ? amount : potBefore;
          const vaultBefore = (await agents.getAgent(agentId)).vault;
          await expect(treasury.claim(agentId))
            .to.emit(treasury, "Claimed")
            .withArgs(agentId, expected);
          const vaultAfter = (await agents.getAgent(agentId)).vault;
          expect(vaultAfter - vaultBefore).to.equal(expected);
          expectedPaid += expected;
          vaultPaid += vaultAfter - vaultBefore;
        }
        const remaining = await aggregateClaimable(treasury, [1, 2, 3]);
        const pot = await treasury.tranchePot();
        const treasuryBalance = await usdc.balanceOf(await treasury.getAddress());
        expect(remaining).to.equal(0n);
        expect(expectedPaid).to.equal(vaultPaid);
        expect(initialTreasuryBalance - treasuryBalance).to.equal(expectedPaid);
        expect(pot).to.equal(initialPot - expectedPaid);
        expect(await usdc.balanceOf(await treasury.getAddress())).to.be.gte(pot);
        await ethers.provider.send("evm_revert", [snapshot]);
      }
    });

    it("indexes fees deposited before the first ticket exactly once", async function () {
      const [deployer, alice] = await ethers.getSigners();
      const { usdc, arena, treasury } = await deployLocalStack(ethers, {
        protocolRecipient: deployer.address,
        graduationFloor: TEST_FLOOR,
      });
      await fundAndApprove(usdc, arena, [alice]);

      const fees = 1_000_000n; // 1 USDC
      await usdc.mint(deployer.address, fees);
      await usdc.approve(await treasury.getAddress(), fees);
      await treasury.depositFees(fees);

      const agentPot = fees - (fees * 1000n) / 10000n;
      expect(await treasury.rewardRemainder()).to.equal(agentPot);
      expect(await treasury.tranchePot()).to.equal(agentPot);
      expect(await treasury.totalTickets()).to.equal(0n);

      await arena.connect(alice).hatch(MIN_RUNWAY);
      await arena.connect(alice).commit(1);

      expect(await treasury.rewardRemainder()).to.equal(0n);
      expect(await treasury.claimable(1)).to.equal(agentPot);
      expect(await treasury.tranchePot()).to.equal(agentPot);
      await treasury.claim(1);
      expect(await treasury.claimable(1)).to.equal(0n);
      expect(await treasury.tranchePot()).to.equal(0n);
    });
  });

  describe("A2 referral ownership after safe-mint transfer", function () {
    it("rejects referral when the receiver transfers the NFT to the referrer owner", async function () {
      const [deployer, alice] = await ethers.getSigners();
      const { usdc, agents, arena, referralPool } = await deployLocalStack(ethers, {
        protocolRecipient: deployer.address,
        graduationFloor: TEST_FLOOR,
        referralReward: REFERRAL_REWARD,
      });
      await fundAndApprove(usdc, arena, [alice]);
      await arena.connect(alice).hatch(MIN_RUNWAY);
      await usdc.connect(alice).approve(await referralPool.getAddress(), REFERRAL_REWARD);
      await referralPool.connect(alice).fund(1, ethers.id("fund"), REFERRAL_REWARD);

      const Hatcher = await ethers.getContractFactory("ReferralTransferHatcher");
      const hatcher = await Hatcher.deploy(
        await usdc.getAddress(),
        await arena.getAddress(),
        await agents.getAddress(),
        alice.address
      );
      await usdc.mint(await hatcher.getAddress(), MIN_RUNWAY);

      await expect(hatcher.hatch(MIN_RUNWAY, 1))
        .to.emit(arena, "Hatched")
        .withArgs(2, alice.address, anyValue, MIN_RUNWAY)
        .and
        .to.emit(arena, "ReferralAttempted")
        .withArgs(2, 1, false, 0);

      expect(await agents.ownerOf(2)).to.equal(alice.address);
      expect(await referralPool.referredBy(2)).to.equal(0n);
      expect(await referralPool.totalPaid()).to.equal(0n);
      expect((await agents.getAgent(1)).vault).to.equal(0n);
    });
  });

  describe("A3 bootstrap activation order", function () {
    it("cannot hatch until AgentNFT is bootstrapped last among Arena dependencies", async function () {
      const [deployer, alice, bob] = await ethers.getSigners();
      const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
      const factory = await (await ethers.getContractFactory("MockUniswapV2Factory")).deploy();
      const router = await (await ethers.getContractFactory("MockUniswapV2Router")).deploy(await factory.getAddress());

      const agents = await (await ethers.getContractFactory("AgentNFT")).deploy(await usdc.getAddress());
      const syndicate = await (await ethers.getContractFactory("SyndicateEngine")).deploy(await usdc.getAddress(), TEST_FLOOR);
      const treasury = await (await ethers.getContractFactory("TrancheTreasury")).deploy(await usdc.getAddress(), deployer.address);
      const missionEscrow = await (await ethers.getContractFactory("MissionEscrow")).deploy(
        await usdc.getAddress(),
        await agents.getAddress()
      );
      const referralPool = await (await ethers.getContractFactory("ReferralPool")).deploy(
        await usdc.getAddress(),
        await agents.getAddress(),
        REFERRAL_REWARD
      );
      const arena = await (await ethers.getContractFactory("Arena")).deploy(
        await usdc.getAddress(),
        await agents.getAddress(),
        await syndicate.getAddress(),
        await treasury.getAddress(),
        await referralPool.getAddress()
      );
      const graduation = await (await ethers.getContractFactory("GraduationModule")).deploy(
        await usdc.getAddress(),
        await router.getAddress(),
        await syndicate.getAddress(),
        await treasury.getAddress()
      );

      await usdc.mint(alice.address, MIN_RUNWAY);
      await usdc.mint(bob.address, MIN_RUNWAY);
      await usdc.connect(alice).approve(await arena.getAddress(), ethers.MaxUint256);
      await usdc.connect(bob).approve(await arena.getAddress(), ethers.MaxUint256);

      await expect(arena.connect(alice).hatch(MIN_RUNWAY)).to.be.reverted;

      await syndicate.bootstrap(await arena.getAddress(), await graduation.getAddress());
      await treasury.bootstrap(await arena.getAddress(), await agents.getAddress());
      await referralPool.bootstrap(await arena.getAddress());
      await expect(arena.connect(alice).hatch(MIN_RUNWAY)).to.be.reverted;

      await agents.bootstrap(
        await arena.getAddress(),
        await treasury.getAddress(),
        await missionEscrow.getAddress(),
        await referralPool.getAddress()
      );

      await arena.connect(alice).hatch(MIN_RUNWAY);
      // Attribution records even when the pool cannot pay yet.
      await expect(arena.connect(bob)["hatch(uint256,uint256)"](MIN_RUNWAY, 1))
        .to.emit(arena, "ReferralAttempted")
        .withArgs(2, 1, true, 0)
        .and.to.emit(referralPool, "ReferralRewardSkipped");
      expect(await referralPool.referredBy(2)).to.equal(1n);
      expect(await referralPool.totalPaid()).to.equal(0n);
    });
  });

  describe("C missing regressions", function () {
    it("removes vault pulls and rejects unauthorized graduation, ticket, referral, and tax calls", async function () {
      const [deployer, alice, bob] = await ethers.getSigners();
      const { usdc, agents, arena, syndicate, treasury, referralPool, graduation } = await deployLocalStack(ethers, {
        protocolRecipient: deployer.address,
        graduationFloor: TEST_FLOOR,
      });
      await fundAndApprove(usdc, arena, [alice]);
      await arena.connect(alice).hatch(MIN_RUNWAY);
      await usdc.connect(alice).approve(await agents.getAddress(), ethers.MaxUint256);
      await agents.connect(alice).deposit(1, PENNY);

      expect(agents.interface.hasFunction("pullFromVault(uint256,uint256)")).to.equal(false);
      await expect(syndicate.connect(bob).pullClassFunds(1)).to.be.revertedWithCustomError(syndicate, "NotGraduation");
      await expect(syndicate.connect(alice).markGraduated(1, alice.address, bob.address, 1n))
        .to.be.revertedWithCustomError(syndicate, "NotGraduation");
      await expect(treasury.connect(bob).awardTickets(1, 1)).to.be.revertedWithCustomError(treasury, "NotArena");
      await expect(treasury.connect(bob).awardCommitTicket(1)).to.be.revertedWithCustomError(treasury, "NotArena");
      await expect(referralPool.connect(bob).recordReferral(2, 1, bob.address))
        .to.be.revertedWithCustomError(referralPool, "NotAuthorized");
      await expect(graduation.connect(bob).swapCollectedTax(1n)).to.be.revertedWithCustomError(graduation, "NotClassToken");
    });

    it("isolates drained Cypher runway from another Cypher's pooled backing", async function () {
      const [deployer, alice, bob] = await ethers.getSigners();
      const { usdc, arena } = await deployLocalStack(ethers, {
        protocolRecipient: deployer.address,
        graduationFloor: TEST_FLOOR,
      });
      await fundAndApprove(usdc, arena, [alice, bob]);
      await arena.connect(alice).hatch(MIN_RUNWAY);
      await arena.connect(bob).hatch(MIN_RUNWAY);

      const alicePennies = MIN_RUNWAY / PENNY;
      await arena.connect(alice).rainFromRunway(1, 100);
      await arena.connect(alice).rainFromRunway(1, 100);
      await arena.connect(alice).rainFromRunway(1, 100);
      await arena.connect(alice).rainFromRunway(1, 100);
      await arena.connect(alice).rainFromRunway(1, 100);
      await arena.connect(alice).rainFromRunway(1, 100);
      await arena.connect(alice).rainFromRunway(1, 100);
      expect(alicePennies).to.equal(700n);
      expect(await arena.runway(1)).to.equal(0n);
      await expect(arena.connect(alice).rainFromRunway(1, 1)).to.be.revertedWithCustomError(arena, "InsufficientRunway");
      expect(await arena.runway(2)).to.equal(MIN_RUNWAY);
      expect(await arena.totalRunwayLiability()).to.equal(MIN_RUNWAY);
      expect(await usdc.balanceOf(await arena.getAddress())).to.equal(MIN_RUNWAY);
    });

    it("rejects nonowner rain, fundReferralPool, and commit without mutating custody", async function () {
      const [deployer, alice, bob] = await ethers.getSigners();
      const { usdc, arena, referralPool, treasury, syndicate } = await deployLocalStack(ethers, {
        protocolRecipient: deployer.address,
        graduationFloor: TEST_FLOOR,
      });
      await fundAndApprove(usdc, arena, [alice]);
      await arena.connect(alice).hatch(MIN_RUNWAY);

      const arenaBal = await usdc.balanceOf(await arena.getAddress());
      const runway = await arena.runway(1);
      const tickets = await treasury.tickets(1);
      const committed = (await syndicate.getClass(1)).totalCommitted;
      const proposal = ethers.id("nonowner");

      await expect(arena.connect(bob).rainFromRunway(1, 1)).to.be.revertedWithCustomError(arena, "NotAgentOwner");
      await expect(arena.connect(bob).fundReferralPoolFromRunway(1, proposal))
        .to.be.revertedWithCustomError(arena, "NotAgentOwner");
      await expect(arena.connect(bob).commit(1)).to.be.revertedWithCustomError(arena, "NotAgentOwner");

      expect(await usdc.balanceOf(await arena.getAddress())).to.equal(arenaBal);
      expect(await arena.runway(1)).to.equal(runway);
      expect(await treasury.tickets(1)).to.equal(tickets);
      expect((await syndicate.getClass(1)).totalCommitted).to.equal(committed);
      expect(await usdc.balanceOf(await referralPool.getAddress())).to.equal(0n);
    });

    it("keeps all LP tokens with GraduationModule after graduation", async function () {
      const [deployer, alice, caller] = await ethers.getSigners();
      const { usdc, arena, syndicate, graduation } = await deployLocalStack(ethers, {
        protocolRecipient: deployer.address,
        graduationFloor: PENNY,
      });
      await fundAndApprove(usdc, arena, [alice]);
      await arena.connect(alice).hatch(MIN_RUNWAY);
      await arena.connect(alice).commit(1);
      const classId = await syndicate.currentClassId();
      await graduation.connect(caller).graduate();
      const [, pairAddr, liquidity] = await graduation.getGraduation(classId);
      const pair = await ethers.getContractAt("MockUniswapV2Pair", pairAddr);
      expect(liquidity).to.be.gt(0n);
      expect(await pair.balanceOf(await graduation.getAddress())).to.equal(liquidity);
      expect(await pair.balanceOf(caller.address)).to.equal(0n);
      expect(await pair.balanceOf(alice.address)).to.equal(0n);
    });

    it("uses a 99% quote floor for tax swaps and has no harvestTax selector", async function () {
      const [deployer, alice, buyer] = await ethers.getSigners();
      const { usdc, v2Router, arena, syndicate, graduation } = await deployLocalStack(ethers, {
        protocolRecipient: deployer.address,
        graduationFloor: PENNY,
      });
      expect(graduation.interface.hasFunction("harvestTax")).to.equal(false);
      expect(await graduation.TAX_SWAP_MIN_BPS()).to.equal(9900n);

      await fundAndApprove(usdc, arena, [alice]);
      await arena.connect(alice).hatch(MIN_RUNWAY);
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

      const sellAmount = (await token.balanceOf(buyer.address)) / 10n;
      const sellTax = sellAmount / 100n;
      const swapIn = sellTax * 2n;
      const quoted = await v2Router.getAmountsOut(swapIn, [tokenAddr, await usdc.getAddress()]);
      const expectedMin = (quoted[1] * 9900n) / 10000n;

      await token.connect(buyer).approve(await v2Router.getAddress(), ethers.MaxUint256);
      await v2Router.connect(buyer).swapExactTokensForTokensSupportingFeeOnTransferTokens(
        sellAmount, 0, [tokenAddr, await usdc.getAddress()], buyer.address,
        (await ethers.provider.getBlock("latest")).timestamp + 600
      );
      expect(await v2Router.lastSwapAmountIn()).to.equal(swapIn);
      expect(await v2Router.lastSwapAmountOutMin()).to.equal(expectedMin === 0n ? 1n : expectedMin);
    });

    it("graduates two full classes with distinct tokens and preserved prior state", async function () {
      const [deployer, alice] = await ethers.getSigners();
      const { usdc, arena, syndicate, graduation } = await deployLocalStack(ethers, {
        protocolRecipient: deployer.address,
        graduationFloor: PENNY,
      });
      await fundAndApprove(usdc, arena, [alice], ethers.parseUnits("50", 6));

      await arena.connect(alice).hatch(MIN_RUNWAY);
      await arena.connect(alice).commit(1);
      expect(await syndicate.currentClassId()).to.equal(1n);
      await graduation.graduate();
      const g1 = await graduation.getGraduation(1);
      expect(await ethers.getContractAt("ClassToken", g1.token).then((t) => t.symbol())).to.equal("VRS0");
      expect(await syndicate.currentClassId()).to.equal(2n);

      await ethers.provider.send("evm_increaseTime", [86400]);
      await ethers.provider.send("evm_mine");
      await arena.connect(alice).commit(1);
      await graduation.graduate();
      const g2 = await graduation.getGraduation(2);
      expect(await ethers.getContractAt("ClassToken", g2.token).then((t) => t.symbol())).to.equal("VRS1");
      expect(g1.token).to.not.equal(g2.token);
      expect(g1.pair).to.not.equal(g2.pair);

      const class1 = await syndicate.getClass(1);
      const [token1, pair1] = await syndicate.getGraduationInfo(1);
      expect(class1.graduated).to.equal(true);
      expect(token1).to.equal(g1.token);
      expect(pair1).to.equal(g1.pair);
      expect(await syndicate.currentClassId()).to.equal(3n);
    });

    it("does not tax ordinary wallet-to-wallet class token transfers", async function () {
      const [deployer, alice, buyer, friend] = await ethers.getSigners();
      const { usdc, v2Router, arena, syndicate, graduation } = await deployLocalStack(ethers, {
        protocolRecipient: deployer.address,
        graduationFloor: PENNY,
      });
      await fundAndApprove(usdc, arena, [alice]);
      await arena.connect(alice).hatch(MIN_RUNWAY);
      await arena.connect(alice).commit(1);
      await graduation.graduate();
      const [tokenAddr] = await graduation.getGraduation((await syndicate.currentClassId()) - 1n);
      const token = await ethers.getContractAt("ClassToken", tokenAddr);

      await usdc.mint(buyer.address, PENNY);
      await usdc.connect(buyer).approve(await v2Router.getAddress(), ethers.MaxUint256);
      await v2Router.connect(buyer).swapExactTokensForTokensSupportingFeeOnTransferTokens(
        PENNY, 0, [await usdc.getAddress(), tokenAddr], buyer.address,
        (await ethers.provider.getBlock("latest")).timestamp + 600
      );

      const bankBefore = await token.balanceOf(await graduation.getAddress());
      const held = await token.balanceOf(buyer.address);
      const send = held / 4n;
      await token.connect(buyer).transfer(friend.address, send);
      expect(await token.balanceOf(friend.address)).to.equal(send);
      expect(await token.balanceOf(buyer.address)).to.equal(held - send);
      expect(await token.balanceOf(await graduation.getAddress())).to.equal(bankBefore);
    });

    it("charges exactly 15 pennies for one of each typed signal", async function () {
      const [deployer, alice] = await ethers.getSigners();
      const { usdc, arena, syndicate, treasury } = await deployLocalStack(ethers, {
        protocolRecipient: deployer.address,
        graduationFloor: TEST_FLOOR,
      });
      await fundAndApprove(usdc, arena, [alice]);
      await arena.connect(alice).hatch(MIN_RUNWAY);
      const classId = await syndicate.currentClassId();
      const typeCounts = [1, 1, 1, 1, 1, 1, 1, 1];
      // prices: 1+1+3+1+1+1+5+2 = 15
      const batchRoot = ethers.id("all eight typed signals");
      const typeCountsHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["uint16[8]"], [typeCounts])
      );

      await expect(arena.connect(alice).settleSignalBatchFromRunway(1, classId, batchRoot, typeCounts))
        .to.emit(arena, "SignalBatchSettled")
        .withArgs(1, classId, batchRoot, 8, 15, PENNY * 15n, PENNY * 15n, typeCountsHash);

      expect(await arena.runway(1)).to.equal(MIN_RUNWAY - PENNY * 15n);
      expect(await treasury.tickets(1)).to.equal(15n);
      expect(await syndicate.commitOf(classId, 1)).to.equal(PENNY * 15n);
    });
  });
});
