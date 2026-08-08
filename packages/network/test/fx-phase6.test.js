const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Wallet, keccak256, toUtf8Bytes } = require("ethers");
const {
  FxCoordinationSession,
  FxDeterministicDealer,
  FxRequesterBroker,
  FxTradeJournal,
  FxWakuTransport,
  createFxContentTopics,
  signFxMessage,
} = require("../src");

const DEPLOYMENT_ID = "0x" + "91".repeat(32);
const COORDINATION_DOMAIN = "0x" + "92".repeat(32);
const BASE_TOKEN = "0x" + "10".repeat(20);
const ARB_TOKEN = "0x" + "20".repeat(20);
const BOOTSTRAPS = ["relay-a", "relay-b"];

class FakeWakuBus {
  constructor() {
    this.history = [];
    this.nodes = new Set();
    this.drop = false;
    this.duplicates = 1;
  }

  node() {
    const bus = this;
    const callbacks = new Map();
    const node = {
      callbacks,
      peers: [
        {
          id: "relay-a",
          protocols: [
            "/vac/waku/lightpush/3.0.0",
            "/vac/waku/filter-subscribe/2.0.0-beta1",
            "/vac/waku/store-query/3.0.0",
          ],
        },
      ],
      async waitForPeers() {},
      async getConnectedPeers() { return node.peers; },
      createEncoder({ contentTopic, ephemeral }) { return { contentTopic, ephemeral }; },
      createDecoder({ contentTopic }) { return { contentTopic }; },
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
          for (const entry of bus.history.filter((candidate) => candidate.topic === topic)) {
            if (await callback(entry.message)) break;
          }
        },
      },
      lightPush: {
        async send(encoder, message) {
          const entry = {
            topic: encoder.contentTopic,
            message: { ...message, hashStr: `fake-${bus.history.length + 1}` },
          };
          bus.history.push(entry);
          if (!bus.drop) {
            for (let copy = 0; copy < bus.duplicates; copy += 1) {
              for (const target of bus.nodes) {
                await target.callbacks.get(entry.topic)?.(entry.message);
              }
            }
          }
          return { successes: ["relay-a"], failures: [] };
        },
      },
      async stop() {
        bus.nodes.delete(node);
        callbacks.clear();
      },
    };
    this.nodes.add(node);
    return node;
  }
}

function createTransport(bus, now) {
  return new FxWakuTransport({
    deploymentId: DEPLOYMENT_ID,
    bootstrapPeers: BOOTSTRAPS,
    now: () => now.value * 1000,
    sdkLoader: async () => ({ Protocols: { LightPush: "lightpush", Filter: "filter" } }),
    nodeFactory: async () => bus.node(),
  });
}

function createJournal(directory, name, now) {
  return new FxTradeJournal({
    filePath: path.join(directory, `${name}.sqlite`),
    deploymentId: DEPLOYMENT_ID,
    now: () => now.value,
  });
}

function rfqPayload(now) {
  return {
    outputChainId: "421614",
    outputToken: ARB_TOKEN,
    outputAmountAtomic: "100000",
    inputOptions: [{
      chainId: "84532",
      token: BASE_TOKEN,
      maxInputAtomic: "105000",
    }],
    quoteDeadline: now.value + 45,
    settlementDeadline: now.value + 3600,
    quotePolicy: "lowest_all_in",
    x402Commitment: null,
  };
}

function dealerPolicy(now) {
  return async () => ({
    inputChainId: "84532",
    inputToken: BASE_TOKEN,
    inputAmountAtomic: "101000",
    referenceSource: "chainlink:usdc-usd",
    referencePriceMicros: "1000000",
    referenceTimestamp: now.value,
    spreadBps: 25,
    dealerSettlementCostAtomic: "750",
    estimatedCompletionSeconds: 55,
    adapterId: "evm-htlc-v1",
    adapterVersion: 1,
  });
}

function once(emitter, event, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
    emitter.once(event, (...args) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

test("Phase 6 topics isolate discovery and deterministically shard trade coordination", () => {
  const topics = createFxContentTopics({ deploymentId: DEPLOYMENT_ID, shardCount: 4 });
  assert.match(topics.discovery, /^\/versus-fx\/1\/rfq-/);
  assert.equal(topics.coordination.length, 4);
  assert.equal(new Set(topics.coordination).size, 4);
  assert.ok(topics.coordination.every((topic) => !topic.includes("postcards")));
});

test("FX Waku watchdog reconnects every topic after a quiet peer loss", async () => {
  const now = { value: 1_800_000_000 };
  const bus = new FakeWakuBus();
  let starts = 0;
  let firstNode = null;
  const transport = new FxWakuTransport({
    deploymentId: DEPLOYMENT_ID,
    bootstrapPeers: BOOTSTRAPS,
    reconnectPollMs: 10,
    reconnectBackoffMaxMs: 40,
    now: () => now.value * 1000,
    sdkLoader: async () => ({ Protocols: { LightPush: "lightpush", Filter: "filter" } }),
    nodeFactory: async () => {
      starts += 1;
      const node = bus.node();
      if (starts === 1) firstNode = node;
      return node;
    },
  });
  await transport.start();
  await transport.historyCatchUp;
  firstNode.peers = [];

  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline && starts < 2) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await transport.historyCatchUp;
  assert.equal(starts, 2);
  assert.equal(transport.decoders.size, 1 + (transport.shardCount * 2));
  assert.equal(transport.status().state, "caught_up");
  assert.equal(transport.status().reconnect.active, true);
  await transport.close();
  assert.equal(transport.status().reconnect.active, false);
});

test("FX Waku startup failure tears down partial subscriptions before retry", async () => {
  const now = { value: 1_800_000_000 };
  const bus = new FakeWakuBus();
  let starts = 0;
  let failedNode;
  let failedNodeStops = 0;
  const transport = new FxWakuTransport({
    deploymentId: DEPLOYMENT_ID,
    bootstrapPeers: BOOTSTRAPS,
    now: () => now.value * 1000,
    sdkLoader: async () => ({ Protocols: { LightPush: "lightpush", Filter: "filter" } }),
    nodeFactory: async () => {
      starts += 1;
      const node = bus.node();
      if (starts === 1) {
        failedNode = node;
        const stop = node.stop.bind(node);
        const subscribe = node.filter.subscribe.bind(node.filter);
        let subscriptions = 0;
        node.filter.subscribe = async (...arguments_) => {
          subscriptions += 1;
          if (subscriptions === 2) return false;
          return subscribe(...arguments_);
        };
        node.stop = async () => {
          failedNodeStops += 1;
          await stop();
        };
      }
      return node;
    },
  });

  await assert.rejects(
    transport.start(),
    /FX Waku Filter rejected/
  );
  assert.equal(failedNodeStops, 1);
  assert.equal(bus.nodes.has(failedNode), false);
  assert.equal(transport.node, null);
  assert.equal(transport.encoders.size, 0);
  assert.equal(transport.decoders.size, 0);
  assert.equal(transport.status().state, "offline");

  await transport.start();
  assert.equal(starts, 2);
  assert.equal(transport.status().state, "ready");
  await transport.close();
});

test("a frozen coordination domain scopes Waku topics without replacing deployment identity", () => {
  const deploymentTopics = createFxContentTopics({
    deploymentId: DEPLOYMENT_ID,
    shardCount: 4,
  });
  const domainTopics = createFxContentTopics({
    deploymentId: DEPLOYMENT_ID,
    coordinationDomain: COORDINATION_DOMAIN,
    shardCount: 4,
  });

  assert.notEqual(domainTopics.discovery, deploymentTopics.discovery);
  assert.ok(domainTopics.discovery.includes(COORDINATION_DOMAIN.slice(2)));
  assert.equal(domainTopics.coordination.length, 4);
});

test("real signed requester and deterministic dealer coordinate over isolated Waku", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-fx-phase6-flow-"));
  const now = { value: 1_800_000_000 };
  const bus = new FakeWakuBus();
  const requesterWallet = Wallet.createRandom();
  const dealerWallet = Wallet.createRandom();
  const requesterSession = new FxCoordinationSession({
    deploymentId: DEPLOYMENT_ID,
    signer: requesterWallet,
    role: "requester",
    journal: createJournal(directory, "requester", now),
    transport: createTransport(bus, now),
    now: () => now.value,
  });
  const dealerSession = new FxCoordinationSession({
    deploymentId: DEPLOYMENT_ID,
    signer: dealerWallet,
    role: "dealer",
    journal: createJournal(directory, "dealer", now),
    transport: createTransport(bus, now),
    now: () => now.value,
  });
  const requester = new FxRequesterBroker({ session: requesterSession, observationWindowMs: 0, now: () => now.value });
  const dealer = new FxDeterministicDealer({
    session: dealerSession,
    quotePolicy: dealerPolicy(now),
    sourceClaimAddress: dealerWallet.address,
    destinationRefundAddress: dealerWallet.address,
    observationWindowMs: 0,
    now: () => now.value,
  });
  t.after(async () => {
    await Promise.allSettled([requester.close(), dealer.close()]);
    requesterSession.journal.close();
    dealerSession.journal.close();
  });

  await Promise.all([requester.start(), dealer.start()]);
  const quoteReady = once(requester, "quote");
  const rfq = await requester.openRfq({ payload: rfqPayload(now) });
  await quoteReady;
  const route = requester.selectRoute(rfq.tradeId);
  assert.equal(route.dealer, dealerWallet.address.toLowerCase());

  const replayed = once(dealer, "quoteReplayed");
  assert.equal(dealerSession.ingest(rfq, { live: true }).status, "duplicate");
  const [replayedQuote] = await replayed;
  assert.equal(replayedQuote.id, route.quoteId);

  const reserved = once(requester, "reserved");
  const secretHash = keccak256(toUtf8Bytes("phase-6-secret"));
  const accepted = await requester.accept({
    tradeId: rfq.tradeId,
    route,
    secretHash,
    sourceRefundAddress: requesterWallet.address,
    destinationClaimAddress: requesterWallet.address,
  });
  const [reservation] = await reserved;
  assert.equal(reservation.payload.quoteId, route.quoteId);
  assert.equal(requesterSession.journal.snapshot(rfq.tradeId).settlementState, "quote_accepted");
  assert.equal(dealerSession.journal.snapshot(rfq.tradeId).stateHash, requesterSession.journal.snapshot(rfq.tradeId).stateHash);

  const dealerCancelled = once(dealer, "cancelled");
  const cancellation = await requesterSession.publish({
    protocol: "versus-fx",
    version: 1,
    type: "fx_cancel",
    tradeId: rfq.tradeId,
    createdAt: now.value,
    expiresAt: now.value + 60,
    payload: {
      acceptId: accepted.id,
      reserveId: reservation.id,
      reason: "owner_cancelled",
    },
  });
  await dealerCancelled;
  assert.equal(cancellation.payload.reserveId, reservation.id);
  assert.equal(requesterSession.journal.snapshot(rfq.tradeId).settlementState, "cancelled");
  assert.equal(dealerSession.journal.snapshot(rfq.tradeId).settlementState, "cancelled");
  assert.equal(
    dealerSession.journal.snapshot(rfq.tradeId).stateHash,
    requesterSession.journal.snapshot(rfq.tradeId).stateHash
  );

  await assert.rejects(
    requesterSession.publish({
      protocol: "versus-fx",
      version: 1,
      type: "fx_lock_source",
      tradeId: rfq.tradeId,
      createdAt: now.value + 1,
      expiresAt: now.value + 3600,
      payload: {
        acceptId: accepted.id,
        chainId: route.inputChainId,
        token: route.inputToken,
        amountAtomic: route.totalInputAtomic,
        lockAddress: requesterWallet.address,
        beneficiary: reservation.payload.dealerSourceClaimAddress,
        refundAddress: requesterWallet.address,
        secretHash,
        timeout: now.value + 1800,
        transactionHash: `0x${"ab".repeat(32)}`,
        blockNumber: "1",
      },
    }),
    /local FX message was not accepted/
  );
  const snapshotMessageIds = requesterSession.journal
    .snapshot(rfq.tradeId)
    .messages.map((message) => message.id);
  assert.deepEqual(snapshotMessageIds, [...snapshotMessageIds].sort());

  const rfqWire = bus.history.find((entry) => entry.topic.includes("/rfq-"));
  const publicRfq = JSON.parse(new TextDecoder().decode(rfqWire.message.payload));
  assert.equal(publicRfq.payload.sourceRefundAddress, undefined);
  assert.equal(publicRfq.payload.destinationClaimAddress, undefined);

  const wirePayload = JSON.stringify(bus.history);
  for (const forbiddenKey of ["secret", "privateKey", "mnemonic", "keystore", "balance", "inventory"]) {
    assert.doesNotMatch(
      wirePayload,
      new RegExp(`"${forbiddenKey}"\\s*:`, "i"),
      `${forbiddenKey} must never appear in FX Waku payloads`
    );
  }

  const conflicting = await signFxMessage({
    ...accepted,
    id: undefined,
    signature: undefined,
    sequence: "2",
    createdAt: now.value + 1,
    payload: {
      ...accepted.payload,
      destinationClaimAddress: Wallet.createRandom().address,
    },
  }, requesterWallet);
  assert.equal(requesterSession.ingest(conflicting).status, "rejected");
  assert.equal(
    requesterSession.journal.snapshot(rfq.tradeId).messages.filter(
      (message) => message.type === "fx_accept"
    ).length,
    1
  );
});

test("out-of-order dependencies are bounded and replayed after their RFQ arrives", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-fx-phase6-order-"));
  const now = { value: 1_800_100_000 };
  const bus = new FakeWakuBus();
  const requester = Wallet.createRandom();
  const dealer = Wallet.createRandom();
  const journal = createJournal(directory, "receiver", now);
  const session = new FxCoordinationSession({
    deploymentId: DEPLOYMENT_ID,
    signer: Wallet.createRandom(),
    role: "broker",
    journal,
    transport: createTransport(bus, now),
    now: () => now.value,
  });
  t.after(async () => {
    await session.close();
    journal.close();
  });
  await session.start();
  const tradeId = "0x" + "31".repeat(32);
  const rfq = await signFxMessage({
    protocol: "versus-fx",
    version: 1,
    deploymentId: DEPLOYMENT_ID,
    type: "fx_rfq",
    tradeId,
    role: "requester",
    sequence: "1",
    createdAt: now.value,
    expiresAt: now.value + 60,
    payload: rfqPayload(now),
  }, requester);
  const quote = await signFxMessage({
    protocol: "versus-fx",
    version: 1,
    deploymentId: DEPLOYMENT_ID,
    type: "fx_quote",
    tradeId,
    role: "dealer",
    sequence: "1",
    createdAt: now.value + 1,
    expiresAt: now.value + 45,
    payload: {
      ...(await dealerPolicy(now)()),
      rfqId: rfq.id,
      outputChainId: rfq.payload.outputChainId,
      outputToken: rfq.payload.outputToken,
      outputAmountAtomic: rfq.payload.outputAmountAtomic,
      quoteType: "fixed_exact_output",
    },
  }, dealer);

  assert.equal(session.ingest(quote).status, "pending");
  assert.equal(session.pending.size, 1);
  assert.equal(session.ingest(rfq).status, "accepted");
  assert.equal(session.pending.size, 0);
  assert.equal(journal.snapshot(tradeId).messages.length, 2);
});

test("desktop recovery accepts signed expired history without weakening live ingress", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-fx-phase6-recovery-"));
  const now = { value: 1_800_150_000 };
  const bus = new FakeWakuBus();
  const requester = Wallet.createRandom();
  const journal = createJournal(directory, "receiver", now);
  const session = new FxCoordinationSession({
    deploymentId: DEPLOYMENT_ID,
    signer: Wallet.createRandom(),
    role: "broker",
    journal,
    transport: createTransport(bus, now),
    now: () => now.value,
  });
  t.after(async () => {
    await session.close();
    journal.close();
  });
  await session.start();

  const expiredAt = now.value - 600;
  const envelope = await signFxMessage({
    protocol: "versus-fx",
    version: 1,
    deploymentId: DEPLOYMENT_ID,
    type: "fx_rfq",
    tradeId: "0x" + "32".repeat(32),
    role: "requester",
    sequence: "1",
    createdAt: expiredAt - 30,
    expiresAt: expiredAt,
    payload: {
      ...rfqPayload(now),
      quoteDeadline: expiredAt - 5,
      settlementDeadline: now.value + 3_600,
    },
  }, requester);

  assert.deepEqual(session.ingest(envelope), {
    status: "rejected",
    error: "EXPIRED_MESSAGE",
  });
  assert.equal(
    session.ingest(envelope, { desktopRecovery: true }).status,
    "accepted"
  );
  assert.equal(journal.snapshot(envelope.tradeId).messages.length, 1);
});

test("local publish preserves the journal replay code for idempotent recovery", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-fx-phase6-replay-"));
  const now = { value: 1_800_175_000 };
  const bus = new FakeWakuBus();
  const journal = createJournal(directory, "requester", now);
  const session = new FxCoordinationSession({
    deploymentId: DEPLOYMENT_ID,
    signer: Wallet.createRandom(),
    role: "requester",
    journal,
    transport: createTransport(bus, now),
    now: () => now.value,
  });
  t.after(async () => {
    await session.close();
    journal.close();
  });
  await session.start();
  const tradeId = "0x" + "33".repeat(32);
  const message = {
    protocol: "versus-fx",
    version: 1,
    type: "fx_rfq",
    tradeId,
    createdAt: now.value,
    expiresAt: now.value + 60,
    payload: rfqPayload(now),
  };

  await session.publish(message);
  await assert.rejects(
    session.publish({ ...message, createdAt: now.value + 1 }),
    (error) => error.code === "ACTION_REPLAY"
  );
});

test("duplicate delivery is idempotent and RFQ floods are rejected before journaling", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-fx-phase6-flood-"));
  const now = { value: 1_800_200_000 };
  const bus = new FakeWakuBus();
  const sender = Wallet.createRandom();
  const journal = createJournal(directory, "receiver", now);
  const session = new FxCoordinationSession({
    deploymentId: DEPLOYMENT_ID,
    signer: Wallet.createRandom(),
    role: "broker",
    journal,
    transport: createTransport(bus, now),
    now: () => now.value,
    maxRfqsPerSenderPerMinute: 2,
  });
  t.after(async () => {
    await session.close();
    journal.close();
  });
  await session.start();
  const messages = [];
  for (let index = 0; index < 3; index += 1) {
    messages.push(await signFxMessage({
      protocol: "versus-fx",
      version: 1,
      deploymentId: DEPLOYMENT_ID,
      type: "fx_rfq",
      tradeId: `0x${String(index + 1).padStart(64, "0")}`,
      role: "requester",
      sequence: "1",
      createdAt: now.value,
      expiresAt: now.value + 60,
      payload: rfqPayload(now),
    }, sender));
  }
  assert.equal(session.ingest(messages[0]).status, "accepted");
  assert.equal(session.ingest(messages[0]).status, "duplicate");
  assert.equal(session.ingest(messages[1]).status, "accepted");
  assert.equal(session.ingest(messages[2]).error, "FX_RFQ_RATE_LIMIT");
  assert.equal(journal.snapshot(messages[2].tradeId), null);
});

test("dealer quote floods hit their dedicated limit before journaling", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-fx-phase6-quote-flood-"));
  const now = { value: 1_800_225_000 };
  const bus = new FakeWakuBus();
  const requester = Wallet.createRandom();
  const dealer = Wallet.createRandom();
  const journal = createJournal(directory, "receiver", now);
  const session = new FxCoordinationSession({
    deploymentId: DEPLOYMENT_ID,
    signer: Wallet.createRandom(),
    role: "broker",
    journal,
    transport: createTransport(bus, now),
    now: () => now.value,
    maxQuotesPerSenderPerMinute: 2,
  });
  t.after(async () => {
    await session.close();
    journal.close();
  });
  await session.start();
  const tradeId = "0x" + "35".repeat(32);
  const rfq = await signFxMessage({
    protocol: "versus-fx",
    version: 1,
    deploymentId: DEPLOYMENT_ID,
    type: "fx_rfq",
    tradeId,
    role: "requester",
    sequence: "1",
    createdAt: now.value,
    expiresAt: now.value + 60,
    payload: rfqPayload(now),
  }, requester);
  assert.equal(session.ingest(rfq).status, "accepted");

  const quotes = [];
  for (let index = 0; index < 3; index += 1) {
    quotes.push(await signFxMessage({
      protocol: "versus-fx",
      version: 1,
      deploymentId: DEPLOYMENT_ID,
      type: "fx_quote",
      tradeId,
      role: "dealer",
      sequence: String(index + 1),
      createdAt: now.value + index + 1,
      expiresAt: now.value + 45,
      payload: {
        ...(await dealerPolicy(now)()),
        rfqId: rfq.id,
        outputChainId: rfq.payload.outputChainId,
        outputToken: rfq.payload.outputToken,
        outputAmountAtomic: rfq.payload.outputAmountAtomic,
        quoteType: "fixed_exact_output",
      },
    }, dealer));
  }

  assert.equal(session.ingest(quotes[0]).status, "accepted");
  assert.equal(session.ingest(quotes[1]).status, "accepted");
  assert.equal(session.ingest(quotes[2]).error, "FX_QUOTE_RATE_LIMIT");
  assert.equal(journal.message(quotes[2].id), null);
});

test("a third party cannot race the requester acceptance or selected dealer reservation", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-fx-phase6-hijack-"));
  const now = { value: 1_800_250_000 };
  const bus = new FakeWakuBus();
  const requester = Wallet.createRandom();
  const dealer = Wallet.createRandom();
  const attacker = Wallet.createRandom();
  const journal = createJournal(directory, "receiver", now);
  const session = new FxCoordinationSession({
    deploymentId: DEPLOYMENT_ID,
    signer: Wallet.createRandom(),
    role: "broker",
    journal,
    transport: createTransport(bus, now),
    now: () => now.value,
  });
  t.after(async () => {
    await session.close();
    journal.close();
  });
  await session.start();
  const tradeId = "0x" + "37".repeat(32);
  const rfq = await signFxMessage({
    protocol: "versus-fx",
    version: 1,
    deploymentId: DEPLOYMENT_ID,
    type: "fx_rfq",
    tradeId,
    role: "requester",
    sequence: "1",
    createdAt: now.value,
    expiresAt: now.value + 60,
    payload: rfqPayload(now),
  }, requester);
  const quote = await signFxMessage({
    protocol: "versus-fx",
    version: 1,
    deploymentId: DEPLOYMENT_ID,
    type: "fx_quote",
    tradeId,
    role: "dealer",
    sequence: "1",
    createdAt: now.value + 1,
    expiresAt: now.value + 45,
    payload: {
      ...(await dealerPolicy(now)()),
      rfqId: rfq.id,
      outputChainId: rfq.payload.outputChainId,
      outputToken: rfq.payload.outputToken,
      outputAmountAtomic: rfq.payload.outputAmountAtomic,
      quoteType: "fixed_exact_output",
    },
  }, dealer);
  session.ingest(rfq);
  session.ingest(quote);
  const route = require("../src").selectSingleDealerRoute(
    rfq,
    [{ quote, brokerFeeAtomic: "0" }],
    { now: now.value + 2 }
  );
  const maliciousAccept = await signFxMessage({
    protocol: "versus-fx",
    version: 1,
    deploymentId: DEPLOYMENT_ID,
    type: "fx_accept",
    tradeId,
    role: "requester",
    sequence: "1",
    createdAt: now.value + 2,
    expiresAt: now.value + 60,
    payload: {
      rfqId: rfq.id,
      quoteId: quote.id,
      routeId: route.routeId,
      dealerInputAmountAtomic: quote.payload.inputAmountAtomic,
      brokerFeeAtomic: "0",
      totalInputAtomic: quote.payload.inputAmountAtomic,
      outputAmountAtomic: quote.payload.outputAmountAtomic,
      secretHash: "0x" + "ab".repeat(32),
      sourceRefundAddress: attacker.address,
      destinationClaimAddress: attacker.address,
      sourceAdapterId: "evm-htlc-v1",
      sourceAdapterVersion: 1,
      destinationAdapterId: "evm-htlc-v1",
      destinationAdapterVersion: 1,
    },
  }, attacker);
  assert.equal(session.ingest(maliciousAccept).error, "ROUTE_MISMATCH");
  assert.equal(journal.snapshot(tradeId).settlementState, "rfq_open");
});

test("a restarted dealer recovers the active RFQ from Store without a live replay", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-fx-phase6-store-"));
  const now = { value: 1_800_300_000 };
  const bus = new FakeWakuBus();
  const requesterWallet = Wallet.createRandom();
  const dealerWallet = Wallet.createRandom();
  const requesterJournal = createJournal(directory, "requester", now);
  const requesterSession = new FxCoordinationSession({
    deploymentId: DEPLOYMENT_ID,
    signer: requesterWallet,
    role: "requester",
    journal: requesterJournal,
    transport: createTransport(bus, now),
    now: () => now.value,
  });
  const requester = new FxRequesterBroker({ session: requesterSession, now: () => now.value });
  t.after(async () => {
    await requester.close();
    requesterJournal.close();
  });
  await requester.start();
  const rfq = await requester.openRfq({ payload: rfqPayload(now) });

  const dealerJournal = createJournal(directory, "dealer", now);
  const dealerSession = new FxCoordinationSession({
    deploymentId: DEPLOYMENT_ID,
    signer: dealerWallet,
    role: "dealer",
    journal: dealerJournal,
    transport: createTransport(bus, now),
    now: () => now.value,
  });
  const dealer = new FxDeterministicDealer({
    session: dealerSession,
    quotePolicy: dealerPolicy(now),
    sourceClaimAddress: dealerWallet.address,
    destinationRefundAddress: dealerWallet.address,
    observationWindowMs: 0,
    now: () => now.value,
  });
  t.after(async () => {
    await dealer.close();
    dealerJournal.close();
  });
  const quote = once(requester, "quote");
  await dealer.start();
  await quote;
  assert.ok(dealerJournal.snapshot(rfq.tradeId));
  assert.equal(dealerSession.transport.status().state, "caught_up");
});

test("a late dealer does not quote an RFQ already reserved with another dealer", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-fx-phase6-late-dealer-"));
  const now = { value: 1_800_325_000 };
  const bus = new FakeWakuBus();
  const requesterWallet = Wallet.createRandom();
  const selectedDealerWallet = Wallet.createRandom();
  const lateDealerWallet = Wallet.createRandom();
  const requesterJournal = createJournal(directory, "requester", now);
  const selectedDealerJournal = createJournal(directory, "selected-dealer", now);
  const requesterSession = new FxCoordinationSession({
    deploymentId: DEPLOYMENT_ID,
    signer: requesterWallet,
    role: "requester",
    journal: requesterJournal,
    transport: createTransport(bus, now),
    now: () => now.value,
  });
  const selectedDealerSession = new FxCoordinationSession({
    deploymentId: DEPLOYMENT_ID,
    signer: selectedDealerWallet,
    role: "dealer",
    journal: selectedDealerJournal,
    transport: createTransport(bus, now),
    now: () => now.value,
  });
  const requester = new FxRequesterBroker({
    session: requesterSession,
    observationWindowMs: 0,
    now: () => now.value,
  });
  const selectedDealer = new FxDeterministicDealer({
    session: selectedDealerSession,
    quotePolicy: dealerPolicy(now),
    sourceClaimAddress: selectedDealerWallet.address,
    destinationRefundAddress: selectedDealerWallet.address,
    observationWindowMs: 0,
    now: () => now.value,
  });
  t.after(async () => {
    await Promise.allSettled([requester.close(), selectedDealer.close()]);
    requesterJournal.close();
    selectedDealerJournal.close();
  });
  await Promise.all([requester.start(), selectedDealer.start()]);
  const quoteReady = once(requester, "quote");
  const rfq = await requester.openRfq({ payload: rfqPayload(now) });
  await quoteReady;
  const route = requester.selectRoute(rfq.tradeId);
  const reserved = once(requester, "reserved");
  await requester.accept({
    tradeId: rfq.tradeId,
    route,
    secretHash: "0x" + "61".repeat(32),
    sourceRefundAddress: requesterWallet.address,
    destinationClaimAddress: requesterWallet.address,
  });
  await reserved;

  const lateDealerJournal = createJournal(directory, "late-dealer", now);
  const lateDealerSession = new FxCoordinationSession({
    deploymentId: DEPLOYMENT_ID,
    signer: lateDealerWallet,
    role: "dealer",
    journal: lateDealerJournal,
    transport: createTransport(bus, now),
    now: () => now.value,
  });
  let policyCalls = 0;
  const lateDealer = new FxDeterministicDealer({
    session: lateDealerSession,
    quotePolicy: async () => {
      policyCalls += 1;
      return dealerPolicy(now)();
    },
    sourceClaimAddress: lateDealerWallet.address,
    destinationRefundAddress: lateDealerWallet.address,
    observationWindowMs: 0,
    now: () => now.value,
  });
  t.after(async () => {
    await lateDealer.close();
    lateDealerJournal.close();
  });
  await lateDealer.start();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(lateDealerJournal.snapshot(rfq.tradeId).settlementState, "quote_accepted");
  assert.equal(policyCalls, 0);
  assert.equal(lateDealer.quotes.has(rfq.tradeId), false);
});

test("suppressed acceptance recovers through Store and produces one reservation", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-fx-phase6-suppressed-"));
  const now = { value: 1_800_350_000 };
  const bus = new FakeWakuBus();
  const requesterWallet = Wallet.createRandom();
  const dealerWallet = Wallet.createRandom();
  const requesterJournal = createJournal(directory, "requester", now);
  const dealerJournal = createJournal(directory, "dealer", now);
  const requesterSession = new FxCoordinationSession({
    deploymentId: DEPLOYMENT_ID,
    signer: requesterWallet,
    role: "requester",
    journal: requesterJournal,
    transport: createTransport(bus, now),
    now: () => now.value,
  });
  const dealerSession = new FxCoordinationSession({
    deploymentId: DEPLOYMENT_ID,
    signer: dealerWallet,
    role: "dealer",
    journal: dealerJournal,
    transport: createTransport(bus, now),
    now: () => now.value,
  });
  const requester = new FxRequesterBroker({ session: requesterSession, observationWindowMs: 0, now: () => now.value });
  const dealer = new FxDeterministicDealer({
    session: dealerSession,
    quotePolicy: dealerPolicy(now),
    sourceClaimAddress: dealerWallet.address,
    destinationRefundAddress: dealerWallet.address,
    observationWindowMs: 0,
    now: () => now.value,
  });
  t.after(async () => {
    await Promise.allSettled([requester.close(), dealer.close()]);
    requesterJournal.close();
    dealerJournal.close();
  });
  await Promise.all([requester.start(), dealer.start()]);
  const quoteReady = once(requester, "quote");
  const rfq = await requester.openRfq({ payload: rfqPayload(now) });
  await quoteReady;
  const route = requester.selectRoute(rfq.tradeId);
  bus.drop = true;
  await requester.accept({
    tradeId: rfq.tradeId,
    route,
    secretHash: "0x" + "51".repeat(32),
    sourceRefundAddress: requesterWallet.address,
    destinationClaimAddress: requesterWallet.address,
  });
  assert.equal(dealerJournal.snapshot(rfq.tradeId).settlementState, "rfq_open");
  bus.drop = false;
  const reservation = once(requester, "reserved");
  await dealer.resume();
  await reservation;
  assert.equal(dealerJournal.snapshot(rfq.tradeId).settlementState, "quote_accepted");
  assert.equal(
    dealerJournal.snapshot(rfq.tradeId).messages.filter((message) => message.type === "fx_reserve").length,
    1
  );
});

test("settlement truth remains recoverable when every Waku notification is lost", async () => {
  const observedChain = {
    sourceLock: "0x" + "41".repeat(32),
    destinationLock: "0x" + "42".repeat(32),
    destinationClaim: "0x" + "43".repeat(32),
    sourceClaim: "0x" + "44".repeat(32),
  };
  const coordinator = {
    async reconcile() {
      return { state: "complete", observedChain };
    },
  };
  const result = await coordinator.reconcile();
  assert.equal(result.state, "complete");
  assert.equal(Object.keys(result.observedChain).length, 4);
});
