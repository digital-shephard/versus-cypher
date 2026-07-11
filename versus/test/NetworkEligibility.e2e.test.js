const { expect } = require("chai");
const { ethers } = require("hardhat");
const { ContractCypherVerifier } = require("../../packages/network/src");
const { deployLocalStack } = require("../scripts/lib/deployOwnerless");
const MIN_RUNWAY = 7_000_000n;

describe("Versus network Cypher eligibility", function () {
  it("follows AgentNFT registration and current ownership", async function () {
    const [deployer, alice, bob] = await ethers.getSigners();
    const { usdc, agents, arena } = await deployLocalStack(ethers, {
      protocolRecipient: deployer.address,
      graduationFloor: 30_000n,
    });
    await usdc.mint(alice.address, MIN_RUNWAY);
    await usdc.connect(alice).approve(await arena.getAddress(), ethers.MaxUint256);
    await arena.connect(alice).hatch(4, MIN_RUNWAY);

    const verifier = new ContractCypherVerifier({
      provider: ethers.provider,
      contractAddress: await agents.getAddress(),
      arenaAddress: await arena.getAddress(),
      expectedChainId: 31337,
      cacheTtlMs: 0,
    });

    expect((await verifier.verify({ address: alice.address, cypherId: 1 })).eligible).to.equal(true);
    expect((await verifier.verify({ address: bob.address, cypherId: 1 })).eligible).to.equal(false);
    expect((await verifier.verify({ address: alice.address, cypherId: 2 })).eligible).to.equal(false);

    const voiceDay = Number(await arena.currentDay());
    const silent = await verifier.verify({ address: alice.address, cypherId: 1, voiceDay });
    expect(silent.eligible).to.equal(false);
    expect(silent.reason).to.equal("daily_voice_not_earned");

    await arena.connect(alice).commit(1);
    const active = await verifier.verify({ address: alice.address, cypherId: 1, voiceDay });
    expect(active.eligible).to.equal(true);
    expect(active.voiceActive).to.equal(true);

    await agents.connect(alice).transferFrom(alice.address, bob.address, 1);
    expect((await verifier.verify({ address: alice.address, cypherId: 1 })).eligible).to.equal(false);
    expect((await verifier.verify({ address: bob.address, cypherId: 1 })).eligible).to.equal(true);
    expect((await verifier.verify({ address: bob.address, cypherId: 1, voiceDay })).eligible).to.equal(true);
  });
});
