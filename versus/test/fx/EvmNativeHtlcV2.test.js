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
  const [deployer, funder, beneficiary, refundAddress, relayer, attacker] =
    await ethers.getSigners();
  const Adapter = await ethers.getContractFactory("EvmNativeHtlcV2");
  const adapter = await Adapter.deploy(MIN_DURATION, MAX_DURATION);
  return { deployer, funder, beneficiary, refundAddress, relayer, attacker, adapter };
}

function secretPair(label = "native-v2-secret") {
  const secret = ethers.keccak256(ethers.toUtf8Bytes(label));
  return {
    secret,
    secretHash: ethers.keccak256(ethers.solidityPacked(["bytes32"], [secret])),
  };
}

async function fundDefault(context, overrides = {}) {
  const { secret, secretHash } = secretPair(overrides.secretLabel);
  const lockId =
    overrides.lockId || ethers.keccak256(ethers.toUtf8Bytes(overrides.label || "native-v2-lock"));
  const refundTimestamp =
    overrides.refundTimestamp || (await latestTimestamp()) + MIN_DURATION + 30;
  const beneficiaryAmount = overrides.beneficiaryAmount ?? BENEFICIARY_AMOUNT;
  const executorAmount = overrides.executorAmount ?? EXECUTOR_AMOUNT;
  await context.adapter.connect(context.funder).fund(
    lockId,
    overrides.beneficiary || context.beneficiary.address,
    overrides.refundAddress || context.refundAddress.address,
    secretHash,
    refundTimestamp,
    beneficiaryAmount,
    executorAmount,
    { value: beneficiaryAmount + executorAmount }
  );
  return {
    lockId,
    secret,
    secretHash,
    refundTimestamp,
    beneficiaryAmount,
    executorAmount,
  };
}

describe("EvmNativeHtlcV2", function () {
  it("is an ownerless version-two adapter", async function () {
    const { adapter } = await deployFixture();
    expect(await adapter.ADAPTER_VERSION()).to.equal(2n);
    expect(await adapter.minimumLockDuration()).to.equal(BigInt(MIN_DURATION));
    expect(await adapter.maximumLockDuration()).to.equal(BigInt(MAX_DURATION));
    for (const signature of [
      "owner()",
      "pause()",
      "upgradeTo(address)",
      "sweep(address)",
      "execute(address,bytes)",
      "setBeneficiary(address)",
    ]) {
      expect(adapter.interface.hasFunction(signature)).to.equal(false);
    }
  });

  it("pays the exact output to the recipient and the bounty to the successful relayer", async function () {
    const context = await deployFixture();
    const lock = await fundDefault(context);
    const transaction = context.adapter.connect(context.relayer).claim(
      lock.lockId,
      lock.secret
    );
    await expect(transaction)
      .to.emit(context.adapter, "LockClaimed")
      .withArgs(
        lock.lockId,
        context.relayer.address,
        context.beneficiary.address,
        lock.secret,
        lock.beneficiaryAmount,
        lock.executorAmount
      );
    await expect(transaction).to.changeEtherBalances(
      [context.adapter, context.beneficiary, context.relayer],
      [
        -(lock.beneficiaryAmount + lock.executorAmount),
        lock.beneficiaryAmount,
        lock.executorAmount,
      ]
    );
    expect((await context.adapter.getLock(lock.lockId)).state).to.equal(2n);
    expect(await context.adapter.totalLocked()).to.equal(0n);
  });

  it("supports a source lock with no executor bounty", async function () {
    const context = await deployFixture();
    const lock = await fundDefault(context, { executorAmount: 0n });
    await expect(
      context.adapter.connect(context.relayer).claim(lock.lockId, lock.secret)
    ).to.changeEtherBalances(
      [context.adapter, context.beneficiary],
      [-lock.beneficiaryAmount, lock.beneficiaryAmount]
    );
    expect(await context.adapter.totalLocked()).to.equal(0n);
  });

  it("requires exact funding and a nonzero beneficiary amount", async function () {
    const context = await deployFixture();
    const { secretHash } = secretPair();
    const timeout = (await latestTimestamp()) + MIN_DURATION + 30;
    const args = [
      ethers.id("incorrect-value"),
      context.beneficiary.address,
      context.refundAddress.address,
      secretHash,
      timeout,
      BENEFICIARY_AMOUNT,
      EXECUTOR_AMOUNT,
    ];
    await expect(
      context.adapter.connect(context.funder).fund(...args, {
        value: BENEFICIARY_AMOUNT + EXECUTOR_AMOUNT - 1n,
      })
    )
      .to.be.revertedWithCustomError(context.adapter, "IncorrectValue")
      .withArgs(BENEFICIARY_AMOUNT + EXECUTOR_AMOUNT, BENEFICIARY_AMOUNT + EXECUTOR_AMOUNT - 1n);
    await expect(
      context.adapter.connect(context.funder).fund(
        ethers.id("zero-beneficiary"),
        context.beneficiary.address,
        context.refundAddress.address,
        secretHash,
        timeout,
        0,
        EXECUTOR_AMOUNT,
        { value: EXECUTOR_AMOUNT }
      )
    ).to.be.revertedWithCustomError(context.adapter, "InvalidAmount");
  });

  it("lets any caller trigger refund but returns output and bounty to the fixed refund address", async function () {
    const context = await deployFixture();
    const lock = await fundDefault(context);
    await ethers.provider.send("evm_setNextBlockTimestamp", [lock.refundTimestamp]);
    await expect(context.adapter.connect(context.attacker).refund(lock.lockId))
      .to.emit(context.adapter, "LockRefunded")
      .withArgs(
        lock.lockId,
        context.attacker.address,
        context.refundAddress.address,
        lock.beneficiaryAmount + lock.executorAmount
      );
    expect((await context.adapter.getLock(lock.lockId)).state).to.equal(3n);
    expect(await context.adapter.totalLocked()).to.equal(0n);
  });

  it("makes competing execution and refund attempts idempotent", async function () {
    const context = await deployFixture();
    const lock = await fundDefault(context);
    await context.adapter.connect(context.relayer).claim(lock.lockId, lock.secret);
    await expect(
      context.adapter.connect(context.attacker).claim(lock.lockId, lock.secret)
    ).to.be.revertedWithCustomError(context.adapter, "LockNotFunded");
    await expect(
      context.adapter.connect(context.attacker).refund(lock.lockId)
    ).to.be.revertedWithCustomError(context.adapter, "LockNotFunded");
  });

  it("rolls back both payouts if either fixed transfer rejects", async function () {
    const context = await deployFixture();
    const Rejector = await ethers.getContractFactory("FxNativeRejector");
    const rejector = await Rejector.deploy();
    const lock = await fundDefault(context, { beneficiary: await rejector.getAddress() });
    await expect(
      context.adapter.connect(context.relayer).claim(lock.lockId, lock.secret)
    ).to.be.revertedWithCustomError(context.adapter, "NativeTransferFailed");
    expect((await context.adapter.getLock(lock.lockId)).state).to.equal(1n);
    expect(await context.adapter.totalLocked()).to.equal(
      lock.beneficiaryAmount + lock.executorAmount
    );
    expect(await context.adapter.solvent()).to.equal(true);
  });

  it("rejects direct transfers, wrong secrets, replay, and unsafe timeouts", async function () {
    const context = await deployFixture();
    const lock = await fundDefault(context);
    await expect(
      context.funder.sendTransaction({ to: await context.adapter.getAddress(), value: 1n })
    ).to.be.revertedWithCustomError(context.adapter, "DirectTransferUnsupported");
    await expect(
      context.adapter.connect(context.attacker).claim(lock.lockId, ethers.id("wrong"))
    ).to.be.revertedWithCustomError(context.adapter, "WrongSecret");
    await expect(
      context.adapter.connect(context.funder).fund(
        lock.lockId,
        context.beneficiary.address,
        context.refundAddress.address,
        lock.secretHash,
        lock.refundTimestamp,
        lock.beneficiaryAmount,
        lock.executorAmount,
        { value: lock.beneficiaryAmount + lock.executorAmount }
      )
    ).to.be.revertedWithCustomError(context.adapter, "LockAlreadyExists");
    await expect(
      context.adapter.connect(context.funder).fund(
        ethers.id("short-v2"),
        context.beneficiary.address,
        context.refundAddress.address,
        lock.secretHash,
        (await latestTimestamp()) + MIN_DURATION - 1,
        1,
        0,
        { value: 1 }
      )
    ).to.be.revertedWithCustomError(context.adapter, "InvalidRefundTimestamp");
  });
});
