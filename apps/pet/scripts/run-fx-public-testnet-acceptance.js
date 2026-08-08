const { EventEmitter } = require("node:events");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  Wallet,
  hexlify,
  keccak256,
  randomBytes,
} = require("ethers");
const {
  FX_NATIVE_ETH_ADDRESS,
  FxCoordinationSession,
  FxRequesterFundingSdk,
  FxTradeJournal,
  FxWakuTransport,
  FxX402ExactBrokerBridge,
  FxX402ExactStore,
  createFxBrokerHttpService,
  createFxX402ExactHttpHandler,
} = require("@versus/network");
const {
  FX_PUBLIC_WAKU_PEERS,
  FxDesktopNetworkRuntime,
} = require("../src/fx-desktop-network");
const { FxEvmCohort } = require("../src/fx-evm-cohort");
const { loadFxMarketRuntime } = require("../src/fx-market-runtime");
const {
  fetchNodeFxPriceReference,
  fxPriceReferenceEndpointsFromEnv,
} = require("../src/fx-price-reference");

const ACCEPTANCE_GUARD = "I_UNDERSTAND_PUBLIC_TESTNET_ONLY";
const PHYSICAL_ACCEPTANCE_GUARD = "I_UNDERSTAND_TWO_DEVICE_TESTNET_ONLY";
const DEFAULT_RECOVERY_PASSWORD = "public testnet acceptance recovery";
const TEST_VALUE_MICROS = 2_000n;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function execFileAsync(file, arguments_, options) {
  return new Promise((resolve, reject) => {
    execFile(file, arguments_, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function waitUntil(predicate, { timeoutMs = 180_000, label } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await delay(1_000);
  }
  throw new Error(`timed out waiting for ${label || "condition"}`);
}

class LocalWakuBus extends EventEmitter {
  constructor() {
    super();
    this.history = [];
    this.nodes = new Set();
    this.connected = true;
  }

  node() {
    const bus = this;
    const callbacks = new Map();
    const node = {
      callbacks,
      peers: [{
        id: "public-testnet-acceptance-local-bus",
        protocols: [
          "/vac/waku/lightpush/3.0.0",
          "/vac/waku/filter-subscribe/2.0.0-beta1",
          "/vac/waku/store-query/3.0.0",
        ],
      }],
      async waitForPeers() {
        if (!bus.connected) throw new Error("acceptance relay is disconnected");
      },
      async getConnectedPeers() {
        return bus.connected ? node.peers : [];
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
          if (!bus.connected) throw new Error("acceptance relay is disconnected");
          const topic = decoders[0].contentTopic;
          for (const entry of bus.history.filter(
            (candidate) => candidate.topic === topic
          )) {
            if (await callback(entry.message)) break;
          }
        },
      },
      lightPush: {
        async send(encoder, message) {
          if (!bus.connected) throw new Error("acceptance relay is disconnected");
          const entry = {
            topic: encoder.contentTopic,
            message: {
              ...message,
              hashStr: `acceptance-${bus.history.length + 1}`,
            },
          };
          bus.history.push(entry);
          for (const target of bus.nodes) {
            await target.callbacks.get(entry.topic)?.(entry.message);
          }
          return { successes: ["local-bus"], failures: [] };
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

function localSessionFactory({ dataDirectory, bus, deploymentId, now }) {
  return ({ role, fileName, signer }) => {
    const journal = new FxTradeJournal({
      filePath: path.join(dataDirectory, fileName),
      deploymentId,
      now,
      minimumTimeoutDeltaSeconds: 3_600,
    });
    const transport = new FxWakuTransport({
      deploymentId,
      bootstrapPeers: ["local-bus"],
      now: () => now() * 1_000,
      sdkLoader: async () => ({
        Protocols: {
          LightPush: "lightpush",
          Filter: "filter",
        },
      }),
      nodeFactory: async () => bus.node(),
    });
    const session = new FxCoordinationSession({
      deploymentId,
      signer,
      role,
      journal,
      transport,
      now,
    });
    return { session, journal };
  };
}

function identityDirectory(repositoryRoot, environment = process.env) {
  return path.resolve(
    environment.VERSUS_FX_TEST_IDENTITY_DIR ||
      path.join(repositoryRoot, ".local", "fx-phase5-testnet")
  );
}

function readWallets(repositoryRoot, roles, environment = process.env) {
  const identityRoot = identityDirectory(repositoryRoot, environment);
  const password = fs.readFileSync(
    path.join(identityRoot, "identity-password.txt"),
    "utf8"
  ).trim();
  return Object.fromEntries(
    roles.map((role) => {
      const keystore = fs.readFileSync(
        path.join(identityRoot, `${role}.keystore.json`),
        "utf8"
      );
      return [role, Wallet.fromEncryptedJsonSync(keystore, password)];
    })
  );
}

function createPriceProvider({ repositoryRoot, environment }) {
  const baseDeployment = require(path.join(
    repositoryRoot,
    "versus",
    "deployments",
    "base.json"
  ));
  let cached = null;
  return async (symbol) => {
    if (!cached || Date.now() - cached.fetchedAt > 30_000) {
      const reference = await fetchNodeFxPriceReference({
        endpoints: fxPriceReferenceEndpointsFromEnv(environment),
        trustedSigners: baseDeployment.rainAttestors,
        timeoutMs: 10_000,
      });
      assert(reference.freshness === "fresh", "signed FX price quorum is stale");
      cached = { ...reference, fetchedAt: Date.now() };
    }
    const value = cached.prices.get(String(symbol).toUpperCase());
    assert(value > 0n, `${symbol}/USD price is unavailable`);
    return value;
  };
}

function amountForValue(position, valueMicros, priceMicros) {
  return (
    (valueMicros * (10n ** BigInt(position.decimals)) + priceMicros - 1n) /
    priceMicros
  );
}

function maxInputFor(position, priceMicros) {
  return amountForValue(position, 2_000_000n, priceMicros).toString();
}

function policy() {
  return {
    minimumTradeUsd: 0.0001,
    maximumTradeUsd: 5,
    maximumExposureUsd: 50,
    maximumRequesterExposureUsd: 20,
    maximumAssetExposureUsd: 20,
    maximumGasUsd: 5,
    maximumOverheadBps: 10_000,
    minimumSpreadBps: 5,
    inventoryPremiumBps: 0,
  };
}

function createRuntime({
  dataDirectory,
  wallets,
  market,
  cohort,
  bus,
  price,
  publicWaku = false,
}) {
  const now = () => Math.floor(Date.now() / 1_000);
  const options = {
    dataDirectory,
    walletProvider: (role) => {
      const wallet = role === "broker"
        ? wallets.deployer
        : wallets[role] || (role === "dealer" ? wallets.requester : null);
      assert(wallet, `${role} wallet is unavailable for this acceptance role`);
      return { address: wallet.address, privateKey: wallet.privateKey };
    },
    evm: cohort,
    deploymentId: market.deploymentId,
    coordinationDomain: market.coordinationDomain,
    bootstrapPeers: publicWaku
      ? String(process.env.VERSUS_FX_WAKU_PEERS || FX_PUBLIC_WAKU_PEERS.join(","))
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
      : ["local-bus"],
    now,
    brokerObservationWindowMs: 10_000,
    brokerQuoteSettleWindowMs: 250,
    dealerObservationWindowMs: 0,
    nativeUsdPriceProvider: ({ configuration }) =>
      price(configuration.nativeSymbol),
    assetUsdPriceProvider: ({ symbol }) => price(symbol),
    protocolVersion: 3,
    // On two physical devices the dealer is the preferred V3 executor. Give
    // the requester-side recovery relayer time to observe that claim before
    // it exercises the permissionless fallback path with a different wallet.
    executorFallbackBaseMs: publicWaku ? 30_000 : 0,
    executorFallbackJitterMs: publicWaku ? 5_000 : 0,
  };
  if (!publicWaku) {
    options.sessionFactory = localSessionFactory({
      dataDirectory,
      bus,
      deploymentId: market.deploymentId,
      now,
    });
  }
  const runtime = new FxDesktopNetworkRuntime(options);
  runtime.on("error", (error) => {
    process.stderr.write(`[runtime] ${error.code || error.name}: ${error.message}\n`);
  });
  runtime.on("trade", (event) => {
    if (event.state === "quote_rejected") {
      process.stderr.write(
        `[dealer] quote rejected: ${JSON.stringify(event.rejection)}\n`
      );
    }
  });
  return runtime;
}

function createSdk({ runtime, market, wallets, dataDirectory }) {
  return new FxRequesterFundingSdk({
    deploymentId: market.deploymentId,
    signer: wallets.requester,
    brokerEndpoints: ["waku://local-public-testnet-acceptance"],
    recoveryDirectory: path.join(dataDirectory, "requester-recovery"),
    queryRoutes: (input) => runtime.queryRoutes(input),
    settlementExecutor: (input) => runtime.executeRequester(input),
    destinationVerifier: async ({ settlement }) =>
      settlement.destinationObservation,
    protocolVersion: 3,
  });
}

async function executeRoute({
  route,
  runtime,
  sdk,
  wallets,
  price,
  destinationAddress = wallets.requester.address,
}) {
  const outputPrice = route.output.symbol === "USDC"
    ? 1_000_000n
    : await price(route.output.symbol);
  const inputPrice = route.input.symbol === "USDC"
    ? 1_000_000n
    : await price(route.input.symbol);
  const outputAmount = amountForValue(
    route.output,
    TEST_VALUE_MICROS,
    outputPrice
  );
  const quote = await sdk.quoteFunding({
    requirement: {
      source: "public-testnet-acceptance",
      outputChainId: route.output.chainId,
      outputToken: route.output.token,
      outputAmountAtomic: outputAmount.toString(),
    },
    destinationAddress,
    sourceRefundAddress: wallets.requester.address,
    inputOptions: [{
      chainId: route.input.chainId,
      token: route.input.token,
      maxInputAtomic: maxInputFor(route.input, inputPrice),
    }],
    inputChainId: route.input.chainId,
    inputToken: route.input.token,
  });
  const prepared = await sdk.prepareExternalFunding({
    quote,
    recoveryPassword: DEFAULT_RECOVERY_PASSWORD,
    ownerApproved: true,
  });
  const reservation = await runtime.reserveRequester({
    acceptance: prepared.acceptance,
  });
  const result = await sdk.executePreparedFunding({
    prepared: { ...prepared, reservation },
    recoveryPassword: DEFAULT_RECOVERY_PASSWORD,
  });
  assert(result.fundsReady, `${route.routeId} did not reach funds-ready`);
  return {
    routeId: route.routeId,
    tradeId: prepared.tradeId,
    inputAmountAtomic: prepared.inputAmountAtomic,
    outputAmountAtomic: prepared.outputAmountAtomic,
    destinationTransactionHash:
      result.receipt.destinationTransactionHash ||
      result.receipt.transactionHash ||
      null,
    confirmedAt: result.receipt.confirmedAt,
  };
}

async function runGenericX402({
  repositoryRoot,
  identityRoot,
  runRoot,
  market,
  runtime,
  cohort,
  wallets,
  identityPassword,
}) {
  const broker = await runtime.ensureBroker();
  const factories = Object.fromEntries(market.exactFactories.map((factory) => [
    `${factory.chainId}:${factory.token.toLowerCase()}`,
    {
      factoryAddress: factory.address,
      tokenName: factory.tokenName,
      tokenVersion: factory.tokenVersion,
      facilitatorRecipient: wallets.deployer.address,
      facilitatorFeeAtomic: factory.facilitatorFeeAtomic,
    },
  ]));
  const bridge = new FxX402ExactBrokerBridge({
    broker,
    session: broker.session,
    manifest: JSON.parse(fs.readFileSync(market.deploymentPath, "utf8")).v3,
    providers: Object.fromEntries(
      market.chains.map((chain) => [chain.chainId, cohort.provider(chain.chainId)])
    ),
    factories,
    signerForNetwork: (network) => {
      const chainId = String(network).replace(/^eip155:/, "");
      return wallets.deployer.connect(cohort.provider(chainId));
    },
    store: new FxX402ExactStore({
      directory: path.join(runRoot, "x402-exact-swaps"),
    }),
    reservationTimeoutMs: 30_000,
    confirmations: 1,
  });
  const service = createFxBrokerHttpService({
    broker,
    x402SwapHandler: createFxX402ExactHttpHandler({
      coordinator: bridge.coordinator,
    }),
    host: "127.0.0.1",
    port: 0,
    maxX402RequestsPerMinutePerIp: 1_000,
  });
  const baseUrl = await service.listen();
  const endpoint = `${baseUrl}/v1/fx/exact`;
  const positions = new Map(
    market.positions.map((position) => [position.id, position])
  );
  const pairs = [
    ["base-sepolia-usdc", "avalanche-fuji-eurc"],
    ["base-sepolia-eurc", "avalanche-fuji-usdc"],
    ["avalanche-fuji-usdc", "base-sepolia-eurc"],
    ["avalanche-fuji-eurc", "base-sepolia-usdc"],
  ];
  const results = [];
  try {
    for (const [inputId, outputId] of pairs) {
      const input = positions.get(inputId);
      const output = positions.get(outputId);
      assert(input && output, `x402 position pair ${inputId}/${outputId} is missing`);
      process.stderr.write(
        `[x402] ${input.asset}/${input.chainId} -> ${output.asset}/${output.chainId}\n`
      );
      const recoveryDirectory = path.join(
        runRoot,
        "x402-requester-recovery",
        `${input.asset}-${input.chainId}`
      );
      const child = await execFileAsync(
        process.execPath,
        [path.join(
          repositoryRoot,
          "packages",
          "network",
          "scripts",
          "fx-x402-exact-requester.js"
        )],
        {
          cwd: repositoryRoot,
          timeout: 15 * 60 * 1000,
          maxBuffer: 4 * 1024 * 1024,
          env: {
            ...process.env,
            FX_X402_TESTNET_ONLY: "1",
            FX_X402_EXACT_ENDPOINT: endpoint,
            FX_X402_EXACT_INPUT_NETWORK: `eip155:${input.chainId}`,
            FX_X402_EXACT_OUTPUT_NETWORK: `eip155:${output.chainId}`,
            FX_X402_EXACT_INPUT_ASSET: input.assetAddress,
            FX_X402_EXACT_OUTPUT_ASSET: output.assetAddress,
            FX_X402_EXACT_MAXIMUM_INPUT_ATOMIC: "100000",
            FX_X402_EXACT_OUTPUT_AMOUNT_ATOMIC: "2000",
            FX_X402_EXACT_DESTINATION_ADDRESS: wallets.requester.address,
            FX_X402_EXACT_PAYER_KEYSTORE: path.join(
              identityRoot,
              "requester.keystore.json"
            ),
            FX_X402_EXACT_PAYER_KEYSTORE_PASSWORD: identityPassword,
            FX_X402_EXACT_RECOVERY_DIR: recoveryDirectory,
            FX_X402_EXACT_RECOVERY_PASSWORD: DEFAULT_RECOVERY_PASSWORD,
            FX_X402_EXACT_POLL_INTERVAL_MS: "1000",
            FX_X402_EXACT_TIMEOUT_MS: String(12 * 60 * 1000),
          },
        }
      );
      if (child.stderr.trim()) process.stderr.write(child.stderr);
      results.push(JSON.parse(child.stdout));
    }
  } finally {
    await service.close().catch(() => {});
  }
  return results;
}

async function runZeroDestinationGas({ market, runtime, cohort, wallets, price, sdk }) {
  const routeIds = [
    "84532:0x036cbd53842c5426634e7929541ec2318f3dcf7e->43113:0x5e44db7996c682e92a960b65ac713a54ad815c6b",
    "43113:0x5425890298aed601595a70ab815c96711a31bc65->84532:0x808456652fdb597867f38412077a9182bf77359f",
  ];
  const results = [];
  for (const routeId of routeIds) {
    const route = market.routes.find((candidate) => candidate.routeId === routeId);
    assert(route, `zero-gas route ${routeId} is missing`);
    const recipient = Wallet.createRandom();
    const provider = cohort.provider(route.output.chainId);
    const [nativeBefore, tokenBefore] = await Promise.all([
      provider.getBalance(recipient.address),
      cohort.tokenBalance(
        route.output.chainId,
        route.output.token,
        recipient.address
      ),
    ]);
    assert(nativeBefore === 0n, "fresh destination recipient unexpectedly has gas");
    const routeResult = await executeRoute({
      route,
      runtime,
      sdk,
      wallets,
      price,
      destinationAddress: recipient.address,
    });
    const [nativeAfter, tokenAfter] = await Promise.all([
      provider.getBalance(recipient.address),
      cohort.tokenBalance(
        route.output.chainId,
        route.output.token,
        recipient.address
      ),
    ]);
    assert(nativeAfter === 0n, "destination recipient received native gas");
    assert(BigInt(tokenAfter) > BigInt(tokenBefore), "destination token balance did not increase");
    results.push({
      ...routeResult,
      scenario: "zero-destination-gas",
      destinationAddress: recipient.address.toLowerCase(),
      nativeBalanceBeforeAtomic: nativeBefore.toString(),
      nativeBalanceAfterAtomic: nativeAfter.toString(),
      tokenBalanceBeforeAtomic: String(tokenBefore),
      tokenBalanceAfterAtomic: String(tokenAfter),
    });
  }
  return results;
}

async function runTimeoutRefund({ market, cohort, wallets }) {
  const positions = market.positions.filter(
    (position) => position.asset === "USDC"
  );
  const results = [];
  for (const position of positions) {
    const provider = cohort.provider(position.chainId);
    const latest = await provider.getBlock("latest");
    assert(latest, `${position.chain} latest block is unavailable`);
    const tradeId = hexlify(randomBytes(32)).toLowerCase();
    const secret = hexlify(randomBytes(32)).toLowerCase();
    const refundTimestamp = Number(latest.timestamp) + 120;
    const funded = await cohort.fundLock({
      chainId: position.chainId,
      tradeId,
      side: "source",
      amountAtomic: "1000",
      beneficiaryAmountAtomic: "1000",
      executorAmountAtomic: "0",
      beneficiary: wallets.dealer.address,
      refundAddress: wallets.requester.address,
      secretHash: keccak256(secret),
      refundTimestamp,
      role: "requester",
      token: position.assetAddress,
    });
    await waitUntil(async () => {
      const head = await provider.getBlock("latest");
      return head && Number(head.timestamp) >= refundTimestamp;
    }, { timeoutMs: 5 * 60 * 1000, label: `${position.chain} refund timeout` });
    const refunded = await cohort.refundLock({
      chainId: position.chainId,
      tradeId,
      side: "source",
      role: "requester",
      token: position.assetAddress,
      fundingTransactionHash: funded.receipt.transactionHash,
    });
    assert(refunded.lock.stateName === "refunded", "lock did not enter refunded state");
    results.push({
      scenario: "timeout-refund",
      chainId: position.chainId,
      token: position.assetAddress,
      tradeId,
      refundTimestamp,
      fundingTransactionHash: funded.receipt.transactionHash,
      refundTransactionHash: refunded.receipt.transactionHash,
      finalState: refunded.lock.stateName,
    });
  }
  return results;
}

async function runRelayReconnect({ market, runtime, bus, wallets, price, sdk }) {
  const route = market.routes.find((candidate) =>
    candidate.input.symbol === "USDC" &&
    candidate.input.chainId === "84532" &&
    candidate.output.symbol === "EURC" &&
    candidate.output.chainId === "43113"
  );
  assert(route, "relay reconnect route is missing");
  bus.connected = false;
  let disconnectedError = null;
  try {
    await executeRoute({ route, runtime, sdk, wallets, price });
  } catch (error) {
    disconnectedError = error;
  }
  assert(disconnectedError, "disconnected relay unexpectedly accepted a route");
  bus.connected = true;
  const recovered = await executeRoute({ route, runtime, sdk, wallets, price });
  return [{
    ...recovered,
    scenario: "relay-disconnect-reconnect",
    disconnectedFailure: disconnectedError.code || disconnectedError.message,
    reconnected: true,
  }];
}

function publicTransportEntries(runtime) {
  return [
    ["broker", runtime.broker?.session?.transport],
    ["requester", runtime.requesterSession?.transport],
    ["relayer", runtime.relayerSession?.transport],
    ["dealer", runtime.dealerSession?.transport],
  ].filter(([, transport]) => transport);
}

function publicTransportEvidence(runtime) {
  return Object.fromEntries(publicTransportEntries(runtime).map(([role, transport]) => {
    const status = transport.status();
    return [role, {
      state: status.state,
      peerCount: status.peerCount,
      protocolCounts: status.protocolCounts,
      historySync: status.historySync,
      reconnect: status.reconnect,
    }];
  }));
}

function assertPublicRelayRedundancy(evidence, label) {
  const entries = Object.entries(evidence);
  assert(entries.length > 0, `${label} has no public Waku transports`);
  for (const [role, status] of entries) {
    assert(
      status.protocolCounts?.lightPush >= 2,
      `${label} ${role} needs two LightPush peers`
    );
    assert(
      status.protocolCounts?.filter >= 2,
      `${label} ${role} needs two Filter peers`
    );
  }
}

async function waitForPublicRelayRedundancy(runtime, label) {
  return waitUntil(async () => {
    for (const [, transport] of publicTransportEntries(runtime)) {
      await transport.refreshPeerDiagnostics().catch(() => {});
    }
    const evidence = publicTransportEvidence(runtime);
    try {
      assertPublicRelayRedundancy(evidence, label);
      return evidence;
    } catch (_) {
      return null;
    }
  }, { timeoutMs: 120_000, label: `${label} public relay redundancy` });
}

async function forcePublicRelayReconnect(runtime) {
  await runtime.warmRequester();
  const before = await waitForPublicRelayRedundancy(runtime, "before disconnect");
  const transports = publicTransportEntries(runtime).map(([, transport]) => transport);
  await Promise.all(transports.map((transport) => transport.close()));
  const disconnected = publicTransportEvidence(runtime);
  for (const [role, status] of Object.entries(disconnected)) {
    assert(status.state === "offline", `${role} transport did not disconnect`);
    assert(status.peerCount === 0, `${role} transport retained connected peers`);
  }
  await Promise.all(transports.map((transport) => transport.ensureConnected({ force: true })));
  await Promise.all(transports.map((transport) => transport.historyCatchUp).filter(Boolean));
  const after = await waitForPublicRelayRedundancy(runtime, "after reconnect");
  return { before, disconnected, after };
}

async function runPublicRelayReconnect({ market, runtime, wallets, price, sdk }) {
  const route = market.routes.find((candidate) =>
    candidate.input.symbol === "USDC" &&
    candidate.input.chainId === "84532" &&
    candidate.output.symbol === "EURC" &&
    candidate.output.chainId === "43113"
  );
  assert(route, "public relay reconnect route is missing");
  const relay = await forcePublicRelayReconnect(runtime);
  const recovered = await executeRoute({ route, runtime, sdk, wallets, price });
  return [{
    ...recovered,
    scenario: "public-relay-disconnect-reconnect",
    relay,
    reconnected: true,
  }];
}

function waitForShutdownSignal() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (signal) => {
      if (settled) return;
      settled = true;
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      resolve(signal);
    };
    const onSigint = () => finish("SIGINT");
    const onSigterm = () => finish("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
  });
}

async function runStalePrice({ market, runtime, cohort, wallets, price, sdk }) {
  const route = market.routes.find((candidate) =>
    candidate.input.symbol === "USDC" &&
    candidate.input.chainId === "84532" &&
    candidate.output.symbol === "EURC" &&
    candidate.output.chainId === "43113"
  );
  assert(route, "stale-price route is missing");
  const fundLock = cohort.fundLock.bind(cohort);
  let fundingCalls = 0;
  cohort.fundLock = async (input) => {
    fundingCalls += 1;
    return fundLock(input);
  };
  runtime.nativePrices.clear();
  runtime.assetPrices.clear();
  runtime.nativeUsdPriceProvider = async () => {
    const error = new Error("injected stale native/USD reference");
    error.code = "STALE_PRICE";
    throw error;
  };
  runtime.assetUsdPriceProvider = async () => {
    const error = new Error("injected stale asset/USD reference");
    error.code = "STALE_PRICE";
    throw error;
  };
  let rejected;
  try {
    await executeRoute({ route, runtime, sdk, wallets, price });
  } catch (error) {
    rejected = error;
  }
  assert(rejected, "stale prices unexpectedly produced a route");
  cohort.fundLock = fundLock;
  assert(fundingCalls === 0, "stale-price rejection reached the funding boundary");
  return [{
    scenario: "stale-price-fail-closed",
    routeId: route.routeId,
    rejection: rejected.code || rejected.message,
    onchainTransactionsBroadcast: 0,
  }];
}

async function runStaleRpc({ market, cohort, wallets, environment }) {
  const badEnvironment = {
    ...environment,
    BASE_SEPOLIA_RPC_URL: "http://127.0.0.1:1",
  };
  const badCohort = new FxEvmCohort({
    walletProvider: (role) => wallets[role] || wallets.requester,
    configurations: market.configurations,
    environment: badEnvironment,
    settlementVersion: 3,
  });
  let rejected;
  try {
    await badCohort.preflight("84532");
  } catch (error) {
    rejected = error;
  }
  assert(rejected, "unavailable RPC unexpectedly passed preflight");
  await cohort.preflight("84532");
  return [{
    scenario: "stale-rpc-fail-closed",
    chainId: "84532",
    rejection: rejected.code || rejected.message,
    fallbackPreflight: "passed",
    onchainTransactionsBroadcast: 0,
  }];
}

async function runRestartMidSwap({
  runRoot,
  market,
  runtime,
  cohort,
  bus,
  wallets,
  price,
  sdk,
}) {
  const route = market.routes.find((candidate) =>
    candidate.input.symbol === "USDC" &&
    candidate.input.chainId === "84532" &&
    candidate.output.symbol === "EURC" &&
    candidate.output.chainId === "43113"
  );
  assert(route, "restart route is missing");
  const claimLock = cohort.claimLock.bind(cohort);
  let blockSourceClaim = true;
  let injectedFailures = 0;
  cohort.claimLock = async (input) => {
    if (input.side === "source" && blockSourceClaim) {
      injectedFailures += 1;
      const error = new Error("injected restart before source claim");
      error.code = "INJECTED_RESTART";
      throw error;
    }
    return claimLock(input);
  };
  const routeResult = await executeRoute({ route, runtime, sdk, wallets, price });
  await waitUntil(() => {
    const trade = runtime.exposureJournal.trade(routeResult.tradeId);
    return trade?.state === "destination_claimed";
  }, { label: "destination claim before restart" });
  assert(injectedFailures > 0, "source claim failure was not injected");
  await runtime.close();
  blockSourceClaim = false;
  cohort.claimLock = claimLock;
  const resumed = createRuntime({
    dataDirectory: runRoot,
    wallets,
    market,
    cohort,
    bus,
    price,
  });
  await resumed.armDealer({
    policy: policy(),
    positions: market.positions.map((position) => ({ ...position, enabled: true })),
  });
  await waitUntil(
    () => resumed.exposureJournal.activeTrades().length === 0,
    { timeoutMs: 5 * 60 * 1000, label: "source claim after restart" }
  );
  const sourceLock = resumed.dealerJournal.findType(
    routeResult.tradeId,
    "fx_lock_source"
  );
  const sourceClaim = resumed.dealerJournal.snapshot(routeResult.tradeId).messages
    .map((entry) => resumed.dealerJournal.message(entry.id))
    .find((entry) =>
      entry?.type === "fx_claim" &&
      entry.payload.lockMessageId === sourceLock.id
    );
  assert(sourceClaim, "restarted dealer did not publish the source claim");
  return {
    runtime: resumed,
    results: [{
      ...routeResult,
      scenario: "restart-mid-swap",
      injectedFailures,
      stateBeforeRestart: "destination_claimed",
      stateAfterRestart: "complete",
      sourceClaimTransactionHash: sourceClaim.payload.transactionHash,
    }],
  };
}

async function main() {
  assert(
    process.env.VERSUS_FX_TESTNET_ACCEPT === ACCEPTANCE_GUARD,
    `set VERSUS_FX_TESTNET_ACCEPT=${ACCEPTANCE_GUARD}`
  );
  const physicalDealer = process.argv.includes("--physical-dealer");
  const physicalRequester = process.argv.includes("--physical-requester");
  assert(
    !(physicalDealer && physicalRequester),
    "choose either --physical-dealer or --physical-requester"
  );
  const publicWaku = physicalDealer || physicalRequester;
  if (publicWaku) {
    assert(
      process.env.VERSUS_FX_PHYSICAL_ACCEPT === PHYSICAL_ACCEPTANCE_GUARD,
      `set VERSUS_FX_PHYSICAL_ACCEPT=${PHYSICAL_ACCEPTANCE_GUARD}`
    );
  }
  if (physicalDealer) {
    assert(
      !process.argv.some((argument) => argument !== "--physical-dealer" && argument.startsWith("--")),
      "--physical-dealer cannot be combined with a scenario flag"
    );
  }
  if (physicalRequester) {
    const scenarioFlags = process.argv.filter(
      (argument) => argument.startsWith("--") && argument !== "--physical-requester"
    );
    assert(
      scenarioFlags.length <= 1 &&
        scenarioFlags.every((argument) =>
          argument === "--x402" ||
          argument === "--relay-reconnect" ||
          argument.startsWith("--route=")
        ),
      "--physical-requester supports the 30-route run, --route, --relay-reconnect, or --x402"
    );
  }
  const repositoryRoot = path.resolve(__dirname, "..", "..", "..");
  const sourceCommit = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
  ).stdout.trim();
  const deploymentPath = path.join(
    repositoryRoot,
    "versus",
    "deployments",
    "fx",
    "public-testnet-v1-market-deployment.json"
  );
  const environment = {
    ...process.env,
    VERSUS_FX_MARKET_DEPLOYMENT: deploymentPath,
    BASE_SEPOLIA_RPC_URL:
      process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
    AVALANCHE_FUJI_RPC_URL:
      process.env.AVALANCHE_FUJI_RPC_URL ||
      "https://api.avax-test.network/ext/bc/C/rpc",
  };
  const market = loadFxMarketRuntime(environment);
  assert(
    market.releaseStage === "public-testnet-v1-candidate",
    "acceptance runner is restricted to the public-testnet candidate"
  );
  assert(
    market.chains.map((chain) => chain.chainId).sort().join(",") ===
      "43113,84532",
    "acceptance runner is restricted to Avalanche Fuji and Base Sepolia"
  );
  assert(market.routes.length === 30, "expected the frozen 30-route market");
  const walletRoles = physicalDealer
    ? ["dealer", "relayer"]
    : physicalRequester
      ? ["requester", "relayer", "deployer"]
      : ["dealer", "requester", "relayer", "deployer"];
  const identityRoot = identityDirectory(repositoryRoot, environment);
  const wallets = readWallets(repositoryRoot, walletRoles, environment);
  const identityPassword = fs.readFileSync(path.join(
    identityRoot,
    "identity-password.txt"
  ), "utf8").trim();
  const price = createPriceProvider({ repositoryRoot, environment });
  const runRoot = process.env.VERSUS_FX_ACCEPTANCE_DATA_DIR
    ? path.resolve(process.env.VERSUS_FX_ACCEPTANCE_DATA_DIR)
    : path.join(
      repositoryRoot,
      ".local",
      "fx-public-testnet-v1",
      new Date().toISOString().replace(/[:.]/g, "-")
    );
  fs.mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  const bus = publicWaku ? null : new LocalWakuBus();
  const cohort = new FxEvmCohort({
    walletProvider: (role) =>
      wallets[role] || wallets.requester || wallets.dealer,
    configurations: market.configurations,
    environment,
    settlementVersion: 3,
  });
  let runtime = createRuntime({
    dataDirectory: runRoot,
    wallets,
    market,
    cohort,
    bus,
    price,
    publicWaku,
  });
  const results = [];
  let finalRelay = null;
  try {
    if (!physicalRequester) {
      await runtime.armDealer({
        policy: policy(),
        positions: market.positions.map((position) => ({
          ...position,
          enabled: true,
        })),
      });
    }
    if (physicalDealer) {
      const relay = await waitForPublicRelayRedundancy(
        runtime,
        "physical dealer ready"
      );
      const readyAt = new Date().toISOString();
      const ready = {
        event: "physical-dealer-ready",
        device: os.hostname(),
        readyAt,
        sourceCommit,
        deploymentId: market.deploymentId,
        coordinationDomain: market.coordinationDomain,
        dealerAddress: wallets.dealer.address.toLowerCase(),
        relay,
        dataDirectory: runRoot,
      };
      process.stdout.write(`${JSON.stringify(ready, null, 2)}\n`);
      const signal = await waitForShutdownSignal();
      results.push({
        scenario: "physical-dealer-public-waku",
        device: os.hostname(),
        readyAt,
        stoppedBy: signal,
        dealerAddress: wallets.dealer.address.toLowerCase(),
        relay,
      });
    } else {
      const sdk = createSdk({ runtime, market, wallets, dataDirectory: runRoot });
      if (process.argv.includes("--x402")) {
        results.push(...await runGenericX402({
          repositoryRoot,
          identityRoot,
          runRoot,
          market,
          runtime,
          cohort,
          wallets,
          identityPassword,
        }));
      } else if (process.argv.includes("--zero-destination-gas")) {
        results.push(...await runZeroDestinationGas({
          market,
          runtime,
          cohort,
          wallets,
          price,
          sdk,
        }));
      } else if (process.argv.includes("--timeout-refund")) {
        results.push(...await runTimeoutRefund({ market, cohort, wallets }));
      } else if (process.argv.includes("--relay-reconnect")) {
        results.push(...await (physicalRequester
          ? runPublicRelayReconnect({ market, runtime, wallets, price, sdk })
          : runRelayReconnect({ market, runtime, bus, wallets, price, sdk })));
      } else if (process.argv.includes("--stale-price")) {
        results.push(...await runStalePrice({
          market,
          runtime,
          cohort,
          wallets,
          price,
          sdk,
        }));
      } else if (process.argv.includes("--stale-rpc")) {
        results.push(...await runStaleRpc({
          market,
          cohort,
          wallets,
          environment,
        }));
      } else if (process.argv.includes("--restart-mid-swap")) {
        const restarted = await runRestartMidSwap({
          runRoot,
          market,
          runtime,
          cohort,
          bus,
          wallets,
          price,
          sdk,
        });
        runtime = restarted.runtime;
        results.push(...restarted.results);
      } else {
        const only = process.argv.find(
          (argument) => argument.startsWith("--route=")
        );
        const routes = only
          ? market.routes.filter((route) => route.routeId === only.slice(8))
          : market.routes;
        assert(routes.length > 0, "selected route is not in the frozen market");
        for (const [index, route] of routes.entries()) {
          process.stderr.write(
            `[${index + 1}/${routes.length}] ${route.input.symbol}/${route.input.chainId} -> ${route.output.symbol}/${route.output.chainId}\n`
          );
          results.push(await executeRoute({
            route,
            runtime,
            sdk,
            wallets,
            price,
          }));
        }
      }
    }
    if (runtime.exposureJournal) {
      await waitUntil(
        () => runtime.exposureJournal.activeTrades().length === 0,
        { label: "all dealer exposures to settle" }
      );
    }
    if (publicWaku) {
      finalRelay = await waitForPublicRelayRedundancy(
        runtime,
        "final physical acceptance"
      );
    }
  } finally {
    runtime.removeAllListeners("error");
    await runtime.close().catch(() => {});
  }
  const twoDevice = physicalDealer || physicalRequester;
  const evidence = {
    schema: twoDevice
      ? "versus-fx-public-testnet-two-device-acceptance"
      : "versus-fx-public-testnet-single-workstation-acceptance",
    schemaVersion: 1,
    completedAt: new Date().toISOString(),
    device: os.hostname(),
    sourceCommit,
    scope: physicalDealer
      ? "independent-physical-dealer-public-waku"
      : physicalRequester
        ? "independent-physical-requester-public-waku"
        : "single-workstation-real-chain-in-process-waku",
    deploymentId: market.deploymentId,
    coordinationDomain: market.coordinationDomain,
    routesExpected: process.argv.includes("--x402")
      ? 4
      : physicalDealer
        ? 1
      : process.argv.includes("--zero-destination-gas") ||
          process.argv.includes("--timeout-refund")
        ? 2
      : process.argv.includes("--relay-reconnect")
        ? 1
      : process.argv.includes("--stale-price") ||
          process.argv.includes("--stale-rpc") ||
          process.argv.includes("--restart-mid-swap")
        ? 1
      : process.argv.some((argument) => argument.startsWith("--route="))
      ? results.length
      : 30,
    routesCompleted: results.length,
    relay: finalRelay,
    results,
  };
  const evidencePath = path.join(runRoot, "evidence.json");
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify({ ...evidence, evidencePath }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  PHYSICAL_ACCEPTANCE_GUARD,
  assertPublicRelayRedundancy,
  forcePublicRelayReconnect,
  identityDirectory,
  publicTransportEvidence,
};
