const { expect } = require("chai");
const { ethers } = require("hardhat");

const MIN_DURATION = 60;
const MAX_DURATION = 7 * 24 * 60 * 60;
const BENEFICIARY_AMOUNT = ethers.parseEther("0.25");
const EXECUTOR_AMOUNT = ethers.parseEther("0.002");

async function latestTimestamp() {
  return Number((await ethers.provider.getBlock("latest")).timestamp);
}

async function deployFixture() {
  const [deployer, funder, beneficiary, relayer, attacker] =
    await ethers.getSigners();
  const Adapter = await ethers.getContractFactory("EvmNativeHtlcV3");
  const adapter = await Adapter.deploy(MIN_DURATION, MAX_DURATION);
  return { deployer, funder, beneficiary, relayer, attacker, adapter };
}

function secretPair(label = "native-v3-secret") {
  const secret = ethers.keccak256(ethers.toUtf8Bytes(label));
  return {
    secret,
    secretHash: ethers.keccak256(ethers.solidityPacked(["bytes32"], [secret])),
  };
}

function packSettlement(terms) {
  return (
    (BigInt(terms.refundTimestamp) << 192n) |
    (BigInt(terms.beneficiaryAmount) << 96n) |
    BigInt(terms.executorAmount)
  );
}

async function defaultTerms(context, overrides = {}) {
  const { secret, secretHash } = secretPair(overrides.secretLabel);
  return {
    secret,
    terms: {
      tradeId:
        overrides.tradeId ||
        ethers.keccak256(ethers.toUtf8Bytes(overrides.label || "native-v3-trade")),
      funder: overrides.funder || context.funder.address,
      beneficiary: overrides.beneficiary || context.beneficiary.address,
      secretHash: overrides.secretHash || secretHash,
      refundTimestamp:
        overrides.refundTimestamp ||
        (await latestTimestamp()) + MIN_DURATION + 30,
      beneficiaryAmount:
        overrides.beneficiaryAmount ?? BENEFICIARY_AMOUNT,
      executorAmount: overrides.executorAmount ?? EXECUTOR_AMOUNT,
    },
  };
}

async function fund(context, prepared) {
  const amount =
    prepared.terms.beneficiaryAmount + prepared.terms.executorAmount;
  const transaction = await context.adapter
    .connect(context.funder)
    .fund(prepared.terms, { value: amount });
  await transaction.wait();
  return context.adapter.lockDigest(prepared.terms);
}

describe("EvmNativeHtlcV3", function () {
  it("is an ownerless commitment-only adapter", async function () {
    const { adapter } = await deployFixture();
    expect(await adapter.ADAPTER_VERSION()).to.equal(3n);
    expect(await adapter.minimumLockDuration()).to.equal(BigInt(MIN_DURATION));
    expect(await adapter.maximumLockDuration()).to.equal(BigInt(MAX_DURATION));
    for (const signature of [
      "owner()",
      "pause()",
      "upgradeTo(address)",
      "sweep(address)",
      "execute(address,bytes)",
      "totalLocked()",
      "solvent()",
    ]) {
      expect(adapter.interface.hasFunction(signature)).to.equal(false);
    }
  });

  it("domain-separates every term by chain and adapter", async function () {
    const context = await deployFixture();
    const Adapter = await ethers.getContractFactory("EvmNativeHtlcV3");
    const second = await Adapter.deploy(MIN_DURATION, MAX_DURATION);
    const prepared = await defaultTerms(context);
    const digest = await context.adapter.lockDigest(prepared.terms);

    expect(await second.lockDigest(prepared.terms)).not.to.equal(digest);
    for (const mutation of [
      { beneficiary: context.attacker.address },
      { funder: context.attacker.address },
      { tradeId: ethers.id("another-trade") },
      { secretHash: ethers.id("another-hash") },
      { refundTimestamp: prepared.terms.refundTimestamp + 1 },
      { beneficiaryAmount: prepared.terms.beneficiaryAmount + 1n },
      { executorAmount: prepared.terms.executorAmount + 1n },
    ]) {
      expect(
        await context.adapter.lockDigest({ ...prepared.terms, ...mutation })
      ).not.to.equal(digest);
    }
  });

  it("pays the exact output and permissionless executor bounty", async function () {
    const context = await deployFixture();
    const prepared = await defaultTerms(context);
    const digest = await fund(context, prepared);

    const claim = await context.adapter
      .connect(context.relayer)
      .claim(prepared.terms, prepared.secret);
    await expect(claim)
      .to.emit(context.adapter, "LockClaimed")
      .withArgs(
        digest,
        prepared.terms.tradeId,
        context.relayer.address,
        prepared.secret
      );
    await expect(claim).to.changeEtherBalances(
        [context.adapter, context.beneficiary, context.relayer],
        [
          -(prepared.terms.beneficiaryAmount + prepared.terms.executorAmount),
          prepared.terms.beneficiaryAmount,
          prepared.terms.executorAmount,
        ]
      );
    expect(await context.adapter.stateOf(digest)).to.equal(2n);
  });

  it("binds the same terms through the compact funding and claim selectors", async function () {
    const context = await deployFixture();
    const prepared = await defaultTerms(context);
    const settlement = packSettlement(prepared.terms);
    const digest = await context.adapter.lockDigest(prepared.terms);
    const total =
      prepared.terms.beneficiaryAmount + prepared.terms.executorAmount;

    await context.adapter
      .connect(context.funder)
      ["fund(bytes32,address,bytes32,uint256)"](
        prepared.terms.tradeId,
        prepared.terms.beneficiary,
        prepared.terms.secretHash,
        settlement,
        { value: total }
      );
    await expect(
      context.adapter
        .connect(context.relayer)
        ["claim(bytes32,address,address,uint256,bytes32)"](
          prepared.terms.tradeId,
          prepared.terms.funder,
          prepared.terms.beneficiary,
          settlement,
          prepared.secret
        )
    ).to.changeEtherBalances(
      [context.adapter, context.beneficiary, context.relayer],
      [
        -total,
        prepared.terms.beneficiaryAmount,
        prepared.terms.executorAmount,
      ]
    );
    expect(await context.adapter.stateOf(digest)).to.equal(2n);
  });

  it("completes requester-secret source-first settlement across two adapters", async function () {
    const context = await deployFixture();
    const Adapter = await ethers.getContractFactory("EvmNativeHtlcV3");
    const destination = await Adapter.deploy(MIN_DURATION, MAX_DURATION);
    const { secret, secretHash } = secretPair("cross-chain-v3-requester");
    const now = await latestTimestamp();
    const sourceTerms = {
      tradeId: ethers.id("cross-chain-v3-source"),
      funder: context.funder.address,
      beneficiary: context.beneficiary.address,
      secretHash,
      refundTimestamp: now + 3600,
      beneficiaryAmount: ethers.parseEther("0.01"),
      executorAmount: 0n,
    };
    const destinationTerms = {
      tradeId: ethers.id("cross-chain-v3-destination"),
      funder: context.beneficiary.address,
      beneficiary: context.attacker.address,
      secretHash,
      refundTimestamp: now + 1800,
      beneficiaryAmount: ethers.parseEther("0.008"),
      executorAmount: ethers.parseEther("0.0001"),
    };
    const sourceSettlement = packSettlement(sourceTerms);
    const destinationSettlement = packSettlement(destinationTerms);

    await context.adapter
      .connect(context.funder)
      ["fund(bytes32,address,bytes32,uint256)"](
        sourceTerms.tradeId,
        sourceTerms.beneficiary,
        sourceTerms.secretHash,
        sourceSettlement,
        { value: sourceTerms.beneficiaryAmount }
      );
    await expect(
      context.adapter
        .connect(context.beneficiary)
        ["claim((bytes32,address,address,bytes32,uint64,uint128,uint128),bytes32)"](
          sourceTerms,
          ethers.id("dealer-does-not-know-requester-secret")
        )
    ).to.be.revertedWithCustomError(context.adapter, "WrongSecret");

    await destination
      .connect(context.beneficiary)
      ["fund(bytes32,address,bytes32,uint256)"](
        destinationTerms.tradeId,
        destinationTerms.beneficiary,
        destinationTerms.secretHash,
        destinationSettlement,
        {
          value:
            destinationTerms.beneficiaryAmount +
            destinationTerms.executorAmount,
        }
      );
    await expect(
      destination
        .connect(context.relayer)
        ["claim(bytes32,address,address,uint256,bytes32)"](
          destinationTerms.tradeId,
          destinationTerms.funder,
          destinationTerms.beneficiary,
          destinationSettlement,
          secret
        )
    ).to.changeEtherBalances(
      [destination, context.attacker, context.relayer],
      [
        -(
          destinationTerms.beneficiaryAmount +
          destinationTerms.executorAmount
        ),
        destinationTerms.beneficiaryAmount,
        destinationTerms.executorAmount,
      ]
    );
    await expect(
      context.adapter
        .connect(context.beneficiary)
        ["claim(bytes32,address,address,uint256,bytes32)"](
          sourceTerms.tradeId,
          sourceTerms.funder,
          sourceTerms.beneficiary,
          sourceSettlement,
          secret
        )
    ).to.changeEtherBalances(
      [context.adapter, context.beneficiary],
      [-sourceTerms.beneficiaryAmount, sourceTerms.beneficiaryAmount]
    );
  });

  it("rejects compact encoding above uint96 without truncation", async function () {
    const { adapter } = await deployFixture();
    await expect(
      adapter.packSettlement(1, 1n << 96n, 0)
    ).to.be.revertedWithCustomError(
      adapter,
      "AmountTooLargeForCompactEncoding"
    );
    await expect(
      adapter.packSettlement(1, 1, 1n << 96n)
    ).to.be.revertedWithCustomError(
      adapter,
      "AmountTooLargeForCompactEncoding"
    );
  });

  it("supports an exact source lock with no executor bounty", async function () {
    const context = await deployFixture();
    const prepared = await defaultTerms(context, { executorAmount: 0n });
    const digest = await fund(context, prepared);
    await expect(
      context.adapter
        .connect(context.attacker)
        .claim(prepared.terms, prepared.secret)
    ).to.changeEtherBalances(
      [context.adapter, context.beneficiary],
      [-prepared.terms.beneficiaryAmount, prepared.terms.beneficiaryAmount]
    );
    expect(await context.adapter.stateOf(digest)).to.equal(2n);
  });

  it("refunds the complete liability to the committed funder", async function () {
    const context = await deployFixture();
    const prepared = await defaultTerms(context);
    const digest = await fund(context, prepared);
    await ethers.provider.send("evm_setNextBlockTimestamp", [
      prepared.terms.refundTimestamp,
    ]);
    const refund = await context.adapter
      .connect(context.attacker)
      .refund(prepared.terms);
    await expect(refund)
      .to.emit(context.adapter, "LockRefunded")
      .withArgs(digest, prepared.terms.tradeId, context.attacker.address);
    await expect(refund).to.changeEtherBalances(
        [context.adapter, context.funder],
        [
          -(prepared.terms.beneficiaryAmount + prepared.terms.executorAmount),
          prepared.terms.beneficiaryAmount + prepared.terms.executorAmount,
        ]
      );
    expect(await context.adapter.stateOf(digest)).to.equal(3n);
  });

  it("rejects overpayment, underpayment, and a mismatched funder", async function () {
    const context = await deployFixture();
    const prepared = await defaultTerms(context);
    const amount =
      prepared.terms.beneficiaryAmount + prepared.terms.executorAmount;
    await expect(
      context.adapter.connect(context.funder).fund(prepared.terms, {
        value: amount + 1n,
      })
    )
      .to.be.revertedWithCustomError(context.adapter, "IncorrectValue")
      .withArgs(amount, amount + 1n);
    await expect(
      context.adapter.connect(context.funder).fund(prepared.terms, {
        value: amount - 1n,
      })
    )
      .to.be.revertedWithCustomError(context.adapter, "IncorrectValue")
      .withArgs(amount, amount - 1n);
    await expect(
      context.adapter
        .connect(context.attacker)
        .fund(prepared.terms, { value: amount })
    )
      .to.be.revertedWithCustomError(context.adapter, "InvalidFunder")
      .withArgs(context.funder.address, context.attacker.address);
  });

  it("cannot claim a funded digest with mutated terms", async function () {
    const context = await deployFixture();
    const prepared = await defaultTerms(context);
    await fund(context, prepared);
    const changed = {
      ...prepared.terms,
      beneficiary: context.attacker.address,
    };
    const changedDigest = await context.adapter.lockDigest(changed);
    await expect(
      context.adapter.connect(context.attacker).claim(changed, prepared.secret)
    )
      .to.be.revertedWithCustomError(context.adapter, "LockNotFunded")
      .withArgs(changedDigest);
  });

  it("rolls back state when a fixed native recipient rejects", async function () {
    const context = await deployFixture();
    const Rejector = await ethers.getContractFactory("FxNativeRejector");
    const rejector = await Rejector.deploy();
    const prepared = await defaultTerms(context, {
      beneficiary: await rejector.getAddress(),
    });
    const digest = await fund(context, prepared);
    await expect(
      context.adapter
        .connect(context.relayer)
        .claim(prepared.terms, prepared.secret)
    ).to.be.revertedWithCustomError(context.adapter, "NativeTransferFailed");
    expect(await context.adapter.stateOf(digest)).to.equal(1n);
  });

  it("prevents same-lock reentrancy through checks-effects-interactions", async function () {
    const context = await deployFixture();
    const Recipient = await ethers.getContractFactory(
      "FxNativeV3ReentrantRecipient"
    );
    const recipient = await Recipient.deploy(await context.adapter.getAddress());
    const prepared = await defaultTerms(context, {
      beneficiary: await recipient.getAddress(),
    });
    const digest = await fund(context, prepared);
    await recipient.configure(prepared.terms, prepared.secret);
    await context.adapter
      .connect(context.relayer)
      .claim(prepared.terms, prepared.secret);
    expect(await recipient.attempted()).to.equal(true);
    expect(await recipient.succeeded()).to.equal(false);
    expect(await context.adapter.stateOf(digest)).to.equal(2n);
  });

  it("remains fully backed when forced ETH is donated", async function () {
    const context = await deployFixture();
    const prepared = await defaultTerms(context);
    const digest = await fund(context, prepared);
    const Force = await ethers.getContractFactory("FxForceNative");
    const force = await Force.deploy({ value: 123n });
    await force.force(await context.adapter.getAddress());
    expect(await ethers.provider.getBalance(await context.adapter.getAddress()))
      .to.equal(
        prepared.terms.beneficiaryAmount +
          prepared.terms.executorAmount +
          123n
      );
    await context.adapter
      .connect(context.relayer)
      .claim(prepared.terms, prepared.secret);
    expect(await context.adapter.stateOf(digest)).to.equal(2n);
    expect(
      await ethers.provider.getBalance(await context.adapter.getAddress())
    ).to.equal(123n);
  });

  it("rejects wrong secrets, replay, unsafe deadlines, and direct transfers", async function () {
    const context = await deployFixture();
    const prepared = await defaultTerms(context);
    const digest = await fund(context, prepared);
    await expect(
      context.adapter
        .connect(context.attacker)
        .claim(prepared.terms, ethers.id("wrong"))
    )
      .to.be.revertedWithCustomError(context.adapter, "WrongSecret")
      .withArgs(digest);
    await expect(
      context.adapter.connect(context.funder).fund(prepared.terms, {
        value:
          prepared.terms.beneficiaryAmount + prepared.terms.executorAmount,
      })
    )
      .to.be.revertedWithCustomError(context.adapter, "LockAlreadyExists")
      .withArgs(digest);
    await expect(
      context.funder.sendTransaction({
        to: await context.adapter.getAddress(),
        value: 1n,
      })
    ).to.be.revertedWithCustomError(
      context.adapter,
      "DirectTransferUnsupported"
    );

    const unsafe = await defaultTerms(context, {
      label: "unsafe",
      refundTimestamp: (await latestTimestamp()) + MIN_DURATION - 1,
    });
    await expect(
      context.adapter.connect(context.funder).fund(unsafe.terms, {
        value: unsafe.terms.beneficiaryAmount + unsafe.terms.executorAmount,
      })
    ).to.be.revertedWithCustomError(
      context.adapter,
      "InvalidRefundTimestamp"
    );
  });
});
