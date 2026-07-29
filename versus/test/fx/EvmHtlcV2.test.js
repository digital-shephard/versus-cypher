const { expect } = require("chai");
const { ethers } = require("hardhat");

const MIN_DURATION = 60;
const MAX_DURATION = 7 * 24 * 60 * 60;
const BENEFICIARY_AMOUNT = 25_000_000n;
const EXECUTOR_AMOUNT = 200_000n;

async function latestTimestamp() {
  return Number((await ethers.provider.getBlock("latest")).timestamp);
}

async function deployFixture({ tokenFactory = "MockUSDC" } = {}) {
  const [deployer, funder, beneficiary, refundAddress, relayer, attacker] =
    await ethers.getSigners();
  const Token = await ethers.getContractFactory(tokenFactory);
  const token = await Token.deploy();
  const Adapter = await ethers.getContractFactory("EvmHtlcV2");
  const adapter = await Adapter.deploy(
    await token.getAddress(),
    6,
    MIN_DURATION,
    MAX_DURATION
  );
  await token.mint(funder.address, (BENEFICIARY_AMOUNT + EXECUTOR_AMOUNT) * 20n);
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

function secretPair(label = "erc20-v2-secret") {
  const secret = ethers.keccak256(ethers.toUtf8Bytes(label));
  return {
    secret,
    secretHash: ethers.keccak256(ethers.solidityPacked(["bytes32"], [secret])),
  };
}

async function fundDefault(context, overrides = {}) {
  const { secret, secretHash } = secretPair(overrides.secretLabel);
  const lockId =
    overrides.lockId || ethers.keccak256(ethers.toUtf8Bytes(overrides.label || "erc20-v2-lock"));
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
    executorAmount
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

describe("EvmHtlcV2", function () {
  it("binds the token and exposes no privileged surface", async function () {
    const { token, adapter } = await deployFixture();
    expect(await adapter.ADAPTER_VERSION()).to.equal(2n);
    expect(await adapter.asset()).to.equal(await token.getAddress());
    expect(await adapter.assetDecimals()).to.equal(6n);
    for (const signature of [
      "owner()",
      "pause()",
      "upgradeTo(address)",
      "sweep(address)",
      "execute(address,bytes)",
    ]) {
      expect(adapter.interface.hasFunction(signature)).to.equal(false);
    }
  });

  it("pays exact output and executor bounty atomically", async function () {
    const context = await deployFixture();
    const lock = await fundDefault(context);
    await expect(
      context.adapter.connect(context.relayer).claim(lock.lockId, lock.secret)
    )
      .to.emit(context.adapter, "LockClaimed")
      .withArgs(
        lock.lockId,
        context.relayer.address,
        context.beneficiary.address,
        lock.secret,
        lock.beneficiaryAmount,
        lock.executorAmount
      );
    expect(await context.token.balanceOf(context.beneficiary.address)).to.equal(
      lock.beneficiaryAmount
    );
    expect(await context.token.balanceOf(context.relayer.address)).to.equal(
      lock.executorAmount
    );
    expect(await context.adapter.totalLocked()).to.equal(0n);
  });

  it("supports zero-bounty source locks without paying the caller", async function () {
    const context = await deployFixture();
    const lock = await fundDefault(context, { executorAmount: 0n });
    await context.adapter.connect(context.relayer).claim(lock.lockId, lock.secret);
    expect(await context.token.balanceOf(context.beneficiary.address)).to.equal(
      lock.beneficiaryAmount
    );
    expect(await context.token.balanceOf(context.relayer.address)).to.equal(0n);
  });

  it("refunds output and unspent bounty to the fixed refund address", async function () {
    const context = await deployFixture();
    const lock = await fundDefault(context);
    await ethers.provider.send("evm_setNextBlockTimestamp", [lock.refundTimestamp]);
    await context.adapter.connect(context.attacker).refund(lock.lockId);
    expect(await context.token.balanceOf(context.refundAddress.address)).to.equal(
      lock.beneficiaryAmount + lock.executorAmount
    );
    expect(await context.token.balanceOf(context.attacker.address)).to.equal(0n);
    expect(await context.adapter.totalLocked()).to.equal(0n);
  });

  it("rejects fee-on-transfer funding without recording a lock", async function () {
    const context = await deployFixture({ tokenFactory: "FxFeeOnTransferToken" });
    const { secretHash } = secretPair();
    const lockId = ethers.id("fee-v2");
    await expect(
      context.adapter.connect(context.funder).fund(
        lockId,
        context.beneficiary.address,
        context.refundAddress.address,
        secretHash,
        (await latestTimestamp()) + MIN_DURATION + 30,
        BENEFICIARY_AMOUNT,
        EXECUTOR_AMOUNT
      )
    ).to.be.revertedWithCustomError(context.adapter, "UnsupportedTokenBehavior");
    expect((await context.adapter.getLock(lockId)).state).to.equal(0n);
    expect(await context.adapter.totalLocked()).to.equal(0n);
  });

  it("makes competing executors idempotent", async function () {
    const context = await deployFixture();
    const lock = await fundDefault(context);
    await context.adapter.connect(context.relayer).claim(lock.lockId, lock.secret);
    await expect(
      context.adapter.connect(context.attacker).claim(lock.lockId, lock.secret)
    ).to.be.revertedWithCustomError(context.adapter, "LockNotFunded");
    expect(await context.token.balanceOf(context.relayer.address)).to.equal(
      lock.executorAmount
    );
    expect(await context.token.balanceOf(context.attacker.address)).to.equal(0n);
  });

  it("rejects wrong secrets, replay, invalid amounts, and native value", async function () {
    const context = await deployFixture();
    const lock = await fundDefault(context);
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
        lock.executorAmount
      )
    ).to.be.revertedWithCustomError(context.adapter, "LockAlreadyExists");
    await expect(
      context.adapter.connect(context.funder).fund(
        ethers.id("zero-v2"),
        context.beneficiary.address,
        context.refundAddress.address,
        lock.secretHash,
        (await latestTimestamp()) + MIN_DURATION + 30,
        0,
        EXECUTOR_AMOUNT
      )
    ).to.be.revertedWithCustomError(context.adapter, "InvalidAmount");
    await expect(
      context.funder.sendTransaction({ to: await context.adapter.getAddress(), value: 1n })
    ).to.be.revertedWithCustomError(context.adapter, "NativeAssetUnsupported");
  });
});
