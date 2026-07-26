const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { JsonRpcProvider, Wallet, hexlify, keccak256, randomBytes } = require("ethers");
const {
  FxCoordinationSession,
  FxDeterministicDealer,
  FxPhase5Coordinator,
  FxPhase5Journal,
  FxRequesterBroker,
  FxTradeJournal,
  FxWakuTransport,
} = require("../../../packages/network/src");
const { NETWORKS } = require("./phase5-testnet-config");

const BOOTSTRAPS = [
  "/dns4/relay-a.versuscypher.com/tcp/443/wss/p2p/16Uiu2HAmCQArrt8ND7sTzPCg76YmQPab7HKjSrVZeyeTVZdQyPWy",
  "/dns4/relay-b.versuscypher.com/tcp/443/wss/p2p/16Uiu2HAkx96y18XpzAybpmi1zzdMQZFvsRPZfkku8R9T4KJFMr2P",
];

function waitFor(emitter, event, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
    emitter.once(event, (...args) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

function sourceState(repositoryRoot) {
  const run = (...args) => execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const differs = (args) => {
    try {
      execFileSync("git", args, {
        cwd: repositoryRoot,
        stdio: "ignore",
      });
      return false;
    } catch (_) {
      return true;
    }
  };
  const implementationPaths = [
    "packages/network/scripts/fx-phase6-headless.js",
    "packages/network/src/fx-coordination.js",
    "packages/network/src/fx-ephemeral-identity.js",
    "packages/network/src/fx-journal.js",
    "packages/network/src/fx-phase6-runners.js",
    "packages/network/src/fx-waku-transport.js",
    "versus/scripts/fx/run-phase6-public-waku-smoke.js",
  ];
  const workingTreeDirty = differs(["diff", "--quiet"]) ||
    differs(["diff", "--cached", "--quiet"]);
  const phase6ImplementationDirty = differs([
    "diff",
    "--quiet",
    "HEAD",
    "--",
    ...implementationPaths,
  ]);
  return {
    commit: run("rev-parse", "HEAD"),
    branch: run("branch", "--show-current"),
    workingTreeDirty,
    phase6ImplementationDirty,
    protocolVersion: 1,
  };
}

function bootstrapPeers() {
  return String(process.env.FX_PHASE6_WAKU_PEERS || BOOTSTRAPS.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function transport(deploymentId, peers) {
  return new FxWakuTransport({
    deploymentId,
    bootstrapPeers: peers,
    peerTimeoutMs: 30_000,
    storeHistoryMs: 15 * 60 * 1000,
    storeMessageLimit: 512,
  });
}

function providerFor(chainId) {
  const network = Object.values(NETWORKS).find((candidate) => candidate.chainId === String(chainId));
  if (!network) throw new Error(`unsupported Phase 5 chain ${chainId}`);
  return new JsonRpcProvider(
    process.env[network.rpcEnvironmentVariable] || network.publicRpcUrl,
    BigInt(network.chainId),
    { staticNetwork: true, cacheTimeout: -1 }
  );
}

async function identity(directory, role, password) {
  return Wallet.fromEncryptedJson(
    fs.readFileSync(path.join(directory, `${role}.keystore.json`), "utf8"),
    password
  );
}

async function main() {
  const repositoryRoot = path.resolve(__dirname, "..", "..", "..");
  const identityDirectory = path.resolve(
    process.env.FX_PHASE5_IDENTITY_DIRECTORY ||
      path.join(repositoryRoot, ".local", "fx-phase5-testnet")
  );
  const bundle = JSON.parse(
    fs.readFileSync(path.join(identityDirectory, "phase5-testnet-routes.json"), "utf8")
  );
  const password = fs.readFileSync(
    path.join(identityDirectory, "identity-password.txt"),
    "utf8"
  ).trim();
  const [requesterWallet, dealerWallet, relayerWallet] = await Promise.all([
    identity(identityDirectory, "requester", password),
    identity(identityDirectory, "dealer", password),
    identity(identityDirectory, "relayer", password),
  ]);
  const requesterCoordinationWallet = Wallet.createRandom();
  const dealerCoordinationWallet = Wallet.createRandom();
  const peers = bootstrapPeers();
  if (peers.length < 1) throw new Error("Phase 6 smoke requires at least one Waku bootstrap peer");
  const runDirectory = path.join(
    identityDirectory,
    "phase6-waku-runs",
    new Date().toISOString().replaceAll(":", "-")
  );
  fs.mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  const requesterJournal = new FxTradeJournal({
    filePath: path.join(runDirectory, "requester.sqlite"),
    deploymentId: bundle.deploymentId,
  });
  const dealerJournal = new FxTradeJournal({
    filePath: path.join(runDirectory, "dealer.sqlite"),
    deploymentId: bundle.deploymentId,
  });
  const requesterSession = new FxCoordinationSession({
    deploymentId: bundle.deploymentId,
    signer: requesterCoordinationWallet,
    role: "requester",
    journal: requesterJournal,
    transport: transport(bundle.deploymentId, peers),
  });
  const dealerSession = new FxCoordinationSession({
    deploymentId: bundle.deploymentId,
    signer: dealerCoordinationWallet,
    role: "dealer",
    journal: dealerJournal,
    transport: transport(bundle.deploymentId, peers),
  });
  const requester = new FxRequesterBroker({
    session: requesterSession,
    observationWindowMs: 2_000,
  });
  const route = bundle.routes.baseToArbitrum;
  const dealer = new FxDeterministicDealer({
    session: dealerSession,
    sourceClaimAddress: dealerWallet.address,
    destinationRefundAddress: dealerWallet.address,
    observationWindowMs: 2_000,
    quotePolicy: async (rfq) => ({
      inputChainId: route.source.chainId,
      inputToken: route.source.tokenAddress,
      inputAmountAtomic: route.inputAmountAtomic,
      referenceSource: "phase6:public-testnet-manifest",
      referencePriceMicros: "1000000",
      referenceTimestamp: Math.floor(Date.now() / 1000),
      spreadBps: 0,
      dealerSettlementCostAtomic: "0",
      estimatedCompletionSeconds: 60,
      adapterId: "evm-htlc-v1",
      adapterVersion: 1,
    }),
  });
  const events = [];
  const record = (actor, event) => (envelope, metadata = {}) => {
    const observedAtMs = Date.now();
    events.push({
      at: new Date(observedAtMs).toISOString(),
      actor,
      event,
      id: envelope?.id || null,
      type: envelope?.type || null,
      tradeId: envelope?.tradeId || null,
      sender: envelope?.sender || null,
      history: Boolean(metadata.history),
      local: Boolean(metadata.local),
      recoveredDependency: Boolean(metadata.recoveredDependency),
      propagationLatencyMs: envelope?.createdAt
        ? Math.max(0, observedAtMs - envelope.createdAt * 1000)
        : null,
    });
  };
  requesterSession.on("accepted", record("requester", "accepted"));
  dealerSession.on("accepted", record("dealer", "accepted"));
  const startedAt = Date.now();
  let rfq;
  let chainSettlement = null;
  try {
    await requester.start();
    rfq = await requester.openRfq({
      tradeId: hexlify(randomBytes(32)),
      payload: {
        outputChainId: route.destination.chainId,
        outputToken: route.destination.tokenAddress,
        outputAmountAtomic: route.outputAmountAtomic,
        inputOptions: [{
          chainId: route.source.chainId,
          token: route.source.tokenAddress,
          maxInputAtomic: (BigInt(route.inputAmountAtomic) + 1_000n).toString(),
        }],
        settlementDeadline: Math.floor(Date.now() / 1000) + 3600,
        quotePolicy: "lowest_all_in",
        x402Commitment: null,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const quoteReady = waitFor(requester, "quote");
    await dealer.start();
    await quoteReady;
    const selected = requester.selectRoute(rfq.tradeId);
    if (
      selected.dealer !== dealerCoordinationWallet.address.toLowerCase()
    ) {
      throw new Error(
        `Phase 6 selected an unexpected dealer ${selected.dealer}`
      );
    }
    const reserved = waitFor(requester, "reserved");
    const secret = randomBytes(32);
    await requester.accept({
      tradeId: rfq.tradeId,
      route: selected,
      secretHash: keccak256(secret),
      sourceRefundAddress: requesterWallet.address,
      destinationClaimAddress: requesterWallet.address,
    });
    await reserved;
    const requesterSnapshot = requesterJournal.snapshot(rfq.tradeId);
    const dealerSnapshot = dealerJournal.snapshot(rfq.tradeId);
    const currentTradeEvents = events.filter(
      (event) => event.tradeId === rfq.tradeId
    );
    const storeRecoveryExercised = events.some(
      (event) =>
        event.tradeId === rfq.tradeId &&
        event.actor === "dealer" &&
        event.type === "fx_rfq" &&
        event.history
    );
    if (!storeRecoveryExercised) {
      throw new Error("Phase 6 dealer did not recover the RFQ through Waku Store");
    }
    if (requesterSnapshot.stateHash !== dealerSnapshot.stateHash) {
      throw new Error("Phase 6 journals diverged before settlement");
    }
    const requesterTransportEvidence = requesterSession.transport.status();
    const dealerTransportEvidence = dealerSession.transport.status();
    if (process.env.FX_PHASE6_SETTLE === "1") {
      await Promise.all([requester.close(), dealer.close()]);
      const providers = {
        source: providerFor(route.source.chainId),
        destination: providerFor(route.destination.chainId),
      };
      const signers = Object.fromEntries(["source", "destination"].map((side) => [
        side,
        {
          requester: requesterWallet.connect(providers[side]),
          dealer: dealerWallet.connect(providers[side]),
          relayer: relayerWallet.connect(providers[side]),
        },
      ]));
      const settlementJournal = new FxPhase5Journal({
        filePath: path.join(runDirectory, "settlement.sqlite"),
        encryptionSecret: password,
      });
      const coordinator = new FxPhase5Coordinator({
        route,
        manifest: bundle.manifest,
        journal: settlementJournal,
        providers,
        signers,
        recoveryDirectory: path.join(runDirectory, "recovery"),
        maximumNativeFeeByChain: Object.fromEntries(
          Object.values(NETWORKS).map((network) => [
            network.chainId,
            BigInt(network.maximumActionFeeWei),
          ])
        ),
        receiptTimeoutMs: 180_000,
      });
      try {
        const preflight = await coordinator.preflight();
        const prepared = await coordinator.prepareTrade({
          tradeId: rfq.tradeId,
          recoveryPassword: password,
          secret,
        });
        coordinator.approveFromOwnerUi(prepared.tradeId, true);
        await coordinator.fundSource(prepared.tradeId, password);
        await coordinator.fundDestination(prepared.tradeId);
        await coordinator.claimDestination(prepared.tradeId, password);
        await coordinator.extractPublishedSecret(prepared.tradeId);
        await coordinator.claimSource(prepared.tradeId);
        const terminal = settlementJournal.trade(prepared.tradeId);
        chainSettlement = {
          wakuClosedBeforeSettlement: true,
          state: terminal.state,
          preflight: Object.fromEntries(Object.entries(preflight).map(([side, value]) => [
            side,
            {
              chainId: value.chainId,
              adapterAddress: value.adapterAddress,
              assetAddress: value.assetAddress,
            },
          ])),
          actions: terminal.actions.map((action) => ({
            slot: action.slot,
            chainId: action.chainId,
            transactionHash: action.transactionHash,
            state: action.state,
            blockNumber: action.receipt?.blockNumber || null,
          })),
        };
        if (terminal.state !== "completed") {
          throw new Error(`Phase 6 chain settlement ended in ${terminal.state}`);
        }
      } finally {
        settlementJournal.close();
      }
    }
    const report = {
      schema: "versus-fx-phase6-public-waku-smoke",
      schemaVersion: 1,
      source: sourceState(repositoryRoot),
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      deploymentId: bundle.deploymentId,
      tradeId: rfq.tradeId,
      testnetFundsOnly: true,
      productionWaku: true,
      configuredBootstrapPeers: peers.map((peer) => {
        const match = peer.match(/\/dns4\/([^/]+)/);
        return match ? match[1] : "non-dns-bootstrap";
      }),
      ephemeralCoordinationIdentities: true,
      requesterCoordinationAddress: requesterCoordinationWallet.address.toLowerCase(),
      dealerCoordinationAddress: dealerCoordinationWallet.address.toLowerCase(),
      selectedDealerCoordinationAddress: selected.dealer,
      requesterSettlementAddress: requesterWallet.address.toLowerCase(),
      dealerSettlementAddress: dealerWallet.address.toLowerCase(),
      storeRecoveryExercised,
      requesterStateHash: requesterSnapshot.stateHash,
      dealerStateHash: dealerSnapshot.stateHash,
      stateHashesMatch: requesterSnapshot.stateHash === dealerSnapshot.stateHash,
      chainSettlement,
      requesterTransport: requesterTransportEvidence,
      dealerTransport: dealerTransportEvidence,
      events: currentTradeEvents,
      latency: {
        observedMessages: currentTradeEvents.filter(
          (event) => event.propagationLatencyMs !== null
        ).length,
        maximumPropagationLatencyMs: Math.max(
          0,
          ...currentTradeEvents.map((event) => event.propagationLatencyMs || 0)
        ),
      },
    };
    const reportPath = path.join(runDirectory, "report.json");
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    process.stdout.write(`${JSON.stringify({ reportPath, ...report }, null, 2)}\n`);
  } finally {
    await Promise.allSettled([requester.close(), dealer.close()]);
    requesterJournal.close();
    dealerJournal.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
