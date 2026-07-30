const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  Transaction,
  Wallet,
  keccak256,
} = require("ethers");
const {
  FX_NATIVE_ETH_ADDRESS,
  FxX402RequesterClient,
  FxX402SwapCoordinator,
  FxX402SwapStore,
  createBrokerRouteProposal,
  createFxBrokerHttpService,
  createFxX402SwapHttpHandler,
  packSettlementV3,
  signFxMessage,
  sourceFundingSpecification,
  verifySignedSourceFundingTransaction,
  x402SwapCommitment,
  x402SwapIntent,
} = require("../src");

const MANIFEST = require("../../../versus/deployments/fx/phase12-v3-public-testnet.json");
const DEPLOYMENT_ID = MANIFEST.deploymentId;
const SOURCE_CHAIN = "84532";
const DESTINATION_CHAIN = "421614";
const NOW = 1_800_000_000;
const SECRET = Buffer.alloc(32, 7);
const SECRET_HASH = keccak256(SECRET);

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-fx-x402-"));
  return {
    directory,
    cleanup() {
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function signedRfq(requester, {
  tradeId = `0x${"a1".repeat(32)}`,
  secretHash = SECRET_HASH,
} = {}) {
  const intent = x402SwapIntent({
    inputChainId: SOURCE_CHAIN,
    inputToken: FX_NATIVE_ETH_ADDRESS,
    outputChainId: DESTINATION_CHAIN,
    outputToken: FX_NATIVE_ETH_ADDRESS,
    outputAmountAtomic: "1000",
    destinationAddress: requester.address,
    sourceRefundAddress: requester.address,
    secretHash,
  });
  return signFxMessage({
    protocol: "versus-fx",
    version: 3,
    deploymentId: DEPLOYMENT_ID,
    type: "fx_rfq",
    tradeId,
    role: "requester",
    sequence: "1",
    createdAt: NOW,
    expiresAt: NOW + 120,
    payload: {
      outputChainId: DESTINATION_CHAIN,
      outputToken: FX_NATIVE_ETH_ADDRESS,
      outputAmountAtomic: "1000",
      inputOptions: [{
        chainId: SOURCE_CHAIN,
        token: FX_NATIVE_ETH_ADDRESS,
        maxInputAtomic: "2000",
      }],
      quoteDeadline: NOW + 115,
      settlementDeadline: NOW + 7_200,
      quotePolicy: "lowest_all_in",
      x402Commitment: x402SwapCommitment(intent),
    },
  }, requester);
}

async function signedProposal(rfq, dealer, broker) {
  const quote = await signFxMessage({
    protocol: "versus-fx",
    version: 3,
    deploymentId: DEPLOYMENT_ID,
    type: "fx_quote",
    tradeId: rfq.tradeId,
    role: "dealer",
    sequence: "1",
    createdAt: NOW,
    expiresAt: NOW + 100,
    payload: {
      rfqId: rfq.id,
      inputChainId: SOURCE_CHAIN,
      inputToken: FX_NATIVE_ETH_ADDRESS,
      inputAmountAtomic: "1010",
      outputChainId: DESTINATION_CHAIN,
      outputToken: FX_NATIVE_ETH_ADDRESS,
      outputAmountAtomic: "1000",
      quoteType: "fixed_exact_output",
      referenceSource: "relay:eth-usd",
      referencePriceMicros: "3000000000",
      referenceTimestamp: NOW,
      spreadBps: 5,
      dealerSettlementCostAtomic: "5",
      estimatedCompletionSeconds: 20,
      adapterId: "evm-native-htlc-v3",
      adapterVersion: 3,
      sourceAdapterId: "evm-native-htlc-v3",
      sourceAdapterVersion: 3,
      destinationAdapterId: "evm-native-htlc-v3",
      destinationAdapterVersion: 3,
      dealerPrincipalAtomic: "1000",
      dealerSpreadAtomic: "5",
      dealerOperatingCostAtomic: "5",
      destinationExecutorAmountAtomic: "1",
      destinationClaimGasEstimate: "85000",
      destinationMaxFeePerGas: "100000000",
      gasPriceSource: "rpc:arbitrum-sepolia",
      gasPriceTimestamp: NOW,
    },
  }, dealer);
  return createBrokerRouteProposal({
    signer: broker,
    rfq,
    quotes: [quote],
    brokerFeeAtomic: "0",
    now: NOW,
    lifetimeSeconds: 60,
  });
}

async function signedAcceptance(rfq, proposal, requester) {
  const quote = proposal.quotes[0];
  return signFxMessage({
    protocol: "versus-fx",
    version: 3,
    deploymentId: DEPLOYMENT_ID,
    type: "fx_accept",
    tradeId: rfq.tradeId,
    role: "requester",
    sequence: "2",
    createdAt: NOW + 3,
    expiresAt: NOW + 600,
    payload: {
      rfqId: rfq.id,
      quoteId: quote.id,
      routeId: proposal.route.routeId,
      dealerInputAmountAtomic: quote.payload.inputAmountAtomic,
      brokerFeeAtomic: proposal.route.brokerFeeAtomic,
      totalInputAtomic: proposal.route.totalInputAtomic,
      outputAmountAtomic: proposal.route.outputAmountAtomic,
      secretHash: SECRET_HASH,
      sourceRefundAddress: requester.address,
      destinationClaimAddress: requester.address,
      sourceAdapterId: quote.payload.sourceAdapterId,
      sourceAdapterVersion: 3,
      destinationAdapterId: quote.payload.destinationAdapterId,
      destinationAdapterVersion: 3,
    },
  }, requester);
}

async function signedReservation(acceptance, proposal, dealer) {
  const createdAt = acceptance.createdAt;
  return signFxMessage({
    protocol: "versus-fx",
    version: 3,
    deploymentId: DEPLOYMENT_ID,
    type: "fx_reserve",
    tradeId: acceptance.tradeId,
    role: "dealer",
    sequence: "2",
    createdAt,
    expiresAt: acceptance.expiresAt,
    payload: {
      acceptId: acceptance.id,
      quoteId: proposal.route.quoteId,
      dealerSourceClaimAddress: dealer.address,
      dealerDestinationRefundAddress: dealer.address,
      reservationDeadline: createdAt + 300,
    },
  }, dealer);
}

class FakeSession extends EventEmitter {
  constructor({ dealer, proposal }) {
    super();
    this.dealer = dealer;
    this.proposal = proposal;
    this.published = [];
    this.transport = {
      publish: async (envelope) => {
        this.published.push(envelope);
        if (envelope.type === "fx_accept") {
          const reserve = await signedReservation(
            envelope,
            this.proposal,
            this.dealer
          );
          setImmediate(() => this.emit("accepted", reserve));
        } else if (envelope.type === "fx_lock_source") {
          setImmediate(() => this.emit("accepted", {
            type: "fx_lock_destination",
            tradeId: envelope.tradeId,
            id: `0x${"d1".repeat(32)}`,
          }));
        } else if (envelope.type === "fx_reveal") {
          setImmediate(() => this.emit("accepted", {
            type: "fx_complete",
            tradeId: envelope.tradeId,
            id: `0x${"d2".repeat(32)}`,
          }));
        }
      },
    };
  }

  ingest() {
    return { status: "accepted" };
  }
}

class FakeProvider {
  constructor({ balance = 10n ** 18n } = {}) {
    this.broadcasts = [];
    this.receipts = new Map();
    this.balance = balance;
  }

  async getBlock() {
    return { timestamp: NOW };
  }

  async getTransactionCount() {
    return 0;
  }

  async getBalance() {
    return this.balance;
  }

  async estimateGas() {
    return 100_000n;
  }

  async getFeeData() {
    return {
      maxFeePerGas: 100_000_000n,
      maxPriorityFeePerGas: 1n,
    };
  }

  async broadcastTransaction(rawTransaction) {
    const transaction = Transaction.from(rawTransaction);
    this.broadcasts.push(rawTransaction);
    const receipt = {
      status: 1,
      blockNumber: 12345,
      hash: transaction.hash,
    };
    this.receipts.set(transaction.hash.toLowerCase(), receipt);
    return {
      hash: transaction.hash,
      wait: async () => receipt,
    };
  }

  async getTransactionReceipt(transactionHash) {
    return this.receipts.get(String(transactionHash).toLowerCase()) || null;
  }
}

test("requester fails clearly when the source wallet cannot fund principal and gas", async () => {
  const run = temporaryDirectory();
  const requester = Wallet.createRandom();
  const dealer = Wallet.createRandom();
  const brokerSigner = Wallet.createRandom();
  let proposal;
  let session;
  const broker = {
    async requestRoute(rfq) {
      proposal = await signedProposal(rfq, dealer, brokerSigner);
      session.proposal = proposal;
      return proposal;
    },
    status: () => ({ active: true }),
    metricsSnapshot: async () => ({}),
  };
  session = new FakeSession({ dealer, proposal: null });
  const provider = new FakeProvider({ balance: 0n });
  const store = new FxX402SwapStore({
    directory: path.join(run.directory, "broker"),
  });
  const coordinator = new FxX402SwapCoordinator({
    deploymentId: DEPLOYMENT_ID,
    manifest: MANIFEST,
    session,
    broker,
    providers: { [SOURCE_CHAIN]: provider },
    store,
    now: () => NOW,
  });
  const handler = createFxX402SwapHttpHandler({ coordinator });
  const service = createFxBrokerHttpService({
    broker,
    x402SwapHandler: handler,
  });
  try {
    const baseUrl = await service.listen();
    const client = new FxX402RequesterClient({
      endpoint: `${baseUrl}/v1/fx/swaps`,
      deploymentId: DEPLOYMENT_ID,
      manifest: MANIFEST,
      signer: requester,
      providers: { [SOURCE_CHAIN]: provider },
      recoveryDirectory: path.join(run.directory, "requester"),
      now: () => NOW,
      randomSecret: () => SECRET,
      sleep: () => new Promise((resolve) => setImmediate(resolve)),
    });
    await assert.rejects(
      client.execute({
        inputChainId: SOURCE_CHAIN,
        inputToken: FX_NATIVE_ETH_ADDRESS,
        maxInputAtomic: "2000",
        outputChainId: DESTINATION_CHAIN,
        outputToken: FX_NATIVE_ETH_ADDRESS,
        outputAmountAtomic: "1000",
        destinationAddress: requester.address,
        recoveryPassword: "test-only recovery password",
        statusPollMs: 1,
        completionTimeoutMs: 5_000,
      }),
      (error) => error?.code === "SOURCE_FUNDS_REQUIRED"
    );
  } finally {
    await service.close();
    coordinator.close();
    run.cleanup();
  }
});

async function fixture() {
  const requester = Wallet.createRandom();
  const dealer = Wallet.createRandom();
  const brokerSigner = Wallet.createRandom();
  const rfq = await signedRfq(requester);
  const proposal = await signedProposal(rfq, dealer, brokerSigner);
  const acceptance = await signedAcceptance(rfq, proposal, requester);
  const reservation = await signedReservation(acceptance, proposal, dealer);
  return {
    requester,
    dealer,
    brokerSigner,
    rfq,
    proposal,
    acceptance,
    reservation,
  };
}

test("V3 compact source settlement packs timeout and exact amounts", () => {
  const packed = packSettlementV3(NOW + 7_200, 1010n, 0n);
  assert.equal(packed >> 192n, BigInt(NOW + 7_200));
  assert.equal((packed >> 96n) & ((1n << 96n) - 1n), 1010n);
  assert.equal(packed & ((1n << 96n) - 1n), 0n);
});

test("source funding challenge binds the frozen V3 native adapter", async () => {
  const value = await fixture();
  const funding = sourceFundingSpecification({
    manifest: MANIFEST,
    proposal: value.proposal,
    acceptance: value.acceptance,
    reservation: value.reservation,
    sourceChainTimestamp: NOW,
    sourceRefundTimestamp: NOW + 7_200,
  });
  assert.equal(funding.adapterId, "evm-native-htlc-v3");
  assert.equal(
    funding.adapterAddress,
    "0x9ff9e978801b7819fa4169638814543028d0c0f2"
  );
  assert.equal(funding.amountAtomic, "1010");
  assert.equal(funding.transaction.value, "1010");
  assert.equal(funding.refundAddress, value.requester.address.toLowerCase());
  assert.equal(funding.beneficiary, value.dealer.address.toLowerCase());
});

test("only the exact requester-signed funding transaction is accepted", async () => {
  const value = await fixture();
  const funding = sourceFundingSpecification({
    manifest: MANIFEST,
    proposal: value.proposal,
    acceptance: value.acceptance,
    reservation: value.reservation,
    sourceChainTimestamp: NOW,
    sourceRefundTimestamp: NOW + 7_200,
  });
  const raw = await value.requester.signTransaction({
    chainId: BigInt(SOURCE_CHAIN),
    type: 2,
    nonce: 0,
    gasLimit: 100_000n,
    maxFeePerGas: 10n,
    maxPriorityFeePerGas: 1n,
    to: funding.transaction.to,
    data: funding.transaction.data,
    value: BigInt(funding.transaction.value),
  });
  const verified = verifySignedSourceFundingTransaction(raw, funding);
  assert.match(verified.transactionHash, /^0x[0-9a-f]{64}$/);
  const altered = await value.requester.signTransaction({
    chainId: BigInt(SOURCE_CHAIN),
    type: 2,
    nonce: 0,
    gasLimit: 100_000n,
    maxFeePerGas: 10n,
    maxPriorityFeePerGas: 1n,
    to: funding.transaction.to,
    data: funding.transaction.data,
    value: BigInt(funding.transaction.value) + 1n,
  });
  assert.throws(
    () => verifySignedSourceFundingTransaction(altered, funding),
    { code: "SOURCE_TRANSACTION_MISMATCH" }
  );
});

test("swap journal refuses plaintext secrets and signed transactions", async () => {
  const run = temporaryDirectory();
  try {
    const store = new FxX402SwapStore({ directory: run.directory });
    const tradeId = `0x${"b2".repeat(32)}`;
    store.put({ tradeId, status: "quote_ready", secretHash: SECRET_HASH });
    assert.equal(store.get(tradeId).status, "quote_ready");
    assert.throws(
      () => store.put({ tradeId, secret: SECRET.toString("hex") }),
      { code: "UNSAFE_PERSISTENCE" }
    );
    assert.throws(
      () => store.put({ tradeId, rawTransaction: "0x01" }),
      { code: "UNSAFE_PERSISTENCE" }
    );
  } finally {
    run.cleanup();
  }
});

test("coordinator journals acceptance, reserves, and broadcasts exactly once", async () => {
  const value = await fixture();
  const provider = new FakeProvider();
  const broker = {
    requestRoute: async () => value.proposal,
    status: () => ({ active: true }),
    metricsSnapshot: async () => ({}),
  };
  const session = new FakeSession({
    dealer: value.dealer,
    proposal: value.proposal,
  });
  const coordinator = new FxX402SwapCoordinator({
    broker,
    session,
    manifest: MANIFEST,
    providers: { [SOURCE_CHAIN]: provider },
    now: () => NOW + 5,
  });
  try {
    const opened = await coordinator.open({
      rfq: value.rfq,
      destinationAddress: value.requester.address,
      sourceRefundAddress: value.requester.address,
      secretHash: SECRET_HASH,
    });
    assert.equal(opened.status, "quote_ready");
    const reserved = await coordinator.accept({
      tradeId: value.rfq.tradeId,
      acceptance: value.acceptance,
    });
    assert.equal(reserved.status, "reserved");
    assert.equal(reserved.acceptance.id, value.acceptance.id);
    const raw = await value.requester.signTransaction({
      chainId: BigInt(SOURCE_CHAIN),
      type: 2,
      nonce: 0,
      gasLimit: 100_000n,
      maxFeePerGas: 10n,
      maxPriorityFeePerGas: 1n,
      to: reserved.funding.transaction.to,
      data: reserved.funding.transaction.data,
      value: BigInt(reserved.funding.transaction.value),
    });
    const settled = await coordinator.settle({
      tradeId: value.rfq.tradeId,
      rawTransaction: raw,
    });
    assert.equal(settled.status, "source_confirmed");
    await coordinator.settle({
      tradeId: value.rfq.tradeId,
      rawTransaction: raw,
    });
    assert.equal(provider.broadcasts.length, 1);
  } finally {
    coordinator.close();
  }
});

test("coordinator rejects destination data outside the signed x402 commitment", async () => {
  const value = await fixture();
  let routeRequests = 0;
  const broker = {
    async requestRoute() {
      routeRequests += 1;
      return value.proposal;
    },
  };
  const session = new FakeSession({
    dealer: value.dealer,
    proposal: value.proposal,
  });
  const coordinator = new FxX402SwapCoordinator({
    broker,
    session,
    manifest: MANIFEST,
    providers: { [SOURCE_CHAIN]: new FakeProvider() },
    now: () => NOW,
  });
  try {
    await assert.rejects(
      coordinator.open({
        rfq: value.rfq,
        destinationAddress: Wallet.createRandom().address,
        sourceRefundAddress: value.requester.address,
        secretHash: SECRET_HASH,
      }),
      { code: "COMMITMENT_MISMATCH" }
    );
    assert.equal(routeRequests, 0);
  } finally {
    coordinator.close();
  }
});

test("coordinator completes when source and destination claims arrive in either order", async () => {
  const value = await fixture();
  const provider = new FakeProvider();
  const broker = {
    requestRoute: async () => value.proposal,
    status: () => ({ active: true }),
    metricsSnapshot: async () => ({}),
  };
  const session = new FakeSession({
    dealer: value.dealer,
    proposal: value.proposal,
  });
  const coordinator = new FxX402SwapCoordinator({
    broker,
    session,
    manifest: MANIFEST,
    providers: { [SOURCE_CHAIN]: provider },
    now: () => NOW + 5,
  });
  try {
    await coordinator.open({
      rfq: value.rfq,
      destinationAddress: value.requester.address,
      sourceRefundAddress: value.requester.address,
      secretHash: SECRET_HASH,
    });
    await coordinator.accept({
      tradeId: value.rfq.tradeId,
      acceptance: value.acceptance,
    });
    const state = coordinator.store.get(value.rfq.tradeId);
    coordinator.store.update(value.rfq.tradeId, {
      sourceLockEnvelope: {
        id: `0x${"c1".repeat(32)}`,
      },
      destinationLockMessageId: `0x${"d1".repeat(32)}`,
    });
    coordinator.observe({
      type: "fx_claim",
      tradeId: value.rfq.tradeId,
      id: `0x${"e1".repeat(32)}`,
      payload: {
        lockMessageId: `0x${"c1".repeat(32)}`,
      },
    });
    assert.equal(coordinator.status(value.rfq.tradeId).status, "claim_observed");
    coordinator.observe({
      type: "fx_claim",
      tradeId: value.rfq.tradeId,
      id: `0x${"e2".repeat(32)}`,
      payload: {
        lockMessageId: `0x${"d1".repeat(32)}`,
      },
    });
    const completed = coordinator.status(value.rfq.tradeId);
    assert.equal(completed.status, "complete");
    assert.equal(completed.sourceClaimMessageId, `0x${"e1".repeat(32)}`);
    assert.equal(completed.destinationClaimMessageId, `0x${"e2".repeat(32)}`);
    assert.ok(state);
  } finally {
    coordinator.close();
  }
});

test("requester SDK completes staged x402 negotiation without exposing its secret", async () => {
  const run = temporaryDirectory();
  const requester = Wallet.createRandom();
  const dealer = Wallet.createRandom();
  const brokerSigner = Wallet.createRandom();
  const provider = new FakeProvider();
  let proposal;
  const broker = {
    async requestRoute(rfq) {
      proposal = await signedProposal(rfq, dealer, brokerSigner);
      return proposal;
    },
    status: () => ({ active: true }),
    metricsSnapshot: async () => ({}),
  };
  const session = new FakeSession({ dealer, get proposal() { return proposal; } });
  session.transport.publish = async (envelope) => {
    session.published.push(envelope);
    if (envelope.type === "fx_accept") {
      const reserve = await signedReservation(envelope, proposal, dealer);
      setImmediate(() => session.emit("accepted", reserve));
    } else if (envelope.type === "fx_lock_source") {
      setImmediate(() => session.emit("accepted", {
        type: "fx_lock_destination",
        tradeId: envelope.tradeId,
        id: `0x${"d1".repeat(32)}`,
      }));
    } else if (envelope.type === "fx_reveal") {
      setImmediate(() => session.emit("accepted", {
        type: "fx_complete",
        tradeId: envelope.tradeId,
        id: `0x${"d2".repeat(32)}`,
      }));
    }
  };
  const store = new FxX402SwapStore({
    directory: path.join(run.directory, "broker"),
  });
  const coordinator = new FxX402SwapCoordinator({
    broker,
    session,
    manifest: MANIFEST,
    providers: { [SOURCE_CHAIN]: provider },
    store,
    now: () => NOW,
  });
  const handler = createFxX402SwapHttpHandler({ coordinator });
  const service = createFxBrokerHttpService({
    broker,
    x402SwapHandler: handler,
  });
  try {
    const baseUrl = await service.listen();
    const client = new FxX402RequesterClient({
      endpoint: `${baseUrl}/v1/fx/swaps`,
      deploymentId: DEPLOYMENT_ID,
      manifest: MANIFEST,
      signer: requester,
      providers: { [SOURCE_CHAIN]: provider },
      recoveryDirectory: path.join(run.directory, "requester"),
      now: () => NOW,
      randomSecret: () => SECRET,
      sleep: () => new Promise((resolve) => setImmediate(resolve)),
    });
    const result = await client.execute({
      inputChainId: SOURCE_CHAIN,
      inputToken: FX_NATIVE_ETH_ADDRESS,
      maxInputAtomic: "2000",
      outputChainId: DESTINATION_CHAIN,
      outputToken: FX_NATIVE_ETH_ADDRESS,
      outputAmountAtomic: "1000",
      destinationAddress: requester.address,
      recoveryPassword: "test-only recovery password",
      statusPollMs: 1,
      completionTimeoutMs: 5_000,
    });
    assert.equal(result.status, "complete");
    assert.equal(result.endpointPaymentSubmitted, true);
    assert.equal(provider.broadcasts.length, 1);
    assert.deepEqual(
      session.published.map((message) => message.type),
      ["fx_accept", "fx_lock_source", "fx_reveal"]
    );
    const persisted = fs.readFileSync(
      store.filePath(result.tradeId),
      "utf8"
    );
    assert.doesNotMatch(persisted, /rawTransaction|privateKey|\"secret\"\s*:/);
    assert.doesNotMatch(persisted, new RegExp(SECRET.toString("hex"), "i"));
  } finally {
    await service.close().catch(() => {});
    coordinator.close();
    run.cleanup();
  }
});
