const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  Wallet,
  keccak256,
  toUtf8Bytes,
} = require("ethers");
const {
  FxBrokerFeeLedger,
  FxPublicBroker,
  compareBrokerRouteProposals,
  compileSelfRoutedProposal,
  createBrokerFeeVoucher,
  createBrokerRouteProposal,
  createFxBrokerHttpService,
  queryBrokerRoutes,
  signFxMessage,
  verifyBrokerMetricsSnapshot,
  verifyBrokerRouteProposal,
} = require("../src");

const DEPLOYMENT_ID = `0x${"71".repeat(32)}`;
const TRADE_ID = `0x${"72".repeat(32)}`;
const SOURCE_TOKEN = `0x${"11".repeat(20)}`;
const ALTERNATE_SOURCE_TOKEN = `0x${"12".repeat(20)}`;
const DESTINATION_TOKEN = `0x${"22".repeat(20)}`;
const SOURCE_CHAIN = "84532";
const DESTINATION_CHAIN = "421614";
const NOW = 1_800_000_000;

async function fixture({
  dealerInput = "101000",
  brokerFee = "500",
  broker = Wallet.createRandom(),
  dealer = Wallet.createRandom(),
  requester = Wallet.createRandom(),
  quotePolicy = "lowest_all_in",
  inputOptions = [{
    chainId: SOURCE_CHAIN,
    token: SOURCE_TOKEN,
    maxInputAtomic: "110000",
  }],
  inputToken = SOURCE_TOKEN,
  estimatedCompletionSeconds = 55,
} = {}) {
  const rfq = await signFxMessage({
    protocol: "versus-fx",
    version: 1,
    deploymentId: DEPLOYMENT_ID,
    type: "fx_rfq",
    tradeId: TRADE_ID,
    role: "requester",
    sequence: "1",
    createdAt: NOW,
    expiresAt: NOW + 60,
    payload: {
      outputChainId: DESTINATION_CHAIN,
      outputToken: DESTINATION_TOKEN,
      outputAmountAtomic: "100000",
      inputOptions,
      quoteDeadline: NOW + 50,
      settlementDeadline: NOW + 3600,
      quotePolicy,
      x402Commitment: null,
    },
  }, requester);
  const quote = await signFxMessage({
    protocol: "versus-fx",
    version: 1,
    deploymentId: DEPLOYMENT_ID,
    type: "fx_quote",
    tradeId: TRADE_ID,
    role: "dealer",
    sequence: "1",
    createdAt: NOW + 1,
    expiresAt: NOW + 45,
    payload: {
      rfqId: rfq.id,
      inputChainId: SOURCE_CHAIN,
      inputToken,
      inputAmountAtomic: dealerInput,
      outputChainId: DESTINATION_CHAIN,
      outputToken: DESTINATION_TOKEN,
      outputAmountAtomic: "100000",
      quoteType: "fixed_exact_output",
      referenceSource: "chainlink:usdc-usd",
      referencePriceMicros: "1000000",
      referenceTimestamp: NOW,
      spreadBps: 25,
      dealerSettlementCostAtomic: "750",
      estimatedCompletionSeconds,
      adapterId: "evm-htlc-v1",
      adapterVersion: 1,
    },
  }, dealer);
  const proposal = await createBrokerRouteProposal({
    signer: broker,
    rfq,
    quotes: [quote],
    brokerFeeAtomic: brokerFee,
    now: NOW + 2,
  });
  return { broker, dealer, requester, rfq, quote, proposal };
}

async function completionEvidence(context) {
  const secretHash = keccak256(toUtf8Bytes("phase-7-completion-secret"));
  const accept = await signFxMessage({
    protocol: "versus-fx",
    version: 1,
    deploymentId: DEPLOYMENT_ID,
    type: "fx_accept",
    tradeId: TRADE_ID,
    role: "requester",
    sequence: "2",
    createdAt: NOW + 3,
    expiresAt: NOW + 600,
    payload: {
      rfqId: context.rfq.id,
      quoteId: context.proposal.route.quoteId,
      routeId: context.proposal.route.routeId,
      dealerInputAmountAtomic: context.quote.payload.inputAmountAtomic,
      brokerFeeAtomic: context.proposal.fee.amountAtomic,
      totalInputAtomic: context.proposal.route.totalInputAtomic,
      outputAmountAtomic: context.proposal.route.outputAmountAtomic,
      secretHash,
      sourceRefundAddress: context.requester.address,
      destinationClaimAddress: context.requester.address,
      sourceAdapterId: "evm-htlc-v1",
      sourceAdapterVersion: 1,
      destinationAdapterId: "evm-htlc-v1",
      destinationAdapterVersion: 1,
    },
  }, context.requester);
  const sourceClaim = await signFxMessage({
    protocol: "versus-fx",
    version: 1,
    deploymentId: DEPLOYMENT_ID,
    type: "fx_claim",
    tradeId: TRADE_ID,
    role: "dealer",
    sequence: "2",
    createdAt: NOW + 100,
    expiresAt: NOW + 1000,
    payload: {
      lockMessageId: `0x${"31".repeat(32)}`,
      chainId: SOURCE_CHAIN,
      transactionHash: `0x${"32".repeat(32)}`,
      blockNumber: "101",
      secretHash,
      beneficiary: context.dealer.address,
    },
  }, context.dealer);
  const destinationClaim = await signFxMessage({
    protocol: "versus-fx",
    version: 1,
    deploymentId: DEPLOYMENT_ID,
    type: "fx_claim",
    tradeId: TRADE_ID,
    role: "requester",
    sequence: "3",
    createdAt: NOW + 90,
    expiresAt: NOW + 1000,
    payload: {
      lockMessageId: `0x${"33".repeat(32)}`,
      chainId: DESTINATION_CHAIN,
      transactionHash: `0x${"34".repeat(32)}`,
      blockNumber: "202",
      secretHash,
      beneficiary: context.requester.address,
    },
  }, context.requester);
  const complete = await signFxMessage({
    protocol: "versus-fx",
    version: 1,
    deploymentId: DEPLOYMENT_ID,
    type: "fx_complete",
    tradeId: TRADE_ID,
    role: "broker",
    sequence: "1",
    createdAt: NOW + 110,
    expiresAt: NOW + 1000,
    payload: {
      acceptId: accept.id,
      sourceClaimMessageId: sourceClaim.id,
      destinationClaimMessageId: destinationClaim.id,
    },
  }, context.broker);
  return { accept, sourceClaim, destinationClaim, complete };
}

test("broker proposal carries every signed quote and is locally reproducible", async () => {
  const context = await fixture();
  const verified = verifyBrokerRouteProposal(context.proposal, { now: NOW + 3 });
  assert.equal(verified.broker, context.broker.address.toLowerCase());
  assert.equal(verified.route.quoteId, context.quote.id);
  assert.equal(verified.route.totalInputAtomic, "101500");
  assert.equal(verified.fee.amountAtomic, "500");
  assert.equal(verified.quotes.length, 1);

  const changed = structuredClone(context.proposal);
  changed.route.totalInputAtomic = "1";
  assert.throws(
    () => verifyBrokerRouteProposal(changed, { now: NOW + 3 }),
    (error) => error.code === "ROUTE_MISMATCH"
  );
});

test("a forged included quote and an undisclosed fee recipient are rejected", async () => {
  const context = await fixture();
  const forged = structuredClone(context.proposal);
  forged.quotes[0].payload.inputAmountAtomic = "1";
  assert.throws(
    () => verifyBrokerRouteProposal(forged, { now: NOW + 3 }),
    (error) => ["BAD_ID", "BAD_SIGNATURE"].includes(error.code)
  );

  const redirected = structuredClone(context.proposal);
  redirected.fee.recipient = Wallet.createRandom().address.toLowerCase();
  assert.throws(
    () => verifyBrokerRouteProposal(redirected, { now: NOW + 3 }),
    (error) => error.code === "FEE_RECIPIENT_MISMATCH"
  );
});

test("self-routing uses the same compiler with no broker fee", async () => {
  const context = await fixture();
  const direct = compileSelfRoutedProposal(context.rfq, [context.quote], {
    now: NOW + 3,
  });
  assert.equal(direct.mode, "self-routed");
  assert.equal(direct.route.brokerFeeAtomic, "0");
  assert.equal(direct.route.totalInputAtomic, context.quote.payload.inputAmountAtomic);
  assert.ok(
    BigInt(direct.route.totalInputAtomic) <
      BigInt(context.proposal.route.totalInputAtomic)
  );
});

test("concurrent broker comparison chooses the lowest verified all-in route", async () => {
  const sharedRequester = Wallet.createRandom();
  const sharedDealer = Wallet.createRandom();
  const expensive = await fixture({
    requester: sharedRequester,
    dealer: sharedDealer,
    brokerFee: "900",
  });
  const cheaper = await createBrokerRouteProposal({
    signer: Wallet.createRandom(),
    rfq: expensive.rfq,
    quotes: [expensive.quote],
    brokerFeeAtomic: "300",
    now: NOW + 2,
  });
  const comparison = compareBrokerRouteProposals(
    [expensive.proposal, cheaper],
    { now: NOW + 3 }
  );
  assert.equal(comparison.selected.proposalId, cheaper.proposalId);
  assert.deepEqual(
    comparison.proposals.map((proposal) => proposal.route.totalInputAtomic),
    ["101300", "101900"]
  );
});

test("broker comparison rejects mixed assets and honors fastest policy", async () => {
  const context = await fixture({
    quotePolicy: "fastest",
    inputOptions: [
      {
        chainId: SOURCE_CHAIN,
        token: SOURCE_TOKEN,
        maxInputAtomic: "110000",
      },
      {
        chainId: SOURCE_CHAIN,
        token: ALTERNATE_SOURCE_TOKEN,
        maxInputAtomic: "120000",
      },
    ],
  });
  const fasterQuote = await signFxMessage({
    ...context.quote,
    id: undefined,
    signature: undefined,
    sequence: "2",
    payload: {
      ...context.quote.payload,
      inputAmountAtomic: "109000",
      estimatedCompletionSeconds: 5,
    },
  }, context.dealer);
  const fasterProposal = await createBrokerRouteProposal({
    signer: Wallet.createRandom(),
    rfq: context.rfq,
    quotes: [fasterQuote],
    brokerFeeAtomic: "500",
    now: NOW + 2,
  });
  const fastest = compareBrokerRouteProposals(
    [context.proposal, fasterProposal],
    { now: NOW + 3 }
  );
  assert.equal(fastest.selected.proposalId, fasterProposal.proposalId);

  const alternateQuote = await signFxMessage({
    ...context.quote,
    id: undefined,
    signature: undefined,
    sequence: "3",
    payload: {
      ...context.quote.payload,
      inputToken: ALTERNATE_SOURCE_TOKEN,
      inputAmountAtomic: "100000",
    },
  }, context.dealer);
  const alternateProposal = await createBrokerRouteProposal({
    signer: Wallet.createRandom(),
    rfq: context.rfq,
    quotes: [alternateQuote],
    brokerFeeAtomic: "100",
    now: NOW + 2,
  });
  assert.throws(
    () => compareBrokerRouteProposals(
      [context.proposal, alternateProposal],
      { now: NOW + 3 }
    ),
    (error) => error.code === "AMBIGUOUS_INPUT_ASSET"
  );
  const selectedAsset = compareBrokerRouteProposals(
    [context.proposal, alternateProposal],
    {
      now: NOW + 3,
      inputChainId: SOURCE_CHAIN,
      inputToken: ALTERNATE_SOURCE_TOKEN,
    }
  );
  assert.equal(selectedAsset.selected.proposalId, alternateProposal.proposalId);
});

test("broker fee cannot leave escrow without both independently confirmed claims", async () => {
  const context = await fixture();
  const voucher = await createBrokerFeeVoucher({
    signer: context.requester,
    proposal: context.proposal,
    nonce: `0x${"41".repeat(32)}`,
    now: NOW + 3,
  });
  const evidence = await completionEvidence(context);
  const ledger = new FxBrokerFeeLedger();
  ledger.escrow(voucher, context.proposal, { now: NOW + 3 });

  await assert.rejects(
    () => ledger.claim({
      proposal: context.proposal,
      voucher,
      evidence: { ...evidence, sourceClaim: evidence.destinationClaim },
      verifyChainClaim: async () => true,
      now: NOW + 120,
    }),
    (error) => error.code === "INVALID_COMPLETION_EVIDENCE"
  );
  await assert.rejects(
    () => ledger.claim({
      proposal: context.proposal,
      voucher,
      evidence,
      verifyChainClaim: async ({ side }) => side === "source",
      now: NOW + 120,
    }),
    (error) => error.code === "UNCONFIRMED_COMPLETION"
  );
  await assert.rejects(
    () => ledger.claim({
      proposal: context.proposal,
      voucher,
      evidence,
      verifyChainClaim: async () => true,
      now: NOW + 3601,
    }),
    (error) => error.code === "EXPIRED_VOUCHER"
  );

  const paid = await ledger.claim({
    proposal: context.proposal,
    voucher,
    evidence,
    verifyChainClaim: async () => ({ confirmed: true }),
    now: NOW + 120,
  });
  assert.equal(paid.state, "paid");
  assert.equal(paid.fee.amountAtomic, "500");
  await assert.rejects(
    () => ledger.claim({
      proposal: context.proposal,
      voucher,
      evidence,
      verifyChainClaim: async () => true,
      now: NOW + 120,
    }),
    (error) => error.code === "DUPLICATE_FEE_CLAIM"
  );
});

class FakeBrokerSession extends EventEmitter {
  constructor({ signer, quote }) {
    super();
    this.role = "broker";
    this.signer = signer;
    this.address = signer.address.toLowerCase();
    this.started = false;
    this.quote = quote;
    this.published = [];
    this.transport = {
      publish: async (rfq) => {
        this.published.push(rfq);
      },
      status: () => ({ ready: true, peers: 2 }),
    };
  }

  async start() {
    this.started = true;
  }

  ingest() {
    return { status: "accepted" };
  }

  async close() {
    this.started = false;
  }
}

async function runningBroker(context, fee, serviceOptions = {}) {
  const signer = Wallet.createRandom();
  const session = new FakeBrokerSession({ signer, quote: context.quote });
  const broker = new FxPublicBroker({
    session,
    signer,
    brokerFeeAtomic: fee,
    observationWindowMs: 0,
    now: () => NOW + 3,
    sleep: async () => session.emit("accepted", context.quote, { live: true }),
  });
  await broker.start();
  const httpService = createFxBrokerHttpService({ broker, ...serviceOptions });
  const url = await httpService.listen();
  return { broker, httpService, url };
}

test("public broker ingress accepts a non-Cypher signed RFQ and exposes signed metrics", async (t) => {
  const context = await fixture();
  const service = await runningBroker(context, "500");
  t.after(async () => {
    await service.httpService.close();
    await service.broker.close();
  });

  const response = await fetch(`${service.url}/v1/fx/routes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rfq: context.rfq }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(
    verifyBrokerRouteProposal(body.proposal, { now: NOW + 3 }).rfq.sender,
    context.requester.address.toLowerCase()
  );
  assert.equal(service.broker.session.published[0].id, context.rfq.id);

  const metricsResponse = await fetch(`${service.url}/metrics`);
  const metrics = verifyBrokerMetricsSnapshot(await metricsResponse.json());
  assert.equal(metrics.counters.requests, 1);
  assert.equal(metrics.counters.routesCompiled, 1);
  assert.equal(metrics.gauges.reachableDealers, 1);
  assert.throws(
    () => verifyBrokerMetricsSnapshot({ ...metrics, untrustedScore: 100 }),
    /metrics shape is invalid/
  );
});

test("broker ignores quotes that do not answer the active signed RFQ", async (t) => {
  const context = await fixture();
  const poison = structuredClone(context.quote);
  poison.payload.rfqId = `0x${"99".repeat(32)}`;
  const signer = Wallet.createRandom();
  const session = new FakeBrokerSession({ signer, quote: context.quote });
  const broker = new FxPublicBroker({
    session,
    signer,
    brokerFeeAtomic: "500",
    observationWindowMs: 0,
    now: () => NOW + 3,
    sleep: async () => {
      session.emit("accepted", poison, { live: true });
      session.emit("accepted", context.quote, { live: true });
    },
  });
  await broker.start();
  t.after(() => broker.close());

  const proposal = await broker.requestRoute(context.rfq);
  assert.equal(proposal.route.quoteId, context.quote.id);
  assert.equal(proposal.quotes.length, 1);
  assert.equal(broker.metrics.counters.rejectedQuotes, 1);
  assert.equal(broker.status().openTradeSets, 0);
});

test("requester queries brokers concurrently and rejects a bad response locally", async (t) => {
  const context = await fixture();
  const expensive = await runningBroker(context, "800");
  const cheap = await runningBroker(context, "200");
  t.after(async () => {
    await Promise.all([
      expensive.httpService.close(),
      cheap.httpService.close(),
    ]);
    await Promise.all([expensive.broker.close(), cheap.broker.close()]);
  });

  const result = await queryBrokerRoutes({
    endpoints: [
      `${expensive.url}/ignored`,
      "http://127.0.0.1:1",
      cheap.url,
    ],
    rfq: context.rfq,
    now: NOW + 3,
    timeoutMs: 1_000,
  });
  assert.equal(result.selected.fee.amountAtomic, "200");
  assert.equal(result.attempts.filter((attempt) => attempt.ok).length, 2);
  assert.equal(result.attempts.filter((attempt) => !attempt.ok).length, 1);
});

test("optional x402 data API is paywalled and route ingress is bounded", async (t) => {
  const context = await fixture();
  const requirement = {
    x402Version: 2,
    scheme: "versus-atomic-exact",
    network: "eip155:84532",
    asset: SOURCE_TOKEN,
    amount: "100",
    payTo: context.broker.address.toLowerCase(),
    maxTimeoutSeconds: 20,
    resource: "/v1/fx/data/metrics",
    description: "Versus broker metrics",
    extensions: { paymentIdentifier: `0x${"91".repeat(32)}` },
  };
  const service = await runningBroker(context, "500", {
    maxRequestsPerMinutePerIp: 1,
    x402DataGate: {
      requirement,
      async verify(proof) {
        return {
          confirmed: proof.ok === true,
          transactionHash: `0x${"92".repeat(32)}`,
        };
      },
    },
  });
  t.after(async () => {
    await service.httpService.close();
    await service.broker.close();
  });

  const required = await fetch(`${service.url}/v1/fx/data/metrics`);
  assert.equal(required.status, 402);
  assert.ok(required.headers.get("payment-required"));
  const payment = Buffer.from(JSON.stringify({ ok: true }), "utf8").toString("base64");
  const paid = await fetch(`${service.url}/v1/fx/data/metrics`, {
    headers: { "payment-signature": payment },
  });
  assert.equal(paid.status, 200);
  assert.ok(paid.headers.get("payment-response"));
  verifyBrokerMetricsSnapshot(await paid.json());

  const first = await fetch(`${service.url}/v1/fx/routes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rfq: context.rfq }),
  });
  assert.equal(first.status, 200);
  const second = await fetch(`${service.url}/v1/fx/routes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rfq: context.rfq }),
  });
  assert.equal(second.status, 429);
});
