const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  Contract,
  ContractFactory,
  HDNodeWallet,
  JsonRpcProvider,
  keccak256,
  toUtf8Bytes,
} = require("ethers");
const {
  FxPhase5Coordinator,
} = require("../../../packages/network/src/fx-phase5-coordinator");
const {
  FxPhase5Journal,
} = require("../../../packages/network/src/fx-phase5-journal");
const {
  validatePhase5Route,
} = require("../../../packages/network/src/fx-phase5-route");
const { buildFreezeRecord } = require("./build-freeze");

const MNEMONIC = "test test test test test test test test test test test junk";
const CHAIN_A = Object.freeze({
  chainId: "31337",
  name: "Phase 5 Local A",
  port: 18545,
  rpcEnvironmentVariable: "FX_PHASE5_LOCAL_A_RPC_URL",
});
const CHAIN_B = Object.freeze({
  chainId: "31338",
  name: "Phase 5 Local B",
  port: 18546,
  rpcEnvironmentVariable: "FX_PHASE5_LOCAL_B_RPC_URL",
});
const TOKEN_DECIMALS = 6;
const MINT_AMOUNT = 100_000_000n;
const SWAP_AMOUNT = 10_000n;
const MINIMUM_LOCK_SECONDS = 60;
const MAXIMUM_LOCK_SECONDS = 7 * 24 * 60 * 60;
const MINIMUM_CROSS_CHAIN_DELTA_SECONDS = 300;
const SOURCE_LOCK_SECONDS = 600;
const DESTINATION_LOCK_SECONDS = 180;
const RECOVERY_PASSWORD = "phase5-local-recovery-only";
const TOKEN_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
const ADAPTER_ABI = [
  "function fund(bytes32,address,address,bytes32,uint64,uint256)",
  "function getLock(bytes32) view returns (tuple(address funder,address beneficiary,address refundAddress,bytes32 secretHash,uint64 refundTimestamp,uint8 state,uint256 amount))",
];

function artifact(root, source, contract) {
  return JSON.parse(
    fs.readFileSync(
      path.join(root, "artifacts", "contracts", source, `${contract}.json`),
      "utf8"
    )
  );
}

function wallet(index, provider) {
  return HDNodeWallet.fromPhrase(
    MNEMONIC,
    undefined,
    `m/44'/60'/0'/0/${index}`
  ).connect(provider);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForRpc(provider, child, label) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`${label} exited before RPC became ready`);
    }
    try {
      await provider.send("eth_chainId", []);
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`${label} RPC did not become ready`);
}

function startNode(contractsRoot, localDirectory, network) {
  const cli = path.join(
    contractsRoot,
    "node_modules",
    "hardhat",
    "internal",
    "cli",
    "cli.js"
  );
  const logPath = path.join(localDirectory, `${network.chainId}.node.log`);
  const log = fs.openSync(logPath, "w");
  const child = spawn(
    process.execPath,
    [cli, "node", "--hostname", "127.0.0.1", "--port", String(network.port)],
    {
      cwd: contractsRoot,
      env: {
        ...process.env,
        APPDATA: path.join(localDirectory, "hardhat-appdata"),
        HARDHAT_DISABLE_TELEMETRY_PROMPT: "true",
        LOCAL_CHAIN_ID: network.chainId,
      },
      stdio: ["ignore", log, log],
      windowsHide: true,
    }
  );
  child.once("exit", () => fs.closeSync(log));
  return { child, logPath };
}

async function deployChain(contractsRoot, provider, network, identities) {
  const deployer = identities.deployer.connect(provider);
  const tokenArtifact = artifact(
    contractsRoot,
    "test/MockUSDC.sol",
    "MockUSDC"
  );
  const adapterArtifact = artifact(
    contractsRoot,
    "fx/EvmHtlcV1.sol",
    "EvmHtlcV1"
  );
  const token = await new ContractFactory(
    tokenArtifact.abi,
    tokenArtifact.bytecode,
    deployer
  ).deploy();
  const tokenReceipt = await token.deploymentTransaction().wait();
  const tokenAddress = (await token.getAddress()).toLowerCase();
  const adapter = await new ContractFactory(
    adapterArtifact.abi,
    adapterArtifact.bytecode,
    deployer
  ).deploy(
    tokenAddress,
    TOKEN_DECIMALS,
    MINIMUM_LOCK_SECONDS,
    MAXIMUM_LOCK_SECONDS
  );
  const adapterReceipt = await adapter.deploymentTransaction().wait();
  const adapterAddress = (await adapter.getAddress()).toLowerCase();
  const mintReceipts = [];
  for (const role of ["requester", "dealer"]) {
    const transaction = await token.mint(identities[role].address, MINT_AMOUNT);
    const receipt = await transaction.wait();
    mintReceipts.push({
      role,
      transactionHash: receipt.hash.toLowerCase(),
      gasUsed: receipt.gasUsed.toString(),
    });
  }
  const [adapterCode, tokenCode] = await Promise.all([
    provider.getCode(adapterAddress),
    provider.getCode(tokenAddress),
  ]);
  return {
    network,
    token,
    adapter,
    tokenAddress,
    adapterAddress,
    adapterRuntimeCodeHash: keccak256(adapterCode),
    tokenRuntimeCodeHash: keccak256(tokenCode),
    evidence: {
      tokenDeployment: {
        transactionHash: tokenReceipt.hash.toLowerCase(),
        gasUsed: tokenReceipt.gasUsed.toString(),
      },
      adapterDeployment: {
        transactionHash: adapterReceipt.hash.toLowerCase(),
        gasUsed: adapterReceipt.gasUsed.toString(),
      },
      mintReceipts,
    },
  };
}

function capability(deployment) {
  return {
    chainId: deployment.network.chainId,
    adapterAddress: deployment.adapterAddress,
    runtimeCodeHash: deployment.adapterRuntimeCodeHash,
    asset: {
      address: deployment.tokenAddress,
      runtimeCodeHash: deployment.tokenRuntimeCodeHash,
      symbol: "tUSDC",
      decimals: TOKEN_DECIMALS,
      standard: "ERC20",
      features: {
        feeOnTransfer: false,
        rebasing: false,
        callbacks: false,
        issuerControls: "documented",
      },
    },
    confirmationPolicy: {
      requiredConfirmations: 1,
      reorgSafetyBlocks: 1,
    },
    timeoutPolicy: {
      minimumSeconds: MINIMUM_LOCK_SECONDS,
      maximumSeconds: MAXIMUM_LOCK_SECONDS,
      minimumCrossChainDeltaSeconds: MINIMUM_CROSS_CHAIN_DELTA_SECONDS,
    },
  };
}

function manifest(contractsRoot, deployments) {
  const freeze = buildFreezeRecord(contractsRoot);
  return {
    schema: "versus-fx-adapter-capabilities",
    schemaVersion: 1,
    adapter: {
      id: "evm-htlc",
      version: 1,
      contract: "EvmHtlcV1",
      sourcePath: "versus/contracts/fx/EvmHtlcV1.sol",
    },
    build: {
      compiler: freeze.compiler.version,
      evmVersion: freeze.compiler.evmVersion,
      sourceTag: freeze.sourceControl.tag,
      optimizerRuns: freeze.compiler.optimizer.runs,
      viaIR: freeze.compiler.viaIR,
      sourceSha256: freeze.sourceSha256,
      creationCodeHash: freeze.creationCodeHash,
    },
    capabilities: deployments.map(capability),
  };
}

function routeLeg(deployment) {
  return {
    chainId: deployment.network.chainId,
    name: deployment.network.name,
    rpcEnvironmentVariable: deployment.network.rpcEnvironmentVariable,
    explorerUrl: `http://127.0.0.1:${deployment.network.port}`,
    adapterAddress: deployment.adapterAddress,
    tokenAddress: deployment.tokenAddress,
    decimals: TOKEN_DECIMALS,
  };
}

function route(deploymentId, source, destination, identities) {
  return {
    schema: "versus-fx-phase5-route",
    schemaVersion: 1,
    environment: "local-lab",
    deploymentId,
    enabledByDefault: false,
    productionWaku: false,
    productionFunds: false,
    source: routeLeg(source),
    destination: routeLeg(destination),
    requester: identities.requester.address,
    dealer: identities.dealer.address,
    relayer: identities.relayer.address,
    inputAmountAtomic: SWAP_AMOUNT.toString(),
    outputAmountAtomic: SWAP_AMOUNT.toString(),
    sourceLockSeconds: SOURCE_LOCK_SECONDS,
    destinationLockSeconds: DESTINATION_LOCK_SECONDS,
    minimumTimeoutDeltaSeconds: MINIMUM_CROSS_CHAIN_DELTA_SECONDS,
  };
}

function signerSet(provider, identities) {
  return {
    requester: identities.requester.connect(provider),
    dealer: identities.dealer.connect(provider),
    relayer: identities.relayer.connect(provider),
  };
}

function coordinator({
  route: frozenRoute,
  manifest: frozenManifest,
  journal,
  providers,
  identities,
  recoveryDirectory,
  maximumNativeFeeByChain,
}) {
  return new FxPhase5Coordinator({
    route: frozenRoute,
    manifest: frozenManifest,
    journal,
    providers,
    signers: {
      source: signerSet(providers.sourceSignerProvider || providers.source, identities),
      destination: signerSet(
        providers.destinationSignerProvider || providers.destination,
        identities
      ),
    },
    recoveryDirectory,
    maximumNativeFeeByChain,
    receiptTimeoutMs: 15_000,
  });
}

function openJournal(directory, name) {
  return new FxPhase5Journal({
    filePath: path.join(directory, `${name}.sqlite`),
    encryptionSecret: RECOVERY_PASSWORD,
  });
}

function gasEvidence(trade) {
  return Object.fromEntries(
    trade.actions.map((action) => [
      action.slot,
      {
        chainId: action.chainId,
        transactionHash: action.transactionHash,
        state: action.state,
        gasUsed: action.receipt?.gasUsed || null,
      },
    ])
  );
}

async function advancePast(provider, timestamp) {
  const latest = await provider.getBlock("latest");
  const target = Math.max(Number(latest.timestamp) + 1, Number(timestamp) + 1);
  await provider.send("evm_setNextBlockTimestamp", [target]);
  await provider.send("evm_mine", []);
}

function stalledProvider(provider) {
  return new Proxy(provider, {
    get(target, property, receiver) {
      if (property === "estimateGas") {
        return async () => {
          throw new Error("simulated destination RPC stall");
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function runSuccessfulSwap(context, name, frozenRoute, {
  restartEveryStep = false,
} = {}) {
  const startedAt = Date.now();
  let journal = openJournal(context.localDirectory, name);
  let runner = coordinator({
    route: frozenRoute,
    manifest: context.manifest,
    journal,
    providers: context.providersFor(frozenRoute),
    identities: context.identities,
    recoveryDirectory: context.recoveryDirectory,
  });
  await runner.preflight();
  const prepared = await runner.prepareTrade({
    recoveryPassword: RECOVERY_PASSWORD,
  });
  assert.equal(prepared.actions.length, 0);
  assert.equal(fs.existsSync(prepared.recoveryFile), true);
  runner.approveFromOwnerUi(prepared.tradeId, true);

  async function restart() {
    if (!restartEveryStep) return;
    journal.close();
    journal = openJournal(context.localDirectory, name);
    runner = coordinator({
      route: frozenRoute,
      manifest: context.manifest,
      journal,
      providers: context.providersFor(frozenRoute),
      identities: context.identities,
      recoveryDirectory: context.recoveryDirectory,
    });
    await runner.reconcile(prepared.tradeId);
  }

  await runner.fundSource(prepared.tradeId, RECOVERY_PASSWORD);
  await restart();
  await runner.fundDestination(prepared.tradeId);
  await restart();
  await runner.claimDestination(prepared.tradeId, RECOVERY_PASSWORD);
  await restart();
  const publishedSecret = await runner.extractPublishedSecret(prepared.tradeId);
  assert.equal(keccak256(publishedSecret), journal.trade(prepared.tradeId).secretHash);
  await runner.claimSource(prepared.tradeId);
  const completed = journal.trade(prepared.tradeId);
  assert.equal(completed.state, "completed");
  journal.close();
  return {
    name,
    direction: `${frozenRoute.source.chainId}->${frozenRoute.destination.chainId}`,
    state: completed.state,
    elapsedMs: Date.now() - startedAt,
    restartEveryStep,
    recoveryPersistedBeforeBroadcast: true,
    publishedSecretHashMatched: true,
    actions: gasEvidence(completed),
  };
}

async function runDealerDisappears(context, frozenRoute) {
  const name = "dealer-disappears-after-source";
  const journal = openJournal(context.localDirectory, name);
  const providers = context.providersFor(frozenRoute);
  const runner = coordinator({
    route: frozenRoute,
    manifest: context.manifest,
    journal,
    providers,
    identities: context.identities,
    recoveryDirectory: context.recoveryDirectory,
  });
  const prepared = await runner.prepareTrade({ recoveryPassword: RECOVERY_PASSWORD });
  runner.approveFromOwnerUi(prepared.tradeId, true);
  const funded = await runner.fundSource(prepared.tradeId, RECOVERY_PASSWORD);
  await advancePast(providers.source, funded.route.sourceRefundTimestamp);
  const refunded = await runner.refundSource(prepared.tradeId);
  assert.equal(refunded.state, "refunded");
  journal.close();
  return {
    name,
    state: refunded.state,
    actions: gasEvidence(refunded),
  };
}

async function runRequesterDisappears(context, frozenRoute) {
  const name = "requester-disappears-after-destination";
  const journal = openJournal(context.localDirectory, name);
  const providers = context.providersFor(frozenRoute);
  const runner = coordinator({
    route: frozenRoute,
    manifest: context.manifest,
    journal,
    providers,
    identities: context.identities,
    recoveryDirectory: context.recoveryDirectory,
  });
  const prepared = await runner.prepareTrade({ recoveryPassword: RECOVERY_PASSWORD });
  runner.approveFromOwnerUi(prepared.tradeId, true);
  await runner.fundSource(prepared.tradeId, RECOVERY_PASSWORD);
  const funded = await runner.fundDestination(prepared.tradeId);
  await advancePast(
    providers.destination,
    funded.route.destinationRefundTimestamp
  );
  await runner.refundDestination(prepared.tradeId);
  await advancePast(providers.source, funded.route.sourceRefundTimestamp);
  const refunded = await runner.refundSource(prepared.tradeId);
  assert.equal(refunded.state, "refunded");
  journal.close();
  return {
    name,
    state: refunded.state,
    actions: gasEvidence(refunded),
  };
}

async function runDestinationStall(context, frozenRoute) {
  const name = "destination-rpc-stalls";
  const journal = openJournal(context.localDirectory, name);
  const normalProviders = context.providersFor(frozenRoute);
  let runner = coordinator({
    route: frozenRoute,
    manifest: context.manifest,
    journal,
    providers: normalProviders,
    identities: context.identities,
    recoveryDirectory: context.recoveryDirectory,
  });
  const prepared = await runner.prepareTrade({ recoveryPassword: RECOVERY_PASSWORD });
  runner.approveFromOwnerUi(prepared.tradeId, true);
  const funded = await runner.fundSource(prepared.tradeId, RECOVERY_PASSWORD);
  const failingProviders = {
    ...normalProviders,
    destination: stalledProvider(normalProviders.destination),
    destinationSignerProvider: normalProviders.destination,
  };
  runner = coordinator({
    route: frozenRoute,
    manifest: context.manifest,
    journal,
    providers: failingProviders,
    identities: context.identities,
    recoveryDirectory: context.recoveryDirectory,
  });
  await assert.rejects(
    () => runner.fundDestination(prepared.tradeId),
    /simulated destination RPC stall/
  );
  assert.equal(
    journal.action(prepared.tradeId, "destination_approval"),
    null
  );
  runner = coordinator({
    route: frozenRoute,
    manifest: context.manifest,
    journal,
    providers: normalProviders,
    identities: context.identities,
    recoveryDirectory: context.recoveryDirectory,
  });
  await advancePast(normalProviders.source, funded.route.sourceRefundTimestamp);
  const refunded = await runner.refundSource(prepared.tradeId);
  journal.close();
  return {
    name,
    state: refunded.state,
    signedDestinationTransaction: false,
    actions: gasEvidence(refunded),
  };
}

async function runFeeSpike(context, frozenRoute) {
  const name = "fee-spike";
  const journal = openJournal(context.localDirectory, name);
  const providers = context.providersFor(frozenRoute);
  const runner = coordinator({
    route: frozenRoute,
    manifest: context.manifest,
    journal,
    providers,
    identities: context.identities,
    recoveryDirectory: context.recoveryDirectory,
    maximumNativeFeeByChain: {
      [frozenRoute.source.chainId]: 1n,
      [frozenRoute.destination.chainId]: 1n,
    },
  });
  const prepared = await runner.prepareTrade({ recoveryPassword: RECOVERY_PASSWORD });
  runner.approveFromOwnerUi(prepared.tradeId, true);
  await assert.rejects(
    () => runner.fundSource(prepared.tradeId, RECOVERY_PASSWORD),
    (error) => error?.code === "FEE_LIMIT"
  );
  assert.equal(journal.trade(prepared.tradeId).actions.length, 0);
  journal.close();
  return {
    name,
    state: "blocked-before-signing",
    actionCount: 0,
  };
}

async function runWrongLock(context, frozenRoute) {
  const name = "wrong-lock-fields";
  const journal = openJournal(context.localDirectory, name);
  const providers = context.providersFor(frozenRoute);
  const runner = coordinator({
    route: frozenRoute,
    manifest: context.manifest,
    journal,
    providers,
    identities: context.identities,
    recoveryDirectory: context.recoveryDirectory,
  });
  const prepared = await runner.prepareTrade({ recoveryPassword: RECOVERY_PASSWORD });
  runner.approveFromOwnerUi(prepared.tradeId, true);
  const requester = context.identities.requester.connect(providers.source);
  const token = new Contract(
    prepared.route.source.tokenAddress,
    TOKEN_ABI,
    requester
  );
  await (
    await token.approve(prepared.route.source.adapterAddress, SWAP_AMOUNT)
  ).wait();
  const adapter = new Contract(
    prepared.route.source.adapterAddress,
    ADAPTER_ABI,
    requester
  );
  await (
    await adapter.fund(
      prepared.route.sourceLockId,
      context.identities.relayer.address,
      context.identities.requester.address,
      prepared.secretHash,
      prepared.route.sourceRefundTimestamp,
      SWAP_AMOUNT
    )
  ).wait();
  await assert.rejects(
    () => runner.observeLock(prepared.tradeId, "source"),
    (error) => error?.code === "LOCK_MISMATCH"
  );
  journal.close();
  return {
    name,
    state: "rejected",
    mismatchedField: "beneficiary",
  };
}

async function runWrongRpc(context, frozenRoute) {
  const name = "rpc-chain-disagreement";
  const journal = openJournal(context.localDirectory, name);
  const normal = context.providersFor(frozenRoute);
  const wrongDestination = {
    getNetwork: async () => ({ chainId: 999_999n }),
  };
  const runner = coordinator({
    route: frozenRoute,
    manifest: context.manifest,
    journal,
    providers: {
      ...normal,
      destination: wrongDestination,
      destinationSignerProvider: normal.destination,
    },
    identities: context.identities,
    recoveryDirectory: context.recoveryDirectory,
  });
  await assert.rejects(
    () => runner.preflight(),
    (error) => error?.code === "WRONG_CHAIN"
  );
  journal.close();
  return {
    name,
    state: "rejected-before-signing",
  };
}

function assertNoSensitiveEvidence(evidence) {
  const serialized = JSON.stringify(evidence).toLowerCase();
  assert.equal(serialized.includes("rawtransaction"), false);
  assert.equal(serialized.includes("recovery-only"), false);
  assert.equal(serialized.includes(MNEMONIC), false);
}

async function main() {
  const contractsRoot = path.resolve(__dirname, "..", "..");
  const repositoryRoot = path.resolve(contractsRoot, "..");
  const labRoot = path.resolve(
    process.env.FX_PHASE5_LAB_DIRECTORY ||
      path.join(repositoryRoot, ".local", "fx-phase5-dual-chain-lab")
  );
  const localDirectory = path.join(
    labRoot,
    `run-${new Date().toISOString().replaceAll(":", "-")}`
  );
  const recoveryDirectory = path.join(localDirectory, "recovery");
  fs.mkdirSync(recoveryDirectory, { recursive: true, mode: 0o700 });

  const nodeA = startNode(contractsRoot, localDirectory, CHAIN_A);
  const nodeB = startNode(contractsRoot, localDirectory, CHAIN_B);
  const children = [nodeA.child, nodeB.child];
  const stop = () => {
    for (const child of children) {
      if (child.exitCode === null) child.kill();
    }
  };
  process.once("exit", stop);
  process.once("SIGINT", () => {
    stop();
    process.exit(130);
  });

  try {
    const providerA = new JsonRpcProvider(
      `http://127.0.0.1:${CHAIN_A.port}`,
      BigInt(CHAIN_A.chainId),
      { staticNetwork: true, cacheTimeout: -1 }
    );
    const providerB = new JsonRpcProvider(
      `http://127.0.0.1:${CHAIN_B.port}`,
      BigInt(CHAIN_B.chainId),
      { staticNetwork: true, cacheTimeout: -1 }
    );
    await Promise.all([
      waitForRpc(providerA, nodeA.child, CHAIN_A.name),
      waitForRpc(providerB, nodeB.child, CHAIN_B.name),
    ]);
    const identities = {
      deployer: wallet(0),
      requester: wallet(1),
      dealer: wallet(2),
      relayer: wallet(3),
    };
    const [deploymentA, deploymentB] = await Promise.all([
      deployChain(contractsRoot, providerA, CHAIN_A, identities),
      deployChain(contractsRoot, providerB, CHAIN_B, identities),
    ]);
    const frozenManifest = manifest(contractsRoot, [deploymentA, deploymentB]);
    const deploymentId = keccak256(
      toUtf8Bytes(
        `${deploymentA.adapterAddress}:${deploymentB.adapterAddress}:phase5-local`
      )
    );
    const routeAB = validatePhase5Route(
      route(deploymentId, deploymentA, deploymentB, identities),
      frozenManifest
    );
    const routeBA = validatePhase5Route(
      route(deploymentId, deploymentB, deploymentA, identities),
      frozenManifest
    );
    const byChain = new Map([
      [CHAIN_A.chainId, providerA],
      [CHAIN_B.chainId, providerB],
    ]);
    const context = {
      localDirectory,
      recoveryDirectory,
      identities,
      manifest: frozenManifest,
      providersFor(frozenRoute) {
        return {
          source: byChain.get(frozenRoute.source.chainId),
          destination: byChain.get(frozenRoute.destination.chainId),
        };
      },
    };

    const scenarios = [];
    scenarios.push(
      await runSuccessfulSwap(context, "success-a-to-b", routeAB, {
        restartEveryStep: true,
      })
    );
    scenarios.push(
      await runSuccessfulSwap(context, "success-b-to-a", routeBA)
    );
    scenarios.push(await runDealerDisappears(context, routeAB));
    scenarios.push(await runRequesterDisappears(context, routeBA));
    scenarios.push(await runDestinationStall(context, routeAB));
    scenarios.push(await runFeeSpike(context, routeBA));
    scenarios.push(await runWrongLock(context, routeAB));
    scenarios.push(await runWrongRpc(context, routeBA));

    const evidence = {
      schema: "versus-fx-phase5-dual-chain-evidence",
      schemaVersion: 1,
      environment: "local-lab",
      productionWaku: false,
      productionFunds: false,
      generatedAt: new Date().toISOString(),
      nodes: [
        {
          chainId: CHAIN_A.chainId,
          adapterAddress: deploymentA.adapterAddress,
          tokenAddress: deploymentA.tokenAddress,
          ...deploymentA.evidence,
        },
        {
          chainId: CHAIN_B.chainId,
          adapterAddress: deploymentB.adapterAddress,
          tokenAddress: deploymentB.tokenAddress,
          ...deploymentB.evidence,
        },
      ],
      routes: [
        {
          routeId: routeAB.routeId,
          direction: `${routeAB.source.chainId}->${routeAB.destination.chainId}`,
          inputAmountAtomic: routeAB.inputAmountAtomic,
          outputAmountAtomic: routeAB.outputAmountAtomic,
        },
        {
          routeId: routeBA.routeId,
          direction: `${routeBA.source.chainId}->${routeBA.destination.chainId}`,
          inputAmountAtomic: routeBA.inputAmountAtomic,
          outputAmountAtomic: routeBA.outputAmountAtomic,
        },
      ],
      scenarios,
      summary: {
        scenarios: scenarios.length,
        successfulSwaps: scenarios.filter(
          (scenario) => scenario.state === "completed"
        ).length,
        safeRefunds: scenarios.filter(
          (scenario) => scenario.state === "refunded"
        ).length,
        failClosedChecks: scenarios.filter((scenario) =>
          ["blocked-before-signing", "rejected", "rejected-before-signing"].includes(
            scenario.state
          )
        ).length,
      },
    };
    assertNoSensitiveEvidence(evidence);
    const evidencePath = path.join(localDirectory, "evidence.json");
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    console.log(JSON.stringify({ evidencePath, summary: evidence.summary }, null, 2));
  } finally {
    stop();
    await sleep(150);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
