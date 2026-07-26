const fs = require("node:fs");
const path = require("node:path");
const { Wallet, hexlify, randomBytes } = require("ethers");
const {
  FxCoordinationSession,
  FxDeterministicDealer,
  FxRequesterBroker,
  FxTradeJournal,
  FxWakuTransport,
  loadOrCreateFxEphemeralIdentity,
} = require("../src");

const DEFAULT_BOOTSTRAPS = [
  "/dns4/relay-a.versuscypher.com/tcp/443/wss/p2p/16Uiu2HAmCQArrt8ND7sTzPCg76YmQPab7HKjSrVZeyeTVZdQyPWy",
  "/dns4/relay-b.versuscypher.com/tcp/443/wss/p2p/16Uiu2HAkx96y18XpzAybpmi1zzdMQZFvsRPZfkku8R9T4KJFMr2P",
];

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be an unsigned integer`);
  return value;
}

function appendMetric(filePath, record) {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    pid: process.pid,
    ...record,
  });
  fs.appendFileSync(filePath, `${line}\n`, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`${line}\n`);
}

function waitFor(emitter, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
    emitter.once(event, (...args) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

async function loadCoordinationIdentity(dataDirectory) {
  if (process.env.FX_PHASE6_COORDINATION_KEYSTORE || process.env.FX_PHASE6_KEYSTORE) {
    const password = required("FX_PHASE6_KEYSTORE_PASSWORD");
    const wallet = await Wallet.fromEncryptedJson(
      fs.readFileSync(path.resolve(
        process.env.FX_PHASE6_COORDINATION_KEYSTORE ||
        process.env.FX_PHASE6_KEYSTORE
      ), "utf8"),
      password
    );
    return { wallet, created: false, expiresAt: null, source: "operator_keystore" };
  }
  if (process.env.FX_PHASE6_PRIVATE_KEY) {
    return {
      wallet: new Wallet(process.env.FX_PHASE6_PRIVATE_KEY),
      created: false,
      expiresAt: null,
      source: "operator_private_key",
    };
  }
  const identity = await loadOrCreateFxEphemeralIdentity({
    filePath: path.join(dataDirectory, "phase6-coordination-identity.json"),
    password: required("FX_PHASE6_COORDINATION_PASSWORD"),
    lifetimeSeconds: integer(
      "FX_PHASE6_COORDINATION_LIFETIME_SECONDS",
      24 * 60 * 60
    ),
  });
  return { ...identity, source: "encrypted_ephemeral" };
}

async function main() {
  const role = required("FX_PHASE6_ROLE").toLowerCase();
  if (!["requester", "dealer"].includes(role)) {
    throw new Error("FX_PHASE6_ROLE must be requester or dealer");
  }
  const deploymentId = required("FX_PHASE6_DEPLOYMENT_ID").toLowerCase();
  const dataDirectory = path.resolve(required("FX_PHASE6_DATA_DIR"));
  fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const metricsFile = path.join(dataDirectory, "phase6-events.ndjson");
  const coordinationIdentity = await loadCoordinationIdentity(dataDirectory);
  const wallet = coordinationIdentity.wallet;
  const transport = new FxWakuTransport({
    deploymentId,
    bootstrapPeers: String(process.env.FX_PHASE6_WAKU_PEERS || DEFAULT_BOOTSTRAPS.join(","))
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    storeHistoryMs: integer("FX_PHASE6_STORE_HISTORY_MS", 15 * 60 * 1000),
    storeMessageLimit: integer("FX_PHASE6_STORE_MESSAGE_LIMIT", 512),
  });
  const journal = new FxTradeJournal({
    filePath: path.join(dataDirectory, "phase6-coordination.sqlite"),
    deploymentId,
  });
  const session = new FxCoordinationSession({
    deploymentId,
    signer: wallet,
    role,
    journal,
    transport,
    maxMessagesPerSenderPerMinute: integer("FX_PHASE6_MAX_MESSAGES_PER_MINUTE", 60),
    maxMessagesPerMinuteGlobal: integer("FX_PHASE6_MAX_GLOBAL_MESSAGES_PER_MINUTE", 600),
    maxRfqsPerSenderPerMinute: integer("FX_PHASE6_MAX_RFQS_PER_MINUTE", 6),
    maxQuotesPerSenderPerMinute: integer("FX_PHASE6_MAX_QUOTES_PER_MINUTE", 12),
    maxActiveRfqs: integer("FX_PHASE6_MAX_ACTIVE_RFQS", 32),
  });
  for (const event of ["state", "historySynced", "published"]) {
    transport.on(event, (value) => appendMetric(metricsFile, { event: `transport:${event}`, value }));
  }
  session.on("accepted", (envelope, metadata) => appendMetric(metricsFile, {
    event: "coordination:accepted",
    id: envelope.id,
    type: envelope.type,
    tradeId: envelope.tradeId,
    sender: envelope.sender,
    history: Boolean(metadata.history),
  }));
  session.on("pending", (envelope, metadata) => appendMetric(metricsFile, {
    event: "coordination:pending",
    id: envelope.id,
    type: envelope.type,
    tradeId: envelope.tradeId,
    error: metadata.error?.code || metadata.error?.message,
  }));
  session.on("rejected", (error, metadata, envelope) => appendMetric(metricsFile, {
    event: "coordination:rejected",
    id: envelope?.id || null,
    type: envelope?.type || null,
    tradeId: envelope?.tradeId || null,
    error: error.code || error.message,
    history: Boolean(metadata?.history),
  }));

  const stop = async () => {
    await session.close().catch(() => {});
    journal.close();
  };
  process.once("SIGINT", () => stop().finally(() => process.exit(0)));
  process.once("SIGTERM", () => stop().finally(() => process.exit(0)));

  if (role === "dealer") {
    const sourceClaimAddress = required("FX_PHASE6_SOURCE_CLAIM_ADDRESS");
    const destinationRefundAddress = required("FX_PHASE6_DESTINATION_REFUND_ADDRESS");
    const dealer = new FxDeterministicDealer({
      session,
      observationWindowMs: integer("FX_PHASE6_OBSERVATION_WINDOW_MS", 15_000),
      sourceClaimAddress,
      destinationRefundAddress,
      quotePolicy: async (rfq) => {
        const option = rfq.payload.inputOptions.find((candidate) =>
          candidate.chainId === required("FX_PHASE6_INPUT_CHAIN_ID") &&
          candidate.token === required("FX_PHASE6_INPUT_TOKEN").toLowerCase()
        );
        if (!option) return null;
        const inputAmountAtomic = required("FX_PHASE6_INPUT_AMOUNT_ATOMIC");
        if (BigInt(inputAmountAtomic) > BigInt(option.maxInputAtomic)) return null;
        return {
          inputChainId: option.chainId,
          inputToken: option.token,
          inputAmountAtomic,
          referenceSource: process.env.FX_PHASE6_REFERENCE_SOURCE || "phase6:testnet-manifest",
          referencePriceMicros: process.env.FX_PHASE6_REFERENCE_PRICE_MICROS || "1000000",
          referenceTimestamp: Math.floor(Date.now() / 1000),
          spreadBps: integer("FX_PHASE6_SPREAD_BPS", 25),
          dealerSettlementCostAtomic: process.env.FX_PHASE6_SETTLEMENT_COST_ATOMIC || "0",
          estimatedCompletionSeconds: integer("FX_PHASE6_ESTIMATED_SECONDS", 60),
          adapterId: "evm-htlc-v1",
          adapterVersion: 1,
        };
      },
    });
    dealer.on("quoted", (quote) => appendMetric(metricsFile, {
      event: "dealer:quoted",
      id: quote.id,
      tradeId: quote.tradeId,
    }));
    dealer.on("reserved", (reserve) => appendMetric(metricsFile, {
      event: "dealer:reserved",
      id: reserve.id,
      tradeId: reserve.tradeId,
    }));
    dealer.on("error", (error) => appendMetric(metricsFile, {
      event: "dealer:error",
      error: error.code || error.message,
    }));
    await dealer.start();
    appendMetric(metricsFile, {
      event: "dealer:listening",
      address: wallet.address.toLowerCase(),
      identitySource: coordinationIdentity.source,
      identityExpiresAt: coordinationIdentity.expiresAt,
      status: dealer.status(),
    });
    await new Promise(() => {});
  }

  const requester = new FxRequesterBroker({
    session,
    observationWindowMs: integer("FX_PHASE6_OBSERVATION_WINDOW_MS", 15_000),
  });
  await requester.start();
  const timeoutMs = integer("FX_PHASE6_REQUEST_TIMEOUT_MS", 120_000);
  const quoted = waitFor(requester, "quote", timeoutMs);
  const tradeId = (process.env.FX_PHASE6_TRADE_ID || hexlify(randomBytes(32))).toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  const rfq = await requester.openRfq({
    tradeId,
    payload: {
      outputChainId: required("FX_PHASE6_OUTPUT_CHAIN_ID"),
      outputToken: required("FX_PHASE6_OUTPUT_TOKEN"),
      outputAmountAtomic: required("FX_PHASE6_OUTPUT_AMOUNT_ATOMIC"),
      inputOptions: [{
        chainId: required("FX_PHASE6_INPUT_CHAIN_ID"),
        token: required("FX_PHASE6_INPUT_TOKEN"),
        maxInputAtomic: required("FX_PHASE6_MAX_INPUT_ATOMIC"),
      }],
      quoteDeadline: now + 60,
      settlementDeadline: now + integer("FX_PHASE6_SETTLEMENT_DEADLINE_SECONDS", 3600),
      quotePolicy: process.env.FX_PHASE6_QUOTE_POLICY || "lowest_all_in",
      x402Commitment: null,
    },
  });
  appendMetric(metricsFile, { event: "requester:rfq", id: rfq.id, tradeId });
  await quoted;
  await new Promise((resolve) => setTimeout(
    resolve,
    integer("FX_PHASE6_OBSERVATION_WINDOW_MS", 15_000)
  ));
  const route = requester.selectRoute(tradeId);
  const reserved = waitFor(requester, "reserved", timeoutMs);
  const accept = await requester.accept({
    tradeId,
    route,
    secretHash: required("FX_PHASE6_SECRET_HASH"),
    sourceRefundAddress: required("FX_PHASE6_SOURCE_REFUND_ADDRESS"),
    destinationClaimAddress: required("FX_PHASE6_DESTINATION_CLAIM_ADDRESS"),
  });
  appendMetric(metricsFile, {
    event: "requester:accepted",
    id: accept.id,
    tradeId,
    route,
  });
  const [reservation] = await reserved;
  appendMetric(metricsFile, {
    event: "requester:reserved",
    id: reservation.id,
    tradeId,
    stateHash: journal.snapshot(tradeId).stateHash,
  });
  await stop();
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
