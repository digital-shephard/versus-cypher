/**
 * Ownerless Versus deploy helper (Hardhat).
 * - No seed fund
 * - $1000 graduation floor (overridable for tests)
 * - Ownerless mission escrow + nonreplayable paid-signal batches
 * - Permanent daily-penny voice credentials for postcard verification
 * - 10% of tranche → immutable protocolRecipient
 */
async function deployOwnerlessVersus(ethers, { usdcAddress, routerAddress, protocolRecipient, graduationFloor }) {
  if (!usdcAddress || !routerAddress || !protocolRecipient) {
    throw new Error("usdc + router + protocolRecipient required");
  }

  const floor = graduationFloor ?? 1_000_000_000n; // $1000 USDC (6 decimals)
  const transactions = [];

  async function recordDeployment(label, contract) {
    await contract.waitForDeployment();
    const receipt = await contract.deploymentTransaction().wait();
    transactions.push(receiptRecord(label, receipt));
    return contract;
  }

  async function recordCall(label, transactionPromise) {
    const transaction = await transactionPromise;
    const receipt = await transaction.wait();
    transactions.push(receiptRecord(label, receipt));
    return receipt;
  }

  const agents = await recordDeployment(
    "deploy AgentNFT",
    await (await ethers.getContractFactory("AgentNFT")).deploy(usdcAddress)
  );

  const syndicate = await recordDeployment(
    "deploy SyndicateEngine",
    await (await ethers.getContractFactory("SyndicateEngine")).deploy(usdcAddress, floor)
  );

  const treasury = await recordDeployment(
    "deploy TrancheTreasury",
    await (await ethers.getContractFactory("TrancheTreasury")).deploy(usdcAddress, protocolRecipient)
  );

  const missionEscrow = await recordDeployment(
    "deploy MissionEscrow",
    await (await ethers.getContractFactory("MissionEscrow")).deploy(usdcAddress, await agents.getAddress())
  );

  const arena = await recordDeployment(
    "deploy Arena",
    await (await ethers.getContractFactory("Arena")).deploy(
      usdcAddress,
      await agents.getAddress(),
      await syndicate.getAddress(),
      await treasury.getAddress()
    )
  );

  const graduation = await recordDeployment(
    "deploy GraduationModule",
    await (await ethers.getContractFactory("GraduationModule")).deploy(
      usdcAddress,
      routerAddress,
      await syndicate.getAddress(),
      await treasury.getAddress()
    )
  );

  await recordCall(
    "bootstrap AgentNFT",
    agents.bootstrap(
      await arena.getAddress(),
      await treasury.getAddress(),
      await missionEscrow.getAddress()
    )
  );
  await recordCall(
    "bootstrap SyndicateEngine",
    syndicate.bootstrap(await arena.getAddress(), await graduation.getAddress())
  );
  await recordCall(
    "bootstrap TrancheTreasury",
    treasury.bootstrap(await arena.getAddress(), await agents.getAddress())
  );

  return {
    agents,
    arena,
    syndicate,
    treasury,
    missionEscrow,
    graduation,
    transactions,
    addresses: {
      agents: await agents.getAddress(),
      arena: await arena.getAddress(),
      syndicate: await syndicate.getAddress(),
      treasury: await treasury.getAddress(),
      missionEscrow: await missionEscrow.getAddress(),
      graduation: await graduation.getAddress(),
      usdc: usdcAddress,
      router: routerAddress,
      protocolRecipient,
      graduationFloor: floor.toString(),
    },
  };
}

function receiptRecord(label, receipt) {
  return {
    label,
    hash: receipt.hash,
    blockNumber: receipt.blockNumber,
    status: Number(receipt.status),
    gasUsed: receipt.gasUsed.toString(),
    contractAddress: receipt.contractAddress || null,
  };
}

async function deployLocalStack(ethers, opts = {}) {
  const [deployer] = await ethers.getSigners();
  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
  await usdc.waitForDeployment();

  const v2Factory = await (await ethers.getContractFactory("MockUniswapV2Factory")).deploy();
  await v2Factory.waitForDeployment();

  const v2Router = await (await ethers.getContractFactory("MockUniswapV2Router")).deploy(
    await v2Factory.getAddress()
  );
  await v2Router.waitForDeployment();

  const core = await deployOwnerlessVersus(ethers, {
    usdcAddress: await usdc.getAddress(),
    routerAddress: await v2Router.getAddress(),
    protocolRecipient: opts.protocolRecipient || deployer.address,
    graduationFloor: opts.graduationFloor, // tests pass small floor
  });

  return { usdc, v2Factory, v2Router, ...core };
}

module.exports = { deployOwnerlessVersus, deployLocalStack };
