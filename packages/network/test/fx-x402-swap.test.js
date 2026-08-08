const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  Interface,
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
  phase5LockId,
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

const V3_LOCK_INTERFACE = new Interface([
  "function stateOf(bytes32 lockDigest) view returns (uint8)",
  "event LockFunded(bytes32 indexed lockDigest,bytes32 indexed tradeId,address indexed funder,address beneficiary,bytes32 secretHash,uint64 refundTimestamp,uint128 beneficiaryAmount,uint128 executorAmount)",
]);

class FakeLockProvider extends FakeProvider {
  constructor({ receipt, state = 2 } = {}) {
    super();
    this.lockReceipt = receipt;
    this.lockState = state;
  }

  async getTransactionReceipt() {
    return this.lockReceipt;
  }

  async call() {
    return V3_LOCK_INTERFACE.encodeFunctionResult("stateOf", [this.lockState]);
  }
}

function v3LockEvidence({
  tradeId,
  side,
  adapterAddress,
  funder,
  beneficiary,
  amountAtomic,
  beneficiaryAmountAtomic,
  executorAmountAtomic,
  timeout,
  transactionHash,
  blockNumber,
  sender,
  chainId,
  token = FX_NATIVE_ETH_ADDRESS,
  acceptId,
  lockDigest = `0x${(side === "source" ? "91" : "92").repeat(32)}`,
}) {
  const lockId = phase5LockId(tradeId, side);
  const encoded = V3_LOCK_INTERFACE.encodeEventLog(
    V3_LOCK_INTERFACE.getEvent("LockFunded"),
    [
      lockDigest,
      lockId,
      funder,
      beneficiary,
      SECRET_HASH,
      timeout,
      beneficiaryAmountAtomic,
      executorAmountAtomic,
    ]
  );
  return {
    envelope: {
      type: side === "source" ? "fx_lock_source" : "fx_lock_destination",
      tradeId,
      sender: sender.toLowerCase(),
      id: `0x${(side === "source" ? "c1" : "d1").repeat(32)}`,
      payload: {
        acceptId,
        chainId,
        token,
        amountAtomic,
        beneficiaryAmountAtomic,
        executorAmountAtomic,
        lockAddress: adapterAddress,
        beneficiary: beneficiary.toLowerCase(),
        refundAddress: funder.toLowerCase(),
        secretHash: SECRET_HASH,
        timeout,
        transactionHash,
        blockNumber: String(blockNumber),
      },
    },
    receipt: {
      status: 1,
      blockNumber,
      logs: [{
        address: adapterAddress,
        topics: encoded.topics,
        data: encoded.data,
      }],
    },
  };
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

test("coordinator rebuilds persisted HTTP status from an already-synced journal", async () => {
  const value = await fixture();
  const run = temporaryDirectory();
  const sourceLockId = `0x${"c1".repeat(32)}`;
  const destinationLockId = `0x${"d1".repeat(32)}`;
  const destinationClaimId = `0x${"e2".repeat(32)}`;
  const sourceClaimId = `0x${"e1".repeat(32)}`;
  const messages = new Map([
    [destinationLockId, {
      type: "fx_lock_destination",
      tradeId: value.rfq.tradeId,
      id: destinationLockId,
      sequence: "3",
      createdAt: NOW + 7,
      payload: {},
    }],
    [sourceClaimId, {
      type: "fx_claim",
      tradeId: value.rfq.tradeId,
      id: sourceClaimId,
      sequence: "4",
      createdAt: NOW + 10,
      payload: { lockMessageId: sourceLockId },
    }],
    [destinationClaimId, {
      type: "fx_claim",
      tradeId: value.rfq.tradeId,
      id: destinationClaimId,
      sequence: "5",
      createdAt: NOW + 9,
      payload: { lockMessageId: destinationLockId },
    }],
  ]);
  const session = new FakeSession({
    dealer: value.dealer,
    proposal: value.proposal,
  });
  session.journal = {
    tradeIds: () => [value.rfq.tradeId],
    snapshot: () => ({
      // Deliberately return hash order rather than settlement order.
      messages: [...messages.keys()].sort().map((id) => ({ id })),
    }),
    message: (id) => messages.get(id),
  };
  const store = new FxX402SwapStore({
    directory: path.join(run.directory, "broker"),
  });
  store.put({
    tradeId: value.rfq.tradeId,
    status: "secret_revealed",
    sourceLockEnvelope: { id: sourceLockId },
  });
  const coordinator = new FxX402SwapCoordinator({
    broker: {
      requestRoute: async () => value.proposal,
    },
    session,
    manifest: MANIFEST,
    providers: { [SOURCE_CHAIN]: new FakeProvider() },
    store,
    now: () => NOW + 20,
  });
  try {
    assert.equal(coordinator.recoverFromJournal(), 3);
    const recovered = coordinator.status(value.rfq.tradeId);
    assert.equal(recovered.status, "complete");
    assert.equal(recovered.destinationLockMessageId, destinationLockId);
    assert.equal(recovered.destinationClaimMessageId, destinationClaimId);
    assert.equal(recovered.sourceClaimMessageId, sourceClaimId);
  } finally {
    coordinator.close();
    run.cleanup();
  }
});

test("coordinator reconciles missed terminal Waku claims from exact V3 locks", async () => {
  const value = await fixture();
  const sourceCapability = MANIFEST.capabilities.find(
    (item) => String(item.chainId) === SOURCE_CHAIN
  ).native;
  const destinationCapability = MANIFEST.capabilities.find(
    (item) => String(item.chainId) === DESTINATION_CHAIN
  ).native;
  const funding = sourceFundingSpecification({
    manifest: MANIFEST,
    proposal: value.proposal,
    acceptance: value.acceptance,
    reservation: value.reservation,
    sourceChainTimestamp: NOW,
    sourceRefundTimestamp: NOW + 7_200,
  });
  const source = v3LockEvidence({
    tradeId: value.rfq.tradeId,
    side: "source",
    adapterAddress: sourceCapability.adapterAddress,
    funder: value.requester.address,
    beneficiary: value.dealer.address,
    amountAtomic: "1010",
    beneficiaryAmountAtomic: "1010",
    executorAmountAtomic: "0",
    timeout: NOW + 7_200,
    transactionHash: `0x${"11".repeat(32)}`,
    blockNumber: 101,
    sender: value.requester.address,
    chainId: SOURCE_CHAIN,
    acceptId: value.acceptance.id,
  });
  const destination = v3LockEvidence({
    tradeId: value.rfq.tradeId,
    side: "destination",
    adapterAddress: destinationCapability.adapterAddress,
    funder: value.dealer.address,
    beneficiary: value.requester.address,
    amountAtomic: "1001",
    beneficiaryAmountAtomic: "1000",
    executorAmountAtomic: "1",
    timeout: NOW + 3_600,
    transactionHash: `0x${"22".repeat(32)}`,
    blockNumber: 102,
    sender: value.dealer.address,
    chainId: DESTINATION_CHAIN,
    acceptId: value.acceptance.id,
  });
  const session = new FakeSession({
    dealer: value.dealer,
    proposal: value.proposal,
  });
  session.journal = {
    message: (id) =>
      id === destination.envelope.id ? destination.envelope : null,
  };
  const coordinator = new FxX402SwapCoordinator({
    broker: { requestRoute: async () => value.proposal },
    session,
    manifest: MANIFEST,
    providers: {
      [SOURCE_CHAIN]: new FakeLockProvider({ receipt: source.receipt }),
      [DESTINATION_CHAIN]: new FakeLockProvider({
        receipt: destination.receipt,
      }),
    },
    now: () => NOW + 30,
  });
  try {
    coordinator.store.put({
      schema: "versus-x402-atomic-swap",
      schemaVersion: 1,
      tradeId: value.rfq.tradeId,
      status: "secret_revealed",
      rfq: value.rfq,
      proposal: value.proposal,
      acceptance: value.acceptance,
      reservation: value.reservation,
      funding,
      sourceLockEnvelope: source.envelope,
      destinationLockMessageId: destination.envelope.id,
    });
    const reconciled = await coordinator.reconcileStatus(value.rfq.tradeId);
    assert.equal(reconciled.status, "complete");
    assert.equal(reconciled.onchainReconciled, true);
    assert.equal(
      reconciled.onchainReconciledAt,
      new Date((NOW + 30) * 1000).toISOString()
    );
  } finally {
    coordinator.close();
  }
});

test("onchain reconciliation fails closed for incomplete or mismatched locks", async () => {
  const value = await fixture();
  const sourceCapability = MANIFEST.capabilities.find(
    (item) => String(item.chainId) === SOURCE_CHAIN
  ).native;
  const destinationCapability = MANIFEST.capabilities.find(
    (item) => String(item.chainId) === DESTINATION_CHAIN
  ).native;
  const funding = sourceFundingSpecification({
    manifest: MANIFEST,
    proposal: value.proposal,
    acceptance: value.acceptance,
    reservation: value.reservation,
    sourceChainTimestamp: NOW,
    sourceRefundTimestamp: NOW + 7_200,
  });
  const source = v3LockEvidence({
    tradeId: value.rfq.tradeId,
    side: "source",
    adapterAddress: sourceCapability.adapterAddress,
    funder: value.requester.address,
    beneficiary: value.dealer.address,
    amountAtomic: "1010",
    beneficiaryAmountAtomic: "1010",
    executorAmountAtomic: "0",
    timeout: NOW + 7_200,
    transactionHash: `0x${"31".repeat(32)}`,
    blockNumber: 201,
    sender: value.requester.address,
    chainId: SOURCE_CHAIN,
    acceptId: value.acceptance.id,
  });
  const destination = v3LockEvidence({
    tradeId: value.rfq.tradeId,
    side: "destination",
    adapterAddress: destinationCapability.adapterAddress,
    funder: value.dealer.address,
    beneficiary: value.requester.address,
    amountAtomic: "1001",
    beneficiaryAmountAtomic: "1000",
    executorAmountAtomic: "1",
    timeout: NOW + 3_600,
    transactionHash: `0x${"32".repeat(32)}`,
    blockNumber: 202,
    sender: value.dealer.address,
    chainId: DESTINATION_CHAIN,
    acceptId: value.acceptance.id,
  });
  const mismatchedDestination = v3LockEvidence({
    tradeId: value.rfq.tradeId,
    side: "destination",
    adapterAddress: destinationCapability.adapterAddress,
    funder: value.dealer.address,
    beneficiary: Wallet.createRandom().address,
    amountAtomic: "1001",
    beneficiaryAmountAtomic: "1000",
    executorAmountAtomic: "1",
    timeout: NOW + 3_600,
    transactionHash: `0x${"32".repeat(32)}`,
    blockNumber: 202,
    sender: value.dealer.address,
    chainId: DESTINATION_CHAIN,
    acceptId: value.acceptance.id,
  });
  for (const destinationProvider of [
    new FakeLockProvider({ receipt: destination.receipt, state: 1 }),
    new FakeLockProvider({ receipt: mismatchedDestination.receipt, state: 2 }),
  ]) {
    const session = new FakeSession({
      dealer: value.dealer,
      proposal: value.proposal,
    });
    session.journal = {
      message: (id) =>
        id === destination.envelope.id ? destination.envelope : null,
    };
    const coordinator = new FxX402SwapCoordinator({
      broker: { requestRoute: async () => value.proposal },
      session,
      manifest: MANIFEST,
      providers: {
        [SOURCE_CHAIN]: new FakeLockProvider({ receipt: source.receipt }),
        [DESTINATION_CHAIN]: destinationProvider,
      },
      now: () => NOW + 30,
    });
    try {
      coordinator.store.put({
        tradeId: value.rfq.tradeId,
        status: "secret_revealed",
        rfq: value.rfq,
        proposal: value.proposal,
        acceptance: value.acceptance,
        reservation: value.reservation,
        funding,
        sourceLockEnvelope: source.envelope,
        destinationLockMessageId: destination.envelope.id,
      });
      const result = await coordinator.reconcileStatus(value.rfq.tradeId);
      assert.equal(result.status, "secret_revealed");
      assert.equal(result.onchainReconciled, undefined);
    } finally {
      coordinator.close();
    }
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
