const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  Wallet,
  keccak256,
  toUtf8Bytes,
} = require("ethers");
const {
  FxPhase8DealerGuard,
  FxPhase8ExposureJournal,
  FxWakuTransport,
  coarseCapacityBand,
  createDealerNoShowEvidence,
  createIndependentSlicePlan,
  createRequesterAbandonmentEvidence,
  evaluatePhase8Economics,
  normalizePhase8Policy,
  phase5LockId,
  selectSingleDealerRoute,
  signFxMessage,
  verifyDealerNoShowEvidence,
  verifyPhase8EvidenceAttestation,
  verifyPhase8SourceLockPackage,
  verifyRequesterAbandonmentEvidence,
} = require("../src");

const DEPLOYMENT_ID = `0x${"81".repeat(32)}`;
const SOURCE_CHAIN = "84532";
const DESTINATION_CHAIN = "421614";
const SOURCE_TOKEN = `0x${"11".repeat(20)}`;
const DESTINATION_TOKEN = `0x${"22".repeat(20)}`;
const SOURCE_ADAPTER = `0x${"33".repeat(20)}`;
const DESTINATION_ADAPTER = `0x${"44".repeat(20)}`;
const NOW = 1_800_000_000;

class Phase8WakuBus {
  constructor() {
    this.history = [];
    this.nodes = new Set();
  }

  node() {
    const bus = this;
    const callbacks = new Map();
    const node = {
      callbacks,
      async waitForPeers() {},
      async getConnectedPeers() {
        return [{
          id: "phase8-relay",
          protocols: [
            "/vac/waku/lightpush/3.0.0",
            "/vac/waku/filter-subscribe/2.0.0-beta1",
            "/vac/waku/store-query/3.0.0",
          ],
        }];
      },
      createEncoder({ contentTopic, ephemeral }) {
        return { contentTopic, ephemeral };
      },
      createDecoder({ contentTopic }) {
        return { contentTopic };
      },
      filter: {
        async subscribe(decoder, callback) {
          callbacks.set(decoder.contentTopic, callback);
          return true;
        },
        async unsubscribe(decoder) {
          callbacks.delete(decoder.contentTopic);
          return true;
        },
      },
      store: {
        async queryWithOrderedCallback(decoders, callback) {
          const topic = decoders[0].contentTopic;
          for (const entry of bus.history.filter((item) => item.topic === topic)) {
            if (await callback(entry.message)) break;
          }
        },
      },
      lightPush: {
        async send(encoder, message) {
          const entry = {
            topic: encoder.contentTopic,
            message: {
              ...message,
              hashStr: `phase8-${bus.history.length + 1}`,
            },
          };
          bus.history.push(entry);
          for (const target of bus.nodes) {
            await target.callbacks.get(entry.topic)?.(entry.message);
          }
          return { successes: ["phase8-relay"], failures: [] };
        },
      },
      async stop() {
        callbacks.clear();
        bus.nodes.delete(node);
      },
    };
    bus.nodes.add(node);
    return node;
  }
}

function phase8Transport(bus) {
  return new FxWakuTransport({
    deploymentId: DEPLOYMENT_ID,
    bootstrapPeers: ["phase8-relay"],
    now: () => (NOW + 301) * 1000,
    sdkLoader: async () => ({
      Protocols: { LightPush: "lightpush", Filter: "filter" },
    }),
    nodeFactory: async () => bus.node(),
  });
}

function once(emitter, event, timeoutMs = 1_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${event}`)),
      timeoutMs
    );
    emitter.once(event, (...args) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

function temporaryDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-fx-phase8-"));
  return {
    directory,
    filePath: path.join(directory, "exposure.sqlite"),
    cleanup() {
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function v2ExposureFixture({
  label = "v2-exposure",
  tradeId = keccak256(toUtf8Bytes(`${label}:trade`)),
  requester = Wallet.createRandom(),
  dealer = Wallet.createRandom(),
} = {}) {
  const message = (name) => keccak256(toUtf8Bytes(`${label}:${name}`));
  const rfq = {
    version: 2,
    deploymentId: DEPLOYMENT_ID,
    tradeId,
    id: message("rfq"),
    sender: requester.address.toLowerCase(),
  };
  const quote = {
    version: 2,
    id: message("quote"),
    sender: dealer.address.toLowerCase(),
    payload: {
      inputAmountAtomic: "101000",
      outputChainId: DESTINATION_CHAIN,
      outputToken: DESTINATION_TOKEN,
      outputAmountAtomic: "100000",
      destinationExecutorAmountAtomic: "2000",
    },
  };
  const accept = {
    version: 2,
    id: message("accept"),
  };
  const reserve = {
    version: 2,
    id: message("reserve"),
    payload: {
      reservationDeadline: NOW + 600,
    },
  };
  return {
    rfq,
    quote,
    accept,
    reserve,
    expectedSourceLockId: phase5LockId(tradeId, "source"),
    expectedDestinationLockId: phase5LockId(tradeId, "destination"),
    destinationRefundTimestamp: NOW + 7_200,
    exposureValueMicros: "100000",
    economics: {
      beneficiaryAmountAtomic: "100000",
      executorAmountAtomic: "2000",
      totalDestinationLiabilityAtomic: "102000",
    },
  };
}

async function signedFixture({
  tradeId = `0x${"82".repeat(32)}`,
  requester = Wallet.createRandom(),
  dealer = Wallet.createRandom(),
  referenceTimestamp = NOW + 1,
  inputAmountAtomic = "101000",
  brokerFeeAtomic = "500",
  sourceTimeout = NOW + 7_220,
  reserveDeadline = NOW + 300,
} = {}) {
  const rfq = await signFxMessage({
    protocol: "versus-fx",
    version: 1,
    deploymentId: DEPLOYMENT_ID,
    type: "fx_rfq",
    tradeId,
    role: "requester",
    sequence: "1",
    createdAt: NOW,
    expiresAt: NOW + 60,
    payload: {
      outputChainId: DESTINATION_CHAIN,
      outputToken: DESTINATION_TOKEN,
      outputAmountAtomic: "100000",
      inputOptions: [{
        chainId: SOURCE_CHAIN,
        token: SOURCE_TOKEN,
        maxInputAtomic: "200000000",
      }],
      quoteDeadline: NOW + 50,
      settlementDeadline: NOW + 7_200,
      quotePolicy: "lowest_all_in",
      x402Commitment: null,
    },
  }, requester);
  const quote = await signFxMessage({
    protocol: "versus-fx",
    version: 1,
    deploymentId: DEPLOYMENT_ID,
    type: "fx_quote",
    tradeId,
    role: "dealer",
    sequence: "1",
    createdAt: NOW + 1,
    expiresAt: NOW + 45,
    payload: {
      rfqId: rfq.id,
      inputChainId: SOURCE_CHAIN,
      inputToken: SOURCE_TOKEN,
      inputAmountAtomic,
      outputChainId: DESTINATION_CHAIN,
      outputToken: DESTINATION_TOKEN,
      outputAmountAtomic: "100000",
      quoteType: "fixed_exact_output",
      referenceSource: "chainlink:usdc-usd",
      referencePriceMicros: "1000000",
      referenceTimestamp,
      spreadBps: 25,
      dealerSettlementCostAtomic: "500",
      estimatedCompletionSeconds: 90,
      adapterId: "evm-htlc-v1",
      adapterVersion: 1,
    },
  }, dealer);
  const route = selectSingleDealerRoute(
    rfq,
    [{ quote, brokerFeeAtomic }],
    { now: NOW + 2, policy: "lowest_all_in" }
  );
  const secretHash = keccak256(toUtf8Bytes(`secret:${tradeId}`));
  const accept = await signFxMessage({
    protocol: "versus-fx",
    version: 1,
    deploymentId: DEPLOYMENT_ID,
    type: "fx_accept",
    tradeId,
    role: "requester",
    sequence: "2",
    createdAt: NOW + 2,
    expiresAt: NOW + 600,
    payload: {
      rfqId: rfq.id,
      quoteId: quote.id,
      routeId: route.routeId,
      dealerInputAmountAtomic: inputAmountAtomic,
      brokerFeeAtomic,
      totalInputAtomic: route.totalInputAtomic,
      outputAmountAtomic: route.outputAmountAtomic,
      secretHash,
      sourceRefundAddress: requester.address,
      destinationClaimAddress: requester.address,
      sourceAdapterId: "evm-htlc-v1",
      sourceAdapterVersion: 1,
      destinationAdapterId: "evm-htlc-v1",
      destinationAdapterVersion: 1,
    },
  }, requester);
  const reserve = await signFxMessage({
    protocol: "versus-fx",
    version: 1,
    deploymentId: DEPLOYMENT_ID,
    type: "fx_reserve",
    tradeId,
    role: "dealer",
    sequence: "2",
    createdAt: NOW + 3,
    expiresAt: NOW + 600,
    payload: {
      acceptId: accept.id,
      quoteId: quote.id,
      dealerSourceClaimAddress: dealer.address,
      dealerDestinationRefundAddress: dealer.address,
      reservationDeadline: reserveDeadline,
    },
  }, dealer);
  const sourceLock = await signFxMessage({
    protocol: "versus-fx",
    version: 1,
    deploymentId: DEPLOYMENT_ID,
    type: "fx_lock_source",
    tradeId,
    role: "requester",
    sequence: "3",
    createdAt: NOW + 20,
    expiresAt: NOW + 7_400,
    payload: {
      acceptId: accept.id,
      chainId: SOURCE_CHAIN,
      token: SOURCE_TOKEN,
      amountAtomic: route.totalInputAtomic,
      lockAddress: SOURCE_ADAPTER,
      beneficiary: dealer.address,
      refundAddress: requester.address,
      secretHash,
      timeout: sourceTimeout,
      transactionHash: `0x${"51".repeat(32)}`,
      blockNumber: "100",
    },
  }, requester);
  return {
    requester,
    dealer,
    rfq,
    quote,
    route,
    accept,
    reserve,
    sourceLock,
    sourceChain: {
      confirmed: true,
      canonical: true,
      confirmations: 3,
      lockId: phase5LockId(tradeId, "source"),
      transactionHash: sourceLock.payload.transactionHash,
      chainId: SOURCE_CHAIN,
      token: SOURCE_TOKEN,
      amountAtomic: route.totalInputAtomic,
      beneficiary: dealer.address,
      refundAddress: requester.address,
      secretHash,
      timeout: sourceTimeout,
      blockTimestamp: NOW + 20,
    },
  };
}

async function firmFixture(context, {
  policy = {},
  now = NOW + 25,
  verifyChainLock = async () => context.sourceChain,
} = {}) {
  return verifyPhase8SourceLockPackage({
    rfq: context.rfq,
    quote: context.quote,
    accept: context.accept,
    reserve: context.reserve,
    sourceLock: context.sourceLock,
    referenceInputAtomic: "100000",
    exposureValueMicros: "100000",
    requesterGasInputAtomic: "1000",
    verifyChainLock,
    policy,
    now,
  });
}

async function destinationLock(context, timeout = NOW + 625) {
  return signFxMessage({
    protocol: "versus-fx",
    version: 1,
    deploymentId: DEPLOYMENT_ID,
    type: "fx_lock_destination",
    tradeId: context.rfq.tradeId,
    role: "dealer",
    sequence: "3",
    createdAt: NOW + 25,
    expiresAt: NOW + 1_000,
    payload: {
      acceptId: context.accept.id,
      chainId: DESTINATION_CHAIN,
      token: DESTINATION_TOKEN,
      amountAtomic: "100000",
      lockAddress: DESTINATION_ADAPTER,
      beneficiary: context.requester.address,
      refundAddress: context.dealer.address,
      secretHash: context.accept.payload.secretHash,
      timeout,
      transactionHash: `0x${"52".repeat(32)}`,
      blockNumber: "200",
    },
  }, context.dealer);
}

async function replacementSourceLock(context, overrides = {}) {
  return signFxMessage({
    protocol: "versus-fx",
    version: 1,
    deploymentId: DEPLOYMENT_ID,
    type: "fx_lock_source",
    tradeId: context.rfq.tradeId,
    role: "requester",
    sequence: "3",
    createdAt: NOW + 20,
    expiresAt: NOW + 7_400,
    payload: {
      ...context.sourceLock.payload,
      ...overrides,
    },
  }, context.requester);
}

test("Phase 8 remains disabled and freezes asymmetric refund policy", () => {
  const policy = normalizePhase8Policy();
  assert.equal(policy.enabledByDefault, false);
  assert.equal(policy.productionFunds, false);
  assert.equal(policy.sourceRefundSeconds, 7_200);
  assert.equal(policy.destinationRefundSeconds, 600);
  assert.throws(
    () => normalizePhase8Policy({ productionFunds: true }),
    (error) => error.code === "PRODUCTION_CONNECTED"
  );
});

test("dealer firms only an independently confirmed source lock", async () => {
  const context = await signedFixture();
  const firm = await firmFixture(context);
  assert.equal(firm.destinationRefundTimestamp, NOW + 625);
  assert.equal(firm.expectedSourceLockId, phase5LockId(context.rfq.tradeId, "source"));
  await assert.rejects(
    () => verifyPhase8SourceLockPackage({
      rfq: context.rfq,
      quote: context.quote,
      accept: context.accept,
      reserve: context.reserve,
      sourceLock: context.sourceLock,
      referenceInputAtomic: "100000",
      exposureValueMicros: "100000",
      requesterGasInputAtomic: "1000",
      verifyChainLock: async () => ({
        ...context.sourceChain,
        amountAtomic: "1",
      }),
      now: NOW + 25,
    }),
    (error) => error.code === "SOURCE_LOCK_NOT_FIRM"
  );
  await assert.rejects(
    () => verifyPhase8SourceLockPackage({
      rfq: context.rfq,
      quote: context.quote,
      accept: context.accept,
      reserve: context.reserve,
      sourceLock: context.sourceLock,
      referenceInputAtomic: "100000",
      exposureValueMicros: "100000",
      requesterGasInputAtomic: "1000",
      verifyChainLock: async () => ({
        ...context.sourceChain,
        canonical: false,
      }),
      now: NOW + 25,
    }),
    (error) => error.code === "SOURCE_LOCK_NOT_FIRM"
  );
});

test("late source locks, stale prices, and gas-heavy trades fail closed", async () => {
  const late = await signedFixture({ reserveDeadline: NOW + 70 });
  await assert.rejects(
    () => firmFixture(late),
    (error) => error.code === "SOURCE_LOCK_NOT_FIRM"
  );
  const stale = await signedFixture({ referenceTimestamp: NOW });
  await assert.rejects(
    () => firmFixture(stale, {
      policy: { maximumReferenceAgeSeconds: 10 },
    }),
    (error) => error.code === "STALE_PRICE_REFERENCE"
  );
  const context = await signedFixture();
  const economics = evaluatePhase8Economics({
    route: context.route,
    referenceInputAtomic: "100000",
    requesterGasInputAtomic: "50000",
  });
  assert.equal(economics.accepted, false);
  assert.ok(economics.reasons.includes("overhead_above_maximum"));
});

test("underfunded, replaced, stalled, and failed source reads never firm", async () => {
  const context = await signedFixture();
  const underfunded = await replacementSourceLock(context, {
    amountAtomic: "100000",
  });
  await assert.rejects(
    () => verifyPhase8SourceLockPackage({
      rfq: context.rfq,
      quote: context.quote,
      accept: context.accept,
      reserve: context.reserve,
      sourceLock: underfunded,
      referenceInputAtomic: "100000",
      exposureValueMicros: "100000",
      requesterGasInputAtomic: "1000",
      verifyChainLock: async () => ({
        ...context.sourceChain,
        amountAtomic: "100000",
      }),
      now: NOW + 25,
    }),
    (error) => error.code === "PACKAGE_LINEAGE_MISMATCH"
  );
  await assert.rejects(
    () => verifyPhase8SourceLockPackage({
      rfq: context.rfq,
      quote: context.quote,
      accept: context.accept,
      reserve: context.reserve,
      sourceLock: context.sourceLock,
      referenceInputAtomic: "100000",
      exposureValueMicros: "100000",
      requesterGasInputAtomic: "1000",
      verifyChainLock: async () => ({
        ...context.sourceChain,
        transactionHash: `0x${"99".repeat(32)}`,
      }),
      now: NOW + 25,
    }),
    (error) => error.code === "SOURCE_LOCK_NOT_FIRM"
  );
  await assert.rejects(
    () => firmFixture(context, {
      policy: { chainVerificationTimeoutMs: 5 },
      now: NOW + 25,
      verifyChainLock: () => new Promise(() => {}),
    }),
    (error) => error.code === "CHAIN_VERIFIER_UNAVAILABLE"
  );
  await assert.rejects(
    () => verifyPhase8SourceLockPackage({
      rfq: context.rfq,
      quote: context.quote,
      accept: context.accept,
      reserve: context.reserve,
      sourceLock: context.sourceLock,
      referenceInputAtomic: "100000",
      exposureValueMicros: "100000",
      requesterGasInputAtomic: "1000",
      verifyChainLock: async () => {
        throw new Error("RPC unavailable");
      },
      now: NOW + 25,
    }),
    (error) => error.code === "CHAIN_VERIFIER_UNAVAILABLE"
  );
});

test("source timeout boundary is exact to one second", async () => {
  const context = await signedFixture();
  await firmFixture(context, {
    policy: { minimumSourceRemainingSeconds: 7_195 },
    now: NOW + 25,
  });
  await assert.rejects(
    () => firmFixture(context, {
      policy: { minimumSourceRemainingSeconds: 7_196 },
      now: NOW + 25,
    }),
    (error) => error.code === "UNSAFE_TIMEOUT_ORDER"
  );
});

test("capacity is coarse and fresh Sybils cannot bypass global exposure", async () => {
  assert.deepEqual(coarseCapacityBand("74999"), {
    lowerBoundAtomic: "50000",
    exactBalanceDisclosed: false,
  });
  const database = temporaryDatabase();
  const policy = {
    maximumActiveLocksGlobal: 1,
    maximumActiveLocksPerRequester: 1,
  };
  const journal = new FxPhase8ExposureJournal({
    filePath: database.filePath,
    deploymentId: DEPLOYMENT_ID,
    policy,
  });
  try {
    const first = await signedFixture();
    journal.admitSource(await firmFixture(first, { policy }));
    const sybil = await signedFixture({
      tradeId: `0x${"83".repeat(32)}`,
      requester: Wallet.createRandom(),
    });
    const sybilFirm = await firmFixture(sybil, { policy });
    assert.throws(
      () => journal.admitSource(sybilFirm),
      (error) => error.code === "EXPOSURE_LIMIT"
    );
  } finally {
    journal.close();
    database.cleanup();
  }
});

test("exposure and exact package identity survive restart", async () => {
  const database = temporaryDatabase();
  const context = await signedFixture();
  const firm = await firmFixture(context);
  let journal = new FxPhase8ExposureJournal({
    filePath: database.filePath,
    deploymentId: DEPLOYMENT_ID,
  });
  const admitted = journal.admitSource(firm);
  assert.equal(admitted.state, "source_firm");
  journal.close();
  journal = new FxPhase8ExposureJournal({
    filePath: database.filePath,
    deploymentId: DEPLOYMENT_ID,
  });
  try {
    assert.equal(journal.activeTrades().length, 1);
    assert.equal(journal.exposureSummary().exposureValueMicros, "100000");
    assert.equal(journal.admitSource(firm).packageId, admitted.packageId);
  } finally {
    journal.close();
    database.cleanup();
  }
});

test("V2 destination reservation counts before broadcast and survives restart", () => {
  const database = temporaryDatabase();
  const policy = {
    maximumActiveLocksGlobal: 1,
    maximumActiveLocksPerRequester: 1,
  };
  const first = v2ExposureFixture();
  let journal = new FxPhase8ExposureJournal({
    filePath: database.filePath,
    deploymentId: DEPLOYMENT_ID,
    policy,
  });
  try {
    const pending = journal.reserveDestinationV2(first);
    assert.equal(pending.state, "destination_pending");
    assert.equal(journal.activeTrades().length, 1);
    assert.equal(journal.exposureSummary().exposureValueMicros, "100000");
    assert.deepEqual(pending.economics, first.economics);
  } finally {
    journal.close();
  }

  journal = new FxPhase8ExposureJournal({
    filePath: database.filePath,
    deploymentId: DEPLOYMENT_ID,
    policy,
  });
  try {
    assert.equal(journal.activeTrades()[0].state, "destination_pending");
    assert.equal(
      journal.reserveDestinationV2(first).packageId,
      journal.activeTrades()[0].packageId
    );
    assert.throws(
      () => journal.reserveDestinationV2(
        v2ExposureFixture({ label: "second-v2-exposure" })
      ),
      (error) => error.code === "EXPOSURE_LIMIT"
    );

    const destinationLock = {
      version: 2,
      type: "fx_lock_destination",
      id: keccak256(toUtf8Bytes("v2-destination-lock-message")),
      payload: {
        transactionHash: keccak256(toUtf8Bytes("v2-destination-lock-tx")),
        timeout: first.destinationRefundTimestamp,
      },
    };
    const locked = journal.markDestinationLockedV2(
      first.rfq.tradeId,
      destinationLock
    );
    assert.equal(locked.state, "destination_locked");
    assert.equal(
      locked.destinationTransactionHash,
      destinationLock.payload.transactionHash
    );
  } finally {
    journal.close();
    database.cleanup();
  }
});

test("free RFQ spam cannot reserve exposure and conflicting replay fails closed", async () => {
  const database = temporaryDatabase();
  const journal = new FxPhase8ExposureJournal({
    filePath: database.filePath,
    deploymentId: DEPLOYMENT_ID,
  });
  try {
    const first = await signedFixture();
    assert.equal(journal.exposureSummary().count, 0);
    journal.admitSource(await firmFixture(first));
    const conflict = await signedFixture({
      tradeId: first.rfq.tradeId,
      requester: Wallet.createRandom(),
      dealer: Wallet.createRandom(),
    });
    const conflictingFirm = await firmFixture(conflict);
    assert.throws(
      () => journal.admitSource(conflictingFirm),
      (error) => error.code === "TRADE_CONFLICT"
    );
    assert.equal(journal.exposureSummary().count, 1);
  } finally {
    journal.close();
    database.cleanup();
  }
});

test("destination lock and claim recovery survive separate restarts", async () => {
  const database = temporaryDatabase();
  const context = await signedFixture();
  const firm = await firmFixture(context);
  let journal = new FxPhase8ExposureJournal({
    filePath: database.filePath,
    deploymentId: DEPLOYMENT_ID,
  });
  journal.admitSource(firm);
  journal.markDestinationLocked(context.rfq.tradeId, {
    lockId: firm.expectedDestinationLockId,
    transactionHash: `0x${"52".repeat(32)}`,
    timeout: firm.destinationRefundTimestamp,
  });
  journal.close();
  journal = new FxPhase8ExposureJournal({
    filePath: database.filePath,
    deploymentId: DEPLOYMENT_ID,
  });
  assert.equal(journal.activeTrades()[0].state, "destination_locked");
  journal.markDestinationClaimed(context.rfq.tradeId);
  journal.close();
  journal = new FxPhase8ExposureJournal({
    filePath: database.filePath,
    deploymentId: DEPLOYMENT_ID,
  });
  try {
    assert.equal(journal.activeTrades()[0].state, "destination_claimed");
    assert.equal(journal.exposureSummary().count, 1);
  } finally {
    journal.close();
    database.cleanup();
  }
});

test("dealer guard produces and verifies the ten-minute destination plan", async () => {
  const database = temporaryDatabase();
  const context = await signedFixture();
  const journal = new FxPhase8ExposureJournal({
    filePath: database.filePath,
    deploymentId: DEPLOYMENT_ID,
  });
  const lock = await destinationLock(context);
  const guard = new FxPhase8DealerGuard({
    journal,
    dealerAddress: context.dealer.address,
    now: () => NOW + 25,
    verifySourceLock: async () => context.sourceChain,
    verifyDestinationLock: async () => ({
      confirmed: true,
      canonical: true,
      lockId: phase5LockId(context.rfq.tradeId, "destination"),
      transactionHash: lock.payload.transactionHash,
      chainId: DESTINATION_CHAIN,
      token: DESTINATION_TOKEN,
      amountAtomic: "100000",
      beneficiary: context.requester.address,
      refundAddress: context.dealer.address,
      secretHash: context.accept.payload.secretHash,
      timeout: NOW + 625,
    }),
    readDestinationLock: async () => ({ exists: false }),
  });
  try {
    const firm = await guard.firmSource({
      rfq: context.rfq,
      quote: context.quote,
      accept: context.accept,
      reserve: context.reserve,
      sourceLock: context.sourceLock,
      referenceInputAtomic: "100000",
      exposureValueMicros: "100000",
      requesterGasInputAtomic: "1000",
    });
    assert.equal(firm.destinationPlan.refundTimestamp, NOW + 625);
    assert.equal(firm.destinationPlan.atomicWithOtherTrades, false);
    const confirmed = await guard.confirmDestinationLock(lock);
    assert.equal(confirmed.trade.state, "destination_locked");
  } finally {
    journal.close();
    database.cleanup();
  }
});

test("dealer guard cannot consume a quote signed for another dealer", async () => {
  const database = temporaryDatabase();
  const context = await signedFixture();
  const journal = new FxPhase8ExposureJournal({
    filePath: database.filePath,
    deploymentId: DEPLOYMENT_ID,
  });
  const guard = new FxPhase8DealerGuard({
    journal,
    dealerAddress: Wallet.createRandom().address,
    now: () => NOW + 25,
    verifySourceLock: async () => context.sourceChain,
    verifyDestinationLock: async () => ({ confirmed: true, canonical: true }),
    readDestinationLock: async () => ({ exists: false }),
  });
  try {
    await assert.rejects(
      () => guard.firmSource({
        rfq: context.rfq,
        quote: context.quote,
        accept: context.accept,
        reserve: context.reserve,
        sourceLock: context.sourceLock,
        referenceInputAtomic: "100000",
        exposureValueMicros: "100000",
        requesterGasInputAtomic: "1000",
      }),
      (error) => error.code === "WRONG_DEALER"
    );
    assert.equal(journal.exposureSummary().count, 0);
  } finally {
    journal.close();
    database.cleanup();
  }
});

test("destination chain stalls fail closed without losing source exposure", async () => {
  const database = temporaryDatabase();
  const context = await signedFixture();
  const lock = await destinationLock(context);
  const journal = new FxPhase8ExposureJournal({
    filePath: database.filePath,
    deploymentId: DEPLOYMENT_ID,
    policy: { chainVerificationTimeoutMs: 5 },
  });
  const guard = new FxPhase8DealerGuard({
    journal,
    dealerAddress: context.dealer.address,
    policy: { chainVerificationTimeoutMs: 5 },
    now: () => NOW + 25,
    verifySourceLock: async () => context.sourceChain,
    verifyDestinationLock: () => new Promise(() => {}),
    readDestinationLock: async () => ({ exists: false }),
  });
  try {
    await guard.firmSource({
      rfq: context.rfq,
      quote: context.quote,
      accept: context.accept,
      reserve: context.reserve,
      sourceLock: context.sourceLock,
      referenceInputAtomic: "100000",
      exposureValueMicros: "100000",
      requesterGasInputAtomic: "1000",
    });
    await assert.rejects(
      () => guard.confirmDestinationLock(lock),
      (error) => error.code === "CHAIN_VERIFIER_UNAVAILABLE"
    );
    assert.equal(journal.trade(context.rfq.tradeId).state, "source_firm");
    assert.equal(journal.exposureSummary().count, 1);
  } finally {
    journal.close();
    database.cleanup();
  }
});

test("dealer no-show evidence is signed but guilt is independently verified", async () => {
  const context = await signedFixture();
  const observer = Wallet.createRandom();
  const observation = {
    chainId: DESTINATION_CHAIN,
    expectedLockId: phase5LockId(context.rfq.tradeId, "destination"),
    deadline: context.reserve.payload.reservationDeadline,
    blockNumber: "250",
    blockHash: `0x${"61".repeat(32)}`,
    blockTimestamp: context.reserve.payload.reservationDeadline,
  };
  const evidence = await createDealerNoShowEvidence({
    signer: observer,
    ...context,
    destinationObservation: observation,
    observedAt: observation.blockTimestamp + 1,
  });
  await assert.rejects(
    () => createDealerNoShowEvidence({
      signer: Wallet.createRandom(),
      ...context,
      destinationObservation: {
        ...observation,
        blockTimestamp: observation.deadline - 1,
      },
      observedAt: observation.deadline,
    }),
    /boundary/
  );
  const verified = await verifyDealerNoShowEvidence(evidence, {
    verifySourceLock: async () => context.sourceChain,
    readDestinationLock: async () => ({
      canonical: true,
      exists: false,
      blockNumber: observation.blockNumber,
      blockHash: observation.blockHash,
      blockTimestamp: observation.blockTimestamp,
    }),
  });
  assert.equal(verified.dealer, context.dealer.address.toLowerCase());
  await assert.rejects(
    () => verifyDealerNoShowEvidence(evidence, {
      verifySourceLock: async () => context.sourceChain,
      readDestinationLock: async () => ({
        canonical: true,
        exists: true,
        blockNumber: observation.blockNumber,
        blockHash: observation.blockHash,
        blockTimestamp: observation.blockTimestamp,
      }),
    }),
    (error) => error.code === "INVALID_NO_SHOW"
  );
});

test("signed abandonment evidence uses a dedicated store-backed Waku lane", async (t) => {
  const context = await signedFixture();
  const observation = {
    chainId: DESTINATION_CHAIN,
    expectedLockId: phase5LockId(context.rfq.tradeId, "destination"),
    deadline: context.reserve.payload.reservationDeadline,
    blockNumber: "250",
    blockHash: `0x${"63".repeat(32)}`,
    blockTimestamp: context.reserve.payload.reservationDeadline,
  };
  const evidence = await createDealerNoShowEvidence({
    signer: Wallet.createRandom(),
    ...context,
    destinationObservation: observation,
    observedAt: observation.blockTimestamp + 1,
  });
  assert.equal(
    verifyPhase8EvidenceAttestation(evidence).tradeId,
    context.rfq.tradeId
  );
  assert.throws(
    () => verifyPhase8EvidenceAttestation({
      ...evidence,
      observedAt: evidence.observedAt + 1,
    }),
    (error) => error.code === "BAD_SIGNATURE"
  );
  const bus = new Phase8WakuBus();
  const publisher = phase8Transport(bus);
  const receiver = phase8Transport(bus);
  const lateReceiver = phase8Transport(bus);
  t.after(async () => {
    await Promise.allSettled([
      publisher.close(),
      receiver.close(),
      lateReceiver.close(),
    ]);
  });
  await Promise.all([publisher.start(), receiver.start()]);
  const received = once(receiver, "evidence");
  const published = await publisher.publishEvidence(evidence);
  const [wireEvidence, metadata] = await received;
  assert.equal(wireEvidence.evidenceId, evidence.evidenceId);
  assert.equal(metadata.history, false);
  assert.match(published.topic, /\/evidence-/);
  assert.ok(bus.history.some((entry) => entry.topic === published.topic));
  const recovered = once(lateReceiver, "evidence");
  await lateReceiver.start();
  const [storedEvidence, storedMetadata] = await recovered;
  assert.equal(storedEvidence.evidenceId, evidence.evidenceId);
  assert.equal(storedMetadata.history, true);
});

test("requester abandonment requires a real unclaimed destination lock", async () => {
  const context = await signedFixture();
  const lock = await destinationLock(context);
  const observer = Wallet.createRandom();
  const observation = {
    chainId: DESTINATION_CHAIN,
    expectedLockId: phase5LockId(context.rfq.tradeId, "destination"),
    deadline: lock.payload.timeout,
    blockNumber: "300",
    blockHash: `0x${"62".repeat(32)}`,
    blockTimestamp: lock.payload.timeout,
  };
  const evidence = await createRequesterAbandonmentEvidence({
    signer: observer,
    ...context,
    destinationLock: lock,
    destinationObservation: observation,
    observedAt: observation.blockTimestamp + 1,
  });
  const readDestinationLock = async () => ({
    canonical: true,
    exists: true,
    claimed: false,
    blockNumber: observation.blockNumber,
    blockHash: observation.blockHash,
    blockTimestamp: observation.blockTimestamp,
    transactionHash: lock.payload.transactionHash,
    timeout: lock.payload.timeout,
  });
  const verified = await verifyRequesterAbandonmentEvidence(evidence, {
    verifySourceLock: async () => context.sourceChain,
    readDestinationLock,
  });
  assert.equal(verified.requester, context.requester.address.toLowerCase());
  await assert.rejects(
    () => verifyRequesterAbandonmentEvidence(evidence, {
      verifySourceLock: async () => context.sourceChain,
      readDestinationLock: async () => ({
        ...(await readDestinationLock()),
        claimed: true,
      }),
    }),
    (error) => error.code === "INVALID_ABANDONMENT"
  );
});

test("verified outcomes release exposure and update only local reputation", async () => {
  const database = temporaryDatabase();
  const context = await signedFixture();
  const journal = new FxPhase8ExposureJournal({
    filePath: database.filePath,
    deploymentId: DEPLOYMENT_ID,
  });
  try {
    journal.admitSource(await firmFixture(context));
    const evidenceId = `0x${"77".repeat(32)}`;
    journal.recordVerifiedOutcome({
      evidenceId,
      tradeId: context.rfq.tradeId,
      subject: context.dealer.address,
      outcome: "dealer_no_show",
      evidence: { verified: true },
    });
    journal.markTerminal(context.rfq.tradeId, "dealer_no_show", evidenceId);
    assert.equal(journal.exposureSummary().count, 0);
    assert.deepEqual(
      journal.reputation(context.dealer.address),
      {
        subject: context.dealer.address.toLowerCase(),
        completed: 0,
        dealerNoShows: 1,
        requesterAbandonments: 0,
        completedWeight: 0,
        dealerNoShowWeight: 1,
        requesterAbandonmentWeight: 0,
        decayHalfLifeSeconds: 2_592_000,
        authority: "local_verified_evidence_only",
      }
    );
  } finally {
    journal.close();
    database.cleanup();
  }
});

test("verified local reputation decays without relay adjudication", async () => {
  const database = temporaryDatabase();
  const clock = { value: NOW };
  const context = await signedFixture();
  const journal = new FxPhase8ExposureJournal({
    filePath: database.filePath,
    deploymentId: DEPLOYMENT_ID,
    policy: { reputationHalfLifeSeconds: 100 },
    now: () => clock.value,
  });
  try {
    journal.admitSource(await firmFixture(context));
    journal.recordVerifiedOutcome({
      evidenceId: `0x${"78".repeat(32)}`,
      tradeId: context.rfq.tradeId,
      subject: context.dealer.address,
      outcome: "dealer_no_show",
      evidence: { verified: true },
    });
    assert.equal(
      journal.reputation(context.dealer.address).dealerNoShowWeight,
      1
    );
    clock.value += 100;
    const reputation = journal.reputation(context.dealer.address);
    assert.equal(reputation.dealerNoShowWeight, 0.5);
    assert.equal(reputation.dealerNoShows, 1);
    assert.equal(reputation.authority, "local_verified_evidence_only");
  } finally {
    journal.close();
    database.cleanup();
  }
});

test("slices are independent swaps and never share a trade or secret", () => {
  const plan = createIndependentSlicePlan({
    parentRequestId: `0x${"91".repeat(32)}`,
    slices: [{
      tradeId: `0x${"92".repeat(32)}`,
      secretHash: `0x${"93".repeat(32)}`,
      dealer: Wallet.createRandom().address,
      inputAmountAtomic: "50000",
      outputAmountAtomic: "49000",
    }, {
      tradeId: `0x${"94".repeat(32)}`,
      secretHash: `0x${"95".repeat(32)}`,
      dealer: Wallet.createRandom().address,
      inputAmountAtomic: "50000",
      outputAmountAtomic: "49000",
    }],
  });
  assert.equal(plan.atomicAcrossSlices, false);
  assert.equal(plan.failureIsolation, "independent");
  assert.equal(plan.totalInputAtomic, "100000");
  assert.throws(
    () => createIndependentSlicePlan({
      parentRequestId: `0x${"91".repeat(32)}`,
      slices: [plan.slices[0], {
        ...plan.slices[1],
        secretHash: plan.slices[0].secretHash,
      }],
    }),
    (error) => error.code === "COUPLED_SLICES"
  );
});

test("independent slices can complete and refund without coupled rollback", async () => {
  const database = temporaryDatabase();
  const first = await signedFixture({
    tradeId: `0x${"a1".repeat(32)}`,
  });
  const second = await signedFixture({
    tradeId: `0x${"a2".repeat(32)}`,
  });
  const journal = new FxPhase8ExposureJournal({
    filePath: database.filePath,
    deploymentId: DEPLOYMENT_ID,
  });
  try {
    journal.admitSource(await firmFixture(first));
    journal.admitSource(await firmFixture(second));
    journal.markTerminal(first.rfq.tradeId, "completed");
    journal.markTerminal(second.rfq.tradeId, "source_refunded");
    assert.equal(journal.trade(first.rfq.tradeId).state, "completed");
    assert.equal(journal.trade(second.rfq.tradeId).state, "source_refunded");
    assert.equal(journal.exposureSummary().count, 0);
  } finally {
    journal.close();
    database.cleanup();
  }
});
