const fs = require("node:fs");
const path = require("node:path");
const {
  Contract,
  JsonRpcProvider,
  Wallet,
} = require("ethers");
const {
  FxPhase5Coordinator,
} = require("../../../packages/network/src/fx-phase5-coordinator");
const {
  FxPhase5Journal,
} = require("../../../packages/network/src/fx-phase5-journal");
const { NETWORKS } = require("./phase5-testnet-config");

const SCENARIOS = new Set([
  "success-base-to-arbitrum",
  "success-arbitrum-to-base",
  "dealer-disappears",
  "requester-disappears",
]);
const TOKEN_ABI = [
  "function balanceOf(address) view returns (uint256)",
];
let releaseExecutionLock = () => {};

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireExecutionLock(directory, scenario) {
  const lockPath = path.join(directory, ".execution.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(
        descriptor,
        `${JSON.stringify({
          pid: process.pid,
          scenario,
          startedAt: new Date().toISOString(),
        })}\n`
      );
      fs.closeSync(descriptor);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          fs.unlinkSync(lockPath);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST" || attempt > 0) throw error;
      let owner = null;
      try {
        owner = readJson(lockPath);
      } catch {
        throw new Error(
          `Phase 5 execution lock is unreadable: ${lockPath}`
        );
      }
      if (processIsAlive(Number(owner.pid))) {
        throw new Error(
          `Phase 5 scenario ${owner.scenario || "unknown"} is already ` +
          `running under PID ${owner.pid}`
        );
      }
      fs.unlinkSync(lockPath);
    }
  }
  throw new Error("could not acquire Phase 5 execution lock");
}

async function decryptIdentities(directory) {
  const password = fs
    .readFileSync(path.join(directory, "identity-password.txt"), "utf8")
    .trim();
  const identities = {};
  for (const role of ["requester", "dealer", "relayer"]) {
    identities[role] = await Wallet.fromEncryptedJson(
      fs.readFileSync(
        path.join(directory, `${role}.keystore.json`),
        "utf8"
      ),
      password
    );
  }
  return identities;
}

function providerFor(network) {
  const rpcUrl =
    process.env[network.rpcEnvironmentVariable] || network.publicRpcUrl;
  return new JsonRpcProvider(rpcUrl, BigInt(network.chainId), {
    staticNetwork: true,
    cacheTimeout: -1,
  });
}

function providersForRoute(route, providersByChain) {
  return {
    source: providersByChain.get(route.source.chainId),
    destination: providersByChain.get(route.destination.chainId),
  };
}

function signerSet(provider, identities) {
  return {
    requester: identities.requester.connect(provider),
    dealer: identities.dealer.connect(provider),
    relayer: identities.relayer.connect(provider),
  };
}

function makeCoordinator({
  route,
  manifest,
  journal,
  providers,
  identities,
  recoveryDirectory,
}) {
  return new FxPhase5Coordinator({
    route,
    manifest,
    journal,
    providers,
    signers: {
      source: signerSet(providers.source, identities),
      destination: signerSet(providers.destination, identities),
    },
    recoveryDirectory,
    maximumNativeFeeByChain: Object.fromEntries(
      Object.values(NETWORKS).map((network) => [
        network.chainId,
        BigInt(network.maximumActionFeeWei),
      ])
    ),
    receiptTimeoutMs: 180_000,
  });
}

async function waitUntil(provider, timestamp, label) {
  for (;;) {
    const block = await provider.getBlock("latest");
    const remaining = Number(timestamp) - Number(block.timestamp);
    if (remaining <= 0) return;
    process.stdout.write(
      `${label}: ${remaining}s until refund eligibility at block ${block.number}\n`
    );
    await sleep(Math.min(12_000, Math.max(2_000, remaining * 1000)));
  }
}

async function balances(route, providers, addresses) {
  const output = {};
  for (const side of ["source", "destination"]) {
    const token = new Contract(
      route[side].tokenAddress,
      TOKEN_ABI,
      providers[side]
    );
    output[side] = {};
    for (const [role, address] of Object.entries(addresses)) {
      output[side][role] = (await token.balanceOf(address)).toString();
    }
  }
  return output;
}

function actionEvidence(trade) {
  return Object.fromEntries(
    trade.actions.map((action) => [
      action.slot,
      {
        chainId: action.chainId,
        transactionHash: action.transactionHash,
        state: action.state,
        blockNumber: action.receipt?.blockNumber || null,
        gasUsed: action.receipt?.gasUsed || null,
        gasPrice: action.receipt?.gasPrice || null,
      },
    ])
  );
}

function recoveryTradeId(recoveryDirectory) {
  const recoveryFiles = fs
    .readdirSync(recoveryDirectory)
    .filter((name) => /^[0-9a-f]{64}\.recovery\.json$/i.test(name));
  if (recoveryFiles.length !== 1) {
    throw new Error(
      `expected one recovery packet, found ${recoveryFiles.length}`
    );
  }
  return `0x${recoveryFiles[0].slice(0, 64).toLowerCase()}`;
}

async function main() {
  const repositoryRoot = path.resolve(__dirname, "..", "..", "..");
  const directory = path.resolve(
    process.env.FX_PHASE5_IDENTITY_DIRECTORY ||
      path.join(repositoryRoot, ".local", "fx-phase5-testnet")
  );
  const scenario = process.env.FX_PHASE5_SCENARIO;
  if (!SCENARIOS.has(scenario)) {
    throw new Error(
      `FX_PHASE5_SCENARIO must be one of ${[...SCENARIOS].join(", ")}`
    );
  }
  releaseExecutionLock = acquireExecutionLock(directory, scenario);
  const bundle = readJson(
    path.join(directory, "phase5-testnet-routes.json")
  );
  const route = scenario === "success-arbitrum-to-base"
    ? bundle.routes.arbitrumToBase
    : bundle.routes.baseToArbitrum;
  const identities = await decryptIdentities(directory);
  const publicIdentities = readJson(
    path.join(directory, "identities.public.json")
  ).identities;
  const providersByChain = new Map(
    Object.values(NETWORKS).map((network) => [
      network.chainId,
      providerFor(network),
    ])
  );
  const providers = providersForRoute(route, providersByChain);
  const resumeDirectory = process.env.FX_PHASE5_RESUME_RUN_DIRECTORY;
  const runDirectory = resumeDirectory
    ? path.resolve(resumeDirectory)
    : path.join(
      directory,
      "testnet-runs",
      `${scenario}-${new Date().toISOString().replaceAll(":", "-")}`
    );
  if (
    resumeDirectory &&
    path.dirname(runDirectory) !== path.join(directory, "testnet-runs")
  ) {
    throw new Error("resume directory must belong to the Phase 5 testnet runs");
  }
  const recoveryDirectory = path.join(runDirectory, "recovery");
  if (resumeDirectory && !fs.existsSync(recoveryDirectory)) {
    throw new Error("resume directory has no recovery packet directory");
  }
  fs.mkdirSync(recoveryDirectory, { recursive: true, mode: 0o700 });
  const journalPath = path.join(runDirectory, "journal.sqlite");
  if (resumeDirectory && !fs.existsSync(journalPath)) {
    throw new Error("resume directory has no durable journal");
  }
  const recoveryPassword = fs
    .readFileSync(path.join(directory, "identity-password.txt"), "utf8")
    .trim();
  let journal = new FxPhase5Journal({
    filePath: journalPath,
    encryptionSecret: recoveryPassword,
  });
  let runner = makeCoordinator({
    route,
    manifest: bundle.manifest,
    journal,
    providers,
    identities,
    recoveryDirectory,
  });
  const preflight = await runner.preflight();
  const before = await balances(route, providers, publicIdentities);
  const prepared = resumeDirectory
    ? await runner.prepareTrade({
      tradeId: recoveryTradeId(recoveryDirectory),
      recoveryPassword,
    })
    : await runner.prepareTrade({ recoveryPassword });
  if (!prepared.ownerApproved) {
    runner.approveFromOwnerUi(prepared.tradeId, true);
  }
  await runner.reconcile(prepared.tradeId);
  const startedAt = prepared.createdAt * 1000;

  async function restart() {
    journal.close();
    journal = new FxPhase5Journal({
      filePath: journalPath,
      encryptionSecret: recoveryPassword,
    });
    runner = makeCoordinator({
      route,
      manifest: bundle.manifest,
      journal,
      providers,
      identities,
      recoveryDirectory,
    });
    await runner.reconcile(prepared.tradeId);
  }

  let current = journal.trade(prepared.tradeId);
  if (current.state === "owner_approved") {
    await runner.fundSource(prepared.tradeId, recoveryPassword);
    await restart();
    current = journal.trade(prepared.tradeId);
  }
  if (scenario === "dealer-disappears") {
    if (current.state === "source_funded") {
      await waitUntil(
        providers.source,
        current.route.sourceRefundTimestamp,
        "source"
      );
      await runner.refundSource(prepared.tradeId);
    } else if (current.state !== "refunded") {
      throw new Error(
        `dealer-disappears cannot resume from ${current.state}`
      );
    }
  } else {
    if (current.state === "source_funded") {
      await runner.fundDestination(prepared.tradeId);
      await restart();
      current = journal.trade(prepared.tradeId);
    }
    if (scenario === "requester-disappears") {
      if (current.state === "destination_funded") {
        await waitUntil(
          providers.destination,
          current.route.destinationRefundTimestamp,
          "destination"
        );
        await runner.refundDestination(prepared.tradeId);
        await restart();
        current = journal.trade(prepared.tradeId);
      }
      if (current.state === "destination_refunded") {
        await waitUntil(
          providers.source,
          current.route.sourceRefundTimestamp,
          "source"
        );
        await runner.refundSource(prepared.tradeId);
      } else if (current.state !== "refunded") {
        throw new Error(
          `requester-disappears cannot resume from ${current.state}`
        );
      }
    } else {
      if (current.state === "destination_funded") {
        await runner.claimDestination(prepared.tradeId, recoveryPassword);
        await restart();
        current = journal.trade(prepared.tradeId);
      }
      if (current.state === "destination_claimed") {
        await runner.extractPublishedSecret(prepared.tradeId);
        await runner.claimSource(prepared.tradeId);
      } else if (current.state !== "completed") {
        throw new Error(`success scenario cannot resume from ${current.state}`);
      }
    }
  }

  const terminal = journal.trade(prepared.tradeId);
  const after = await balances(route, providers, publicIdentities);
  const evidence = {
    schema: "versus-fx-phase5-testnet-scenario-evidence",
    schemaVersion: 1,
    environment: "public-testnet",
    productionWaku: false,
    productionFunds: false,
    scenario,
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    routeId: route.routeId,
    tradeId: terminal.tradeId,
    direction: `${route.source.chainId}->${route.destination.chainId}`,
    state: terminal.state,
    preflight: {
      source: {
        chainId: preflight.source.chainId,
        adapterAddress: preflight.source.adapterAddress,
      },
      destination: {
        chainId: preflight.destination.chainId,
        adapterAddress: preflight.destination.adapterAddress,
      },
    },
    balances: { before, after },
    actions: actionEvidence(terminal),
    recovery: {
      packetPersistedBeforeFirstBroadcast: true,
      coordinatorRestartedBetweenSteps: true,
      resumedExistingRun: Boolean(resumeDirectory),
    },
  };
  const serialized = JSON.stringify(evidence).toLowerCase();
  if (
    serialized.includes("rawtransaction") ||
    serialized.includes(recoveryPassword.toLowerCase())
  ) {
    throw new Error("public evidence contains sensitive recovery material");
  }
  const evidencePath = path.join(runDirectory, "evidence.json");
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  journal.close();
  console.log(
    JSON.stringify(
      {
        evidencePath,
        scenario,
        state: terminal.state,
        actions: Object.keys(evidence.actions).length,
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    releaseExecutionLock();
  });
