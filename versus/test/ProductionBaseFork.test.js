const { expect } = require("chai");
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { deployOwnerlessVersus } = require("../scripts/lib/deployOwnerless");
const { auditDeployment } = require("../scripts/lib/deployment-audit");
const { inspectBaseProduction } = require("../scripts/lib/base-production");
const { loadBuildFreeze } = require("../scripts/lib/build-freeze");
const {
  MANIFEST_VERSION,
  RELEASE_STAGES,
  collectSourceHashes,
  constructorArguments,
} = require("../scripts/lib/deployment-manifest");
const CONSTANTS = require("../scripts/lib/constants");

const WETH = "0x4200000000000000000000000000000000000006";
const SAFE = CONSTANTS.base.protocolRecipient;
const FLOOR = 1_000_000_000n;
const MIN_RUNWAY = 7_000_000n;
const REFERRAL_REWARD = 1_000_000n;
const HATCH_GAS_LIMIT = 500_000n;

describe("Versus Base mainnet fork rehearsal", function () {
  before(function () {
    if (network.name !== "baseFork") this.skip();
  });

  it("runs the exact ownerless lifecycle against canonical Base dependencies", async function () {
    this.timeout(120_000);
    const [deployer] = await ethers.getSigners();
    const alice = ethers.Wallet.createRandom().connect(ethers.provider);
    const bob = ethers.Wallet.createRandom().connect(ethers.provider);
    const carol = ethers.Wallet.createRandom().connect(ethers.provider);
    const buyer = ethers.Wallet.createRandom().connect(ethers.provider);
    for (const wallet of [alice, bob, carol, buyer]) {
      await (await deployer.sendTransaction({ to: wallet.address, value: ethers.parseEther("10") })).wait();
      expect(await ethers.provider.getCode(wallet.address)).to.equal("0x");
    }
    const usdc = await ethers.getContractAt("IERC20", CONSTANTS.base.usdc);
    const factory = new ethers.Contract(
      CONSTANTS.base.uniswapV2Factory,
      [
        "function getPair(address,address) view returns (address)",
        "function createPair(address,address) returns (address)",
      ],
      ethers.provider
    );
    const fundingPair = await factory.getPair(CONSTANTS.base.usdc, WETH);
    expect(fundingPair).to.not.equal(ethers.ZeroAddress);
    const productionPreflight = await inspectBaseProduction({
      provider: ethers.provider,
      protocolRecipient: SAFE,
      releaseStage: RELEASE_STAGES.CLOSED_COHORT,
      env: {},
    });
    expect(productionPreflight).to.include({
      chainId: 8453,
      usdc: ethers.getAddress(CONSTANTS.base.usdc),
      factory: ethers.getAddress(CONSTANTS.base.uniswapV2Factory),
      router: ethers.getAddress(CONSTANTS.base.uniswapV2Router),
    });
    await network.provider.send("anvil_setBalance", [fundingPair, "0x56BC75E2D63100000"]);
    await network.provider.send("anvil_impersonateAccount", [fundingPair]);
    const funder = await ethers.getSigner(fundingPair);

    const stack = await deployOwnerlessVersus(ethers, {
      usdcAddress: CONSTANTS.base.usdc,
      routerAddress: CONSTANTS.base.uniswapV2Router,
      protocolRecipient: SAFE,
      graduationFloor: FLOOR,
      referralReward: REFERRAL_REWARD,
    });
    const { agents, arena, syndicate, treasury, referralPool, graduation } = stack;
    const graduationAddress = await graduation.getAddress();
    const createNonce = await ethers.provider.getTransactionCount(graduationAddress);
    const predictedToken = ethers.getCreateAddress({ from: graduationAddress, nonce: createNonce });
    await (await factory.connect(deployer).createPair(predictedToken, CONSTANTS.base.usdc)).wait();
    const precreatedPair = await factory.getPair(predictedToken, CONSTANTS.base.usdc);
    const pairBeforeGraduation = new ethers.Contract(
      precreatedPair,
      [
        "function sync()",
        "function totalSupply() view returns (uint256)",
        "function getReserves() view returns (uint112,uint112,uint32)",
      ],
      deployer
    );
    await (await usdc.connect(funder).transfer(precreatedPair, 1n)).wait();
    await expect(pairBeforeGraduation.sync()).to.be.reverted;
    expect(await pairBeforeGraduation.totalSupply()).to.equal(0n);
    const poisonedReserves = await pairBeforeGraduation.getReserves();
    expect(poisonedReserves[0]).to.equal(0n);
    expect(poisonedReserves[1]).to.equal(0n);

    const deployedContracts = {
      usdc: CONSTANTS.base.usdc,
      v2Factory: CONSTANTS.base.uniswapV2Factory,
      v2Router: CONSTANTS.base.uniswapV2Router,
      agents: await agents.getAddress(),
      arena: await arena.getAddress(),
      syndicate: await syndicate.getAddress(),
      treasury: await treasury.getAddress(),
      missionEscrow: await stack.missionEscrow.getAddress(),
      referralPool: await referralPool.getAddress(),
      graduation: await graduation.getAddress(),
    };
    const runtimeBytecode = {};
    for (const [label, address] of Object.entries(deployedContracts)) {
      const code = await ethers.provider.getCode(address);
      runtimeBytecode[label] = { address, bytes: (code.length - 2) / 2, keccak256: ethers.keccak256(code) };
    }
    const projectRoot = path.join(__dirname, "..");
    const freeze = loadBuildFreeze(projectRoot);
    const sourceInventory = collectSourceHashes(projectRoot);
    const deploymentAudit = await auditDeployment(ethers.provider, {
      manifestVersion: MANIFEST_VERSION,
      protocol: "versus-cypher",
      network: "base",
      chainId: 8453,
      releaseStage: RELEASE_STAGES.CLOSED_COHORT,
      source: {
        repository: "digital-shephard/versus-cypher",
        commit: "a".repeat(40),
        clean: true,
        ...sourceInventory,
      },
      contracts: deployedContracts,
      constructorArguments: constructorArguments(deployedContracts, FLOOR, SAFE, REFERRAL_REWARD),
      economics: {
        protocolRecipient: SAFE,
        graduationFloorRaw: FLOOR.toString(),
        referralRewardRaw: REFERRAL_REWARD.toString(),
        protocolTrancheBps: 1000,
      },
      compiler: {
        solidity: "0.8.26",
        optimizer: { enabled: true, runs: 1 },
        viaIR: true,
        evmVersion: "cancun",
        compilerInputSha256: freeze.compilerInputSha256,
        creationBytecode: Object.fromEntries(
          Object.entries(freeze.contracts).map(([name, value]) => [
            name,
            { keccak256: value.creationBytecodeKeccak256 },
          ])
        ),
      },
      runtimeBytecode,
    });
    expect(deploymentAudit.passed).to.equal(true);
    expect(deploymentAudit.safePolicy.passed).to.equal(true);

    await (await usdc.connect(funder).transfer(alice.address, MIN_RUNWAY)).wait();
    await (await usdc.connect(funder).transfer(bob.address, MIN_RUNWAY + 1_000_000n)).wait();
    await (await usdc.connect(funder).transfer(carol.address, MIN_RUNWAY)).wait();
    await (await usdc.connect(funder).transfer(alice.address, REFERRAL_REWARD)).wait();
    await (await usdc.connect(funder).transfer(buyer.address, 10_000_000n)).wait();
    expect(await usdc.balanceOf(alice.address)).to.equal(MIN_RUNWAY + REFERRAL_REWARD);
    await (await usdc.connect(alice).approve(await arena.getAddress(), MIN_RUNWAY)).wait();
    expect(await usdc.allowance(alice.address, await arena.getAddress())).to.equal(MIN_RUNWAY);
    // The selected species depends on the mined block's prevrandao, so its packed
    // storage cost can differ from the preceding eth_estimateGas simulation.
    await (await arena.connect(alice)["hatch(uint256)"](MIN_RUNWAY, { gasLimit: HATCH_GAS_LIMIT })).wait();
    const hatchedAgent = await agents.getAgent(1);
    const hatchedTokenUri = await agents.tokenURI(1);
    expect(hatchedAgent.cypherId).to.be.lessThan(29n);
    expect(hatchedTokenUri).to.equal(
      `ipfs://bafybeicbtgrjvljtdjgjua6n6vteayl5micu222mbw5ifessrx63xpuyzy/${hatchedAgent.cypherId}.json`
    );
    await (await usdc.connect(alice).approve(await referralPool.getAddress(), REFERRAL_REWARD)).wait();
    await (await referralPool.connect(alice).fund(1, ethers.id("base fork referral refill"), REFERRAL_REWARD)).wait();
    await (await usdc.connect(bob).approve(await arena.getAddress(), MIN_RUNWAY + 1_000_000n)).wait();
    await (await arena.connect(bob)["hatch(uint256,uint256)"](MIN_RUNWAY, 1, { gasLimit: HATCH_GAS_LIMIT })).wait();
    expect(await referralPool.referredBy(2)).to.equal(1n);
    expect((await agents.getAgent(1)).vault).to.equal(REFERRAL_REWARD);
    await (await usdc.connect(carol).approve(await arena.getAddress(), MIN_RUNWAY)).wait();
    const skippedReferralReceipt = await (
      await arena.connect(carol)["hatch(uint256,uint256)"](MIN_RUNWAY, 1, { gasLimit: HATCH_GAS_LIMIT })
    ).wait();
    const skippedReferralEvent = skippedReferralReceipt.logs
      .map((log) => {
        try {
          return referralPool.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((event) => event?.name === "ReferralRewardSkipped");
    expect(skippedReferralEvent?.args).to.deep.equal([3n, 1n, carol.address, 0n]);
    expect(await agents.ownerOf(3)).to.equal(carol.address);
    expect(await referralPool.referredBy(3)).to.equal(1n);
    const firstCommit = await (await arena.connect(alice).commit(1)).wait();
    const firstCommitBlock = await ethers.provider.getBlock(firstCommit.blockNumber);
    const firstNextCommitAt = await arena.nextCommitAt(1);
    expect(firstNextCommitAt).to.equal(BigInt(firstCommitBlock.timestamp + 86_400));
    await (await arena.connect(alice).rainFromRunway(1, 100)).wait();
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
    expect(tokenAddress).to.equal(predictedToken);
    expect(pairAddress).to.equal(precreatedPair);
    expect(await factory.getPair(tokenAddress, CONSTANTS.base.usdc)).to.equal(pairAddress);
    expect(seeded).to.equal(FLOOR);
    const pairUSDCImmediatelyAfterGraduation = await usdc.balanceOf(pairAddress);
    expect(pairUSDCImmediatelyAfterGraduation).to.equal(FLOOR + 1n);

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
    const bankedBuyTax = await token.balanceOf(await graduation.getAddress());
    expect(bankedBuyTax).to.be.gt(0n);
    await (await token.connect(buyer).approve(CONSTANTS.base.uniswapV2Router, bought)).wait();
    const sellAmount = bought / 100n;
    const sellTax = sellAmount / 100n;
    deadline = (await ethers.provider.getBlock("latest")).timestamp + 600;
    const sellReceipt = await (await router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
      sellAmount, 0, [tokenAddress, CONSTANTS.base.usdc], buyer.address, deadline,
      { gasLimit: 1_000_000n }
    )).wait();
    const taxHarvests = sellReceipt.logs.flatMap((log) => {
      try { return [graduation.interface.parseLog(log)]; } catch (_) { return []; }
    }).filter((event) => event?.name === "TaxHarvested");
    expect(taxHarvests).to.have.length(1);
    expect(taxHarvests[0].args.tokenTax).to.equal(sellTax * 2n);
    expect(taxHarvests[0].args.tokenTax).to.be.lt(bankedBuyTax);
    expect(await token.balanceOf(await graduation.getAddress())).to.be.gt(0n);

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
          missionEscrow: await stack.missionEscrow.getAddress(),
          referralPool: await referralPool.getAddress(),
          graduation: await graduation.getAddress(),
          token: tokenAddress,
          pair: pairAddress,
        },
        assertions: {
          independentDeploymentAuditChecks: deploymentAudit.checks.length,
          integratedProductionPreflight: productionPreflight.safePolicy.passed,
          safePublicReady: deploymentAudit.safePolicy.publicReady,
          selectedCypherId: hatchedAgent.cypherId.toString(),
          tokenURI: hatchedTokenUri,
          referralRewardMicros: (await referralPool.rewardPerReferral()).toString(),
          referredByAgent2: (await referralPool.referredBy(2)).toString(),
          underfundedReferralAgent3Hatched: (await agents.ownerOf(3)) === carol.address,
          referredByAgent3WithoutReward: (await referralPool.referredBy(3)).toString(),
          referralPoolBalanceMicros: (await usdc.balanceOf(await referralPool.getAddress())).toString(),
          firstNextCommitAt: firstNextCommitAt.toString(),
          exactFloorUSDC: seeded.toString(),
          predictedPairPrecreated: pairAddress === precreatedPair,
          preTokenSyncRejected: true,
          unsynchronizedDustDonationMicros: "1",
          pairUSDCImmediatelyAfterGraduation: pairUSDCImmediatelyAfterGraduation.toString(),
          bankedBuyTaxBeforeSell: bankedBuyTax.toString(),
          boundedTaxConvertedOnSell: taxHarvests[0].args.tokenTax.toString(),
          maxTaxAuthorizedBySell: (sellTax * 2n).toString(),
          taxBankRemainsAfterBoundedSell: (await token.balanceOf(await graduation.getAddress())).toString(),
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
