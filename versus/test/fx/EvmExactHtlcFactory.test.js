const { expect } = require("chai");
const { ethers } = require("hardhat");

const MIN_DURATION = 60;
const MAX_DURATION = 7 * 24 * 60 * 60;
const AMOUNT = 1_000_000n;
const BOUNTY = 5_000n;

async function latestTimestamp() {
  return Number((await ethers.provider.getBlock("latest")).timestamp);
}

function secretPair(label = "generic-exact-secret") {
  const secret = ethers.keccak256(ethers.toUtf8Bytes(label));
  return {
    secret,
    secretHash: ethers.keccak256(ethers.solidityPacked(["bytes32"], [secret])),
  };
}

function packSettlement(refundTimestamp, amount = AMOUNT, bounty = BOUNTY) {
  return (
    (BigInt(refundTimestamp) << 192n) |
    (BigInt(amount) << 96n) |
    BigInt(bounty)
  );
}

async function deployFixture() {
  const [deployer, payer, beneficiary, executor, facilitator, attacker] =
    await ethers.getSigners();
  const Token = await ethers.getContractFactory("MockEip3009USDC");
  const token = await Token.deploy();
  const Htlc = await ethers.getContractFactory("EvmHtlcV3");
  const htlc = await Htlc.deploy(
    await token.getAddress(),
    6,
    MIN_DURATION,
    MAX_DURATION
  );
  const Factory = await ethers.getContractFactory("EvmExactHtlcFactory");
  const factory = await Factory.deploy(
    await token.getAddress(),
    await htlc.getAddress()
  );
  await token.mint(payer.address, 100_000_000n);
  return {
    deployer,
    payer,
    beneficiary,
    executor,
    facilitator,
    attacker,
    token,
    htlc,
    factory,
  };
}

async function makeTerms(context, overrides = {}) {
  const { secret, secretHash } = secretPair(overrides.secretLabel);
  const refundTimestamp =
    overrides.refundTimestamp ?? (await latestTimestamp()) + MIN_DURATION + 60;
  const beneficiaryAmount = overrides.beneficiaryAmount ?? AMOUNT;
  const executorAmount = overrides.executorAmount ?? BOUNTY;
  return {
    secret,
    beneficiaryAmount,
    executorAmount,
    lock: {
      payer: overrides.payer ?? context.payer.address,
      tradeId:
        overrides.tradeId ??
        ethers.keccak256(
          ethers.toUtf8Bytes(overrides.label ?? "generic-exact-trade")
        ),
      beneficiary: overrides.beneficiary ?? context.beneficiary.address,
      facilitator: overrides.facilitator ?? ethers.ZeroAddress,
      facilitatorAmount: overrides.facilitatorAmount ?? 0n,
      secretHash: overrides.secretHash ?? secretHash,
      settlement: packSettlement(
        refundTimestamp,
        beneficiaryAmount,
        executorAmount
      ),
    },
    refundTimestamp,
  };
}

async function signAuthorization(context, prepared, overrides = {}) {
  const escrow = await context.factory.predictEscrow(prepared.lock);
  const network = await ethers.provider.getNetwork();
  const nonce =
    overrides.nonce ?? ethers.keccak256(ethers.randomBytes(32));
  const authorization = {
    from: overrides.from ?? context.payer.address,
    to: overrides.to ?? escrow,
    value: overrides.value ?? await context.factory.amountFor(prepared.lock),
    validAfter: overrides.validAfter ?? 0,
    validBefore:
      overrides.validBefore ?? (await latestTimestamp()) + 10 * 60,
    nonce,
  };
  const signature = await context.payer.signTypedData(
    {
      name: "Mock EIP3009 USDC",
      version: "2",
      chainId: network.chainId,
      verifyingContract: await context.token.getAddress(),
    },
    {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    authorization
  );
  return { authorization, signature, escrow };
}

function htlcTerms(prepared, escrow) {
  return {
    tradeId: prepared.lock.tradeId,
    funder: escrow,
    beneficiary: prepared.lock.beneficiary,
    secretHash: prepared.lock.secretHash,
    refundTimestamp: prepared.refundTimestamp,
    beneficiaryAmount: prepared.beneficiaryAmount,
    executorAmount: prepared.executorAmount,
  };
}

describe("EvmExactHtlcFactory", function () {
  it("has no privileged or arbitrary-call surface", async function () {
    const { factory } = await deployFixture();
    for (const signature of [
      "owner()",
      "pause()",
      "upgradeTo(address)",
      "sweep(address)",
      "execute(address,bytes)",
    ]) {
      expect(factory.interface.hasFunction(signature)).to.equal(false);
    }
  });

  it("atomically converts a stock EIP-3009 exact payment into a V3 lock", async function () {
    const context = await deployFixture();
    const prepared = await makeTerms(context);
    const signed = await signAuthorization(context, prepared);
    const terms = htlcTerms(prepared, signed.escrow);
    const digest = await context.htlc.lockDigest(terms);

    await expect(
      context.factory
        .connect(context.attacker)
        .settleEip3009(prepared.lock, signed.authorization, signed.signature)
    )
      .to.emit(context.factory, "ExactPaymentSettled")
      .withArgs(
        prepared.lock.tradeId,
        context.payer.address,
        signed.escrow,
        prepared.beneficiaryAmount + prepared.executorAmount,
        ethers.ZeroAddress,
        0n,
        signed.authorization.nonce
      );

    expect(await context.htlc.stateOf(digest)).to.equal(1n);
    expect(await context.token.balanceOf(await context.htlc.getAddress())).to.equal(
      prepared.beneficiaryAmount + prepared.executorAmount
    );
    expect(await context.token.balanceOf(signed.escrow)).to.equal(0n);
  });

  it("atomically pays a disclosed facilitator fee and locks only dealer principal", async function () {
    const context = await deployFixture();
    const facilitatorAmount = 12_345n;
    const prepared = await makeTerms(context, {
      facilitator: context.facilitator.address,
      facilitatorAmount,
    });
    const signed = await signAuthorization(context, prepared);
    const facilitatorBefore = await context.token.balanceOf(
      context.facilitator.address
    );

    await expect(
      context.factory.settleEip3009(
        prepared.lock,
        signed.authorization,
        signed.signature
      )
    )
      .to.emit(context.factory, "ExactPaymentSettled")
      .withArgs(
        prepared.lock.tradeId,
        context.payer.address,
        signed.escrow,
        prepared.beneficiaryAmount + prepared.executorAmount + facilitatorAmount,
        context.facilitator.address,
        facilitatorAmount,
        signed.authorization.nonce
      );

    expect(await context.token.balanceOf(context.facilitator.address)).to.equal(
      facilitatorBefore + facilitatorAmount
    );
    expect(await context.token.balanceOf(await context.htlc.getAddress())).to.equal(
      prepared.beneficiaryAmount + prepared.executorAmount
    );
    expect(await context.token.balanceOf(signed.escrow)).to.equal(0n);
  });

  it("pays the fixed beneficiary and permissionless executor after reveal", async function () {
    const context = await deployFixture();
    const prepared = await makeTerms(context);
    const signed = await signAuthorization(context, prepared);
    await context.factory.settleEip3009(
      prepared.lock,
      signed.authorization,
      signed.signature
    );

    await context.htlc
      .connect(context.executor)
      .claim(htlcTerms(prepared, signed.escrow), prepared.secret);
    expect(await context.token.balanceOf(context.beneficiary.address)).to.equal(
      prepared.beneficiaryAmount
    );
    expect(await context.token.balanceOf(context.executor.address)).to.equal(
      prepared.executorAmount
    );
  });

  it("changes payTo whenever any committed lock term changes", async function () {
    const context = await deployFixture();
    const prepared = await makeTerms(context);
    const original = await context.factory.predictEscrow(prepared.lock);
    const variants = [
      { ...prepared.lock, payer: context.attacker.address },
      { ...prepared.lock, tradeId: ethers.keccak256(ethers.toUtf8Bytes("other")) },
      { ...prepared.lock, beneficiary: context.attacker.address },
      {
        ...prepared.lock,
        facilitator: context.facilitator.address,
        facilitatorAmount: 1n,
      },
      { ...prepared.lock, secretHash: ethers.keccak256(ethers.toUtf8Bytes("other")) },
      { ...prepared.lock, settlement: prepared.lock.settlement + (1n << 96n) },
    ];
    for (const variant of variants) {
      expect(await context.factory.predictEscrow(variant)).not.to.equal(original);
    }
  });

  it("rejects altered terms without consuming the authorization", async function () {
    const context = await deployFixture();
    const prepared = await makeTerms(context);
    const signed = await signAuthorization(context, prepared);
    const altered = {
      ...prepared.lock,
      beneficiary: context.attacker.address,
    };
    await expect(
      context.factory.settleEip3009(
        altered,
        signed.authorization,
        signed.signature
      )
    ).to.be.revertedWithCustomError(context.factory, "InvalidAuthorization");
    expect(
      await context.token.authorizationState(
        context.payer.address,
        signed.authorization.nonce
      )
    ).to.equal(false);
  });

  it("rolls back token authorization and CREATE2 deployment if HTLC funding fails", async function () {
    const context = await deployFixture();
    const facilitatorAmount = 12_345n;
    const prepared = await makeTerms(context, {
      refundTimestamp: (await latestTimestamp()) + 1,
      facilitator: context.facilitator.address,
      facilitatorAmount,
    });
    const signed = await signAuthorization(context, prepared);
    const facilitatorBefore = await context.token.balanceOf(
      context.facilitator.address
    );
    await expect(
      context.factory.settleEip3009(
        prepared.lock,
        signed.authorization,
        signed.signature
      )
    ).to.be.revertedWithCustomError(context.htlc, "InvalidRefundTimestamp");
    expect(await ethers.provider.getCode(signed.escrow)).to.equal("0x");
    expect(
      await context.token.authorizationState(
        context.payer.address,
        signed.authorization.nonce
      )
    ).to.equal(false);
    expect(await context.token.balanceOf(context.facilitator.address)).to.equal(
      facilitatorBefore
    );
  });

  it("rejects non-canonical zero-fee facilitator terms", async function () {
    const context = await deployFixture();
    const prepared = await makeTerms(context, {
      facilitator: context.facilitator.address,
      facilitatorAmount: 0n,
    });
    await expect(context.factory.predictEscrow(prepared.lock)).to.be.revertedWithCustomError(
      context.factory,
      "InvalidFacilitator"
    );
  });

  it("blocks replay of an already settled exact payment", async function () {
    const context = await deployFixture();
    const prepared = await makeTerms(context);
    const signed = await signAuthorization(context, prepared);
    await context.factory.settleEip3009(
      prepared.lock,
      signed.authorization,
      signed.signature
    );
    await expect(
      context.factory.settleEip3009(
        prepared.lock,
        signed.authorization,
        signed.signature
      )
    )
      .to.be.revertedWithCustomError(context.factory, "EscrowAlreadyDeployed")
      .withArgs(signed.escrow);
  });

  it("returns a timed-out lock to the original generic payer", async function () {
    const context = await deployFixture();
    const facilitatorAmount = 12_345n;
    const prepared = await makeTerms(context, {
      facilitator: context.facilitator.address,
      facilitatorAmount,
    });
    const signed = await signAuthorization(context, prepared);
    await context.factory.settleEip3009(
      prepared.lock,
      signed.authorization,
      signed.signature
    );
    const Escrow = await ethers.getContractFactory("EvmExactHtlcEscrow");
    const escrow = Escrow.attach(signed.escrow);
    const payerBefore = await context.token.balanceOf(context.payer.address);
    const facilitatorBefore = await context.token.balanceOf(
      context.facilitator.address
    );
    await ethers.provider.send("evm_setNextBlockTimestamp", [prepared.refundTimestamp]);
    await escrow.connect(context.attacker).refund();
    expect(await context.token.balanceOf(context.payer.address)).to.equal(
      payerBefore + prepared.beneficiaryAmount + prepared.executorAmount
    );
    expect(await context.token.balanceOf(context.facilitator.address)).to.equal(
      facilitatorBefore
    );
  });

  it("forwards a refund even when someone called the V3 refund first", async function () {
    const context = await deployFixture();
    const prepared = await makeTerms(context);
    const signed = await signAuthorization(context, prepared);
    await context.factory.settleEip3009(
      prepared.lock,
      signed.authorization,
      signed.signature
    );
    await ethers.provider.send("evm_setNextBlockTimestamp", [prepared.refundTimestamp]);
    await context.htlc
      .connect(context.attacker)
      .refund(htlcTerms(prepared, signed.escrow));
    const Escrow = await ethers.getContractFactory("EvmExactHtlcEscrow");
    const escrow = Escrow.attach(signed.escrow);
    const payerBefore = await context.token.balanceOf(context.payer.address);
    await escrow.connect(context.attacker).refund();
    expect(await context.token.balanceOf(context.payer.address)).to.equal(
      payerBefore + prepared.beneficiaryAmount + prepared.executorAmount
    );
  });
});
