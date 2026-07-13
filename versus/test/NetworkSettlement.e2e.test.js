const { expect } = require("chai");
const { ethers } = require("hardhat");
const { EventEmitter } = require("events");
const { createChainRainService } = require("../../apps/pet/src/chain");
const { referralCodeFor } = require("../../apps/pet/src/referrals");
const {
  CypherIdentity,
  ContractEconomicVerifier,
  StaticCypherVerifier,
  VersusNode,
  buildSignalBatch,
} = require("../../packages/network/src");
const { deployLocalStack } = require("../scripts/lib/deployOwnerless");
const MIN_RUNWAY = 7_000_000n;

class MemoryTransport extends EventEmitter {
  constructor() { super(); this.connectionless = true; this.handlesPropagation = true; }
  async broadcast() {}
  async close() {}
  get peerCount() { return 0; }
  peerList() { return []; }
}

describe("Versus network economic settlement E2E", function () {
  it("translates a stale class-bound signal into CLASS_OVER without spending runway", async function () {
    const [deployer] = await ethers.getSigners();
    const stack = await deployLocalStack(ethers, {
      protocolRecipient: deployer.address,
      graduationFloor: 10_000n,
    });
    const wallet = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: wallet.address, value: ethers.parseEther("1") });
    await stack.usdc.mint(wallet.address, MIN_RUNWAY);
    await stack.usdc.connect(wallet).approve(await stack.arena.getAddress(), ethers.MaxUint256);
    await stack.arena.connect(wallet).hatch(MIN_RUNWAY);

    const network = await ethers.provider.getNetwork();
    const identity = new CypherIdentity({ signer: wallet, cypherId: 1 });
    const createdAt = Math.floor(Date.now() / 1000);
    const proposal = await identity.signPostcard({
      type: "proposal",
      launchId: "1",
      sequence: 0,
      createdAt,
      expiresAt: createdAt + 3600,
      body: "build a public harbor ritual",
    });
    const batch = buildSignalBatch({
      postcards: [proposal],
      chainId: network.chainId,
      arena: await stack.arena.getAddress(),
      launchId: 1,
      agentId: 1,
      author: wallet.address,
    });
    const service = createChainRainService(
      { rpcUrl: "injected", deployment: { chainId: Number(network.chainId), contracts: stack.addresses } },
      { provider: ethers.provider }
    );

    await stack.arena.connect(wallet).commit(1);
    const runwayBefore = await stack.arena.runway(1);
    await stack.graduation.graduate();
    expect(await stack.syndicate.currentClassId()).to.equal(2n);

    let failure;
    try {
      await service.settleSignalBatchFromRunway({ privateKey: wallet.privateKey, agentId: 1, batch });
    } catch (error) {
      failure = error;
    }
    expect(failure?.code).to.equal("CLASS_OVER");
    expect(failure?.classId).to.equal("1");
    expect(failure?.currentClassId).to.equal("2");
    expect(await stack.arena.runway(1)).to.equal(runwayBefore);
    expect(await stack.arena.settledSignalBatches(1, batch.root)).to.equal(false);
  });

  it("validates a code and completes manual funding referred hatch payout and one-penny agent funding", async function () {
    const [deployer] = await ethers.getSigners();
    const stack = await deployLocalStack(ethers, {
      protocolRecipient: deployer.address,
      graduationFloor: 1_000_000n,
    });
    const referrer = ethers.Wallet.createRandom().connect(ethers.provider);
    const newcomer = ethers.Wallet.createRandom().connect(ethers.provider);
    for (const wallet of [referrer, newcomer]) {
      await deployer.sendTransaction({ to: wallet.address, value: ethers.parseEther("1") });
    }
    await stack.usdc.mint(referrer.address, MIN_RUNWAY + 1_000_000n);
    await stack.usdc.mint(newcomer.address, MIN_RUNWAY);
    await stack.usdc.connect(referrer).approve(await stack.arena.getAddress(), ethers.MaxUint256);
    await stack.arena.connect(referrer).hatch(MIN_RUNWAY);

    const network = await ethers.provider.getNetwork();
    const service = createChainRainService(
      { rpcUrl: "injected", deployment: { chainId: Number(network.chainId), contracts: stack.addresses } },
      { provider: ethers.provider }
    );
    await service.fundReferralPool({
      privateKey: referrer.privateKey,
      sponsorAgentId: 1,
      proposalId: ethers.id("desktop referral funding drive"),
      amount: 1_000_000n,
    });
    const validated = await service.validateReferralCode({
      code: referralCodeFor(1),
      hatchOwner: newcomer.address,
    });
    expect(validated.referrerAgentId).to.equal(1n);

    const hatch = await service.hatchWithRunway({
      privateKey: newcomer.privateKey,
      runwayAmount: MIN_RUNWAY,
      referrerAgentId: validated.referrerAgentId,
    });
    expect(hatch.agentId).to.equal(2n);
    expect(await stack.referralPool.referredBy(2)).to.equal(1n);
    expect((await stack.agents.getAgent(1)).vault).to.equal(1_000_000n);

    await service.fundReferralPoolFromRunway({
      privateKey: referrer.privateKey,
      agentId: 1,
      proposalId: ethers.id("desktop referral funding drive"),
    });
    const state = await service.readState({ address: referrer.address, agentId: 1 });
    expect(state.referralFundedToday).to.equal(true);
    expect(await stack.usdc.balanceOf(await stack.referralPool.getAddress())).to.equal(10_000n);
  });

  it("runs the packaged ETH hatch and replenish path against the local mock deployment", async function () {
    const [deployer] = await ethers.getSigners();
    const stack = await deployLocalStack(ethers, {
      protocolRecipient: deployer.address,
      graduationFloor: 1_000_000n,
    });
    const wallet = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: wallet.address, value: ethers.parseEther("1") });
    const network = await ethers.provider.getNetwork();
    const service = createChainRainService({
      rpcUrl: "injected",
      deployment: {
        chainId: Number(network.chainId),
        usedMockUsdc: true,
        usedMockRouter: true,
        contracts: stack.addresses,
      },
    }, { provider: ethers.provider });

    const hatch = await service.hatchWithEth({
      privateKey: wallet.privateKey,
      depositWei: ethers.parseEther("0.003"),
    });
    expect(hatch.agentId).to.equal(1n);
    expect(hatch.runway).to.equal(MIN_RUNWAY);
    expect(hatch.cypherId).to.be.lessThan(29n);
    expect(hatch.swapHash).to.match(/^0x[0-9a-f]{64}$/i);

    await service.commitDaily({ privateKey: wallet.privateKey, agentId: 1 });
    const replenished = await service.replenishWithEth({
      privateKey: wallet.privateKey,
      agentId: 1,
      depositWei: ethers.parseEther("0.003"),
    });
    expect(replenished.amount).to.equal(MIN_RUNWAY);
    expect(replenished.runway).to.equal(MIN_RUNWAY * 2n - 10_000n);
  });

  it("reconciles chain state replenishes runway claims rolling rewards and withdraws the NFT vault", async function () {
    const [deployer] = await ethers.getSigners();
    const stack = await deployLocalStack(ethers, {
      protocolRecipient: deployer.address,
      graduationFloor: 1_000_000n,
    });
    const wallet = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: wallet.address, value: ethers.parseEther("1") });
    await stack.usdc.mint(wallet.address, ethers.parseUnits("12", 6));
    await stack.usdc.connect(wallet).approve(await stack.arena.getAddress(), ethers.MaxUint256);
    await stack.arena.connect(wallet).hatch(MIN_RUNWAY);
    await stack.arena.connect(wallet).commit(1);

    const network = await ethers.provider.getNetwork();
    const service = createChainRainService(
      { rpcUrl: "injected", deployment: { chainId: Number(network.chainId), contracts: stack.addresses } },
      { provider: ethers.provider }
    );
    const before = await service.readState({ address: wallet.address, agentId: 1 });
    expect(before.owner).to.equal(wallet.address);
    expect(before.runway).to.equal(MIN_RUNWAY - 10_000n);
    expect(before.tickets).to.equal(1n);
    expect(before.genesis).to.equal(true);

    const replenished = await service.replenishRunway({
      privateKey: wallet.privateKey,
      agentId: 1,
      amount: ethers.parseUnits("2", 6),
    });
    expect(replenished.runway).to.equal(MIN_RUNWAY - 10_000n + ethers.parseUnits("2", 6));

    let rainSubmitted = null;
    const rained = await service.rainFromRunway({
      privateKey: wallet.privateKey,
      agentId: 1,
      pennies: 1,
      onSubmitted: async (hash) => { rainSubmitted = hash; },
    });
    expect(rainSubmitted).to.equal(rained.hash);

    const fees = ethers.parseUnits("10", 6);
    await stack.usdc.mint(deployer.address, fees);
    await stack.usdc.approve(await stack.treasury.getAddress(), fees);
    await stack.treasury.depositFees(fees);

    let claimSubmitted = null;
    const claimed = await service.claimTranche({
      privateKey: wallet.privateKey,
      agentId: 1,
      onSubmitted: async (hash) => { claimSubmitted = hash; },
    });
    expect(claimSubmitted).to.equal(claimed.hash);
    expect((await service.transactionStatus(claimed.hash)).status).to.equal("confirmed");
    expect(claimed.amount).to.equal(ethers.parseUnits("9", 6));
    expect(claimed.vault).to.equal(claimed.amount);
    const afterClaim = await service.readState({ address: wallet.address, agentId: 1 });
    expect(afterClaim.claimable).to.equal(0n);
    expect(afterClaim.vault).to.equal(claimed.amount);

    const walletBefore = await stack.usdc.balanceOf(wallet.address);
    const withdrawn = await service.withdrawVault({ privateKey: wallet.privateKey, agentId: 1 });
    expect(withdrawn.amount).to.equal(claimed.amount);
    expect(withdrawn.vault).to.equal(0n);
    expect(await stack.usdc.balanceOf(wallet.address)).to.equal(walletBefore + claimed.amount);
  });

  it("settles paid ink and mission sponsorship through the Electron chain service", async function () {
    const [deployer, recipient] = await ethers.getSigners();
    const stack = await deployLocalStack(ethers, {
      protocolRecipient: deployer.address,
      graduationFloor: 1_000_000n,
    });
    const wallet = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: wallet.address, value: ethers.parseEther("1") });
    await stack.usdc.mint(wallet.address, ethers.parseUnits("100", 6));
    await stack.usdc.mint(recipient.address, MIN_RUNWAY);
    await stack.usdc.connect(wallet).approve(await stack.arena.getAddress(), ethers.MaxUint256);
    await stack.usdc.connect(wallet).approve(await stack.agents.getAddress(), ethers.MaxUint256);
    await stack.usdc.connect(recipient).approve(await stack.arena.getAddress(), ethers.MaxUint256);
    await stack.arena.connect(wallet).hatch(MIN_RUNWAY);
    await stack.arena.connect(recipient).hatch(MIN_RUNWAY);
    await stack.agents.connect(wallet).deposit(1, ethers.parseUnits("10", 6));

    const network = await ethers.provider.getNetwork();
    const deployment = {
      chainId: Number(network.chainId),
      contracts: stack.addresses,
    };
    const service = createChainRainService(
      { rpcUrl: "injected", deployment },
      { provider: ethers.provider }
    );
    const identity = new CypherIdentity({ signer: wallet, cypherId: 1 });
    const createdAt = Math.floor(Date.now() / 1000);
    const proposal = await identity.signPostcard({
      type: "proposal",
      launchId: "1",
      sequence: 0,
      createdAt,
      expiresAt: createdAt + 3600,
      body: "build a public garden ritual",
    });
    const batch = buildSignalBatch({
      postcards: [proposal],
      chainId: network.chainId,
      arena: await stack.arena.getAddress(),
      launchId: 1,
      agentId: 1,
      author: wallet.address,
    });
    let submittedHash = null;
    const signalReceipt = await service.settleSignalBatchFromRunway({
      privateKey: wallet.privateKey,
      agentId: 1,
      batch,
      onSubmitted: async (hash) => {
        submittedHash = hash;
      },
    });

    expect(signalReceipt.hash).to.equal(submittedHash);
    expect(signalReceipt.batch.root).to.equal(batch.root);
    const reconciled = await service.reconcileSignalBatch({
      agentId: 1,
      batch,
      transactionHash: signalReceipt.hash,
    });
    expect(reconciled.status).to.equal("confirmed");
    expect(reconciled.blockNumber).to.equal(signalReceipt.blockNumber);
    const unknown = await service.reconcileSignalBatch({
      agentId: 1,
      batch,
      transactionHash: `0x${"11".repeat(32)}`,
    });
    expect(unknown.status).to.equal("pending");
    expect(await stack.arena.settledSignalBatches(1, batch.root)).to.equal(true);
    expect(await stack.treasury.tickets(1)).to.equal(3n);
    const verifier = new ContractEconomicVerifier({
      provider: ethers.provider,
      chainId: network.chainId,
      arena: await stack.arena.getAddress(),
      missionEscrow: await stack.missionEscrow.getAddress(),
    });
    const signalProof = {
      kind: "versus-signal-settlement",
      version: 1,
      batch,
      transactionHash: signalReceipt.hash,
      blockNumber: signalReceipt.blockNumber,
    };
    expect((await verifier.verifySignalSettlement(signalProof)).verified).to.equal(true);

    const receiverIdentity = new CypherIdentity({ signer: recipient, cypherId: 2 });
    const registry = new StaticCypherVerifier([
      { address: wallet.address, cypherId: 1 },
      { address: recipient.address, cypherId: 2 },
    ]);
    const receiverNode = new VersusNode({
      identity: receiverIdentity,
      eligibilityVerifier: registry,
      transport: new MemoryTransport(),
      economicVerifier: verifier,
    });
    await expect(receiverNode.accept(proposal)).to.be.rejectedWith("missing its Base proof");
    expect(receiverNode.store.size).to.equal(0);
    expect((await receiverNode.accept(proposal, { paymentProof: signalProof })).accepted).to.equal(true);
    expect(receiverNode.store.size).to.equal(1);
    await receiverNode.close();

    const block = await ethers.provider.getBlock("latest");
    const missionId = ethers.id("network mission postcard");
    const amount = ethers.parseUnits("3", 6);
    let missionSubmitted = null;
    const sponsorship = await service.sponsorMission({
      privateKey: wallet.privateKey,
      missionId,
      launchId: 1,
      sponsorAgentId: 1,
      recipientAgentId: 2,
      amount,
      deadline: block.timestamp + 7200,
      onSubmitted: async (hash) => { missionSubmitted = hash; },
    });
    expect(missionSubmitted).to.equal(sponsorship.hash);
    expect(sponsorship.escrowId).to.equal(1n);
    expect((await service.getMissionEscrow(1)).amount).to.equal(amount);
    const sponsorshipProof = {
      kind: "versus-mission-sponsorship",
      version: 1,
      chainId: sponsorship.chainId,
      escrow: sponsorship.escrow,
      escrowId: sponsorship.escrowId,
      missionId: sponsorship.missionId,
      launchId: sponsorship.launchId,
      sponsorAgentId: sponsorship.sponsorAgentId,
      recipientAgentId: sponsorship.recipientAgentId,
      sponsor: sponsorship.sponsor,
      amountMicros: sponsorship.amount,
      deadline: sponsorship.deadline,
      transactionHash: sponsorship.hash,
      blockNumber: sponsorship.blockNumber,
    };
    expect((await verifier.verifyMissionSponsorship(sponsorshipProof)).verified).to.equal(true);
    await expect(
      verifier.verifyMissionSponsorship({ ...sponsorshipProof, amountMicros: amount + 1n })
    ).to.be.rejectedWith("mission escrow state does not match");
    const release = await service.releaseMission({ privateKey: wallet.privateKey, escrowId: 1 });
    expect(release.amount).to.equal(amount);
    expect((await stack.agents.getAgent(2)).vault).to.equal(amount);
    expect((await service.getMissionEscrow(1)).state).to.equal(1);
  });
});
