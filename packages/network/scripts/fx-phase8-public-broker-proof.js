const fs = require("node:fs");
const path = require("node:path");
const {
  Wallet,
  hexlify,
  randomBytes,
} = require("ethers");
const {
  FxCoordinationSession,
  FxPublicBroker,
  FxTradeJournal,
  FxWakuTransport,
  DEFAULT_FX_CLOCK_RPCS,
  calibrateFxNetworkClock,
  createFxNetworkNow,
  createFxBrokerHttpService,
  queryBrokerRoutes,
  signFxMessage,
  verifyBrokerRouteProposal,
} = require("../src");

const DEPLOYMENT_ID =
  "0xd0935aa32dc4d37e33180ac9409c993b7bf39749ff375df4da033bd106c0983e";
const TEST_TOKEN = "0xcba3d9354dd4c30bb6961abb4473a6340486e01b";
const DEFAULT_BOOTSTRAPS = [
  "/dns4/relay-a.versuscypher.com/tcp/443/wss/p2p/16Uiu2HAmCQArrt8ND7sTzPCg76YmQPab7HKjSrVZeyeTVZdQyPWy",
  "/dns4/relay-b.versuscypher.com/tcp/443/wss/p2p/16Uiu2HAkx96y18XpzAybpmi1zzdMQZFvsRPZfkku8R9T4KJFMr2P",
];
const DEFAULT_CLOCK_RPCS = DEFAULT_FX_CLOCK_RPCS;

function integer(value, fallback, label) {
  const normalized = Number(value ?? fallback);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error(`${label} must be an unsigned integer`);
  }
  return normalized;
}

function proofConfiguration(environment = process.env) {
  const dataDirectory = path.resolve(
    environment.FX_PHASE8_DATA_DIR ||
      path.join(process.cwd(), ".local", `fx-phase8-public-proof-${Date.now()}`)
  );
  return {
    dataDirectory,
    deploymentId: DEPLOYMENT_ID,
    brokerObservationWindowMs: integer(
      environment.FX_PHASE8_OBSERVATION_WINDOW_MS,
      30_000,
      "FX_PHASE8_OBSERVATION_WINDOW_MS"
    ),
    requestTimeoutMs: integer(
      environment.FX_PHASE8_REQUEST_TIMEOUT_MS,
      90_000,
      "FX_PHASE8_REQUEST_TIMEOUT_MS"
    ),
    bootstrapPeers: String(
      environment.FX_PHASE8_WAKU_PEERS || DEFAULT_BOOTSTRAPS.join(",")
    ).split(",").map((value) => value.trim()).filter(Boolean),
    clockRpcUrls: String(
      environment.FX_PHASE8_CLOCK_RPCS || DEFAULT_CLOCK_RPCS.join(",")
    ).split(",").map((value) => value.trim()).filter(Boolean),
  };
}

const calibrateNetworkClock = calibrateFxNetworkClock;

async function signedRfq(requester, {
  tradeId,
  now,
  lifetimeSeconds = 60,
}) {
  return signFxMessage({
    protocol: "versus-fx",
    version: 1,
    deploymentId: DEPLOYMENT_ID,
    type: "fx_rfq",
    tradeId,
    role: "requester",
    sequence: "1",
    createdAt: now,
    expiresAt: now + lifetimeSeconds,
    payload: {
      outputChainId: "421614",
      outputToken: TEST_TOKEN,
      outputAmountAtomic: "10000",
      inputOptions: [{
        chainId: "84532",
        token: TEST_TOKEN,
        maxInputAtomic: "10000",
      }],
      quoteDeadline: now + lifetimeSeconds - 5,
      settlementDeadline: now + 7_200,
      quotePolicy: "lowest_all_in",
      x402Commitment: null,
    },
  }, requester);
}

async function main() {
  const configuration = proofConfiguration();
  const clock = await calibrateNetworkClock({
    rpcUrls: configuration.clockRpcUrls,
  });
  const networkNow = createFxNetworkNow(clock);
  fs.mkdirSync(configuration.dataDirectory, {
    recursive: true,
    mode: 0o700,
  });
  const brokerSigner = Wallet.createRandom();
  const requester = Wallet.createRandom();
  const journal = new FxTradeJournal({
    filePath: path.join(configuration.dataDirectory, "broker.sqlite"),
    deploymentId: configuration.deploymentId,
  });
  const transport = new FxWakuTransport({
    deploymentId: configuration.deploymentId,
    bootstrapPeers: configuration.bootstrapPeers,
    storeHistoryMs: 15 * 60 * 1000,
    storeMessageLimit: 512,
    now: () => networkNow() * 1000,
  });
  const session = new FxCoordinationSession({
    deploymentId: configuration.deploymentId,
    signer: brokerSigner,
    role: "broker",
    journal,
    transport,
    maxMessagesPerSenderPerMinute: 60,
    maxMessagesPerMinuteGlobal: 600,
    maxRfqsPerSenderPerMinute: 6,
    maxQuotesPerSenderPerMinute: 12,
    maxActiveRfqs: 32,
    now: networkNow,
  });
  const broker = new FxPublicBroker({
    session,
    signer: brokerSigner,
    brokerFeeAtomic: "0",
    observationWindowMs: configuration.brokerObservationWindowMs,
    now: networkNow,
  });
  const service = createFxBrokerHttpService({
    broker,
    host: "127.0.0.1",
    port: 0,
  });
  let serviceUrl;
  const coordinationEvents = [];
  let attempt = {
    phase: 8,
    proof: "external-requester-http-broker-public-waku-independent-dealer",
    startedAt: new Date().toISOString(),
    deploymentId: configuration.deploymentId,
    settlementEnabled: false,
    productionFunds: false,
    requester: requester.address.toLowerCase(),
    broker: brokerSigner.address.toLowerCase(),
    networkClock: clock,
    coordinationEvents,
  };
  session.on("accepted", (envelope, metadata) => {
    coordinationEvents.push({
      event: "accepted",
      id: envelope.id,
      type: envelope.type,
      tradeId: envelope.tradeId,
      sender: envelope.sender,
      history: Boolean(metadata?.history),
    });
  });
  session.on("pending", (envelope, metadata) => {
    coordinationEvents.push({
      event: "pending",
      id: envelope.id,
      type: envelope.type,
      tradeId: envelope.tradeId,
      sender: envelope.sender,
      error: metadata?.error?.code || metadata?.error?.message || null,
      history: Boolean(metadata?.history),
    });
  });
  session.on("rejected", (error, metadata, envelope) => {
    coordinationEvents.push({
      event: "rejected",
      id: envelope?.id || null,
      type: envelope?.type || null,
      tradeId: envelope?.tradeId || null,
      sender: envelope?.sender || null,
      error: error?.code || error?.message || String(error),
      history: Boolean(metadata?.history),
    });
  });
  try {
    await broker.start();
    serviceUrl = await service.listen();
    const tradeId = hexlify(randomBytes(32)).toLowerCase();
    const now = networkNow();
    const rfq = await signedRfq(requester, { tradeId, now });
    attempt = {
      ...attempt,
      serviceUrl,
      tradeId,
      rfqId: rfq.id,
      rfq,
      transportAtIngress: transport.status(),
    };
    process.stdout.write(`${JSON.stringify({
      event: "phase8:external_requester_ready",
      serviceUrl,
      tradeId,
      requester: requester.address.toLowerCase(),
      broker: brokerSigner.address.toLowerCase(),
      settlementEnabled: false,
      publicWaku: true,
    })}\n`);
    const comparison = await queryBrokerRoutes({
      endpoints: [serviceUrl],
      rfq,
      timeoutMs: configuration.requestTimeoutMs,
      now,
      inputChainId: "84532",
      inputToken: TEST_TOKEN,
    });
    const proposal = verifyBrokerRouteProposal(comparison.selected, {
      now: networkNow(),
      deploymentId: configuration.deploymentId,
      rfqId: rfq.id,
    });
    const evidence = {
      phase: 8,
      proof: "external-requester-http-broker-public-waku-independent-dealer",
      startedAt: attempt.startedAt,
      completedAt: new Date().toISOString(),
      deploymentId: configuration.deploymentId,
      settlementEnabled: false,
      productionFunds: false,
      requester: requester.address.toLowerCase(),
      broker: brokerSigner.address.toLowerCase(),
      dealer: proposal.route.dealer,
      transport: transport.status(),
      service: {
        protocol: "http",
        address: serviceUrl,
        externalRequesterUsedWaku: false,
        brokerUsedPublicWaku: true,
      },
      rfq,
      proposal,
      comparison: {
        validProposalCount: comparison.proposals.length,
        selectedProposalId: proposal.proposalId,
        attempts: comparison.attempts.map((attempt) => ({
          endpoint: attempt.endpoint,
          ok: attempt.ok,
          status: attempt.status,
          error: attempt.error,
          latencyMs: attempt.latencyMs,
        })),
      },
    };
    const evidencePath = path.join(
      configuration.dataDirectory,
      "physical-public-broker-evidence.json"
    );
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    process.stdout.write(`${JSON.stringify({
      event: "phase8:physical_proof_complete",
      evidencePath,
      tradeId,
      rfqId: rfq.id,
      quoteId: proposal.route.quoteId,
      proposalId: proposal.proposalId,
      dealer: proposal.route.dealer,
    })}\n`);
  } catch (error) {
    const evidencePath = path.join(
      configuration.dataDirectory,
      "physical-public-broker-failure.json"
    );
    const failure = {
      ...attempt,
      completedAt: new Date().toISOString(),
      transportAtFailure: transport.status(),
      error: {
        name: error?.name || "Error",
        code: error?.code || null,
        message: error?.message || String(error),
      },
    };
    fs.writeFileSync(evidencePath, `${JSON.stringify(failure, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    process.stderr.write(`${JSON.stringify({
      event: "phase8:physical_proof_failed",
      evidencePath,
      tradeId: attempt.tradeId || null,
      rfqId: attempt.rfqId || null,
      error: failure.error,
    })}\n`);
    throw error;
  } finally {
    await service.close().catch(() => {});
    await broker.close().catch(() => {});
    journal.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_BOOTSTRAPS,
  DEFAULT_CLOCK_RPCS,
  DEPLOYMENT_ID,
  TEST_TOKEN,
  calibrateNetworkClock,
  proofConfiguration,
  signedRfq,
};
