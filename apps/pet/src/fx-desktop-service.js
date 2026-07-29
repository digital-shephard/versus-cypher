const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const {
  Wallet,
  formatUnits,
  isAddress,
  parseUnits,
} = require("ethers");
const { FxRequesterFundingSdk } = require("@versus/network");
const {
  FX_DEFAULT_CHAINS,
  FX_DEFAULT_POSITIONS,
  FxDesktopStore,
} = require("./fx-desktop-store");
const {
  FX_PUBLIC_TESTNET_DEPLOYMENT_ID,
} = require("./fx-desktop-network");

const FX_DESKTOP_DEPLOYMENT_ID = FX_PUBLIC_TESTNET_DEPLOYMENT_ID;

class FxDesktopError extends Error {
  constructor(message, code = "FX_DESKTOP_ERROR") {
    super(message);
    this.name = "FxDesktopError";
    this.code = code;
  }
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FxDesktopError(`${label} is invalid`, "INVALID_INPUT");
  }
  return value;
}

function decimalAtomic(value, decimals, label) {
  try {
    const parsed = parseUnits(String(value || "").trim(), decimals);
    if (parsed <= 0n) throw new Error("zero");
    return parsed.toString();
  } catch {
    throw new FxDesktopError(`${label} must be greater than zero`, "INVALID_AMOUNT");
  }
}

function supportedPositionOf(id, label) {
  const position = FX_DEFAULT_POSITIONS.find(
    (candidate) => candidate.id === id
  );
  if (!position) {
    throw new FxDesktopError(`${label} is unsupported`, "UNSUPPORTED_ASSET");
  }
  return position;
}

function quoteableDealerPositions(snapshot, requireFunding) {
  return snapshot.positions.filter(
    (position) =>
      position.usable &&
      (
        !requireFunding ||
        BigInt(position.availableAtomic || "0") > 0n
      )
  );
}

function usableDealerPositions(snapshot) {
  return snapshot.positions.filter((position) => position.usable);
}

function address(value, label) {
  const normalized = String(value || "").trim();
  if (!isAddress(normalized)) {
    throw new FxDesktopError(`${label} must be a valid address`, "INVALID_ADDRESS");
  }
  return normalized.toLowerCase();
}

function shortAddress(value) {
  const normalized = String(value || "");
  if (normalized.length < 14) return normalized;
  return `${normalized.slice(0, 6)}\u2026${normalized.slice(-4)}`;
}

function atomicDisplay(value, decimals, symbol) {
  return `${formatUnits(BigInt(value), decimals)} ${symbol}`;
}

function normalizedRpcUrl(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new FxDesktopError("Custom RPC URL is invalid", "INVALID_RPC_URL");
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    throw new FxDesktopError(
      "Custom RPC must use HTTPS unless it is local",
      "INVALID_RPC_URL"
    );
  }
  return parsed.toString();
}

function publicRoute(quote) {
  const route = quote.proposal.route;
  const selected = quote.proposal.quotes.find(
    (candidate) => candidate.id === route.quoteId
  );
  if (!selected) {
    throw new FxDesktopError("selected route has no dealer quote", "ROUTE_MISMATCH");
  }
  return {
    proposalId: quote.proposal.proposalId,
    routeId: route.routeId,
    quoteId: route.quoteId,
    broker: quote.proposal.broker,
    dealer: selected.sender,
    inputChainId: route.inputChainId,
    inputToken: route.inputToken,
    dealerInputAtomic: route.dealerInputAmountAtomic,
    brokerFeeAtomic: route.brokerFeeAtomic,
    totalInputAtomic: route.totalInputAtomic,
    outputChainId: route.outputChainId,
    outputToken: route.outputToken,
    outputAmountAtomic: route.outputAmountAtomic,
    spreadBps: selected.payload.spreadBps,
    estimatedCompletionSeconds: selected.payload.estimatedCompletionSeconds,
    expiresAt: Math.min(
      quote.rfq.expiresAt,
      selected.expiresAt,
      quote.proposal.expiresAt
    ),
    brokerAttempts: quote.brokerAttempts,
  };
}

function publicTrade(trade) {
  if (!trade) return null;
  const {
    quote,
    prepared,
    recoveryFile,
    fundingBaseline,
    ...safe
  } = trade;
  return {
    ...safe,
    route: trade.route || (quote ? publicRoute(quote) : null),
    funding: prepared
      ? {
          address: prepared.sourceFundingAddress,
          addressShort: shortAddress(prepared.sourceFundingAddress),
          chainId: prepared.inputChainId,
          token: prepared.inputToken,
          amountAtomic: prepared.inputAmountAtomic,
          expiresAt: prepared.reservation?.payload?.reservationDeadline || null,
        }
      : trade.funding || null,
    endpointPaymentAuthorized: false,
    endpointPaymentSubmitted: false,
  };
}

function brokerEndpointsFromEnvironment(environment = process.env) {
  return String(environment.VERSUS_FX_BROKER_ENDPOINTS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 8);
}

class FxDesktopService extends EventEmitter {
  constructor({
    statePath,
    recoveryDirectory,
    walletProvider,
    recoveryPasswordProvider,
    brokerEndpoints = brokerEndpointsFromEnvironment(),
    deploymentId = FX_DESKTOP_DEPLOYMENT_ID,
    queryRoutes,
    reservationExecutor,
    cancellationExecutor,
    settlementExecutor,
    settlementReconciler,
    refundExecutor,
    destinationVerifier,
    sourceFundingPlanner,
    sourceFundingVerifier,
    dealerController,
    nativeUsdPriceProvider,
    chainReadinessRequired = true,
    refreshMinimumAgeMs = 15_000,
    now = () => Math.floor(Date.now() / 1000),
  } = {}) {
    super();
    if (typeof walletProvider !== "function") {
      throw new TypeError("FX desktop service requires a wallet provider");
    }
    if (typeof recoveryPasswordProvider !== "function") {
      throw new TypeError("FX desktop service requires a recovery password provider");
    }
    this.store = new FxDesktopStore({ filePath: statePath });
    this.recoveryDirectory = path.resolve(recoveryDirectory);
    this.walletProvider = walletProvider;
    this.recoveryPasswordProvider = recoveryPasswordProvider;
    this.brokerEndpoints = [...brokerEndpoints];
    this.deploymentId = deploymentId;
    this.queryRoutes = queryRoutes;
    this.reservationExecutor = reservationExecutor;
    this.cancellationExecutor = cancellationExecutor;
    this.settlementExecutor = settlementExecutor;
    this.settlementReconciler = settlementReconciler;
    this.refundExecutor = refundExecutor;
    this.destinationVerifier = destinationVerifier;
    this.sourceFundingPlanner = sourceFundingPlanner;
    this.sourceFundingVerifier = sourceFundingVerifier;
    this.dealerController = dealerController;
    this.nativeUsdPriceProvider = nativeUsdPriceProvider;
    this.chainReadinessRequired = chainReadinessRequired !== false;
    this.refreshMinimumAgeMs = Math.max(
      5_000,
      Number(refreshMinimumAgeMs) || 15_000
    );
    this.now = now;
    this.requesterOperations = new Set();
    this.lastRefreshAt = 0;
    this.refreshInFlight = null;
    for (const chain of this.store.snapshot().chains || []) {
      if (chain.rpcUrl) {
        this.dealerController?.setRpcUrl?.(chain.chainId, chain.rpcUrl);
      }
    }
  }

  #emit() {
    const snapshot = this.snapshot();
    this.emit("changed", snapshot);
    return snapshot;
  }

  #wallet() {
    const wallet = this.walletProvider();
    if (!wallet?.privateKey) {
      throw new FxDesktopError("local FX identity is unavailable", "WALLET_UNAVAILABLE");
    }
    return new Wallet(wallet.privateKey);
  }

  #sdk() {
    if (this.brokerEndpoints.length === 0 && typeof this.queryRoutes !== "function") {
      throw new FxDesktopError(
        "No FX broker is configured",
        "BROKER_UNAVAILABLE"
      );
    }
    return new FxRequesterFundingSdk({
      deploymentId: this.deploymentId,
      signer: this.#wallet(),
      brokerEndpoints: this.brokerEndpoints.length
        ? this.brokerEndpoints
        : ["http://127.0.0.1"],
      recoveryDirectory: this.recoveryDirectory,
      settlementExecutor: this.settlementExecutor || (async () => {
        throw new FxDesktopError(
          "FX settlement is not configured on this build",
          "SETTLEMENT_UNAVAILABLE"
        );
      }),
      destinationVerifier: this.destinationVerifier || (async () => {
        throw new FxDesktopError(
          "Independent destination verification is unavailable",
          "DESTINATION_VERIFIER_UNAVAILABLE"
        );
      }),
      queryRoutes: this.queryRoutes,
      now: this.now,
    });
  }

  snapshot() {
    const state = this.store.snapshot();
    const dealerStatus = this.dealerController?.status?.().dealer || {
      configured: false,
      active: false,
    };
    const chains = (state.chains || []).map((chain) => ({
      ...chain,
      balanceDisplay: atomicDisplay(
        chain.balanceAtomic || "0",
        chain.nativeDecimals,
        chain.nativeAsset
      ),
      dealerBalanceDisplay: atomicDisplay(
        chain.dealerBalanceAtomic || "0",
        chain.nativeDecimals,
        chain.nativeAsset
      ),
      requesterBalanceDisplay: atomicDisplay(
        chain.requesterBalanceAtomic || "0",
        chain.nativeDecimals,
        chain.nativeAsset
      ),
      balanceUsd:
        Number(BigInt(chain.balanceUsdMicros || "0")) / 1_000_000,
    }));
    const positions = state.positions.map((position) => {
      const chain = chains.find(
        (candidate) => candidate.chainId === position.chainId
      );
      const availableAtomic = BigInt(position.availableAtomic || "0");
      const reservedAtomic = BigInt(position.reservedAtomic || "0");
      const dealerAtomic = BigInt(chain?.dealerBalanceAtomic || "0");
      const dealerUsdMicros = BigInt(chain?.dealerBalanceUsdMicros || "0");
      const nativePriceMicros =
        dealerAtomic > 0n
          ? (dealerUsdMicros * 10n ** 18n) / dealerAtomic
          : 0n;
      return {
        ...position,
        usable:
          position.enabled === true &&
          (
            !this.chainReadinessRequired ||
            (chain?.enabled === true && chain?.dealerGasReady === true)
          ),
        gasReady: chain?.gasReady === true,
        dealerGasReady: chain?.dealerGasReady === true,
        availableUsdMicros:
          position.assetKind === "native"
            ? ((availableAtomic * nativePriceMicros) / 10n ** 18n).toString()
            : availableAtomic.toString(),
        reservedUsdMicros:
          position.assetKind === "native"
            ? ((reservedAtomic * nativePriceMicros) / 10n ** 18n).toString()
            : reservedAtomic.toString(),
      };
    });
    return {
      ...state,
      chains,
      policy: {
        ...state.policy,
        armed: dealerStatus.active === true,
      },
      environment: "public-testnet",
      productionFunds: false,
      brokerConfigured:
        this.brokerEndpoints.length > 0 || typeof this.queryRoutes === "function",
      settlementConfigured:
        typeof this.reservationExecutor === "function" &&
        typeof this.settlementExecutor === "function" &&
        typeof this.destinationVerifier === "function",
      dealerConfigured: dealerStatus.configured === true,
      dealerStatus,
      supportedPositions: FX_DEFAULT_POSITIONS,
      supportedChains: FX_DEFAULT_CHAINS,
      positions,
      trades: state.trades.map(publicTrade),
    };
  }

  async refresh({ force = false } = {}) {
    if (
      !force &&
      this.lastRefreshAt > 0 &&
      Date.now() - this.lastRefreshAt < this.refreshMinimumAgeMs
    ) {
      return this.#emit();
    }
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.#refreshNow().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  async #refreshNow() {
    const state = this.store.snapshot();
    if (state.enabled && this.dealerController?.chainGasSnapshot) {
      let nativeUsdPriceMicros = 0n;
      try {
        const price = await this.nativeUsdPriceProvider?.();
        nativeUsdPriceMicros = BigInt(price || 0);
      } catch {
        nativeUsdPriceMicros = 0n;
      }
      const enabledChains = state.chains.filter((chain) => chain.enabled);
      for (const chain of enabledChains) {
        try {
          const [gas] = await this.dealerController.chainGasSnapshot([chain]);
          const dealerBalanceAtomic = BigInt(
            gas.dealer?.balanceAtomic || 0
          );
          const requesterBalanceAtomic = BigInt(
            gas.requester?.balanceAtomic || 0
          );
          const dealerBalanceUsdMicros =
            nativeUsdPriceMicros > 0n
              ? (dealerBalanceAtomic * nativeUsdPriceMicros) /
                (10n ** BigInt(chain.nativeDecimals))
              : 0n;
          const requesterBalanceUsdMicros =
            nativeUsdPriceMicros > 0n
              ? (requesterBalanceAtomic * nativeUsdPriceMicros) /
                (10n ** BigInt(chain.nativeDecimals))
              : 0n;
          const minimumGasMicros = BigInt(
            Math.round(chain.minimumGasUsd * 1_000_000)
          );
          const dealerGasReady =
            dealerBalanceUsdMicros >= minimumGasMicros;
          const requesterGasReady =
            requesterBalanceUsdMicros >= minimumGasMicros;
          this.store.recordChain(chain.chainId, {
            address: gas.dealer?.address,
            dealerAddress: gas.dealer?.address,
            requesterAddress: gas.requester?.address,
            balanceAtomic: dealerBalanceAtomic.toString(),
            balanceUsdMicros: dealerBalanceUsdMicros.toString(),
            dealerBalanceAtomic: dealerBalanceAtomic.toString(),
            dealerBalanceUsdMicros: dealerBalanceUsdMicros.toString(),
            requesterBalanceAtomic: requesterBalanceAtomic.toString(),
            requesterBalanceUsdMicros: requesterBalanceUsdMicros.toString(),
            dealerGasReady,
            requesterGasReady,
            gasReady: dealerGasReady && requesterGasReady,
            lastCheckedAt: new Date().toISOString(),
            lastFailure: null,
          });
        } catch (error) {
          this.store.recordChain(chain.chainId, {
            dealerGasReady: false,
            requesterGasReady: false,
            gasReady: false,
            lastCheckedAt: new Date().toISOString(),
            lastFailure: {
              code: error.code || "RPC_UNAVAILABLE",
              message: error.message || "Native gas balance is unavailable",
            },
          });
        }
      }
    }
    const refreshed = this.snapshot();
    const usablePositions = refreshed.positions.filter(
      (position) => position.usable
    );
    if (
      state.enabled &&
      usablePositions.length &&
      this.dealerController?.inventorySnapshot
    ) {
      try {
        if (this.dealerController?.status?.().dealer?.active) {
          await this.dealerController.reconcileDealerExposure?.();
        }
        const positions = await this.dealerController.inventorySnapshot(
          usablePositions
        );
        for (const position of positions) {
          this.store.recordPosition(position.id, position);
        }
      } catch (error) {
        this.store.observe({
          category: "inventory",
          value: "stale",
          failure: error.code || "RPC_UNAVAILABLE",
        });
      }
    }
    this.lastRefreshAt = Date.now();
    return this.#emit();
  }

  async refundDealerTrade(tradeId) {
    if (!this.dealerController?.refundDealerTrade) {
      throw new FxDesktopError(
        "Dealer refund execution is unavailable on this build",
        "REFUND_UNAVAILABLE"
      );
    }
    const result = await this.dealerController.refundDealerTrade(tradeId);
    return this.recordRuntimeTrade(result);
  }

  async setEnabled(enabled) {
    if (enabled !== true && this.dealerController?.status?.().dealer?.active) {
      await this.dealerController.disarmDealer();
    }
    this.store.setEnabled(enabled === true);
    if (enabled === true) {
      const dealerAddress =
        this.dealerController?.dealerAddress?.() ||
        this.#wallet().address.toLowerCase();
      for (const position of this.store.snapshot().positions) {
        if (!position.address) {
          this.store.recordPosition(position.id, { address: dealerAddress });
        }
      }
    }
    return this.#emit();
  }

  async setChainSettings(chainId, patch = {}) {
    const state = this.store.snapshot();
    const chain = state.chains.find(
      (candidate) => candidate.chainId === String(chainId)
    );
    if (!chain) {
      throw new FxDesktopError("FX chain is unsupported", "UNSUPPORTED_CHAIN");
    }
    const next = { ...patch };
    if ("rpcUrl" in next) next.rpcUrl = normalizedRpcUrl(next.rpcUrl);
    if ("rpcUrl" in next) {
      this.dealerController?.setRpcUrl?.(chain.chainId, next.rpcUrl);
    }
    if (next.enabled === true && !state.enabled) {
      this.store.setEnabled(true);
    }
    const nativePosition = state.positions.find(
      (position) =>
        position.chainId === chain.chainId &&
        position.assetKind === "native"
    );
    if (next.enabled === false && nativePosition?.enabled) {
      this.store.setPositionEnabled(nativePosition.id, false);
    }
    this.store.setChainSettings(chain.chainId, next);
    if (next.enabled === true && nativePosition && !nativePosition.enabled) {
      this.store.setPositionEnabled(nativePosition.id, true);
    }
    this.lastRefreshAt = 0;
    return this.refresh({ force: true });
  }

  async setPolicy(patch) {
    const requested = object(patch, "FX policy");
    if (requested.armed === true) {
      await this.refresh({ force: true });
    }
    const current = this.snapshot();
    const nextPolicy = { ...current.policy, ...requested };
    if (requested.armed === true) {
      if (!this.dealerController?.armDealer) {
        throw new FxDesktopError(
          "This build cannot run an FX dealer",
          "DEALER_UNAVAILABLE"
        );
      }
      if (!current.enabled) {
        throw new FxDesktopError(
          "Turn on FX before arming the dealer",
          "FX_DISABLED"
        );
      }
      const positions = quoteableDealerPositions(
        current,
        this.chainReadinessRequired
      );
      if (!positions.length) {
        throw new FxDesktopError(
          "Enable a funded chain and at least one inventory asset before dealing",
          "NO_READY_INVENTORY"
        );
      }
      await this.dealerController.armDealer({
        policy: nextPolicy,
        positions: usableDealerPositions(current),
      });
    } else if (
      requested.armed === false &&
      this.dealerController?.status?.().dealer?.active
    ) {
      await this.dealerController.disarmDealer();
    } else if (
      !("armed" in requested) &&
      this.dealerController?.status?.().dealer?.active
    ) {
      await this.dealerController.updateDealer({
        policy: nextPolicy,
        positions: usableDealerPositions(current),
      });
    }
    this.store.setPolicy({
      ...requested,
      armed: this.dealerController?.status?.().dealer?.active === true,
    });
    return this.#emit();
  }

  async setPositionEnabled(id, enabled) {
    if (enabled === true && this.chainReadinessRequired) {
      await this.refresh({ force: true });
      const snapshot = this.snapshot();
      const position = snapshot.positions.find(
        (candidate) => candidate.id === String(id || "")
      );
      const chain = snapshot.chains.find(
        (candidate) => candidate.chainId === position?.chainId
      );
      if (!chain?.enabled || !chain?.dealerGasReady) {
        throw new FxDesktopError(
          `Enable and fund ${chain?.chain || "this chain"} ${chain?.nativeAsset || "gas"} first`,
          "CHAIN_GAS_REQUIRED"
        );
      }
    }
    this.store.setPositionEnabled(String(id || ""), enabled === true);
    if (this.dealerController?.status?.().dealer?.active) {
      const state = this.snapshot();
      await this.dealerController.updateDealer({
        policy: state.policy,
        positions: usableDealerPositions(state),
      });
    }
    return this.#emit();
  }

  async withdrawPosition({ positionId, destination, amount } = {}) {
    if (this.dealerController?.status?.().dealer?.active) {
      throw new FxDesktopError(
        "Disarm FX dealing before withdrawing inventory",
        "DEALER_ACTIVE"
      );
    }
    const snapshot = await this.refresh({ force: true });
    const position = snapshot.positions.find(
      (candidate) =>
        candidate.id === String(positionId || "") &&
        candidate.enabled === true
    );
    if (!position) {
      throw new FxDesktopError(
        "inventory asset is unsupported",
        "UNSUPPORTED_ASSET"
      );
    }
    const recipient = address(destination, "withdrawal destination");
    const amountAtomic = decimalAtomic(
      amount,
      position.decimals,
      "withdrawal amount"
    );
    if (BigInt(amountAtomic) > BigInt(position.availableAtomic || "0")) {
      throw new FxDesktopError(
        "Withdrawal exceeds available inventory",
        "INSUFFICIENT_INVENTORY"
      );
    }
    if (!this.dealerController?.withdrawInventory) {
      throw new FxDesktopError(
        "Inventory withdrawal is unavailable",
        "WITHDRAWAL_UNAVAILABLE"
      );
    }
    const result = await this.dealerController.withdrawInventory({
      chainId: position.chainId,
      token: position.assetAddress,
      destination: recipient,
      amountAtomic,
    });
    this.store.observe({
      category: "inventory_withdrawal",
      value: "confirmed",
      chainId: position.chainId,
      asset: position.asset,
      amountAtomic,
      transactionHash: result.transactionHash,
    });
    this.lastRefreshAt = 0;
    const next = await this.refresh({ force: true });
    return {
      ...next,
      inventoryTransfer: {
        positionId: position.id,
        chainId: position.chainId,
        asset: position.asset,
        amountAtomic,
        transactionHash: result.transactionHash,
      },
    };
  }

  async resumeDealer() {
    const state = this.store.snapshot();
    if (
      !state.enabled ||
      state.policy.armed !== true ||
      !this.dealerController?.armDealer
    ) {
      return this.snapshot();
    }
    await this.refresh({ force: true });
    const snapshot = this.snapshot();
    const positions = quoteableDealerPositions(
      snapshot,
      this.chainReadinessRequired
    );
    if (!positions.length) {
      this.store.setPolicy({ armed: false });
      return this.#emit();
    }
    try {
      await this.dealerController.armDealer({
        policy: state.policy,
        positions: usableDealerPositions(snapshot),
      });
      this.store.setPolicy({ armed: true });
    } catch (error) {
      this.store.setPolicy({ armed: false });
      this.store.observe({
        category: "dealer_resume",
        value: "failed",
        failure: error.code || "DEALER_RESUME_FAILED",
      });
    }
    return this.#emit();
  }

  recordPosition(id, patch) {
    this.store.recordPosition(String(id || ""), object(patch, "position"));
    return this.#emit();
  }

  async requestQuote({
    sourcePositionId,
    destinationPositionId,
    outputAmount,
    destinationAddress,
    sourceRefundAddress,
  } = {}) {
    const snapshot = this.store.snapshot();
    if (!snapshot.enabled) {
      throw new FxDesktopError("Enable the FX lab before requesting a quote", "FX_DISABLED");
    }
    const source = supportedPositionOf(sourcePositionId, "source asset");
    const destination = supportedPositionOf(
      destinationPositionId,
      "destination asset"
    );
    if (source.id === destination.id) {
      throw new FxDesktopError("Choose two different networks", "SAME_ASSET");
    }
    const outputAtomic = decimalAtomic(
      outputAmount,
      destination.decimals,
      "receive amount"
    );
    const usesNative =
      source.assetKind === "native" || destination.assetKind === "native";
    let nativeUsdPriceMicros = 1_000_000n;
    if (usesNative) {
      try {
        nativeUsdPriceMicros = BigInt(await this.nativeUsdPriceProvider?.());
      } catch {
        nativeUsdPriceMicros = 0n;
      }
      if (nativeUsdPriceMicros <= 0n) {
        throw new FxDesktopError(
          "A fresh trusted ETH/USD quote is required",
          "STALE_PRICE"
        );
      }
    }
    const outputUsdMicros =
      destination.assetKind === "native"
        ? (BigInt(outputAtomic) * nativeUsdPriceMicros) / 10n ** 18n
        : BigInt(outputAtomic);
    const recipient = address(destinationAddress, "destination");
    const refund = address(
      sourceRefundAddress || this.#wallet().address,
      "refund address"
    );
    const maximumInputUsdMicros =
      (outputUsdMicros * BigInt(10_000 + snapshot.policy.maximumOverheadBps) +
        9_999n) /
      10_000n;
    const maximumInputAtomic =
      source.assetKind === "native"
        ? (
            (maximumInputUsdMicros * 10n ** 18n +
              nativeUsdPriceMicros -
              1n) /
            nativeUsdPriceMicros
          ).toString()
        : maximumInputUsdMicros.toString();
    const startedAt = Date.now();
    const sdk = this.#sdk();
    let quote;
    try {
      quote = await sdk.quoteFunding({
        requirement: {
          source: "manual",
          outputChainId: destination.chainId,
          outputToken: destination.assetAddress,
          outputAmountAtomic: outputAtomic,
        },
        destinationAddress: recipient,
        sourceRefundAddress: refund,
        inputOptions: [{
          chainId: source.chainId,
          token: source.assetAddress,
          maxInputAtomic: maximumInputAtomic,
        }],
        inputChainId: source.chainId,
        inputToken: source.assetAddress,
        quoteLifetimeSeconds: snapshot.policy.quoteLifetimeSeconds,
        settlementLifetimeSeconds: 7_200,
      });
    } catch (error) {
      this.store.observe({
        category: "quote",
        value: "failed",
        durationMs: Date.now() - startedAt,
        failure: error.code || "QUOTE_FAILED",
      });
      this.#emit();
      throw error;
    }
    const route = publicRoute(quote);
    const trade = {
      tradeId: quote.tradeId,
      role: "requester",
      state: "quoted",
      sourcePositionId: source.id,
      destinationPositionId: destination.id,
      source: {
        chainId: source.chainId,
        chain: source.chain,
        asset: source.asset,
        decimals: source.decimals,
        token: source.assetAddress,
      },
      destination: {
        chainId: destination.chainId,
        chain: destination.chain,
        asset: destination.asset,
        decimals: destination.decimals,
        token: destination.assetAddress,
        address: recipient,
        addressShort: shortAddress(recipient),
      },
      refundAddress: refund,
      outputAmountAtomic: outputAtomic,
      outputAmountDisplay: atomicDisplay(
        outputAtomic,
        destination.decimals,
        destination.asset
      ),
      inputAmountDisplay: atomicDisplay(
        route.totalInputAtomic,
        source.decimals,
        source.asset
      ),
      route,
      quote,
      timeline: [{ state: "quoted", at: new Date().toISOString() }],
      endpointPaymentAuthorized: false,
      endpointPaymentSubmitted: false,
    };
    this.store.putTrade(trade);
    this.store.observe({
      tradeId: trade.tradeId,
      category: "quote",
      value: "accepted_by_client",
      durationMs: Date.now() - startedAt,
    });
    this.#emit();
    return publicTrade(trade);
  }

  async acceptQuote(tradeId) {
    const stored = this.store.trade(tradeId);
    if (!stored || stored.state !== "quoted" || !stored.quote) {
      throw new FxDesktopError("Quote is unavailable or already used", "QUOTE_UNAVAILABLE");
    }
    const password = await this.recoveryPasswordProvider();
    const prepared = await this.#sdk().prepareExternalFunding({
      quote: stored.quote,
      recoveryPassword: password,
      ownerApproved: true,
    });
    if (typeof this.reservationExecutor !== "function") {
      throw new FxDesktopError(
        "Dealer reservation is unavailable",
        "RESERVATION_UNAVAILABLE"
      );
    }
    const reservation = await this.reservationExecutor({
      proposal: prepared.proposal,
      acceptance: prepared.acceptance,
      requester: prepared.requester,
    });
    if (
      reservation?.type !== "fx_reserve" ||
      reservation.tradeId !== prepared.tradeId ||
      reservation.payload?.acceptId !== prepared.acceptance.id ||
      !Number.isSafeInteger(Number(reservation.payload?.reservationDeadline)) ||
      Number(reservation.payload.reservationDeadline) <= this.now()
    ) {
      throw new FxDesktopError(
        "Dealer returned an invalid reservation",
        "RESERVATION_MISMATCH"
      );
    }
    const reservedPrepared = {
      ...prepared,
      reservation,
    };
    if (typeof this.sourceFundingPlanner !== "function") {
      throw new FxDesktopError(
        "Source funding preparation is unavailable",
        "SOURCE_PLANNER_UNAVAILABLE"
      );
    }
    const fundingBaseline = await this.sourceFundingPlanner({
      trade: publicTrade(stored),
      prepared: reservedPrepared,
    });
    const next = {
      ...stored,
      state: "awaiting_source_funds",
      prepared: reservedPrepared,
      fundingBaseline,
      recoveryPersisted: fs.existsSync(reservedPrepared.recoveryFile),
      funding: {
        address: reservedPrepared.sourceFundingAddress,
        addressShort: shortAddress(reservedPrepared.sourceFundingAddress),
        chainId: reservedPrepared.inputChainId,
        token: reservedPrepared.inputToken,
        amountAtomic: reservedPrepared.inputAmountAtomic,
        expiresAt: reservation.payload.reservationDeadline,
      },
      timeline: [
        ...(stored.timeline || []),
        { state: "accepted", at: new Date().toISOString() },
        { state: "reserved", at: new Date().toISOString() },
        { state: "awaiting_source_funds", at: new Date().toISOString() },
      ],
    };
    this.store.putTrade(next);
    this.#emit();
    return publicTrade(next);
  }

  async checkFunding(tradeId) {
    if (this.requesterOperations.has(tradeId)) {
      throw new FxDesktopError(
        "Another action is already running for this swap",
        "TRADE_BUSY"
      );
    }
    this.requesterOperations.add(tradeId);
    try {
      const stored = this.store.trade(tradeId);
      if (!stored || !stored.prepared) {
        throw new FxDesktopError(
          "Prepared funding is unavailable",
          "TRADE_UNAVAILABLE"
        );
      }
      if (stored.state === "funds_ready" || stored.state === "complete") {
        return publicTrade(stored);
      }
      if (stored.state !== "awaiting_source_funds") {
        throw new FxDesktopError(
          "Settlement has already started. Check its chain status instead.",
          "RECONCILIATION_REQUIRED"
        );
      }
      const reservationDeadline = Number(
        stored.prepared.reservation?.payload?.reservationDeadline || 0
      );
      if (
        !Number.isSafeInteger(reservationDeadline) ||
        reservationDeadline <= this.now()
      ) {
        const expired = {
          ...stored,
          state: "failed",
          lastFailure: {
            code: "FUNDING_WINDOW_EXPIRED",
            message:
              "The dealer reservation expired before settlement. Any received source funds remain in the local FX wallet",
            at: new Date().toISOString(),
          },
          timeline: [
            ...(stored.timeline || []),
            { state: "failed", at: new Date().toISOString() },
          ],
        };
        this.store.putTrade(expired);
        this.store.observe({
          tradeId,
          category: "settlement",
          value: "funding_window_expired",
          failure: "FUNDING_WINDOW_EXPIRED",
        });
        this.#emit();
        return publicTrade(expired);
      }
      if (typeof this.sourceFundingVerifier !== "function") {
        throw new FxDesktopError(
          "Source funding verification is unavailable",
          "SOURCE_VERIFIER_UNAVAILABLE"
        );
      }
      const observation = await this.sourceFundingVerifier({
        trade: publicTrade(stored),
        prepared: stored.prepared,
        fundingBaseline: stored.fundingBaseline,
      });
      if (this.store.trade(tradeId)?.state !== "awaiting_source_funds") {
        throw new FxDesktopError(
          "The swap changed while funding was being checked",
          "TRADE_STATE_CHANGED"
        );
      }
      if (
        observation?.confirmed !== true ||
        BigInt(observation.amountAtomic || 0) <
          BigInt(stored.prepared.inputAmountAtomic)
      ) {
        return {
          detected: false,
          requiredAtomic: stored.prepared.inputAmountAtomic,
          observedAtomic: String(observation?.amountAtomic || "0"),
        };
      }
      const password = await this.recoveryPasswordProvider();
      const sourceConfirmed = {
        ...stored,
        state: "source_lock_pending",
        sourceFundingObservation: {
          confirmed: true,
          amountAtomic: String(observation.amountAtomic),
          confirmations: Number(observation.confirmations || 1),
          transactionHash: observation.transactionHash || null,
        },
        timeline: [
          ...(stored.timeline || []),
          { state: "source_funds_detected", at: new Date().toISOString() },
          { state: "source_lock_pending", at: new Date().toISOString() },
        ],
      };
      this.store.putTrade(sourceConfirmed);
      this.#emit();
      let result;
      try {
        result = await this.#sdk().executePreparedFunding({
          prepared: stored.prepared,
          recoveryPassword: password,
        });
      } catch (error) {
        this.store.putTrade({
          ...this.store.trade(tradeId),
          state: "source_lock_pending",
          lastFailure: {
            code: error.code || "SETTLEMENT_UNCERTAIN",
            message: error.message || "Settlement status is uncertain",
            at: new Date().toISOString(),
          },
        });
        this.store.observe({
          tradeId,
          category: "settlement",
          value: "uncertain",
          failure: error.code || "SETTLEMENT_UNCERTAIN",
        });
        this.#emit();
        throw error;
      }
      const completed = {
        ...this.store.trade(tradeId),
        state: "funds_ready",
        receipt: result.receipt,
        timeline: [
          ...(this.store.trade(tradeId)?.timeline || []),
          { state: "funds_ready", at: new Date().toISOString() },
        ],
        endpointPaymentAuthorized: false,
        endpointPaymentSubmitted: false,
      };
      this.store.putTrade(completed);
      this.store.observe({
        tradeId,
        category: "settlement",
        value: "funds_ready",
      });
      this.#emit();
      return publicTrade(completed);
    } finally {
      this.requesterOperations.delete(tradeId);
    }
  }

  async cancelTrade(tradeId) {
    if (this.requesterOperations.has(tradeId)) {
      throw new FxDesktopError(
        "Another action is already running for this swap",
        "TRADE_BUSY"
      );
    }
    this.requesterOperations.add(tradeId);
    try {
      const stored = this.store.trade(tradeId);
      if (!stored?.prepared || stored.state !== "awaiting_source_funds") {
        throw new FxDesktopError(
          "Only an unfunded reserved swap can be cancelled",
          "CANCELLATION_UNAVAILABLE"
        );
      }
      if (typeof this.cancellationExecutor !== "function") {
        throw new FxDesktopError(
          "Network cancellation is unavailable",
          "CANCELLATION_UNAVAILABLE"
        );
      }
      const cancellation = await this.cancellationExecutor({
        acceptance: stored.prepared.acceptance,
        reserve: stored.prepared.reservation,
      });
      if (
        cancellation?.type !== "fx_cancel" ||
        cancellation.tradeId !== stored.tradeId ||
        cancellation.sender !== stored.prepared.requester ||
        cancellation.payload?.acceptId !== stored.prepared.acceptance.id ||
        cancellation.payload?.reserveId !== stored.prepared.reservation.id
      ) {
        throw new FxDesktopError(
          "Network returned an invalid cancellation",
          "CANCELLATION_MISMATCH"
        );
      }
      const cancelled = {
        ...stored,
        state: "cancelled",
        cancellation: {
          id: cancellation.id,
          reason: cancellation.payload.reason,
        },
        timeline: [
          ...(stored.timeline || []),
          { state: "cancelled", at: new Date().toISOString() },
        ],
      };
      this.store.putTrade(cancelled);
      this.store.observe({
        tradeId,
        category: "settlement",
        value: "cancelled_before_source_lock",
      });
      this.#emit();
      return publicTrade(cancelled);
    } finally {
      this.requesterOperations.delete(tradeId);
    }
  }

  async reconcileTrade(tradeId) {
    const stored = this.store.trade(tradeId);
    if (!stored || !stored.prepared) {
      throw new FxDesktopError("Trade recovery is unavailable", "TRADE_UNAVAILABLE");
    }
    if (stored.state === "funds_ready" || stored.state === "complete") {
      return publicTrade(stored);
    }
    if (typeof this.settlementReconciler !== "function") {
      throw new FxDesktopError(
        "Chain reconciliation is unavailable on this build",
        "RECONCILER_UNAVAILABLE"
      );
    }
    const password = await this.recoveryPasswordProvider();
    const result = await this.settlementReconciler({
      trade: publicTrade(stored),
      prepared: stored.prepared,
      recoveryPassword: password,
    });
    if (!result || typeof result !== "object" || !result.state) {
      throw new FxDesktopError(
        "Chain reconciliation returned no usable state",
        "RECONCILER_INVALID"
      );
    }
    const next = {
      ...stored,
      state: result.state,
      receipt: result.receipt || stored.receipt,
      refund: result.refund || stored.refund,
      lastFailure: result.lastFailure || null,
      timeline: Array.isArray(result.timeline)
        ? result.timeline
        : stored.timeline,
    };
    this.store.putTrade(next);
    this.store.observe({
      tradeId,
      category: "recovery",
      value: result.state,
    });
    this.#emit();
    return publicTrade(next);
  }

  async refundTrade(tradeId) {
    const stored = this.store.trade(tradeId);
    if (!stored || !stored.prepared) {
      throw new FxDesktopError("Trade recovery is unavailable", "TRADE_UNAVAILABLE");
    }
    if (stored.state === "refunded") return publicTrade(stored);
    if (stored.state !== "refund_wait" || stored.refund?.eligible !== true) {
      throw new FxDesktopError(
        "The source lock is not refundable yet",
        "REFUND_NOT_READY"
      );
    }
    if (typeof this.refundExecutor !== "function") {
      throw new FxDesktopError(
        "Refund execution is unavailable on this build",
        "REFUND_UNAVAILABLE"
      );
    }
    const result = await this.refundExecutor({
      trade: publicTrade(stored),
      prepared: stored.prepared,
    });
    if (result?.state !== "refunded") {
      throw new FxDesktopError(
        "Refund transaction was not confirmed",
        "REFUND_UNCONFIRMED"
      );
    }
    const next = {
      ...stored,
      state: "refunded",
      refund: result.refund,
      lastFailure: null,
      timeline: [
        ...(stored.timeline || []),
        { state: "refunded", at: new Date().toISOString() },
      ],
    };
    this.store.putTrade(next);
    this.store.observe({
      tradeId,
      category: "refund",
      value: "confirmed",
    });
    this.#emit();
    return publicTrade(next);
  }

  recordRuntimeTrade(update = {}) {
    const tradeId = String(update.tradeId || "").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(tradeId)) return this.snapshot();
    const previous = this.store.trade(tradeId);
    const state = String(update.state || previous?.state || "requesting");
    const timeline = previous?.timeline || [];
    const lastState = timeline.at(-1)?.state;
    const quotePayload = update.quote?.payload || previous?.quote?.payload || null;
    const supported = this.store.snapshot().positions;
    const sourcePosition = quotePayload
      ? supported.find(
          (position) =>
            position.chainId === quotePayload.inputChainId &&
            position.assetAddress.toLowerCase() ===
              String(quotePayload.inputToken || "").toLowerCase()
        )
      : null;
    const destinationPosition = quotePayload
      ? supported.find(
          (position) =>
            position.chainId === quotePayload.outputChainId &&
            position.assetAddress.toLowerCase() ===
              String(quotePayload.outputToken || "").toLowerCase()
        )
      : null;
    const source = previous?.source || (sourcePosition
      ? {
          chainId: sourcePosition.chainId,
          chain: sourcePosition.chain,
          asset: sourcePosition.asset,
          decimals: sourcePosition.decimals,
          token: sourcePosition.assetAddress,
        }
      : update.source || null);
    const destination = previous?.destination || (destinationPosition
      ? {
          chainId: destinationPosition.chainId,
          chain: destinationPosition.chain,
          asset: destinationPosition.asset,
          decimals: destinationPosition.decimals,
          token: destinationPosition.assetAddress,
        }
      : update.destination || null);
    const route = previous?.route || (quotePayload
      ? {
          dealer: update.quote?.sender || null,
          inputChainId: quotePayload.inputChainId,
          inputToken: quotePayload.inputToken,
          totalInputAtomic: quotePayload.inputAmountAtomic,
          outputChainId: quotePayload.outputChainId,
          outputToken: quotePayload.outputToken,
          outputAmountAtomic: quotePayload.outputAmountAtomic,
          brokerFeeAtomic: "0",
          spreadBps: quotePayload.spreadBps,
          estimatedCompletionSeconds:
            quotePayload.estimatedCompletionSeconds,
        }
      : null);
    this.store.putTrade({
      ...(previous || {
        tradeId,
        role: update.role || "dealer",
        source,
        destination,
        outputAmountDisplay:
          update.outputAmountDisplay ||
          (
            quotePayload && destinationPosition
              ? atomicDisplay(
                  quotePayload.outputAmountAtomic,
                  destinationPosition.decimals,
                  destinationPosition.asset
                )
              : null
          ),
      }),
      ...update,
      tradeId,
      state,
      source,
      destination,
      route,
      inputAmountDisplay:
        previous?.inputAmountDisplay ||
        (
          quotePayload && sourcePosition
            ? atomicDisplay(
                quotePayload.inputAmountAtomic,
                sourcePosition.decimals,
                sourcePosition.asset
              )
            : null
        ),
      outputAmountAtomic:
        previous?.outputAmountAtomic ||
        quotePayload?.outputAmountAtomic ||
        null,
      timeline: lastState === state
        ? timeline
        : [...timeline, { state, at: new Date().toISOString() }],
    });
    return this.#emit();
  }

  trade(tradeId) {
    return publicTrade(this.store.trade(tradeId));
  }

  exportEvidence(filePath) {
    const evidence = this.store.scrubbedEvidence();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return filePath;
  }
}

module.exports = {
  FX_DESKTOP_DEPLOYMENT_ID,
  FxDesktopError,
  FxDesktopService,
  atomicDisplay,
  brokerEndpointsFromEnvironment,
  publicTrade,
  shortAddress,
};
