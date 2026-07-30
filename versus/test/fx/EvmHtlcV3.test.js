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
  const [deployer, funder, beneficiary, relayer, attacker] =
    await ethers.getSigners();
  const Token = await ethers.getContractFactory(tokenFactory);
  const token = await Token.deploy();
  const Adapter = await ethers.getContractFactory("EvmHtlcV3");
  const adapter = await Adapter.deploy(
    await token.getAddress(),
    6,
    MIN_DURATION,
    MAX_DURATION
  );
  await token.mint(funder.address, (BENEFICIARY_AMOUNT + EXECUTOR_AMOUNT) * 20n);
  await token
    .connect(funder)
    .approve(await adapter.getAddress(), ethers.MaxUint256);
  return {
    deployer,
    funder,
    beneficiary,
    relayer,
    attacker,
    token,
    adapter,
  };
}

function secretPair(label = "erc20-v3-secret") {
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
        ethers.keccak256(ethers.toUtf8Bytes(overrides.label || "erc20-v3-trade")),
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
  const transaction = await context.adapter
    .connect(context.funder)
    .fund(prepared.terms);
  await transaction.wait();
  return context.adapter.lockDigest(prepared.terms);
}

describe("EvmHtlcV3", function () {
  it("binds one exact token and exposes no privileged surface", async function () {
    const { token, adapter } = await deployFixture();
    expect(await adapter.ADAPTER_VERSION()).to.equal(3n);
    expect(await adapter.asset()).to.equal(await token.getAddress());
    expect(await adapter.assetDecimals()).to.equal(6n);
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
    const Adapter = await ethers.getContractFactory("EvmHtlcV3");
    const second = await Adapter.deploy(
      await context.token.getAddress(),
      6,
      MIN_DURATION,
      MAX_DURATION
    );
    const prepared = await defaultTerms(context);
    const digest = await context.adapter.lockDigest(prepared.terms);
    expect(await second.lockDigest(prepared.terms)).not.to.equal(digest);
    expect(
      await context.adapter.lockDigest({
        ...prepared.terms,
        beneficiaryAmount: prepared.terms.beneficiaryAmount + 1n,
      })
    ).not.to.equal(digest);
  });

  it("pays exact token output and the permissionless executor bounty", async function () {
    const context = await deployFixture();
    const prepared = await defaultTerms(context);
    const digest = await fund(context, prepared);
    await expect(
      context.adapter
        .connect(context.relayer)
        .claim(prepared.terms, prepared.secret)
    )
      .to.emit(context.adapter, "LockClaimed")
      .withArgs(
        digest,
        prepared.terms.tradeId,
        context.relayer.address,
        prepared.secret
      );
    expect(await context.token.balanceOf(context.beneficiary.address)).to.equal(
      prepared.terms.beneficiaryAmount
    );
    expect(await context.token.balanceOf(context.relayer.address)).to.equal(
      prepared.terms.executorAmount
    );
    expect(await context.adapter.stateOf(digest)).to.equal(2n);
  });

  it("binds the same terms through the compact funding and claim selectors", async function () {
    const context = await deployFixture();
    const prepared = await defaultTerms(context);
    const settlement = packSettlement(prepared.terms);
    const digest = await context.adapter.lockDigest(prepared.terms);

    await context.adapter
      .connect(context.funder)
      ["fund(bytes32,address,bytes32,uint256)"](
        prepared.terms.tradeId,
        prepared.terms.beneficiary,
        prepared.terms.secretHash,
        settlement
      );
    await context.adapter
      .connect(context.relayer)
      ["claim(bytes32,address,address,uint256,bytes32)"](
        prepared.terms.tradeId,
        prepared.terms.funder,
        prepared.terms.beneficiary,
        settlement,
        prepared.secret
      );

    expect(await context.token.balanceOf(context.beneficiary.address)).to.equal(
      prepared.terms.beneficiaryAmount
    );
    expect(await context.token.balanceOf(context.relayer.address)).to.equal(
      prepared.terms.executorAmount
    );
    expect(await context.adapter.stateOf(digest)).to.equal(2n);
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

  it("combines exact payouts when the beneficiary is also the executor", async function () {
    const context = await deployFixture();
    const prepared = await defaultTerms(context, {
      beneficiary: context.relayer.address,
    });
    await fund(context, prepared);
    await context.adapter
      .connect(context.relayer)
      .claim(prepared.terms, prepared.secret);
    expect(await context.token.balanceOf(context.relayer.address)).to.equal(
      prepared.terms.beneficiaryAmount + prepared.terms.executorAmount
    );
  });

  it("supports a zero-bounty source lock", async function () {
    const context = await deployFixture();
    const prepared = await defaultTerms(context, { executorAmount: 0n });
    await fund(context, prepared);
    await context.adapter
      .connect(context.attacker)
      .claim(prepared.terms, prepared.secret);
    expect(await context.token.balanceOf(context.beneficiary.address)).to.equal(
      prepared.terms.beneficiaryAmount
    );
    expect(await context.token.balanceOf(context.attacker.address)).to.equal(0n);
  });

  it("refunds every token liability to the committed funder", async function () {
    const context = await deployFixture();
    const prepared = await defaultTerms(context);
    const digest = await fund(context, prepared);
    await ethers.provider.send("evm_setNextBlockTimestamp", [
      prepared.terms.refundTimestamp,
    ]);
    const before = await context.token.balanceOf(context.funder.address);
    await context.adapter.connect(context.attacker).refund(prepared.terms);
    expect(await context.token.balanceOf(context.funder.address)).to.equal(
      before +
        prepared.terms.beneficiaryAmount +
        prepared.terms.executorAmount
    );
    expect(await context.adapter.stateOf(digest)).to.equal(3n);
  });

  it("rejects fee-on-transfer funding and rolls state back to empty", async function () {
    const context = await deployFixture({
      tokenFactory: "FxFeeOnTransferToken",
    });
    const prepared = await defaultTerms(context);
    const digest = await context.adapter.lockDigest(prepared.terms);
    await expect(
      context.adapter.connect(context.funder).fund(prepared.terms)
    ).to.be.revertedWithCustomError(
      context.adapter,
      "UnsupportedTokenBehavior"
    );
    expect(await context.adapter.stateOf(digest)).to.equal(0n);
  });

  it("blocks token-callback reentrancy with transient state", async function () {
    const context = await deployFixture({
      tokenFactory: "FxArbitraryCallbackToken",
    });
    const prepared = await defaultTerms(context);
    const reentrant = await defaultTerms(
      {
        ...context,
        funder: { address: await context.token.getAddress() },
      },
      {
        label: "reentrant-v3",
        funder: await context.token.getAddress(),
      }
    );
    await context.token.configureCallback(
      await context.adapter.getAddress(),
      context.adapter.interface.encodeFunctionData(
        "fund((bytes32,address,address,bytes32,uint64,uint128,uint128))",
        [reentrant.terms]
      )
    );
    await fund(context, prepared);
    expect(await context.token.callbackAttempted()).to.equal(true);
    expect(await context.token.callbackSucceeded()).to.equal(false);
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

  it("rejects wrong secrets, replay, native value, and unsafe deadlines", async function () {
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
      context.adapter.connect(context.funder).fund(prepared.terms)
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
      "NativeAssetUnsupported"
    );

    const unsafe = await defaultTerms(context, {
      label: "unsafe",
      refundTimestamp: (await latestTimestamp()) + MIN_DURATION - 1,
    });
    await expect(
      context.adapter.connect(context.funder).fund(unsafe.terms)
    ).to.be.revertedWithCustomError(
      context.adapter,
      "InvalidRefundTimestamp"
    );
  });
});
