const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const FX_DESKTOP_STATE_VERSION = 4;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const FX_TRADE_STATES = Object.freeze([
  "draft",
  "requesting",
  "quoted",
  "accepted",
  "reserved",
  "awaiting_source_funds",
  "source_funds_detected",
  "source_lock_pending",
  "source_lock_confirmed",
  "destination_lock_pending",
  "destination_lock_confirmed",
  "destination_claimed",
  "source_claimed",
  "funds_ready",
  "complete",
  "refund_wait",
  "refunded",
  "cancelled",
  "failed",
]);

const FX_DEFAULT_POLICY = Object.freeze({
  armed: false,
  minimumTradeUsd: 0.01,
  maximumTradeUsd: 50,
  maximumExposureUsd: 1_000,
  maximumRequesterExposureUsd: 100,
  maximumAssetExposureUsd: 500,
  maximumGasUsd: 5,
  maximumOverheadBps: 100,
  minimumSpreadBps: 25,
  inventoryPremiumBps: 0,
  quoteLifetimeSeconds: 30,
  reservationSeconds: 90,
});

const FX_POLICY_BOUNDS = Object.freeze({
  minimumTradeUsd: [0.01, 10_000],
  maximumTradeUsd: [1, 100_000],
  maximumExposureUsd: [1, 1_000_000],
  maximumRequesterExposureUsd: [1, 1_000_000],
  maximumAssetExposureUsd: [1, 1_000_000],
  maximumGasUsd: [0, 10_000],
  maximumOverheadBps: [0, 10_000],
  minimumSpreadBps: [1, 10_000],
  inventoryPremiumBps: [0, 10_000],
  quoteLifetimeSeconds: [10, 300],
  reservationSeconds: [30, 600],
});

const FX_DEFAULT_POSITIONS = Object.freeze([
  Object.freeze({
    id: "base-sepolia-eth",
    chainId: "84532",
    chainKey: "base-sepolia",
    chain: "BASE SEPOLIA",
    asset: "ETH",
    decimals: 18,
    assetKind: "native",
    assetAddress: "0x0000000000000000000000000000000000000000",
  }),
  Object.freeze({
    id: "base-sepolia-usdc",
    chainId: "84532",
    chainKey: "base-sepolia",
    chain: "BASE SEPOLIA",
    asset: "USDC",
    decimals: 6,
    assetKind: "erc20",
    assetAddress: "0xcba3d9354dd4c30bb6961abb4473a6340486e01b",
  }),
  Object.freeze({
    id: "arbitrum-sepolia-eth",
    chainId: "421614",
    chainKey: "arbitrum-sepolia",
    chain: "ARBITRUM SEPOLIA",
    asset: "ETH",
    decimals: 18,
    assetKind: "native",
    assetAddress: "0x0000000000000000000000000000000000000000",
  }),
  Object.freeze({
    id: "arbitrum-sepolia-usdc",
    chainId: "421614",
    chainKey: "arbitrum-sepolia",
    chain: "ARBITRUM SEPOLIA",
    asset: "USDC",
    decimals: 6,
    assetKind: "erc20",
    assetAddress: "0xcba3d9354dd4c30bb6961abb4473a6340486e01b",
  }),
]);

const FX_DEFAULT_CHAINS = Object.freeze([
  Object.freeze({
    chainId: "84532",
    chainKey: "base-sepolia",
    chain: "BASE SEPOLIA",
    nativeAsset: "ETH",
    nativeDecimals: 18,
    minimumGasUsd: 1,
  }),
  Object.freeze({
    chainId: "421614",
    chainKey: "arbitrum-sepolia",
    chain: "ARBITRUM SEPOLIA",
    nativeAsset: "ETH",
    nativeDecimals: 18,
    minimumGasUsd: 1,
  }),
]);

function clone(value) {
  return structuredClone(value);
}

function initialState(deploymentId = null) {
  return {
    version: FX_DESKTOP_STATE_VERSION,
    deploymentId,
    enabled: false,
    policy: clone(FX_DEFAULT_POLICY),
    chains: FX_DEFAULT_CHAINS.map((chain) => ({
      ...chain,
      enabled: false,
      rpcUrl: "",
      address: null,
      dealerAddress: null,
      requesterAddress: null,
      balanceAtomic: "0",
      balanceUsdMicros: "0",
      dealerBalanceAtomic: "0",
      dealerBalanceUsdMicros: "0",
      requesterBalanceAtomic: "0",
      requesterBalanceUsdMicros: "0",
      dealerGasReady: false,
      requesterGasReady: false,
      gasReady: false,
      lastCheckedAt: null,
      lastFailure: null,
    })),
    positions: FX_DEFAULT_POSITIONS.map((position) => ({
      ...position,
      enabled: false,
      address: null,
      availableAtomic: "0",
      reservedAtomic: "0",
      activeLocks: 0,
    })),
    trades: [],
    observations: [],
    updatedAt: new Date(0).toISOString(),
  };
}

function integer(value, label, [minimum, maximum]) {
  const normalized = Number(value);
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < minimum ||
    normalized > maximum
  ) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return normalized;
}

function usd(value, label, [minimum, maximum]) {
  const normalized = Number(value);
  const cents = Math.round(normalized * 100);
  if (
    !Number.isFinite(normalized) ||
    Math.abs(cents / 100 - normalized) > Number.EPSILON ||
    normalized < minimum ||
    normalized > maximum
  ) {
    throw new Error(
      `${label} must be between ${minimum} and ${maximum} in whole cents`
    );
  }
  return cents / 100;
}

function atomic(value, label) {
  const normalized = String(value);
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${label} must be an unsigned atomic amount`);
  }
  return normalized;
}

function tradeId(value) {
  const normalized = String(value || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new Error("tradeId must be bytes32");
  }
  return normalized;
}

function timestamp() {
  return new Date().toISOString();
}

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  fs.renameSync(temporary, filePath);
}

function normalizeLoadedState(value, deploymentId = null) {
  if (
    !value ||
    ![1, 2, 3, FX_DESKTOP_STATE_VERSION].includes(Number(value.version))
  ) {
    return initialState(deploymentId);
  }
  const defaults = initialState(deploymentId);
  const trades = Array.isArray(value.trades)
    ? value.trades.map((trade) => {
        if (
          !["accepted", "reserved"].includes(trade?.state) ||
          trade?.prepared
        ) {
          return trade;
        }
        const at = trade.updatedAt || value.updatedAt || defaults.updatedAt;
        return {
          ...trade,
          state: "failed",
          lastFailure: {
            code: "RESERVATION_PREPARATION_INTERRUPTED",
            message:
              "The dealer reservation was not fully prepared. No source funds were authorized",
            at,
          },
          timeline: [
            ...(Array.isArray(trade.timeline) ? trade.timeline : []),
            { state: "failed", at },
          ],
        };
      })
    : [];
  const state = {
    ...defaults,
    version: FX_DESKTOP_STATE_VERSION,
    deploymentId,
    enabled: value.enabled === true,
    policy: { ...defaults.policy },
    chains: defaults.chains.map((fallback) => {
      const loaded = Array.isArray(value.chains)
        ? value.chains.find((candidate) => candidate.chainId === fallback.chainId)
        : null;
      return {
        ...fallback,
        ...(loaded || {}),
        enabled: loaded?.enabled === true,
        rpcUrl: typeof loaded?.rpcUrl === "string" ? loaded.rpcUrl : "",
        address: loaded?.address || null,
        dealerAddress: loaded?.dealerAddress || loaded?.address || null,
        requesterAddress: loaded?.requesterAddress || null,
        balanceAtomic: /^\d+$/.test(String(loaded?.balanceAtomic || ""))
          ? String(loaded.balanceAtomic)
          : "0",
        balanceUsdMicros: /^\d+$/.test(String(loaded?.balanceUsdMicros || ""))
          ? String(loaded.balanceUsdMicros)
          : "0",
        dealerBalanceAtomic: /^\d+$/.test(
          String(loaded?.dealerBalanceAtomic || loaded?.balanceAtomic || "")
        )
          ? String(loaded.dealerBalanceAtomic || loaded.balanceAtomic)
          : "0",
        dealerBalanceUsdMicros: /^\d+$/.test(
          String(loaded?.dealerBalanceUsdMicros || loaded?.balanceUsdMicros || "")
        )
          ? String(loaded.dealerBalanceUsdMicros || loaded.balanceUsdMicros)
          : "0",
        requesterBalanceAtomic: /^\d+$/.test(
          String(loaded?.requesterBalanceAtomic || "")
        )
          ? String(loaded.requesterBalanceAtomic)
          : "0",
        requesterBalanceUsdMicros: /^\d+$/.test(
          String(loaded?.requesterBalanceUsdMicros || "")
        )
          ? String(loaded.requesterBalanceUsdMicros)
          : "0",
        dealerGasReady:
          loaded?.dealerGasReady === true || loaded?.gasReady === true,
        requesterGasReady: loaded?.requesterGasReady === true,
        gasReady:
          (loaded?.dealerGasReady === true || loaded?.gasReady === true) &&
          loaded?.requesterGasReady === true,
      };
    }),
    positions: defaults.positions.map((fallback) => {
      const loaded = Array.isArray(value.positions)
        ? value.positions.find((candidate) => candidate.id === fallback.id)
        : null;
      const loadedChain = Array.isArray(value.chains)
        ? value.chains.find(
            (candidate) => candidate.chainId === fallback.chainId
          )
        : null;
      return {
        ...fallback,
        ...(loaded || {}),
        enabled:
          fallback.assetKind === "native"
            ? loadedChain?.enabled === true
            : Number(value.version) >= 2 &&
              loaded?.enabled === true,
        availableAtomic: /^\d+$/.test(String(loaded?.availableAtomic || ""))
          ? String(loaded.availableAtomic)
          : "0",
        reservedAtomic: /^\d+$/.test(String(loaded?.reservedAtomic || ""))
          ? String(loaded.reservedAtomic)
          : "0",
        activeLocks: Number.isSafeInteger(Number(loaded?.activeLocks))
          ? Number(loaded.activeLocks)
          : 0,
      };
    }),
    trades,
    observations: Array.isArray(value.observations)
      ? value.observations.slice(-512)
      : [],
    updatedAt: typeof value.updatedAt === "string"
      ? value.updatedAt
      : defaults.updatedAt,
  };
  for (const [key, bounds] of Object.entries(FX_POLICY_BOUNDS)) {
    const loadedValue =
      key === "minimumTradeUsd" &&
      Number(value.version) < FX_DESKTOP_STATE_VERSION &&
      value.policy?.minimumTradeUsd === 1
        ? defaults.policy.minimumTradeUsd
        : value.policy?.[key] ?? defaults.policy[key];
    state.policy[key] =
      key === "minimumTradeUsd"
        ? usd(loadedValue, key, bounds)
        : integer(loadedValue, key, bounds);
  }
  state.policy.armed = value.policy?.armed === true;
  return state;
}

class FxDesktopStore {
  constructor({ filePath, deploymentId = null, now = timestamp } = {}) {
    if (!filePath) throw new TypeError("FX desktop store requires filePath");
    this.filePath = path.resolve(filePath);
    this.deploymentId = deploymentId == null
      ? null
      : String(deploymentId).toLowerCase();
    if (this.deploymentId && !HASH_PATTERN.test(this.deploymentId)) {
      throw new TypeError("FX desktop store deploymentId must be bytes32");
    }
    this.now = now;
    this.state = this.#read();
  }

  #archiveDeploymentState(previousDeploymentId) {
    const archiveDirectory = path.join(
      path.dirname(this.filePath),
      "deployment-archive",
      `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`
    );
    fs.mkdirSync(archiveDirectory, { recursive: true, mode: 0o700 });
    fs.renameSync(this.filePath, path.join(archiveDirectory, "state.json"));
    atomicWrite(path.join(archiveDirectory, "archive.json"), {
      version: 1,
      reason: "deployment_mismatch",
      previousDeploymentId,
      currentDeploymentId: this.deploymentId,
      archivedAt: this.now(),
      files: ["state.json"],
    });
  }

  #read() {
    try {
      const loaded = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      const previousDeploymentId = HASH_PATTERN.test(
        String(loaded?.deploymentId || "").toLowerCase()
      )
        ? String(loaded.deploymentId).toLowerCase()
        : null;
      if (
        this.deploymentId &&
        previousDeploymentId !== this.deploymentId
      ) {
        this.#archiveDeploymentState(previousDeploymentId);
        return initialState(this.deploymentId);
      }
      return normalizeLoadedState(loaded, this.deploymentId);
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      return initialState(this.deploymentId);
    }
  }

  #save() {
    this.state.updatedAt = this.now();
    atomicWrite(this.filePath, this.state);
    return this.snapshot();
  }

  snapshot() {
    return clone(this.state);
  }

  setEnabled(enabled) {
    this.state.enabled = enabled === true;
    if (!this.state.enabled) this.state.policy.armed = false;
    return this.#save();
  }

  setPolicy(patch = {}) {
    for (const [key, value] of Object.entries(patch)) {
      if (key === "armed") {
        if (value === true && !this.state.enabled) {
          throw new Error("FX must be enabled before dealing can be armed");
        }
        this.state.policy.armed = value === true;
        continue;
      }
      const bounds = FX_POLICY_BOUNDS[key];
      if (!bounds) throw new Error(`unsupported FX policy field ${key}`);
      this.state.policy[key] =
        key === "minimumTradeUsd"
          ? usd(value, key, bounds)
          : integer(value, key, bounds);
    }
    if (this.state.policy.minimumTradeUsd > this.state.policy.maximumTradeUsd) {
      throw new Error("minimum trade cannot exceed maximum trade");
    }
    if (this.state.policy.maximumTradeUsd > this.state.policy.maximumExposureUsd) {
      this.state.policy.maximumExposureUsd = this.state.policy.maximumTradeUsd;
    }
    if (
      this.state.policy.maximumRequesterExposureUsd >
      this.state.policy.maximumExposureUsd
    ) {
      this.state.policy.maximumRequesterExposureUsd =
        this.state.policy.maximumExposureUsd;
    }
    if (
      this.state.policy.maximumAssetExposureUsd >
      this.state.policy.maximumExposureUsd
    ) {
      this.state.policy.maximumAssetExposureUsd =
        this.state.policy.maximumExposureUsd;
    }
    return this.#save();
  }

  setPositionEnabled(id, enabled) {
    const position = this.state.positions.find((candidate) => candidate.id === id);
    if (!position) throw new Error("FX position is unsupported");
    if (
      enabled !== true &&
      (
        BigInt(position.availableAtomic) > 0n ||
        BigInt(position.reservedAtomic) > 0n ||
        position.activeLocks > 0
      )
    ) {
      throw new Error("funded or reserved FX positions cannot be disabled");
    }
    position.enabled = enabled === true;
    return this.#save();
  }

  setChainSettings(chainId, patch = {}) {
    const chain = this.state.chains.find(
      (candidate) => candidate.chainId === String(chainId)
    );
    if (!chain) throw new Error("FX chain is unsupported");
    if (
      patch.enabled === false &&
      this.state.positions.some(
        (position) => position.chainId === chain.chainId && position.enabled
      )
    ) {
      throw new Error("Disable this chain's token positions first");
    }
    if ("enabled" in patch) chain.enabled = patch.enabled === true;
    if ("rpcUrl" in patch) chain.rpcUrl = String(patch.rpcUrl || "").trim();
    if (!chain.enabled) {
      chain.dealerGasReady = false;
      chain.requesterGasReady = false;
      chain.gasReady = false;
    }
    return this.#save();
  }

  recordChain(chainId, patch = {}) {
    const chain = this.state.chains.find(
      (candidate) => candidate.chainId === String(chainId)
    );
    if (!chain) throw new Error("FX chain is unsupported");
    if ("address" in patch) chain.address = patch.address || null;
    if ("dealerAddress" in patch) {
      chain.dealerAddress = patch.dealerAddress || null;
      chain.address = chain.dealerAddress;
    }
    if ("requesterAddress" in patch) {
      chain.requesterAddress = patch.requesterAddress || null;
    }
    if ("balanceAtomic" in patch) {
      chain.balanceAtomic = atomic(patch.balanceAtomic, "balanceAtomic");
    }
    if ("balanceUsdMicros" in patch) {
      chain.balanceUsdMicros = atomic(
        patch.balanceUsdMicros,
        "balanceUsdMicros"
      );
    }
    for (const key of [
      "dealerBalanceAtomic",
      "dealerBalanceUsdMicros",
      "requesterBalanceAtomic",
      "requesterBalanceUsdMicros",
    ]) {
      if (key in patch) chain[key] = atomic(patch[key], key);
    }
    if ("dealerGasReady" in patch) {
      chain.dealerGasReady = patch.dealerGasReady === true;
    }
    if ("requesterGasReady" in patch) {
      chain.requesterGasReady = patch.requesterGasReady === true;
    }
    if ("gasReady" in patch) chain.gasReady = patch.gasReady === true;
    if ("lastCheckedAt" in patch) {
      chain.lastCheckedAt = patch.lastCheckedAt || null;
    }
    if ("lastFailure" in patch) {
      chain.lastFailure = patch.lastFailure || null;
    }
    return this.#save();
  }

  recordPosition(id, patch = {}) {
    const position = this.state.positions.find((candidate) => candidate.id === id);
    if (!position) throw new Error("FX position is unsupported");
    if ("address" in patch) position.address = patch.address || null;
    if ("availableAtomic" in patch) {
      position.availableAtomic = atomic(patch.availableAtomic, "availableAtomic");
    }
    if ("reservedAtomic" in patch) {
      position.reservedAtomic = atomic(patch.reservedAtomic, "reservedAtomic");
    }
    if ("activeLocks" in patch) {
      position.activeLocks = integer(
        patch.activeLocks,
        "activeLocks",
        [0, 1_000_000]
      );
    }
    return this.#save();
  }

  putTrade(input = {}) {
    const id = tradeId(input.tradeId);
    const existingIndex = this.state.trades.findIndex(
      (candidate) => candidate.tradeId === id
    );
    const previous = existingIndex >= 0 ? this.state.trades[existingIndex] : null;
    const state = input.state || previous?.state || "draft";
    if (!FX_TRADE_STATES.includes(state)) {
      throw new Error(`unsupported FX trade state ${state}`);
    }
    const next = {
      ...(previous || {}),
      ...clone(input),
      tradeId: id,
      state,
      createdAt: previous?.createdAt || input.createdAt || this.now(),
      updatedAt: this.now(),
    };
    if (existingIndex >= 0) this.state.trades[existingIndex] = next;
    else this.state.trades.unshift(next);
    this.state.trades = this.state.trades.slice(0, 256);
    this.#observe({
      tradeId: id,
      category: "state",
      value: state,
      at: next.updatedAt,
    });
    return this.#save();
  }

  trade(id) {
    const normalized = tradeId(id);
    const found = this.state.trades.find(
      (candidate) => candidate.tradeId === normalized
    );
    return found ? clone(found) : null;
  }

  #observe(observation) {
    this.state.observations.push(clone(observation));
    this.state.observations = this.state.observations.slice(-512);
  }

  observe(observation = {}) {
    this.#observe({ ...observation, at: observation.at || this.now() });
    return this.#save();
  }

  scrubbedEvidence() {
    const terminalCounts = {};
    for (const trade of this.state.trades) {
      terminalCounts[trade.state] = (terminalCounts[trade.state] || 0) + 1;
    }
    return {
      schema: "versus-fx-cohort-evidence",
      schemaVersion: 1,
      generatedAt: this.now(),
      enabled: this.state.enabled,
      dealerArmed: this.state.policy.armed,
      configuredPositionCount: this.state.positions.filter(
        (position) => position.enabled
      ).length,
      chains: this.state.chains.map((chain) => ({
        chainId: chain.chainId,
        chain: chain.chain,
        enabled: chain.enabled,
        gasReady: chain.gasReady,
        lastCheckedAt: chain.lastCheckedAt,
        lastFailure: chain.lastFailure?.code || null,
      })),
      tradeCount: this.state.trades.length,
      terminalCounts,
      trades: this.state.trades.map((trade) => ({
        tradeId: trade.tradeId,
        role: trade.role || null,
        state: trade.state,
        createdAt: trade.createdAt,
        updatedAt: trade.updatedAt,
        source: trade.source
          ? {
              chainId: trade.source.chainId || null,
              chain: trade.source.chain || null,
              asset: trade.source.asset || null,
              token: trade.source.token || null,
            }
          : null,
        destination: trade.destination
          ? {
              chainId: trade.destination.chainId || null,
              chain: trade.destination.chain || null,
              asset: trade.destination.asset || null,
              token: trade.destination.token || null,
            }
          : null,
        inputAmountAtomic:
          trade.route?.totalInputAtomic ||
          trade.prepared?.inputAmountAtomic ||
          null,
        outputAmountAtomic:
          trade.outputAmountAtomic ||
          trade.route?.outputAmountAtomic ||
          trade.quote?.payload?.outputAmountAtomic ||
          null,
        brokerFeeAtomic: trade.route?.brokerFeeAtomic || null,
        spreadBps:
          trade.route?.spreadBps ||
          trade.quote?.payload?.spreadBps ||
          null,
        confirmations: {
          sourceFunding: trade.fundingVerification?.confirmations || null,
          destination: trade.receipt?.confirmations || null,
        },
        transactionHashes: [
          trade.fundingVerification?.transactionHash,
          trade.receipt?.sourceTransactionHash,
          trade.receipt?.destinationTransactionHash,
          trade.refund?.transactionHash,
          trade.transactionHash,
        ].filter((value, index, values) =>
          /^0x[0-9a-fA-F]{64}$/.test(String(value || "")) &&
          values.indexOf(value) === index
        ),
        timeline: Array.isArray(trade.timeline)
          ? trade.timeline.map((event) => ({
              state: event.state,
              at: event.at,
            }))
          : [],
      })),
      observations: this.state.observations.map((entry) => ({
        at: entry.at,
        tradeId: entry.tradeId || null,
        category: entry.category || null,
        value: entry.value || null,
        durationMs: Number.isFinite(entry.durationMs)
          ? entry.durationMs
          : null,
        failure: entry.failure
          ? String(entry.failure)
              .replace(/0x[a-fA-F0-9]{64}/g, "0x[hash]")
              .replace(/0x[a-fA-F0-9]{40}/g, "0x[address]")
          : null,
        transactionHash:
          /^0x[0-9a-fA-F]{64}$/.test(String(entry.transactionHash || ""))
            ? entry.transactionHash
            : null,
      })),
      endpointPaymentAuthorized: false,
      endpointPaymentSubmitted: false,
      excluded: [
        "private_keys",
        "htlc_secrets",
        "recovery_passwords",
        "recipient_addresses",
        "refund_addresses",
        "exact_private_inventory",
        "endpoint_credentials",
        "private_resource_details",
      ],
    };
  }
}

module.exports = {
  FX_DEFAULT_POLICY,
  FX_DEFAULT_CHAINS,
  FX_DEFAULT_POSITIONS,
  FX_DESKTOP_STATE_VERSION,
  FX_POLICY_BOUNDS,
  FX_TRADE_STATES,
  FxDesktopStore,
  initialState,
  normalizeLoadedState,
};
