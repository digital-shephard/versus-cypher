const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployLocalStack } = require("../scripts/lib/deployOwnerless");
const MIN_RUNWAY = 7_000_000n;

const PENNY = 10_000n;
const TEST_FLOOR = 30_000n;

describe("Versus onboard E2E (ownerless local chain)", function () {
  it("deposit → mint → rain into class → graduate at floor → claim with protocol cut", async function () {
    const [deployer, human] = await ethers.getSigners();
    const { usdc, agents, arena, syndicate, treasury, graduation } = await deployLocalStack(ethers, {
      protocolRecipient: deployer.address,
      graduationFloor: TEST_FLOOR,
    });

    const postSwapUsdc = ethers.parseUnits("7.98", 6);
    await usdc.mint(human.address, postSwapUsdc);
    await usdc.connect(human).approve(await arena.getAddress(), ethers.MaxUint256);
    await usdc.connect(human).approve(await agents.getAddress(), ethers.MaxUint256);

    await arena.connect(human).hatch(0, MIN_RUNWAY);
    expect(await agents.ownerOf(1)).to.equal(human.address);

    // Rain until floor (3 pennies over 3 days)
    await arena.connect(human).commit(1);
    expect(await syndicate.GENESIS_CLASS_ID()).to.equal(1n);
    expect(await syndicate.isGenesisAgent(1)).to.equal(true);
    expect(await syndicate.genesisAgentCount()).to.equal(1n);
    expect(await syndicate.genesisAgentAt(0)).to.equal(1n);
    expect(await syndicate.getGenesisAgents()).to.deep.equal([1n]);
    await ethers.provider.send("evm_increaseTime", [86400]);
    await ethers.provider.send("evm_mine");
    await arena.connect(human).commit(1);
    expect(await syndicate.genesisAgentCount()).to.equal(1n);
    await ethers.provider.send("evm_increaseTime", [86400]);
    await ethers.provider.send("evm_mine");
    await arena.connect(human).commit(1);

    const classId = await syndicate.currentClassId();
    expect(await syndicate.canGraduate(classId)).to.equal(true);
    expect((await syndicate.getClass(classId)).totalCommitted).to.equal(PENNY * 3n);

    await graduation.graduate();
    expect((await syndicate.getClass(classId)).graduated).to.equal(true);
    expect(await syndicate.currentClassId()).to.equal(classId + 1n);
    expect(await syndicate.isGenesisAgent(1)).to.equal(true);

    const leftover = await usdc.balanceOf(human.address);
    if (leftover > 0n) {
      await agents.connect(human).deposit(1, leftover);
    }

    const oil = ethers.parseUnits("30000", 6);
    await usdc.mint(deployer.address, oil);
    await usdc.approve(await treasury.getAddress(), oil);
    const protoBefore = await treasury.totalProtocolPaid();
    await treasury.depositFees(oil);
    const protoAfter = await treasury.totalProtocolPaid();
    expect(protoAfter - protoBefore).to.equal((oil * 1000n) / 10000n);

    await treasury.claim(1);
    expect((await agents.getAgent(1)).vault).to.be.gt(ethers.parseUnits("10000", 6));
  });

  it("selling the Cypher transfers the vault funds", async function () {
    const signers = await ethers.getSigners();
    const seller = signers[1];
    const buyer = signers[2];
    const { usdc, agents, arena } = await deployLocalStack(ethers, { graduationFloor: TEST_FLOOR });

    await usdc.mint(seller.address, ethers.parseUnits("11", 6));
    await usdc.connect(seller).approve(await arena.getAddress(), ethers.MaxUint256);
    await usdc.connect(seller).approve(await agents.getAddress(), ethers.MaxUint256);

    await arena.connect(seller).hatch(1, MIN_RUNWAY);
    await agents.connect(seller).deposit(1, ethers.parseUnits("4", 6));
    await agents.connect(seller).transferFrom(seller.address, buyer.address, 1);

    expect(await agents.ownerOf(1)).to.equal(buyer.address);
    await agents.connect(buyer).withdraw(1, ethers.parseUnits("4", 6));
    expect(await usdc.balanceOf(buyer.address)).to.equal(ethers.parseUnits("4", 6));
  });

  it("many penny agents fill one open class toward the floor", async function () {
    const { usdc, agents, arena, syndicate } = await deployLocalStack(ethers, {
      graduationFloor: TEST_FLOOR,
    });
    const signers = await ethers.getSigners();
    const humans = signers.slice(1, 6);

    for (let i = 0; i < humans.length; i++) {
      const h = humans[i];
      await usdc.mint(h.address, MIN_RUNWAY);
      await usdc.connect(h).approve(await arena.getAddress(), ethers.MaxUint256);
      await arena.connect(h).hatch(i % 3, MIN_RUNWAY);
      await arena.connect(h).commit(i + 1);
    }

    const classId = await syndicate.currentClassId();
    const cls = await syndicate.getClass(classId);
    expect(cls.participantCount).to.equal(5);
    expect(cls.totalCommitted).to.equal(PENNY * 5n);
    expect(await syndicate.canGraduate(classId)).to.equal(true); // 5 pennies > 3 penny floor
  });
});
