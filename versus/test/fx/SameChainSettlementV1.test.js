const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  PAYMENT_REQUIRED,
  PAYMENT_RESPONSE,
  PAYMENT_SIGNATURE,
  base64Json,
  buildControlledRequirement,
  createControlledX402Fixture,
  parseBase64Json,
} = require("../../../packages/network/src/fx-x402-fixture");

const MIN_OUTPUT = 100_000n;
const MAX_OUTPUT = 1_000_000n;
const MAX_INPUT = 2_000_000n;
const MAX_LIFETIME = 20;

const quoteTypes = {
  DealerQuote: [
    { name: "quoteId", type: "bytes32" },
    { name: "dealer", type: "address" },
    { name: "buyer", type: "address" },
    { name: "inputAmount", type: "uint256" },
    { name: "outputAmount", type: "uint256" },
    { name: "outputRecipient", type: "address" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "paymentCommitment", type: "bytes32" },
  ],
};

const acceptanceTypes = {
  BuyerAcceptance: [
    { name: "quoteDigest", type: "bytes32" },
    { name: "buyer", type: "address" },
    { name: "maxInputAmount", type: "uint256" },
    { name: "broker", type: "address" },
    { name: "brokerFee", type: "uint256" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
};

async function timestamp() {
  return Number((await ethers.provider.getBlock("latest")).timestamp);
}

async function fixture({ inputFactory = "FxDecimalToken", outputFactory = "FxDecimalToken" } = {}) {
  const [deployer, buyer, dealer, broker, endpoint, relayer, attacker] =
    await ethers.getSigners();
  const Input = await ethers.getContractFactory(inputFactory);
  const Output = await ethers.getContractFactory(outputFactory);
  const input =
    inputFactory === "FxDecimalToken" ? await Input.deploy(6) : await Input.deploy();
  const output =
    outputFactory === "FxDecimalToken" ? await Output.deploy(6) : await Output.deploy();
  const Settlement = await ethers.getContractFactory("SameChainSettlementV1");
  const settlement = await Settlement.deploy(
    await input.getAddress(),
    await output.getAddress(),
    6,
    6,
    MIN_OUTPUT,
    MAX_OUTPUT,
    MAX_INPUT,
    MAX_LIFETIME
  );
  await input.mint(buyer.address, 20_000_000n);
  await output.mint(dealer.address, 20_000_000n);
  await input.connect(buyer).approve(await settlement.getAddress(), ethers.MaxUint256);
  await output.connect(dealer).approve(await settlement.getAddress(), ethers.MaxUint256);
  return {
    deployer,
    buyer,
    dealer,
    broker,
    endpoint,
    relayer,
    attacker,
    input,
    output,
    settlement,
  };
}

async function signedRoute(context, overrides = {}) {
  const now = await timestamp();
  const network = await ethers.provider.getNetwork();
  const domain = {
    name: "Versus Same Chain Settlement",
    version: "1",
    chainId: network.chainId,
    verifyingContract: await context.settlement.getAddress(),
  };
  const quote = {
    quoteId:
      overrides.quoteId ||
      ethers.keccak256(ethers.toUtf8Bytes(`quote-${overrides.nonce || 1}`)),
    dealer: overrides.dealer || context.dealer.address,
    buyer: overrides.buyer || context.buyer.address,
    inputAmount: overrides.inputAmount ?? 510_000n,
    outputAmount: overrides.outputAmount ?? 500_000n,
    outputRecipient: overrides.outputRecipient || context.endpoint.address,
    issuedAt: overrides.issuedAt ?? now,
    expiresAt: overrides.quoteExpiresAt ?? now + 18,
    nonce: overrides.nonce ?? 1n,
    paymentCommitment:
      overrides.paymentCommitment ||
      ethers.keccak256(ethers.toUtf8Bytes("controlled-x402-requirement")),
  };
  const dealerSigner = overrides.dealerSigner || context.dealer;
  const dealerSignature = await dealerSigner.signTypedData(domain, quoteTypes, quote);
  const quoteDigest = ethers.TypedDataEncoder.hash(domain, quoteTypes, quote);
  const acceptance = {
    quoteDigest: overrides.acceptanceQuoteDigest || quoteDigest,
    buyer: overrides.acceptanceBuyer || context.buyer.address,
    maxInputAmount: overrides.maxInputAmount ?? 515_000n,
    broker: overrides.broker === undefined ? context.broker.address : overrides.broker,
    brokerFee: overrides.brokerFee ?? 5_000n,
    expiresAt: overrides.acceptanceExpiresAt ?? quote.expiresAt,
    nonce: overrides.acceptanceNonce ?? 9n,
  };
  const buyerSigner = overrides.buyerSigner || context.buyer;
  const buyerSignature = await buyerSigner.signTypedData(
    domain,
    acceptanceTypes,
    acceptance
  );
  return {
    domain,
    quote,
    dealerSignature,
    quoteDigest,
    acceptance,
    buyerSignature,
    acceptanceDigest: ethers.TypedDataEncoder.hash(
      domain,
      acceptanceTypes,
      acceptance
    ),
  };
}

describe("SameChainSettlementV1", function () {
  it("is an ownerless immutable settlement box with fixed limits", async function () {
    const context = await fixture();
    expect(await context.settlement.SETTLEMENT_VERSION()).to.equal(1n);
    expect(await context.settlement.inputToken()).to.equal(await context.input.getAddress());
    expect(await context.settlement.outputToken()).to.equal(await context.output.getAddress());
    expect(await context.settlement.minimumOutputAmount()).to.equal(MIN_OUTPUT);
    expect(await context.settlement.maximumOutputAmount()).to.equal(MAX_OUTPUT);
    expect(await context.settlement.maximumInputAmount()).to.equal(MAX_INPUT);
    expect(await context.settlement.maximumQuoteLifetime()).to.equal(
      BigInt(MAX_LIFETIME)
    );
    for (const signature of [
      "owner()",
      "pause()",
      "unpause()",
      "upgradeTo(address)",
      "sweep(address)",
      "execute(address,bytes)",
    ]) {
      expect(context.settlement.interface.hasFunction(signature)).to.equal(false);
    }
  });

  it("atomically pays the dealer, broker, and exact endpoint from signed terms", async function () {
    const context = await fixture();
    const route = await signedRoute(context);
    const buyerBefore = await context.input.balanceOf(context.buyer.address);

    await expect(
      context.settlement
        .connect(context.relayer)
        .settle(
          route.quote,
          route.dealerSignature,
          route.acceptance,
          route.buyerSignature
        )
    )
      .to.emit(context.settlement, "FxSettled")
      .withArgs(
        route.quoteDigest,
        route.acceptanceDigest,
        route.quote.quoteId,
        context.buyer.address,
        context.dealer.address,
        context.broker.address,
        context.endpoint.address,
        510_000n,
        5_000n,
        500_000n,
        route.quote.paymentCommitment
      );

    expect(await context.input.balanceOf(context.buyer.address)).to.equal(
      buyerBefore - 515_000n
    );
    expect(await context.input.balanceOf(context.dealer.address)).to.equal(510_000n);
    expect(await context.input.balanceOf(context.broker.address)).to.equal(5_000n);
    expect(await context.output.balanceOf(context.endpoint.address)).to.equal(500_000n);
    expect(await context.input.balanceOf(await context.settlement.getAddress())).to.equal(
      0n
    );
    expect(await context.output.balanceOf(await context.settlement.getAddress())).to.equal(
      0n
    );
  });

  it("unlocks a controlled x402 resource after independently verifying exact settlement", async function () {
    const context = await fixture();
    const { requirement, commitment } = buildControlledRequirement({
      outputAmountAtomic: 500_000n,
      outputRecipient: context.endpoint.address,
      paymentId: ethers.keccak256(
        ethers.toUtf8Bytes("phase4-hardhat-x402-payment")
      ),
    });
    const x402Server = createControlledX402Fixture({
      requirement,
      commitment,
      async verifySettlement(proof) {
        const receipt = await ethers.provider.getTransactionReceipt(
          proof.transactionHash
        );
        const settlementAddress = (
          await context.settlement.getAddress()
        ).toLowerCase();
        const event = receipt?.logs
          .filter((log) => log.address.toLowerCase() === settlementAddress)
          .map((log) => {
            try {
              return context.settlement.interface.parseLog(log);
            } catch {
              return null;
            }
          })
          .find((parsed) => parsed?.name === "FxSettled");
        return {
          confirmed: receipt?.status === 1 && Boolean(event),
          buyer: event?.args.buyer,
          outputAmountAtomic: event?.args.exactOutputAmount || 0n,
          outputRecipient: event?.args.outputRecipient || ethers.ZeroAddress,
          paymentCommitment: event?.args.paymentCommitment || ethers.ZeroHash,
        };
      },
    });
    const url = await x402Server.listen();
    try {
      const challenge = await fetch(url);
      expect(challenge.status).to.equal(402);
      const required = parseBase64Json(
        challenge.headers.get(PAYMENT_REQUIRED),
        PAYMENT_REQUIRED
      );
      expect(required.accepts[0].amount).to.equal("500000");

      const route = await signedRoute(context, {
        paymentCommitment: commitment,
      });
      const transaction = await context.settlement
        .connect(context.relayer)
        .settle(
          route.quote,
          route.dealerSignature,
          route.acceptance,
          route.buyerSignature
        );
      const receipt = await transaction.wait();

      const paid = await fetch(url, {
        headers: {
          [PAYMENT_SIGNATURE]: base64Json({
            scheme: "versus-atomic-exact",
            paymentCommitment: commitment,
            quoteDigest: route.quoteDigest,
            acceptanceDigest: route.acceptanceDigest,
            transactionHash: receipt.hash,
          }),
        },
      });
      expect(paid.status).to.equal(200);
      expect((await paid.json()).source).to.equal("versus-phase4");
      expect(
        parseBase64Json(
          paid.headers.get(PAYMENT_RESPONSE),
          PAYMENT_RESPONSE
        ).success
      ).to.equal(true);
      expect(await context.output.balanceOf(context.endpoint.address)).to.equal(
        500_000n
      );
    } finally {
      await x402Server.close();
    }
  });

  it("supports a direct dealer route with no broker fee", async function () {
    const context = await fixture();
    const route = await signedRoute(context, {
      broker: ethers.ZeroAddress,
      brokerFee: 0n,
      maxInputAmount: 510_000n,
    });
    await context.settlement
      .connect(context.relayer)
      .settle(
        route.quote,
        route.dealerSignature,
        route.acceptance,
        route.buyerSignature
      );
    expect(await context.input.balanceOf(context.dealer.address)).to.equal(510_000n);
    expect(await context.output.balanceOf(context.endpoint.address)).to.equal(500_000n);
  });

  it("prevents a relayer from redirecting any payment leg", async function () {
    const context = await fixture();
    const route = await signedRoute(context);
    const tampered = { ...route.quote, outputRecipient: context.attacker.address };
    await expect(
      context.settlement
        .connect(context.attacker)
        .settle(
          tampered,
          route.dealerSignature,
          route.acceptance,
          route.buyerSignature
        )
    ).to.be.revertedWithCustomError(context.settlement, "InvalidDealerSignature");
    expect(await context.output.balanceOf(context.attacker.address)).to.equal(0n);
  });

  it("rejects a dealer that tries to make itself the output recipient", async function () {
    const context = await fixture();
    const route = await signedRoute(context, {
      outputRecipient: context.dealer.address,
    });
    await expect(
      context.settlement.settle(
        route.quote,
        route.dealerSignature,
        route.acceptance,
        route.buyerSignature
      )
    ).to.be.revertedWithCustomError(context.settlement, "InvalidParty");
  });

  it("rejects a payment above the buyer's signed all-in maximum", async function () {
    const context = await fixture();
    const route = await signedRoute(context, { maxInputAmount: 514_999n });
    await expect(
      context.settlement.settle(
        route.quote,
        route.dealerSignature,
        route.acceptance,
        route.buyerSignature
      )
    ).to.be.revertedWithCustomError(context.settlement, "InvalidAcceptance");
  });

  it("rejects stale, future, and overlong quotes", async function () {
    const context = await fixture();
    const now = await timestamp();
    for (const overrides of [
      { issuedAt: now - 30, quoteExpiresAt: now - 1 },
      { issuedAt: now + 100, quoteExpiresAt: now + 118 },
      { issuedAt: now, quoteExpiresAt: now + MAX_LIFETIME + 1 },
    ]) {
      const route = await signedRoute(context, {
        ...overrides,
        nonce: BigInt(Math.abs(overrides.issuedAt)),
      });
      await expect(
        context.settlement.settle(
          route.quote,
          route.dealerSignature,
          route.acceptance,
          route.buyerSignature
        )
      ).to.be.revertedWithCustomError(context.settlement, "InvalidQuoteTime");
    }
  });

  it("enforces tiny fixed output and input caps", async function () {
    for (const overrides of [
      { outputAmount: MIN_OUTPUT - 1n },
      { outputAmount: MAX_OUTPUT + 1n },
      { inputAmount: MAX_INPUT + 1n, maxInputAmount: MAX_INPUT + 1n },
    ]) {
      const context = await fixture();
      const route = await signedRoute(context, overrides);
      await expect(
        context.settlement.settle(
          route.quote,
          route.dealerSignature,
          route.acceptance,
          route.buyerSignature
        )
      ).to.be.revertedWithCustomError(context.settlement, "InvalidAmount");
    }
  });

  it("rejects wrong dealer and buyer signatures", async function () {
    let context = await fixture();
    let route = await signedRoute(context, { dealerSigner: context.attacker });
    await expect(
      context.settlement.settle(
        route.quote,
        route.dealerSignature,
        route.acceptance,
        route.buyerSignature
      )
    ).to.be.revertedWithCustomError(context.settlement, "InvalidDealerSignature");

    context = await fixture();
    route = await signedRoute(context, { buyerSigner: context.attacker });
    await expect(
      context.settlement.settle(
        route.quote,
        route.dealerSignature,
        route.acceptance,
        route.buyerSignature
      )
    ).to.be.revertedWithCustomError(context.settlement, "InvalidBuyerSignature");
  });

  it("makes both signed messages single-use", async function () {
    const context = await fixture();
    const route = await signedRoute(context);
    await context.settlement.settle(
      route.quote,
      route.dealerSignature,
      route.acceptance,
      route.buyerSignature
    );
    await expect(
      context.settlement.settle(
        route.quote,
        route.dealerSignature,
        route.acceptance,
        route.buyerSignature
      )
    )
      .to.be.revertedWithCustomError(context.settlement, "QuoteAlreadyUsed")
      .withArgs(route.quoteDigest);
  });

  it("reverts all legs when buyer approval or dealer inventory is missing", async function () {
    let context = await fixture();
    let route = await signedRoute(context);
    await context.input.connect(context.buyer).approve(await context.settlement.getAddress(), 0);
    await expect(
      context.settlement.settle(
        route.quote,
        route.dealerSignature,
        route.acceptance,
        route.buyerSignature
      )
    ).to.be.reverted;
    expect(await context.input.balanceOf(context.dealer.address)).to.equal(0n);
    expect(await context.output.balanceOf(context.endpoint.address)).to.equal(0n);

    context = await fixture();
    route = await signedRoute(context);
    await context.output
      .connect(context.dealer)
      .transfer(context.attacker.address, 20_000_000n);
    await expect(
      context.settlement.settle(
        route.quote,
        route.dealerSignature,
        route.acceptance,
        route.buyerSignature
      )
    ).to.be.reverted;
    expect(await context.input.balanceOf(context.dealer.address)).to.equal(0n);
    expect(await context.input.balanceOf(context.broker.address)).to.equal(0n);
  });

  it("rejects fee-on-transfer behavior without leaving partial settlement", async function () {
    const context = await fixture({ inputFactory: "FxFeeOnTransferToken" });
    const route = await signedRoute(context);
    await expect(
      context.settlement.settle(
        route.quote,
        route.dealerSignature,
        route.acceptance,
        route.buyerSignature
      )
    ).to.be.revertedWithCustomError(
      context.settlement,
      "UnsupportedTokenBehavior"
    );
    expect(await context.output.balanceOf(context.endpoint.address)).to.equal(0n);
  });

  it("rejects native currency and invalid constructor wiring", async function () {
    const context = await fixture();
    await expect(
      context.buyer.sendTransaction({
        to: await context.settlement.getAddress(),
        value: 1n,
      })
    ).to.be.revertedWithCustomError(
      context.settlement,
      "NativeAssetUnsupported"
    );

    const Settlement = await ethers.getContractFactory("SameChainSettlementV1");
    await expect(
      Settlement.deploy(
        await context.input.getAddress(),
        await context.input.getAddress(),
        6,
        6,
        MIN_OUTPUT,
        MAX_OUTPUT,
        MAX_INPUT,
        MAX_LIFETIME
      )
    ).to.be.revertedWithCustomError(Settlement, "SameToken");
  });
});
