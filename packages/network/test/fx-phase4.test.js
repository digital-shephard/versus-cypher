const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  Wallet,
  TypedDataEncoder,
  keccak256,
  toUtf8Bytes,
} = require("ethers");
const {
  BUYER_ACCEPTANCE_TYPES,
  DEALER_QUOTE_TYPES,
  FxPhase4Controller,
  buildBuyerAcceptance,
  routeCost,
  routeHash,
  selectDirectDealerQuote,
  settlementDomain,
} = require("../src/fx-phase4");
const { FxPhase4Journal } = require("../src/fx-phase4-journal");
const {
  PAYMENT_REQUIRED,
  PAYMENT_RESPONSE,
  PAYMENT_SIGNATURE,
  base64Json,
  buildControlledRequirement,
  createControlledX402Fixture,
  parseBase64Json,
} = require("../src/fx-x402-fixture");
const {
  createDirectDealerFixture,
  discoverDirectDealerQuote,
  safeEndpoint,
} = require("../src/fx-direct-dealer");

const settlementAddress = "0x1000000000000000000000000000000000000001";
const endpoint = "0x2000000000000000000000000000000000000002";
const broker = "0x3000000000000000000000000000000000000003";

async function makeSignedRoute({
  buyer = Wallet.createRandom(),
  dealer = Wallet.createRandom(),
  inputAmount = 510_000n,
  outputAmount = 500_000n,
  issuedAt = 1_800_000_000,
  expiresAt = 1_800_000_018,
  nonce = 1n,
  commitment = keccak256(toUtf8Bytes("requirement")),
  settlementContract = settlementAddress,
} = {}) {
  const domain = settlementDomain({ settlementAddress: settlementContract });
  const quote = {
    quoteId: keccak256(toUtf8Bytes(`quote-${nonce}`)),
    dealer: dealer.address,
    buyer: buyer.address,
    inputAmount,
    outputAmount,
    outputRecipient: endpoint,
    issuedAt,
    expiresAt,
    nonce,
    paymentCommitment: commitment,
  };
  const signature = await dealer.signTypedData(domain, DEALER_QUOTE_TYPES, quote);
  const quoteDigest = TypedDataEncoder.hash(domain, DEALER_QUOTE_TYPES, quote);
  const signedQuote = { domain, quote, signature, quoteDigest };
  const acceptance = buildBuyerAcceptance({
    signedQuote,
    buyer: buyer.address,
    maxInputAmount: inputAmount + 5_000n,
    broker,
    brokerFee: 5_000n,
    expiresAt,
    nonce: 7n,
  });
  const buyerSignature = await buyer.signTypedData(
    domain,
    BUYER_ACCEPTANCE_TYPES,
    acceptance
  );
  return { buyer, dealer, signedQuote, acceptance, buyerSignature };
}

function journalPath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-fx-phase4-"));
  return path.join(directory, "phase4.sqlite");
}

test("Phase 4 route fixture is canonical, tiny-capped, and production-disconnected", () => {
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "fixtures", "fx-phase4-base-route.json"),
      "utf8"
    )
  );
  assert.equal(manifest.status, "development-only");
  assert.equal(manifest.network.caip2, "eip155:8453");
  assert.equal(
    manifest.pair.input.address,
    "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42"
  );
  assert.equal(
    manifest.pair.output.address,
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
  );
  assert.deepEqual(manifest.connectivity, {
    productionWaku: false,
    productionFunds: false,
    mainnetDeployment: false,
  });
  assert.equal(manifest.settlement.deploymentAddress, null);
  assert.equal(manifest.settlement.maximumOutputAtomic, "1000000");
  assert.equal(manifest.x402.compatibility, "controlled-fixture-extension");
});

test("Phase 4 cannot enter production startup or the Cypher runway path", () => {
  const repositoryRoot = path.resolve(__dirname, "..", "..", "..");
  const productionMain = fs.readFileSync(
    path.join(repositoryRoot, "apps", "pet", "src", "main.js"),
    "utf8"
  );
  const networkIndex = fs.readFileSync(
    path.join(repositoryRoot, "packages", "network", "src", "index.js"),
    "utf8"
  );
  const controllerSource = fs.readFileSync(
    path.join(repositoryRoot, "packages", "network", "src", "fx-phase4.js"),
    "utf8"
  );
  assert.equal(productionMain.includes("fx-phase4"), false);
  assert.equal(networkIndex.includes("fx-phase4"), false);
  for (const forbidden of [
    "chainRainService",
    "dailyLifecycleScheduler",
    "pullFromVault",
    "runway",
    "agent-runtime",
    "waku-transport",
  ]) {
    assert.equal(controllerSource.includes(forbidden), false, forbidden);
  }
});

test("direct discovery verifies signatures and deterministically selects the cheapest quote", async () => {
  const buyer = Wallet.createRandom();
  const expensive = await makeSignedRoute({
    buyer,
    inputAmount: 530_000n,
    nonce: 1n,
  });
  const cheapest = await makeSignedRoute({
    buyer,
    inputAmount: 510_000n,
    nonce: 2n,
  });
  const wrongContract = await makeSignedRoute({
    buyer,
    inputAmount: 100_000n,
    nonce: 3n,
    settlementContract: "0x4000000000000000000000000000000000000004",
  });
  const selected = selectDirectDealerQuote(
    [
      {
        ...expensive.signedQuote,
        domain: { settlementAddress },
      },
      {
        ...cheapest.signedQuote,
        domain: { settlementAddress },
      },
      {
        ...cheapest.signedQuote,
        domain: { settlementAddress },
        signature: "0xdead",
      },
      {
        ...wrongContract.signedQuote,
        domain: {
          settlementAddress: "0x4000000000000000000000000000000000000004",
        },
      },
    ],
    {
      buyer: buyer.address,
      now: 1_800_000_001,
      settlementAddress,
    }
  );
  assert.equal(selected.quote.inputAmount, 510_000n);
  assert.equal(selected.quoteDigest, cheapest.signedQuote.quoteDigest);
});

test("direct discovery queries independent dealers and ignores failure or forged responses", async () => {
  const buyer = Wallet.createRandom();
  const valid = await makeSignedRoute({ buyer, nonce: 41n });
  const forged = {
    ...valid.signedQuote,
    domain: { settlementAddress },
    signature: `0x${"00".repeat(65)}`,
  };
  const honestServer = createDirectDealerFixture({
    async buildCandidate(request) {
      assert.equal(request.buyer.toLowerCase(), buyer.address.toLowerCase());
      assert.equal(
        request.paymentCommitment,
        valid.signedQuote.quote.paymentCommitment
      );
      return {
        ...valid.signedQuote,
        domain: { settlementAddress },
      };
    },
  });
  const forgedServer = createDirectDealerFixture({
    async buildCandidate() {
      return forged;
    },
  });
  const honestUrl = await honestServer.listen();
  const forgedUrl = await forgedServer.listen();
  try {
    const selected = await discoverDirectDealerQuote({
      endpoints: [forgedUrl, "http://127.0.0.1:1/v1/fx/quote", honestUrl],
      buyer: buyer.address,
      paymentCommitment: valid.signedQuote.quote.paymentCommitment,
      settlementAddress,
      now: 1_800_000_001,
    });
    assert.equal(selected.quoteDigest, valid.signedQuote.quoteDigest);
  } finally {
    await Promise.all([honestServer.close(), forgedServer.close()]);
  }
  assert.throws(
    () => safeEndpoint("http://dealer.example/v1/fx/quote"),
    (error) => error.code === "UNSAFE_DEALER_ENDPOINT"
  );
});

test("all-in cost exposes dealer compensation, broker fee, output, and signed maximum", async () => {
  const route = await makeSignedRoute();
  assert.deepEqual(routeCost(route), {
    inputToken: "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42",
    outputToken: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    dealerInputAtomic: "510000",
    brokerFeeAtomic: "5000",
    allInInputAtomic: "515000",
    exactOutputAtomic: "500000",
    maximumInputAtomic: "515000",
  });
  assert.match(routeHash(route), /^0x[0-9a-f]{64}$/);
});

test("controller is unavailable by default and requires owner UI approval", async () => {
  const route = await makeSignedRoute();
  const journal = new FxPhase4Journal({ filePath: journalPath() });
  const executor = {};
  const unavailable = new FxPhase4Controller({
    available: false,
    journal,
    executor,
  });
  assert.throws(
    () => unavailable.enableFromOwnerUi(true),
    (error) => error.code === "FX_DISABLED"
  );

  const controller = new FxPhase4Controller({
    available: true,
    journal,
    executor,
  });
  controller.enableFromOwnerUi(true);
  const prepared = controller.prepare(route);
  assert.equal(prepared.state, "prepared");
  await assert.rejects(
    () => controller.execute(prepared.intentId),
    (error) => error.code === "OWNER_REQUIRED"
  );
  assert.throws(
    () => journal.approve(prepared.intentId, "model"),
    (error) => error.code === "OWNER_REQUIRED"
  );
  controller.approveFromOwnerUi(prepared.intentId, true);
  assert.equal(journal.get(prepared.intentId).state, "owner_approved");
  journal.close();
});

test("signed raw transaction is journaled before broadcast and duplicate clicks are refused", async () => {
  const route = await makeSignedRoute();
  const filePath = journalPath();
  let stateAtBroadcast;
  const executor = {
    async prepareSignedTransaction() {
      return {
        transactionHash: `0x${"12".repeat(32)}`,
        rawTransaction: "0x1234",
      };
    },
    async broadcastSignedTransaction() {
      const read = new FxPhase4Journal({ filePath });
      stateAtBroadcast = read.get(routeHash(route)).state;
      read.close();
    },
    async waitForReceipt() {
      return { status: 1, blockNumber: 42 };
    },
  };
  const journal = new FxPhase4Journal({ filePath });
  const controller = new FxPhase4Controller({
    available: true,
    journal,
    executor,
  });
  controller.enableFromOwnerUi(true);
  const { intentId } = controller.prepare(route);
  controller.approveFromOwnerUi(intentId, true);
  const confirmed = await controller.execute(intentId);
  assert.equal(stateAtBroadcast, "signed");
  assert.equal(confirmed.state, "confirmed");
  assert.equal(confirmed.receiptBlock, 42);
  assert.throws(
    () => journal.markUncertain(intentId, `0x${"12".repeat(32)}`),
    (error) => error.code === "BAD_STATE"
  );
  await assert.rejects(
    () => controller.execute(intentId),
    (error) => error.code === "OWNER_REQUIRED"
  );
  journal.close();
});

test("restart reconciliation confirms a previously signed transaction without rebroadcast", async () => {
  const route = await makeSignedRoute();
  const filePath = journalPath();
  let broadcasts = 0;
  let journal = new FxPhase4Journal({ filePath });
  const intentId = routeHash(route);
  journal.prepare({ intentId, route, cost: routeCost(route) });
  journal.approve(intentId, "owner_ui");
  journal.recordSignedTransaction(intentId, `0x${"34".repeat(32)}`, "0x5678");
  journal.markUncertain(intentId, `0x${"34".repeat(32)}`);
  journal.close();

  journal = new FxPhase4Journal({ filePath });
  const controller = new FxPhase4Controller({
    available: true,
    journal,
    executor: {
      async broadcastSignedTransaction() {
        broadcasts += 1;
      },
      async getReceipt() {
        return { status: 1, blockNumber: 77 };
      },
    },
  });
  const result = await controller.reconcile(intentId);
  assert.equal(result.state, "confirmed");
  assert.equal(result.receiptBlock, 77);
  assert.equal(broadcasts, 0);
  journal.close();
});

test("an owner may recover a dropped transaction only by rebroadcasting identical signed bytes", async () => {
  const route = await makeSignedRoute();
  const filePath = journalPath();
  const intentId = routeHash(route);
  let journal = new FxPhase4Journal({ filePath });
  journal.prepare({ intentId, route, cost: routeCost(route) });
  journal.approve(intentId, "owner_ui");
  journal.recordSignedTransaction(intentId, `0x${"ab".repeat(32)}`, "0xcafe");
  journal.markUncertain(intentId, `0x${"ab".repeat(32)}`);
  journal.close();

  const broadcasts = [];
  journal = new FxPhase4Journal({ filePath });
  const controller = new FxPhase4Controller({
    available: true,
    journal,
    executor: {
      async broadcastSignedTransaction(raw) {
        broadcasts.push(raw);
      },
      async waitForReceipt(hash) {
        assert.equal(hash, `0x${"ab".repeat(32)}`);
        return { status: 1, blockNumber: 88 };
      },
    },
  });
  controller.enableFromOwnerUi(true);
  await assert.rejects(
    () => controller.rebroadcastRecordedFromOwnerUi(intentId, false),
    (error) => error.code === "OWNER_REQUIRED"
  );
  const recovered = await controller.rebroadcastRecordedFromOwnerUi(
    intentId,
    true
  );
  assert.deepEqual(broadcasts, ["0xcafe"]);
  assert.equal(recovered.state, "confirmed");
  assert.equal(recovered.receiptBlock, 88);
  journal.close();
});

test("controlled x402 fixture releases exact resource only after verified settlement", async () => {
  const { requirement, commitment } = buildControlledRequirement({
    outputAmountAtomic: 500_000n,
    outputRecipient: endpoint,
    paymentId: keccak256(toUtf8Bytes("phase4-x402-test-payment")),
  });
  let verified = 0;
  const fixture = createControlledX402Fixture({
    requirement,
    commitment,
    async verifySettlement(proof) {
      verified += 1;
      return {
        confirmed: proof.transactionHash === `0x${"56".repeat(32)}`,
        buyer: Wallet.createRandom().address,
        outputAmountAtomic: "500000",
        outputRecipient: endpoint,
        paymentCommitment: commitment,
      };
    },
  });
  const url = await fixture.listen();
  try {
    const challenge = await fetch(url);
    assert.equal(challenge.status, 402);
    const required = parseBase64Json(
      challenge.headers.get(PAYMENT_REQUIRED),
      PAYMENT_REQUIRED
    );
    assert.equal(required.accepts[0].scheme, "versus-atomic-exact");
    assert.equal(required.accepts[0].amount, "500000");

    const paid = await fetch(url, {
      headers: {
        [PAYMENT_SIGNATURE]: base64Json({
          scheme: "versus-atomic-exact",
          paymentCommitment: commitment,
          quoteDigest: `0x${"78".repeat(32)}`,
          acceptanceDigest: `0x${"9a".repeat(32)}`,
          transactionHash: `0x${"56".repeat(32)}`,
        }),
      },
    });
    assert.equal(paid.status, 200);
    assert.equal((await paid.json()).source, "versus-phase4");
    assert.equal(
      parseBase64Json(paid.headers.get(PAYMENT_RESPONSE), PAYMENT_RESPONSE).success,
      true
    );
    assert.equal(verified, 1);
  } finally {
    await fixture.close();
  }
});
