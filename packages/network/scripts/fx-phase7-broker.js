const fs = require("node:fs");
const path = require("node:path");
const { JsonRpcProvider, Wallet } = require("ethers");
const {
  FxCoordinationSession,
  FxPublicBroker,
  FxTradeJournal,
  FxWakuTransport,
  FxX402ExactBrokerBridge,
  FxX402ExactStore,
  FxX402SwapCoordinator,
  FxX402SwapStore,
  createFxBrokerHttpService,
  createFxX402ExactHttpHandler,
  createFxX402SwapHttpHandler,
  resolveFxBrokerCoordinationDomain,
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
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be an unsigned integer`);
  }
  return value;
}

async function loadSigner() {
  const sources = [
    process.env.FX_PHASE7_BROKER_KEYSTORE,
    process.env.FX_PHASE7_BROKER_PRIVATE_KEY,
    process.env.FX_PHASE7_BROKER_PRIVATE_KEY_FILE,
  ].filter(Boolean);
  if (sources.length !== 1) {
    throw new Error(
      "configure exactly one FX broker identity source"
    );
  }
  if (process.env.FX_PHASE7_BROKER_KEYSTORE) {
    return Wallet.fromEncryptedJson(
      fs.readFileSync(path.resolve(process.env.FX_PHASE7_BROKER_KEYSTORE), "utf8"),
      required("FX_PHASE7_BROKER_KEYSTORE_PASSWORD")
    );
  }
  if (process.env.FX_PHASE7_BROKER_PRIVATE_KEY) {
    return new Wallet(process.env.FX_PHASE7_BROKER_PRIVATE_KEY);
  }
  return new Wallet(
    fs.readFileSync(
      path.resolve(process.env.FX_PHASE7_BROKER_PRIVATE_KEY_FILE),
      "utf8"
    ).trim()
  );
}

function loadExactSettlementSigner() {
  const filePath = path.resolve(required("FX_X402_EXACT_SETTLER_KEY_FILE"));
  const privateKey = fs.readFileSync(filePath, "utf8").trim();
  return new Wallet(privateKey);
}

function loadExactFactories(
  filePath,
  deploymentId,
  facilitatorRecipient,
  facilitatorFeeAtomic
) {
  const input = JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
  if (
    input.schema !== "versus-fx-x402-exact-factories" ||
    input.schemaVersion !== 1 ||
    String(input.deploymentId || "").toLowerCase() !== deploymentId ||
    !Array.isArray(input.factories) ||
    input.factories.length < 1
  ) {
    throw new Error("FX x402 exact factory manifest is invalid");
  }
  return Object.fromEntries(input.factories.map((item) => {
    const key = `${String(BigInt(item.chainId))}:${String(item.asset).toLowerCase()}`;
    return [key, {
      factoryAddress: item.factoryAddress,
      tokenName: item.tokenName,
      tokenVersion: item.tokenVersion,
      facilitatorRecipient,
      facilitatorFeeAtomic,
    }];
  }));
}

async function main() {
  const deploymentId = required("FX_PHASE7_DEPLOYMENT_ID").toLowerCase();
  const dataDirectory = path.resolve(required("FX_PHASE7_DATA_DIR"));
  fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const x402Enabled = process.env.FX_X402_SWAP_ENABLED === "1";
  const x402ExactEnabled = process.env.FX_X402_EXACT_ENABLED === "1";
  const anyX402Enabled = x402Enabled || x402ExactEnabled;
  const x402ManifestPath = anyX402Enabled
    ? path.resolve(
        process.env.FX_X402_V3_MANIFEST ||
          path.join(
            __dirname,
            x402ExactEnabled
              ? "../../../versus/deployments/fx/phase13-v3-exact-public-testnet.json"
              : "../../../versus/deployments/fx/phase12-v3-public-testnet.json"
          )
      )
    : null;
  const x402Manifest = x402ManifestPath
    ? JSON.parse(fs.readFileSync(x402ManifestPath, "utf8"))
    : null;
  const coordinationDomain = resolveFxBrokerCoordinationDomain({
    deploymentId,
    configuredDomain: process.env.FX_PHASE7_COORDINATION_DOMAIN || null,
    x402Manifest,
  });
  const signer = await loadSigner();
  const transport = new FxWakuTransport({
    deploymentId,
    coordinationDomain,
    bootstrapPeers: String(
      process.env.FX_PHASE7_WAKU_PEERS || DEFAULT_BOOTSTRAPS.join(",")
    ).split(",").map((value) => value.trim()).filter(Boolean),
    storeHistoryMs: integer("FX_PHASE7_STORE_HISTORY_MS", 15 * 60 * 1000),
    storeMessageLimit: integer("FX_PHASE7_STORE_MESSAGE_LIMIT", 512),
  });
  const journal = new FxTradeJournal({
    filePath: path.join(dataDirectory, "phase7-broker-coordination.sqlite"),
    deploymentId,
  });
  const session = new FxCoordinationSession({
    deploymentId,
    signer,
    role: "broker",
    journal,
    transport,
    maxMessagesPerSenderPerMinute: integer(
      "FX_PHASE7_MAX_MESSAGES_PER_MINUTE",
      60
    ),
    maxMessagesPerMinuteGlobal: integer(
      "FX_PHASE7_MAX_GLOBAL_MESSAGES_PER_MINUTE",
      600
    ),
    maxRfqsPerSenderPerMinute: integer(
      "FX_PHASE7_MAX_RFQS_PER_MINUTE",
      6
    ),
    maxQuotesPerSenderPerMinute: integer(
      "FX_PHASE7_MAX_QUOTES_PER_MINUTE",
      12
    ),
    maxActiveRfqs: integer("FX_PHASE7_MAX_ACTIVE_RFQS", 32),
  });
  const broker = new FxPublicBroker({
    session,
    signer,
    brokerFeeAtomic: process.env.FX_PHASE7_BROKER_FEE_ATOMIC || "0",
    observationWindowMs: integer("FX_PHASE7_OBSERVATION_WINDOW_MS", 15_000),
  });
  await broker.start();
  let x402Coordinator = null;
  let x402ExactBridge = null;
  let x402SwapHandler = null;
  if (anyX402Enabled) {
    const manifest = x402Manifest;
    if (manifest.deploymentId !== deploymentId) {
      throw new Error("FX x402 manifest and coordination deployment differ");
    }
    const chainIds = manifest.capabilities
      .map((item) => String(item.chainId))
      .sort();
    if (chainIds.join(",") !== "421614,84532") {
      throw new Error("FX x402 runtime is restricted to the public testnets");
    }
    const providers = {
      "84532": new JsonRpcProvider(
        required("FX_X402_BASE_SEPOLIA_RPC_URL"),
        84532,
        { staticNetwork: true }
      ),
      "421614": new JsonRpcProvider(
        required("FX_X402_ARBITRUM_SEPOLIA_RPC_URL"),
        421614,
        { staticNetwork: true }
      ),
    };
    const handlers = [];
    if (x402Enabled) {
      x402Coordinator = new FxX402SwapCoordinator({
        broker,
        session,
        manifest,
        providers,
        store: new FxX402SwapStore({
          directory: path.join(dataDirectory, "x402-swaps"),
        }),
        sourceRefundSeconds: integer(
          "FX_X402_SOURCE_REFUND_SECONDS",
          7_200
        ),
        reservationTimeoutMs: integer(
          "FX_X402_RESERVATION_TIMEOUT_MS",
          30_000
        ),
      });
      x402Coordinator.recoverFromJournal();
      handlers.push(createFxX402SwapHttpHandler({
        coordinator: x402Coordinator,
      }));
    }
    if (x402ExactEnabled) {
      const settlementSigner = loadExactSettlementSigner();
      const facilitatorFeeAtomic = String(
        process.env.FX_X402_EXACT_FACILITATOR_FEE_ATOMIC || "0"
      );
      if (!/^\d+$/.test(facilitatorFeeAtomic)) {
        throw new Error("FX_X402_EXACT_FACILITATOR_FEE_ATOMIC must be unsigned");
      }
      const factories = loadExactFactories(
        required("FX_X402_EXACT_FACTORIES"),
        deploymentId,
        facilitatorFeeAtomic === "0" ? null : settlementSigner.address,
        facilitatorFeeAtomic
      );
      x402ExactBridge = new FxX402ExactBrokerBridge({
        broker,
        session,
        manifest,
        providers,
        factories,
        signerForNetwork: (network) => {
          const chainId = String(network).replace(/^eip155:/, "");
          const provider = providers[chainId];
          if (!provider) throw new Error(`no exact settler for ${network}`);
          return settlementSigner.connect(provider);
        },
        store: new FxX402ExactStore({
          directory: path.join(dataDirectory, "x402-exact-swaps"),
        }),
        settlementLifetimeSeconds: integer(
          "FX_X402_SOURCE_REFUND_SECONDS",
          7_200
        ),
        reservationTimeoutMs: integer(
          "FX_X402_RESERVATION_TIMEOUT_MS",
          30_000
        ),
      });
      handlers.push(createFxX402ExactHttpHandler({
        coordinator: x402ExactBridge.coordinator,
        publicUrl: process.env.FX_X402_EXACT_PUBLIC_URL || undefined,
      }));
    }
    x402SwapHandler = async (request, response) => {
      for (const handler of handlers) {
        if (await handler(request, response)) return true;
      }
      return false;
    };
  }
  const service = createFxBrokerHttpService({
    broker,
    x402SwapHandler,
    host: process.env.FX_PHASE7_BROKER_HOST || "127.0.0.1",
    port: integer("FX_PHASE7_BROKER_PORT", 8787),
    maxRequestsPerMinutePerIp: integer(
      "FX_PHASE7_HTTP_ROUTES_PER_MINUTE_PER_IP",
      12
    ),
    maxConcurrentRouteRequests: integer(
      "FX_PHASE7_HTTP_MAX_CONCURRENT_ROUTES",
      32
    ),
    maxX402RequestsPerMinutePerIp: integer(
      "FX_X402_HTTP_REQUESTS_PER_MINUTE_PER_IP",
      120
    ),
    maxConcurrentX402Requests: integer(
      "FX_X402_HTTP_MAX_CONCURRENT_REQUESTS",
      32
    ),
    trustProxy: process.env.FX_PHASE7_HTTP_TRUST_PROXY === "1",
  });
  const url = await service.listen();
  process.stdout.write(`${JSON.stringify({
    event: "fx_broker_ready",
    url,
    broker: signer.address.toLowerCase(),
    coordinationDomain,
    feeAtomic: process.env.FX_PHASE7_BROKER_FEE_ATOMIC || "0",
    x402SwapEndpoint: x402Enabled
      ? `${url}/v1/fx/swaps`
      : null,
    x402Scheme: x402Enabled ? "versus-atomic-fx-v3" : null,
    x402ExactEndpoint: x402ExactEnabled
      ? `${url}/v1/fx/exact`
      : null,
    x402ExactScheme: x402ExactEnabled ? "exact" : null,
    x402ExactFacilitatorFeeAtomic: x402ExactEnabled
      ? process.env.FX_X402_EXACT_FACILITATOR_FEE_ATOMIC || "0"
      : null,
    testnetOnly: x402SwapHandler ? true : null,
    custody: false,
    settlementKeys: x402ExactEnabled,
  })}\n`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await service.close().catch(() => {});
    x402Coordinator?.close();
    await broker.close().catch(() => {});
    journal.close();
  };
  process.once("SIGINT", () => stop().finally(() => process.exit(0)));
  process.once("SIGTERM", () => stop().finally(() => process.exit(0)));
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
