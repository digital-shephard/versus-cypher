const { expect } = require("chai");
const { ethers } = require("hardhat");

const MIN_DURATION = 60;
const MAX_DURATION = 7 * 24 * 60 * 60;
const AMOUNT = ethers.parseEther("0.25");

async function latestTimestamp() {
  return Number((await ethers.provider.getBlock("latest")).timestamp);
}

async function deployFixture() {
  const [deployer, funder, beneficiary, refundAddress, relayer, attacker] =
    await ethers.getSigners();
  const Adapter = await ethers.getContractFactory("EvmNativeHtlcV1");
  const adapter = await Adapter.deploy(MIN_DURATION, MAX_DURATION);
  return { deployer, funder, beneficiary, refundAddress, relayer, attacker, adapter };
}

function secretPair(label = "native-secret") {
  const secret = ethers.keccak256(ethers.toUtf8Bytes(label));
  return {
    secret,
    secretHash: ethers.keccak256(ethers.solidityPacked(["bytes32"], [secret])),
  };
}

async function fundDefault(context, overrides = {}) {
  const { secret, secretHash } = secretPair(overrides.secretLabel);
  const lockId =
    overrides.lockId || ethers.keccak256(ethers.toUtf8Bytes(overrides.label || "native-lock"));
  const refundTimestamp =
    overrides.refundTimestamp || (await latestTimestamp()) + MIN_DURATION + 30;
  const amount = overrides.amount || AMOUNT;
  await context.adapter.connect(context.funder).fund(
    lockId,
    overrides.beneficiary || context.beneficiary.address,
    overrides.refundAddress || context.refundAddress.address,
    secretHash,
    refundTimestamp,
    { value: amount }
  );
  return { lockId, secret, secretHash, refundTimestamp, amount };
}

describe("EvmNativeHtlcV1", function () {
  it("has immutable policy and no privileged or arbitrary-call surface", async function () {
    const { adapter } = await deployFixture();
    expect(await adapter.ADAPTER_VERSION()).to.equal(1n);
    expect(await adapter.minimumLockDuration()).to.equal(BigInt(MIN_DURATION));
    expect(await adapter.maximumLockDuration()).to.equal(BigInt(MAX_DURATION));
    for (const signature of [
      "owner()", "pause()", "upgradeTo(address)", "sweep(address)",
      "execute(address,bytes)", "setBeneficiary(address)",
    ]) {
      expect(adapter.interface.hasFunction(signature)).to.equal(false);
    }
  });

  it("funds by exact msg.value and allows public claim to the fixed beneficiary", async function () {
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
        lock.amount
      );
    await expect(transaction).to.changeEtherBalances(
        [context.adapter, context.beneficiary],
        [-lock.amount, lock.amount]
      );
    expect((await context.adapter.getLock(lock.lockId)).state).to.equal(2n);
    expect(await context.adapter.totalLocked()).to.equal(0n);
  });

  it("refunds only after timeout and only to the fixed refund address", async function () {
    const context = await deployFixture();
    const lock = await fundDefault(context);
    await expect(context.adapter.refund(lock.lockId))
      .to.be.revertedWithCustomError(context.adapter, "LockNotExpired");
    await ethers.provider.send("evm_setNextBlockTimestamp", [lock.refundTimestamp]);
    await expect(context.adapter.connect(context.attacker).refund(lock.lockId))
      .to.changeEtherBalances(
        [context.adapter, context.refundAddress],
        [-lock.amount, lock.amount]
      );
    expect((await context.adapter.getLock(lock.lockId)).state).to.equal(3n);
  });

  it("rejects zero value, direct transfers, arbitrary calldata, and bad lock inputs", async function () {
    const context = await deployFixture();
    const { secretHash } = secretPair();
    const timeout = (await latestTimestamp()) + MIN_DURATION + 30;
    await expect(
      context.adapter.fund(
        ethers.id("zero"),
        context.beneficiary.address,
        context.refundAddress.address,
        secretHash,
        timeout
      )
    ).to.be.revertedWithCustomError(context.adapter, "InvalidAmount");
    await expect(
      context.funder.sendTransaction({ to: await context.adapter.getAddress(), value: 1n })
    ).to.be.revertedWithCustomError(context.adapter, "DirectTransferUnsupported");
    await expect(
      context.funder.sendTransaction({
        to: await context.adapter.getAddress(),
        data: "0x12345678",
        value: 1n,
      })
    ).to.be.revertedWithCustomError(context.adapter, "DirectTransferUnsupported");
    await expect(
      context.adapter.fund(
        ethers.ZeroHash,
        context.beneficiary.address,
        context.refundAddress.address,
        secretHash,
        timeout,
        { value: 1n }
      )
    ).to.be.revertedWithCustomError(context.adapter, "InvalidLock");
  });

  it("rejects wrong secrets, replay, unsafe timeouts, and self payout", async function () {
    const context = await deployFixture();
    const lock = await fundDefault(context);
    await expect(context.adapter.claim(lock.lockId, ethers.id("wrong")))
      .to.be.revertedWithCustomError(context.adapter, "WrongSecret");
    await expect(
      context.adapter.connect(context.funder).fund(
        lock.lockId,
        context.beneficiary.address,
        context.refundAddress.address,
        lock.secretHash,
        lock.refundTimestamp,
        { value: 1n }
      )
    ).to.be.revertedWithCustomError(context.adapter, "LockAlreadyExists");
    await expect(
      context.adapter.fund(
        ethers.id("short"),
        context.beneficiary.address,
        context.refundAddress.address,
        lock.secretHash,
        (await latestTimestamp()) + MIN_DURATION - 1,
        { value: 1n }
      )
    ).to.be.revertedWithCustomError(context.adapter, "InvalidRefundTimestamp");
    await expect(
      context.adapter.fund(
        ethers.id("self"),
        await context.adapter.getAddress(),
        context.refundAddress.address,
        lock.secretHash,
        (await latestTimestamp()) + MIN_DURATION + 30,
        { value: 1n }
      )
    ).to.be.revertedWithCustomError(context.adapter, "InvalidParty");
  });

  it("rolls back state when a fixed payout rejects ETH", async function () {
    const context = await deployFixture();
    const Rejector = await ethers.getContractFactory("FxNativeRejector");
    const rejector = await Rejector.deploy();
    const lock = await fundDefault(context, { beneficiary: await rejector.getAddress() });
    await expect(context.adapter.claim(lock.lockId, lock.secret))
      .to.be.revertedWithCustomError(context.adapter, "NativeTransferFailed");
    expect((await context.adapter.getLock(lock.lockId)).state).to.equal(1n);
    expect(await context.adapter.totalLocked()).to.equal(lock.amount);
    expect(await context.adapter.solvent()).to.equal(true);
  });

  it("blocks payout callback reentrancy while completing the original claim", async function () {
    const context = await deployFixture();
    const Recipient = await ethers.getContractFactory("FxNativeReentrantRecipient");
    const recipient = await Recipient.deploy(await context.adapter.getAddress());
    const lock = await fundDefault(context, { beneficiary: await recipient.getAddress() });
    await recipient.configure(lock.lockId, lock.secret);
    await context.adapter.claim(lock.lockId, lock.secret);
    expect(await recipient.attempted()).to.equal(true);
    expect(await recipient.succeeded()).to.equal(false);
    expect((await context.adapter.getLock(lock.lockId)).state).to.equal(2n);
    expect(await ethers.provider.getBalance(await recipient.getAddress())).to.equal(lock.amount);
  });

  it("keeps claim and refund mutually exclusive at the boundary", async function () {
    const context = await deployFixture();
    const lock = await fundDefault(context);
    await ethers.provider.send("evm_setNextBlockTimestamp", [lock.refundTimestamp]);
    await expect(context.adapter.claim(lock.lockId, lock.secret))
      .to.be.revertedWithCustomError(context.adapter, "LockExpired");
    await context.adapter.refund(lock.lockId);
    await expect(context.adapter.claim(lock.lockId, lock.secret))
      .to.be.revertedWithCustomError(context.adapter, "LockNotFunded");
  });
});
