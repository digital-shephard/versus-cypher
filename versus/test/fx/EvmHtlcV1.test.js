const { expect } = require("chai");
const { ethers } = require("hardhat");

const MIN_DURATION = 60;
const MAX_DURATION = 7 * 24 * 60 * 60;
const AMOUNT = 25_000_000n;

async function latestTimestamp() {
  return Number((await ethers.provider.getBlock("latest")).timestamp);
}

async function deployFixture({ tokenFactory = "MockUSDC", expectedDecimals = 6 } = {}) {
  const [deployer, funder, beneficiary, refundAddress, relayer, attacker] =
    await ethers.getSigners();
  const Token = await ethers.getContractFactory(tokenFactory);
  const token =
    tokenFactory === "FxDecimalToken"
      ? await Token.deploy(expectedDecimals)
      : await Token.deploy();
  const Adapter = await ethers.getContractFactory("EvmHtlcV1");
  const adapter = await Adapter.deploy(
    await token.getAddress(),
    expectedDecimals,
    MIN_DURATION,
    MAX_DURATION
  );
  await token.mint(funder.address, AMOUNT * 20n);
  await token.connect(funder).approve(await adapter.getAddress(), ethers.MaxUint256);
  return {
    deployer,
    funder,
    beneficiary,
    refundAddress,
    relayer,
    attacker,
    token,
    adapter,
  };
}

function secretPair(label = "phase-3-secret") {
  const secret = ethers.keccak256(ethers.toUtf8Bytes(label));
  return {
    secret,
    secretHash: ethers.keccak256(ethers.solidityPacked(["bytes32"], [secret])),
  };
}

async function fundDefault(context, overrides = {}) {
  const { funder, beneficiary, refundAddress, adapter } = context;
  const { secret, secretHash } = secretPair(overrides.secretLabel);
  const lockId =
    overrides.lockId || ethers.keccak256(ethers.toUtf8Bytes(overrides.label || "lock-1"));
  const refundTimestamp =
    overrides.refundTimestamp || (await latestTimestamp()) + MIN_DURATION + 30;
  const amount = overrides.amount || AMOUNT;
  await adapter.connect(funder).fund(
    lockId,
    overrides.beneficiary || beneficiary.address,
    overrides.refundAddress || refundAddress.address,
    secretHash,
    refundTimestamp,
    amount
  );
  return { lockId, secret, secretHash, refundTimestamp, amount };
}

describe("EvmHtlcV1", function () {
  it("binds an exact asset and immutable duration policy with no admin surface", async function () {
    const { token, adapter } = await deployFixture();
    expect(await adapter.ADAPTER_VERSION()).to.equal(1n);
    expect(await adapter.asset()).to.equal(await token.getAddress());
    expect(await adapter.assetDecimals()).to.equal(6n);
    expect(await adapter.minimumLockDuration()).to.equal(BigInt(MIN_DURATION));
    expect(await adapter.maximumLockDuration()).to.equal(BigInt(MAX_DURATION));
    for (const signature of [
      "owner()",
      "pause()",
      "unpause()",
      "upgradeTo(address)",
      "setAsset(address)",
      "sweep(address)",
      "execute(address,bytes)",
    ]) {
      expect(adapter.interface.hasFunction(signature)).to.equal(false);
    }
  });

  it("allows a beneficiary to claim with the correct secret", async function () {
    const context = await deployFixture();
    const lock = await fundDefault(context);
    await expect(context.adapter.connect(context.beneficiary).claim(lock.lockId, lock.secret))
      .to.emit(context.adapter, "LockClaimed")
      .withArgs(
        lock.lockId,
        context.beneficiary.address,
        context.beneficiary.address,
        lock.secret,
        lock.amount
      );
    expect(await context.token.balanceOf(context.beneficiary.address)).to.equal(lock.amount);
    expect((await context.adapter.getLock(lock.lockId)).state).to.equal(2n);
    expect(await context.adapter.totalLocked()).to.equal(0n);
  });

  it("rejects the wrong secret without changing custody", async function () {
    const context = await deployFixture();
    const lock = await fundDefault(context);
    const wrongSecret = ethers.keccak256(ethers.toUtf8Bytes("wrong"));
    await expect(
      context.adapter.connect(context.attacker).claim(lock.lockId, wrongSecret)
    ).to.be.revertedWithCustomError(context.adapter, "WrongSecret");
    expect((await context.adapter.getLock(lock.lockId)).state).to.equal(1n);
    expect(await context.adapter.totalLocked()).to.equal(lock.amount);
    expect(await context.adapter.solvent()).to.equal(true);
  });

  it("lets a third party submit a claim but never redirects payout", async function () {
    const context = await deployFixture();
    const lock = await fundDefault(context);
    await context.adapter.connect(context.relayer).claim(lock.lockId, lock.secret);
    expect(await context.token.balanceOf(context.relayer.address)).to.equal(0n);
    expect(await context.token.balanceOf(context.attacker.address)).to.equal(0n);
    expect(await context.token.balanceOf(context.beneficiary.address)).to.equal(lock.amount);
  });

  it("rejects early refund and permits a third-party refund to the fixed address", async function () {
    const context = await deployFixture();
    const lock = await fundDefault(context);
    await expect(
      context.adapter.connect(context.relayer).refund(lock.lockId)
    ).to.be.revertedWithCustomError(context.adapter, "LockNotExpired");
    await ethers.provider.send("evm_setNextBlockTimestamp", [lock.refundTimestamp]);
    await expect(context.adapter.connect(context.relayer).refund(lock.lockId))
      .to.emit(context.adapter, "LockRefunded")
      .withArgs(
        lock.lockId,
        context.relayer.address,
        context.refundAddress.address,
        lock.amount
      );
    expect(await context.token.balanceOf(context.refundAddress.address)).to.equal(lock.amount);
    expect(await context.token.balanceOf(context.relayer.address)).to.equal(0n);
  });

  it("makes claim and refund mutually exclusive at the timeout boundary", async function () {
    const context = await deployFixture();
    const lock = await fundDefault(context);
    await ethers.provider.send("evm_setNextBlockTimestamp", [lock.refundTimestamp]);
    await expect(
      context.adapter.connect(context.relayer).claim(lock.lockId, lock.secret)
    ).to.be.revertedWithCustomError(context.adapter, "LockExpired");
    await context.adapter.connect(context.relayer).refund(lock.lockId);
    await expect(
      context.adapter.connect(context.beneficiary).claim(lock.lockId, lock.secret)
    ).to.be.revertedWithCustomError(context.adapter, "LockNotFunded");
  });

  it("rejects lock replay even after settlement", async function () {
    const context = await deployFixture();
    const lock = await fundDefault(context);
    await context.adapter.connect(context.relayer).claim(lock.lockId, lock.secret);
    await expect(
      context.adapter.connect(context.funder).fund(
        lock.lockId,
        context.beneficiary.address,
        context.refundAddress.address,
        lock.secretHash,
        (await latestTimestamp()) + MIN_DURATION + 30,
        lock.amount
      )
    ).to.be.revertedWithCustomError(context.adapter, "LockAlreadyExists");
  });

  it("rejects decimal mismatch during deployment", async function () {
    const Token = await ethers.getContractFactory("FxDecimalToken");
    const token = await Token.deploy(18);
    const Adapter = await ethers.getContractFactory("EvmHtlcV1");
    await expect(
      Adapter.deploy(await token.getAddress(), 6, MIN_DURATION, MAX_DURATION)
    )
      .to.be.revertedWithCustomError(Adapter, "DecimalMismatch")
      .withArgs(6, 18);
  });

  it("rejects fee-on-transfer funding atomically", async function () {
    const context = await deployFixture({ tokenFactory: "FxFeeOnTransferToken" });
    const { secretHash } = secretPair();
    const lockId = ethers.keccak256(ethers.toUtf8Bytes("fee-lock"));
    await expect(
      context.adapter.connect(context.funder).fund(
        lockId,
        context.beneficiary.address,
        context.refundAddress.address,
        secretHash,
        (await latestTimestamp()) + MIN_DURATION + 30,
        AMOUNT
      )
    ).to.be.revertedWithCustomError(context.adapter, "UnsupportedTokenBehavior");
    expect((await context.adapter.getLock(lockId)).state).to.equal(0n);
    expect(await context.adapter.totalLocked()).to.equal(0n);
    expect(await context.token.balanceOf(await context.adapter.getAddress())).to.equal(0n);
  });

  it("blocks callback reentrancy without corrupting the funded lock", async function () {
    const context = await deployFixture({ tokenFactory: "FxCallbackToken" });
    await context.token.setCallbackTarget(await context.adapter.getAddress());
    const lock = await fundDefault(context);
    expect(await context.token.callbackAttempted()).to.equal(true);
    expect(await context.token.callbackSucceeded()).to.equal(false);
    expect((await context.adapter.getLock(lock.lockId)).state).to.equal(1n);
    expect(await context.adapter.totalLocked()).to.equal(lock.amount);
    expect(await context.adapter.solvent()).to.equal(true);
  });

  it("rejects invalid timeout ordering at funding", async function () {
    const context = await deployFixture();
    const { secretHash } = secretPair();
    const now = await latestTimestamp();
    for (const refundTimestamp of [
      now + MIN_DURATION - 10,
      now + MAX_DURATION + 100,
    ]) {
      await expect(
        context.adapter.connect(context.funder).fund(
          ethers.keccak256(ethers.toUtf8Bytes(`timeout-${refundTimestamp}`)),
          context.beneficiary.address,
          context.refundAddress.address,
          secretHash,
          refundTimestamp,
          AMOUNT
        )
      ).to.be.revertedWithCustomError(context.adapter, "InvalidRefundTimestamp");
    }
  });

  it("rejects payout addresses that would strand funds in the adapter", async function () {
    const context = await deployFixture();
    const { secretHash } = secretPair();
    const adapterAddress = await context.adapter.getAddress();
    for (const [beneficiary, refundAddress, label] of [
      [adapterAddress, context.refundAddress.address, "beneficiary"],
      [context.beneficiary.address, adapterAddress, "refund"],
    ]) {
      await expect(
        context.adapter.connect(context.funder).fund(
          ethers.keccak256(ethers.toUtf8Bytes(`self-${label}`)),
          beneficiary,
          refundAddress,
          secretHash,
          (await latestTimestamp()) + MIN_DURATION + 30,
          AMOUNT
        )
      ).to.be.revertedWithCustomError(context.adapter, "InvalidParty");
    }
  });

  it("rejects native value and arbitrary calldata", async function () {
    const { funder, adapter } = await deployFixture();
    await expect(
      funder.sendTransaction({ to: await adapter.getAddress(), value: 1n })
    ).to.be.revertedWithCustomError(adapter, "NativeAssetUnsupported");
    await expect(
      funder.sendTransaction({
        to: await adapter.getAddress(),
        data: "0x12345678",
      })
    ).to.be.revertedWithCustomError(adapter, "NativeAssetUnsupported");
  });
});
