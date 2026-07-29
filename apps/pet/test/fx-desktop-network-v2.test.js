const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  Wallet,
  keccak256,
} = require("ethers");
const {
  FX_NATIVE_ETH_ADDRESS,
  FxCoordinationSession,
  FxRequesterFundingSdk,
  FxTradeJournal,
  FxWakuTransport,
  phase5LockId,
  restoreFxRecoveryPacket,
} = require("@versus/network");
const {
  FxDesktopNetworkRuntime,
} = require("../src/fx-desktop-network");

const DEPLOYMENT_ID =
  "0x361d43afddce9c272db9d4131c6b6b228693b603924de8f7dc09cc67b58bc5df";
const BASE = "84532";
const ARBITRUM = "421614";
const NATIVE_ADAPTER = "0x1e933ccffaa2cd384d3df751ff7a25183682dc61";
const NOW = 1_800_000_000;

class FakeWakuBus {
  constructor() {
    this.history = [];
    this.nodes = new Set();
  }

  node() {
    const bus = this;
    const callbacks = new Map();
    const node = {
      callbacks,
      peers: [{
        id: "relay-a",
        protocols: [
          "/vac/waku/lightpush/3.0.0",
          "/vac/waku/filter-subscribe/2.0.0-beta1",
          "/vac/waku/store-query/3.0.0",
        ],
      }],
      async waitForPeers() {},
      async getConnectedPeers() { return node.peers; },
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
          for (const entry of bus.history.filter(
            (candidate) => candidate.topic === topic
          )) {
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
              hashStr: `v2-${bus.history.length + 1}`,
            },
          };
          bus.history.push(entry);
          for (const target of bus.nodes) {
            await target.callbacks.get(entry.topic)?.(entry.message);
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

class FakeV2Evm {
  constructor(roles) {
    this.roles = roles;
    this.locks = new Map();
    this.receipts = new Map();
    this.events = new Map();
    this.actions = [];
    this.payouts = new Map();
    this.block = 10_000;
    this.maxFeePerGas = 1_000_000n;
  }

  configuration(chainId) {
    return {
      chainId: String(chainId),
      requiredConfirmations: 1,
      nativeGasReserveWei: "0",
    };
  }

  async preflight(chainId) {
    return this.configuration(chainId);
  }

  adapterAddress() {
    return NATIVE_ADAPTER;
  }

  provider(chainId) {
    return {
      getBlock: async () => ({ timestamp: NOW, number: this.block }),
      getFeeData: async () => ({
        maxFeePerGas: this.maxFeePerGas,
        gasPrice: this.maxFeePerGas,
      }),
      getTransactionReceipt: async (hash) => this.receipts.get(hash) || null,
    };
  }

  async tokenBalance() {
    return "10000000000000000000";
  }

  key(chainId, tradeId, side) {
    return `${chainId}:${phase5LockId(tradeId, side)}`;
  }

  transaction(label) {
    const hash = keccak256(Buffer.from(`${label}:${++this.block}`));
    const receipt = {
      transactionHash: hash,
      blockNumber: this.block,
      confirmations: 1,
      status: 1,
    };
    this.receipts.set(hash, receipt);
    return receipt;
  }

  emptyLock(chainId, tradeId, side) {
    return {
      chainId: String(chainId),
      lockId: phase5LockId(tradeId, side),
      state: 0,
      stateName: "empty",
      amountAtomic: "0",
      beneficiaryAmountAtomic: "0",
      executorAmountAtomic: "0",
      beneficiary: null,
      refundAddress: null,
      secretHash: null,
      timeout: 0,
    };
  }

  async fundLock(input) {
    const key = this.key(input.chainId, input.tradeId, input.side);
    const existing = this.locks.get(key);
    if (existing) return { lock: structuredClone(existing), receipt: null, recovered: true };
    const lock = {
      chainId: String(input.chainId),
      lockId: phase5LockId(input.tradeId, input.side),
      state: 1,
      stateName: "funded",
      amountAtomic: String(input.amountAtomic),
      beneficiaryAmountAtomic: String(input.beneficiaryAmountAtomic),
      executorAmountAtomic: String(input.executorAmountAtomic),
      beneficiary: input.beneficiary.toLowerCase(),
      refundAddress: input.refundAddress.toLowerCase(),
      secretHash: input.secretHash.toLowerCase(),
      timeout: Number(input.refundTimestamp),
      token: String(input.token).toLowerCase(),
      fundingRole: input.role,
      secret: null,
    };
    const receipt = this.transaction(
      `fund:${input.chainId}:${input.tradeId}:${input.side}`
    );
    this.locks.set(key, lock);
    this.events.set(
      `${input.chainId}:${input.tradeId}:${input.side}:LockFunded`,
      receipt
    );
    this.actions.push({
      action: "fund",
      chainId: String(input.chainId),
      side: input.side,
      role: input.role,
    });
    return { lock: structuredClone(lock), receipt, recovered: false };
  }

  async readLock(chainId, lockId, token) {
    const lock = [...this.locks.values()].find(
      (candidate) =>
        candidate.chainId === String(chainId) &&
        candidate.lockId === lockId &&
        candidate.token === String(token).toLowerCase()
    );
    return lock ? structuredClone(lock) : {
      chainId: String(chainId),
      lockId,
      state: 0,
      stateName: "empty",
      amountAtomic: "0",
      beneficiaryAmountAtomic: "0",
      executorAmountAtomic: "0",
      beneficiary: null,
      refundAddress: null,
      secretHash: null,
      timeout: 0,
    };
  }

  async verifyLockEnvelope({ chainId, lockId, token }) {
    const lock = await this.readLock(chainId, lockId, token);
    return { ...lock, confirmed: lock.state === 1, canonical: true };
  }

  async claimLock(input) {
    const key = this.key(input.chainId, input.tradeId, input.side);
    const lock = this.locks.get(key);
    if (!lock || lock.state !== 1) {
      throw new Error("lock is not claimable");
    }
    assert.equal(keccak256(input.secret), lock.secretHash);
    lock.state = 2;
    lock.stateName = "claimed";
    lock.secret = input.secret;
    const receipt = this.transaction(
      `claim:${input.chainId}:${input.tradeId}:${input.side}`
    );
    const executor = this.roles[input.role].address.toLowerCase();
    this.payouts.set(
      lock.beneficiary,
      (this.payouts.get(lock.beneficiary) || 0n) +
        BigInt(lock.beneficiaryAmountAtomic)
    );
    this.payouts.set(
      executor,
      (this.payouts.get(executor) || 0n) +
        BigInt(lock.executorAmountAtomic)
    );
    this.events.set(
      `${input.chainId}:${input.tradeId}:${input.side}:LockClaimed`,
      receipt
    );
    this.actions.push({
      action: "claim",
      chainId: String(input.chainId),
      side: input.side,
      role: input.role,
    });
    return { lock: structuredClone(lock), receipt, recovered: false };
  }

  async extractClaimSecret({ chainId, tradeId, side }) {
    const lock = this.locks.get(this.key(chainId, tradeId, side));
    if (!lock?.secret) throw new Error("claim secret is unavailable");
    return lock.secret;
  }

  async findLockEvent({ chainId, tradeId, side, eventName }) {
    const receipt = this.events.get(
      `${chainId}:${tradeId}:${side}:${eventName}`
    );
    if (!receipt) throw new Error(`${eventName} is unavailable`);
    return receipt;
  }
}

function sessionFactory({ root, bus, now }) {
  return ({ role, fileName, signer }) => {
    const journal = new FxTradeJournal({
      filePath: path.join(root, fileName),
      deploymentId: DEPLOYMENT_ID,
      now,
      minimumTimeoutDeltaSeconds: 3_600,
    });
    const transport = new FxWakuTransport({
      deploymentId: DEPLOYMENT_ID,
      bootstrapPeers: ["relay-a"],
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
      deploymentId: DEPLOYMENT_ID,
      signer,
      role,
      journal,
      transport,
      now,
    });
    return { session, journal };
  };
}

test("V2 delivers exact destination funds through a paid relay with no requester destination gas", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "versus-fx-v2-e2e-"));
  const bus = new FakeWakuBus();
  const roles = {
    requester: Wallet.createRandom(),
    dealer: Wallet.createRandom(),
    broker: Wallet.createRandom(),
    relayer: Wallet.createRandom(),
  };
  const recipient = Wallet.createRandom();
  const evm = new FakeV2Evm(roles);
  const runtime = new FxDesktopNetworkRuntime({
    dataDirectory: root,
    walletProvider: (role) => ({
      address: roles[role].address,
      privateKey: roles[role].privateKey,
    }),
    evm,
    deploymentId: DEPLOYMENT_ID,
    bootstrapPeers: ["relay-a"],
    now: () => NOW,
    brokerObservationWindowMs: 25,
    dealerObservationWindowMs: 0,
    nativeUsdPriceProvider: async () => 3_000_000_000n,
    protocolVersion: 2,
    sessionFactory: sessionFactory({
      root,
      bus,
      now: () => NOW,
    }),
  });
  t.after(async () => {
    await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const positions = [
    {
      id: "base-sepolia-eth",
      enabled: true,
      chainId: BASE,
      assetAddress: FX_NATIVE_ETH_ADDRESS,
    },
    {
      id: "arbitrum-sepolia-eth",
      enabled: true,
      chainId: ARBITRUM,
      assetAddress: FX_NATIVE_ETH_ADDRESS,
    },
  ];
  await runtime.armDealer({
    policy: {
      minimumTradeUsd: 1,
      maximumTradeUsd: 50,
      maximumExposureUsd: 1_000,
      maximumRequesterExposureUsd: 100,
      maximumAssetExposureUsd: 500,
      maximumGasUsd: 5,
      maximumOverheadBps: 500,
      minimumSpreadBps: 25,
      inventoryPremiumBps: 0,
    },
    positions,
  });

  const sdk = new FxRequesterFundingSdk({
    deploymentId: DEPLOYMENT_ID,
    signer: roles.requester,
    brokerEndpoints: ["waku://self-route"],
    recoveryDirectory: path.join(root, "requester-recovery"),
    queryRoutes: (input) => runtime.queryRoutes(input),
    settlementExecutor: (input) => runtime.executeRequester(input),
    destinationVerifier: async ({ settlement }) =>
      settlement.destinationObservation,
    now: () => NOW,
    protocolVersion: 2,
  });
  const outputAmount = "1000000000000000";
  const quote = await sdk.quoteFunding({
    requirement: {
      source: "manual",
      outputChainId: ARBITRUM,
      outputToken: FX_NATIVE_ETH_ADDRESS,
      outputAmountAtomic: outputAmount,
    },
    destinationAddress: recipient.address,
    sourceRefundAddress: roles.requester.address,
    inputOptions: [{
      chainId: BASE,
      token: FX_NATIVE_ETH_ADDRESS,
      maxInputAtomic: "2000000000000000",
    }],
    inputChainId: BASE,
    inputToken: FX_NATIVE_ETH_ADDRESS,
    tradeId: `0x${"42".repeat(32)}`,
  });
  const prepared = await sdk.prepareExternalFunding({
    quote,
    recoveryPassword: "v2 recovery password",
    ownerApproved: true,
  });
  const requesterRecovery = restoreFxRecoveryPacket({
    filePath: prepared.recoveryFile,
    password: "v2 recovery password",
    deploymentId: DEPLOYMENT_ID,
    tradeId: prepared.tradeId,
  });
  assert.notEqual(
    requesterRecovery.secretHash,
    prepared.secretHash,
    "the requester recovery nonce must not be the dealer settlement secret"
  );
  const reserve = await runtime.reserveRequester({
    acceptance: prepared.acceptance,
  });
  const selected = quote.proposal.quotes.find(
    (candidate) => candidate.id === quote.proposal.route.quoteId
  );
  const active = runtime.exposureJournal.activeTrades();
  assert.equal(active.length, 1);
  assert.equal(active[0].state, "destination_pending");
  assert.deepEqual(active[0].economics, {
    beneficiaryAmountAtomic: outputAmount,
    executorAmountAtomic:
      selected.payload.destinationExecutorAmountAtomic,
    totalDestinationLiabilityAtomic: (
      BigInt(outputAmount) +
      BigInt(selected.payload.destinationExecutorAmountAtomic)
    ).toString(),
  });
  const inventory = await runtime.inventorySnapshot(positions, {
    maximumAgeMs: 0,
  });
  assert.equal(
    inventory.find((position) => position.id === "arbitrum-sepolia-eth")
      .reservedAtomic,
    active[0].economics.totalDestinationLiabilityAtomic
  );
  evm.maxFeePerGas = 100_000_000_000n;
  await assert.rejects(
    () => sdk.executePreparedFunding({
      prepared: { ...prepared, reservation: reserve },
      recoveryPassword: "v2 recovery password",
    }),
    (error) => error.code === "EXECUTOR_BOUNTY_UNDERFUNDED"
  );
  assert.equal(
    evm.actions.some(
      (entry) => entry.action === "fund" && entry.side === "source"
    ),
    false,
    "the requester must not lock source while relay gas is underfunded"
  );
  evm.maxFeePerGas = 1_000_000n;
  const result = await sdk.executePreparedFunding({
    prepared: { ...prepared, reservation: reserve },
    recoveryPassword: "v2 recovery password",
  });

  assert.equal(result.fundsReady, true);
  assert.equal(result.receipt.observedAmountAtomic, outputAmount);
  assert.equal(
    evm.payouts.get(recipient.address.toLowerCase()),
    BigInt(outputAmount)
  );
  assert.equal(
    evm.payouts.get(roles.dealer.address.toLowerCase()) >
      BigInt(quote.proposal.route.totalInputAtomic),
    true
  );
  assert.equal(
    evm.payouts.get(roles.dealer.address.toLowerCase()) >=
      BigInt(selected.payload.destinationExecutorAmountAtomic),
    true
  );
  assert.deepEqual(
    evm.actions.map(({ action, chainId, side, role }) => ({
      action,
      chainId,
      side,
      role,
    })),
    [
      { action: "fund", chainId: ARBITRUM, side: "destination", role: "dealer" },
      { action: "fund", chainId: BASE, side: "source", role: "requester" },
      { action: "claim", chainId: BASE, side: "source", role: "dealer" },
      { action: "claim", chainId: ARBITRUM, side: "destination", role: "dealer" },
    ]
  );
  assert.equal(
    evm.actions.some(
      (entry) =>
        entry.chainId === ARBITRUM &&
        entry.role === "requester"
    ),
    false
  );
  assert.equal(runtime.exposureJournal.activeTrades().length, 0);
  assert.equal(
    runtime.relayerJournal.snapshot(prepared.tradeId).settlementState,
    "complete"
  );
});

async function waitUntil(predicate, {
  timeoutMs = 5_000,
  label = "condition",
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function actionCount(evm, action, side) {
  return evm.actions.filter(
    (entry) => entry.action === action && entry.side === side
  ).length;
}

function v2Harness(t, { tradeId = `0x${"42".repeat(32)}` } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "versus-fx-v2-restart-"));
  const bus = new FakeWakuBus();
  const roles = {
    requester: Wallet.createRandom(),
    dealer: Wallet.createRandom(),
    broker: Wallet.createRandom(),
    relayer: Wallet.createRandom(),
  };
  const recipient = Wallet.createRandom();
  const evm = new FakeV2Evm(roles);
  const positions = [
    {
      id: "base-sepolia-eth",
      enabled: true,
      chainId: BASE,
      assetAddress: FX_NATIVE_ETH_ADDRESS,
    },
    {
      id: "arbitrum-sepolia-eth",
      enabled: true,
      chainId: ARBITRUM,
      assetAddress: FX_NATIVE_ETH_ADDRESS,
    },
  ];
  const policy = {
    minimumTradeUsd: 1,
    maximumTradeUsd: 50,
    maximumExposureUsd: 1_000,
    maximumRequesterExposureUsd: 100,
    maximumAssetExposureUsd: 500,
    maximumGasUsd: 5,
    maximumOverheadBps: 500,
    minimumSpreadBps: 25,
    inventoryPremiumBps: 0,
  };
  let activeRuntime = null;
  const runtimeOptions = () => ({
    dataDirectory: root,
    walletProvider: (role) => ({
      address: roles[role].address,
      privateKey: roles[role].privateKey,
    }),
    evm,
    deploymentId: DEPLOYMENT_ID,
    bootstrapPeers: ["relay-a"],
    now: () => NOW,
    brokerObservationWindowMs: 25,
    dealerObservationWindowMs: 0,
    nativeUsdPriceProvider: async () => 3_000_000_000n,
    protocolVersion: 2,
    sessionFactory: sessionFactory({
      root,
      bus,
      now: () => NOW,
    }),
  });
  const createRuntime = () => {
    const runtime = new FxDesktopNetworkRuntime(runtimeOptions());
    runtime.on("error", () => {});
    activeRuntime = runtime;
    return runtime;
  };
  const createSdk = (runtime) => new FxRequesterFundingSdk({
    deploymentId: DEPLOYMENT_ID,
    signer: roles.requester,
    brokerEndpoints: ["waku://self-route"],
    recoveryDirectory: path.join(root, "requester-recovery"),
    queryRoutes: (input) => runtime.queryRoutes(input),
    settlementExecutor: (input) => runtime.executeRequester(input),
    destinationVerifier: async ({ settlement }) =>
      settlement.destinationObservation,
    now: () => NOW,
    protocolVersion: 2,
  });
  t.after(async () => {
    await activeRuntime?.close?.().catch(() => {});
    activeRuntime = null;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows can keep SQLite handles briefly after close.
    }
  });
  return {
    root,
    bus,
    roles,
    recipient,
    evm,
    positions,
    policy,
    tradeId,
    createRuntime,
    createSdk,
  };
}

test("V2 dealer resumes after restart once the destination lock is funded", async (t) => {
  const harness = v2Harness(t, { tradeId: `0x${"43".repeat(32)}` });
  let runtime = harness.createRuntime();
  t.after(async () => {
    await runtime.close().catch(() => {});
  });

  await runtime.armDealer({
    policy: harness.policy,
    positions: harness.positions,
  });
  const sdk = harness.createSdk(runtime);
  const quote = await sdk.quoteFunding({
    requirement: {
      source: "manual",
      outputChainId: ARBITRUM,
      outputToken: FX_NATIVE_ETH_ADDRESS,
      outputAmountAtomic: "1000000000000000",
    },
    destinationAddress: harness.recipient.address,
    sourceRefundAddress: harness.roles.requester.address,
    inputOptions: [{
      chainId: BASE,
      token: FX_NATIVE_ETH_ADDRESS,
      maxInputAtomic: "2000000000000000",
    }],
    inputChainId: BASE,
    inputToken: FX_NATIVE_ETH_ADDRESS,
    tradeId: harness.tradeId,
  });
  const prepared = await sdk.prepareExternalFunding({
    quote,
    recoveryPassword: "v2 recovery password",
    ownerApproved: true,
  });
  const reserve = await runtime.reserveRequester({
    acceptance: prepared.acceptance,
  });
  await waitUntil(
    () => actionCount(harness.evm, "fund", "destination") === 1,
    { label: "destination fund" }
  );
  await waitUntil(
    () => runtime.exposureJournal.trade(prepared.tradeId)?.state ===
      "destination_locked",
    { label: "destination_locked exposure" }
  );
  assert.equal(actionCount(harness.evm, "fund", "destination"), 1);
  assert.equal(actionCount(harness.evm, "fund", "source"), 0);

  await runtime.close();
  runtime = harness.createRuntime();
  await runtime.armDealer({
    policy: harness.policy,
    positions: harness.positions,
  });
  assert.equal(
    runtime.exposureJournal.trade(prepared.tradeId)?.state,
    "destination_locked"
  );
  assert.equal(actionCount(harness.evm, "fund", "destination"), 1);

  const resumedSdk = harness.createSdk(runtime);
  const result = await resumedSdk.executePreparedFunding({
    prepared: { ...prepared, reservation: reserve },
    recoveryPassword: "v2 recovery password",
  });
  assert.equal(result.fundsReady, true);
  assert.equal(actionCount(harness.evm, "fund", "destination"), 1);
  assert.equal(actionCount(harness.evm, "claim", "destination"), 1);
  assert.equal(
    harness.evm.payouts.get(harness.recipient.address.toLowerCase()),
    1000000000000000n
  );
});

test("V2 relayer resumes destination claim after restart once source is claimed", async (t) => {
  const harness = v2Harness(t, { tradeId: `0x${"44".repeat(32)}` });
  let runtime = harness.createRuntime();
  t.after(async () => {
    await runtime.close().catch(() => {});
  });

  let blockDestinationClaim = true;
  const claimLock = harness.evm.claimLock.bind(harness.evm);
  harness.evm.claimLock = async (input) => {
    if (input.side === "destination" && blockDestinationClaim) {
      throw new Error("simulated crash before destination claim");
    }
    return claimLock(input);
  };

  await runtime.armDealer({
    policy: harness.policy,
    positions: harness.positions,
  });
  const sdk = harness.createSdk(runtime);
  const quote = await sdk.quoteFunding({
    requirement: {
      source: "manual",
      outputChainId: ARBITRUM,
      outputToken: FX_NATIVE_ETH_ADDRESS,
      outputAmountAtomic: "1000000000000000",
    },
    destinationAddress: harness.recipient.address,
    sourceRefundAddress: harness.roles.requester.address,
    inputOptions: [{
      chainId: BASE,
      token: FX_NATIVE_ETH_ADDRESS,
      maxInputAtomic: "2000000000000000",
    }],
    inputChainId: BASE,
    inputToken: FX_NATIVE_ETH_ADDRESS,
    tradeId: harness.tradeId,
  });
  const prepared = await sdk.prepareExternalFunding({
    quote,
    recoveryPassword: "v2 recovery password",
    ownerApproved: true,
  });
  const reserve = await runtime.reserveRequester({
    acceptance: prepared.acceptance,
  });
  sdk.executePreparedFunding({
    prepared: { ...prepared, reservation: reserve },
    recoveryPassword: "v2 recovery password",
  }).catch(() => {});
  await waitUntil(
    () => actionCount(harness.evm, "claim", "source") === 1,
    { label: "source claim" }
  );
  await waitUntil(
    () => runtime.relayerJournal.snapshot(prepared.tradeId)?.settlementState ===
      "source_claimed",
    { label: "relayer source_claimed" }
  );
  assert.equal(actionCount(harness.evm, "claim", "destination"), 0);

  await runtime.close();
  blockDestinationClaim = false;

  runtime = harness.createRuntime();
  await runtime.armDealer({
    policy: harness.policy,
    positions: harness.positions,
  });
  await waitUntil(
    () => actionCount(harness.evm, "claim", "destination") === 1,
    { label: "resumed destination claim" }
  );
  assert.equal(actionCount(harness.evm, "claim", "source"), 1);
  assert.equal(actionCount(harness.evm, "claim", "destination"), 1);
  assert.equal(
    harness.evm.payouts.get(harness.recipient.address.toLowerCase()),
    1000000000000000n
  );
  assert.equal(
    runtime.relayerJournal.snapshot(prepared.tradeId).settlementState,
    "complete"
  );
});

test("V2 destination claim executes exactly once after recovery", async (t) => {
  const harness = v2Harness(t, { tradeId: `0x${"45".repeat(32)}` });
  let runtime = harness.createRuntime();
  t.after(async () => {
    await runtime.close().catch(() => {});
  });

  let blockDestinationClaim = true;
  const claimLock = harness.evm.claimLock.bind(harness.evm);
  harness.evm.claimLock = async (input) => {
    if (input.side === "destination" && blockDestinationClaim) {
      throw new Error("simulated crash before destination claim");
    }
    return claimLock(input);
  };

  await runtime.armDealer({
    policy: harness.policy,
    positions: harness.positions,
  });
  const sdk = harness.createSdk(runtime);
  const quote = await sdk.quoteFunding({
    requirement: {
      source: "manual",
      outputChainId: ARBITRUM,
      outputToken: FX_NATIVE_ETH_ADDRESS,
      outputAmountAtomic: "1000000000000000",
    },
    destinationAddress: harness.recipient.address,
    sourceRefundAddress: harness.roles.requester.address,
    inputOptions: [{
      chainId: BASE,
      token: FX_NATIVE_ETH_ADDRESS,
      maxInputAtomic: "2000000000000000",
    }],
    inputChainId: BASE,
    inputToken: FX_NATIVE_ETH_ADDRESS,
    tradeId: harness.tradeId,
  });
  const prepared = await sdk.prepareExternalFunding({
    quote,
    recoveryPassword: "v2 recovery password",
    ownerApproved: true,
  });
  const reserve = await runtime.reserveRequester({
    acceptance: prepared.acceptance,
  });
  sdk.executePreparedFunding({
    prepared: { ...prepared, reservation: reserve },
    recoveryPassword: "v2 recovery password",
  }).catch(() => {});
  await waitUntil(
    () => actionCount(harness.evm, "claim", "source") === 1,
    { label: "source claim" }
  );
  await runtime.close();
  blockDestinationClaim = false;

  runtime = harness.createRuntime();
  await runtime.armDealer({
    policy: harness.policy,
    positions: harness.positions,
  });
  await waitUntil(
    () => actionCount(harness.evm, "claim", "destination") === 1,
    { label: "first recovered destination claim" }
  );

  await runtime.ensureRelayerSession();
  await runtime.close();
  runtime = harness.createRuntime();
  await runtime.armDealer({
    policy: harness.policy,
    positions: harness.positions,
  });
  await runtime.ensureRelayerSession();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(actionCount(harness.evm, "claim", "destination"), 1);
  assert.equal(actionCount(harness.evm, "claim", "source"), 1);
  assert.equal(
    harness.evm.payouts.get(harness.recipient.address.toLowerCase()),
    1000000000000000n
  );
  assert.equal(
    runtime.relayerJournal.snapshot(prepared.tradeId).settlementState,
    "complete"
  );
});
