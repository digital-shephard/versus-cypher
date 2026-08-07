const { getAddress, isAddress, keccak256, toUtf8Bytes } = require("ethers");
const { FX_NATIVE_EVM_ADDRESS } = require("./fx-protocol");

const FX_MARKET_SCHEMA = "versus-fx-market-candidate";
const FX_MARKET_SCHEMA_VERSION = 1;
const FX_STABLE_SYMBOLS = Object.freeze(["USDC", "EURC"]);
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;

class FxMarketConfigError extends Error {
  constructor(message, code = "INVALID_FX_MARKET") {
    super(message);
    this.name = "FxMarketConfigError";
    this.code = code;
  }
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FxMarketConfigError(`${label} must be an object`);
  }
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new FxMarketConfigError(`${label} must be a positive integer`);
  }
  return value;
}

function positiveAtomic(value, label) {
  const normalized = String(value || "");
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new FxMarketConfigError(`${label} must be positive atomic units`);
  }
  return normalized;
}

function nonnegativeAtomic(value, label) {
  const normalized = String(value ?? "");
  if (!/^\d+$/.test(normalized)) {
    throw new FxMarketConfigError(`${label} must be nonnegative atomic units`);
  }
  return normalized;
}

function address(value, label) {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new FxMarketConfigError(`${label} must be an EVM address`);
  }
  return getAddress(value).toLowerCase();
}

function hash(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (!HASH_PATTERN.test(normalized)) {
    throw new FxMarketConfigError(`${label} must be a bytes32 hash`);
  }
  return normalized;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeAsset(value, chain, index) {
  const label = `chains[${chain.chainId}].assets[${index}]`;
  object(value, label);
  const symbol = String(value.symbol || "").toUpperCase();
  const kind = String(value.kind || "");
  if (!/^[A-Z0-9]{2,12}$/.test(symbol)) {
    throw new FxMarketConfigError(`${label}.symbol is invalid`);
  }
  if (!["native", "erc20"].includes(kind)) {
    throw new FxMarketConfigError(`${label}.kind is invalid`);
  }
  const token = kind === "native"
    ? FX_NATIVE_EVM_ADDRESS
    : address(value.token, `${label}.token`);
  const decimals = positiveInteger(value.decimals, `${label}.decimals`);
  if (decimals > 255) {
    throw new FxMarketConfigError(`${label}.decimals is invalid`);
  }
  const stable = value.stable === true;
  if (stable !== FX_STABLE_SYMBOLS.includes(symbol)) {
    throw new FxMarketConfigError(`${label}.stable does not match its symbol`);
  }
  if ((value.x402ExactInput === true) !== stable) {
    throw new FxMarketConfigError(
      `${label}.x402ExactInput must be enabled only for frozen stablecoins`
    );
  }
  const normalized = {
    positionId: `${chain.chainId}:${token}`,
    symbol,
    kind,
    token,
    decimals,
    stable,
    x402ExactInput: value.x402ExactInput === true,
  };
  if (kind === "erc20") {
    const name = String(value.name || "").trim();
    const eip712Version = String(value.eip712Version || "").trim();
    if (!name || !eip712Version) {
      throw new FxMarketConfigError(`${label} is missing EIP-3009 metadata`);
    }
    return {
      ...normalized,
      name,
      eip712Version,
      runtimeCodeHash: hash(value.runtimeCodeHash, `${label}.runtimeCodeHash`),
      domainSeparator: hash(value.domainSeparator, `${label}.domainSeparator`),
    };
  }
  return normalized;
}

function normalizeChain(value, index) {
  const label = `chains[${index}]`;
  object(value, label);
  const chainId = String(BigInt(value.chainId));
  const name = String(value.name || "").trim();
  const nativeSymbol = String(value.nativeSymbol || "").toUpperCase();
  if (!name || !/^[A-Z0-9]{2,12}$/.test(nativeSymbol)) {
    throw new FxMarketConfigError(`${label} identity is invalid`);
  }
  if (!Array.isArray(value.assets) || value.assets.length !== 3) {
    throw new FxMarketConfigError(`${label} must freeze exactly three assets`);
  }
  const shell = { chainId, name, nativeSymbol };
  const assets = value.assets.map((asset, assetIndex) =>
    normalizeAsset(asset, shell, assetIndex)
  );
  if (new Set(assets.map((asset) => asset.token)).size !== assets.length) {
    throw new FxMarketConfigError(`${label} repeats an asset token`);
  }
  if (
    assets.filter((asset) => asset.kind === "native").length !== 1 ||
    assets.find((asset) => asset.kind === "native")?.symbol !== nativeSymbol
  ) {
    throw new FxMarketConfigError(`${label} must bind its named native asset`);
  }
  for (const stable of FX_STABLE_SYMBOLS) {
    if (!assets.some((asset) => asset.symbol === stable && asset.stable)) {
      throw new FxMarketConfigError(`${label} is missing ${stable}`);
    }
  }
  return {
    ...shell,
    rpcEnvironmentVariable: (() => {
      const variable = String(value.rpcEnvironmentVariable || "");
      if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(variable)) {
        throw new FxMarketConfigError(`${label}.rpcEnvironmentVariable is invalid`);
      }
      return variable;
    })(),
    nativeGasReserveAtomic: positiveAtomic(
      value.nativeGasReserveAtomic,
      `${label}.nativeGasReserveAtomic`
    ),
    minimumGasUsd: positiveInteger(
      value.minimumGasUsd,
      `${label}.minimumGasUsd`
    ),
    requiredConfirmations: positiveInteger(
      value.requiredConfirmations,
      `${label}.requiredConfirmations`
    ),
    reorgSafetyBlocks: positiveInteger(
      value.reorgSafetyBlocks,
      `${label}.reorgSafetyBlocks`
    ),
    assets,
  };
}

function buildFxMarketRoutes(market) {
  const positions = market.chains.flatMap((chain) =>
    chain.assets.map((asset) => ({
      chainId: chain.chainId,
      chainName: chain.name,
      ...asset,
    }))
  );
  return positions.flatMap((input) => positions
    .filter((output) => output.positionId !== input.positionId)
    .map((output) => ({
      routeId: `${input.positionId}->${output.positionId}`,
      input,
      output,
      sameChain: input.chainId === output.chainId,
      x402ExactEligible: input.x402ExactInput,
    }))
  );
}

function validateFxMarketConfig(input) {
  object(input, "market");
  if (
    input.schema !== FX_MARKET_SCHEMA ||
    input.schemaVersion !== FX_MARKET_SCHEMA_VERSION
  ) {
    throw new FxMarketConfigError("market schema is unsupported");
  }
  if (!Array.isArray(input.chains) || input.chains.length !== 2) {
    throw new FxMarketConfigError("market must freeze exactly two chains");
  }
  const chains = input.chains.map(normalizeChain);
  chains.sort((left, right) => BigInt(left.chainId) < BigInt(right.chainId) ? -1 : 1);
  if (new Set(chains.map((chain) => chain.chainId)).size !== chains.length) {
    throw new FxMarketConfigError("market repeats a chain");
  }
  object(input.timeoutPolicy, "timeoutPolicy");
  object(input.economics, "economics");
  const normalized = {
    schema: FX_MARKET_SCHEMA,
    schemaVersion: FX_MARKET_SCHEMA_VERSION,
    releaseStage: String(input.releaseStage || ""),
    sameChainRoutes: input.sameChainRoutes === true,
    chains,
    timeoutPolicy: {
      minimumSeconds: positiveInteger(input.timeoutPolicy.minimumSeconds, "timeoutPolicy.minimumSeconds"),
      maximumSeconds: positiveInteger(input.timeoutPolicy.maximumSeconds, "timeoutPolicy.maximumSeconds"),
      minimumCrossChainDeltaSeconds: positiveInteger(
        input.timeoutPolicy.minimumCrossChainDeltaSeconds,
        "timeoutPolicy.minimumCrossChainDeltaSeconds"
      ),
      destinationRelayWindowSeconds: positiveInteger(
        input.timeoutPolicy.destinationRelayWindowSeconds,
        "timeoutPolicy.destinationRelayWindowSeconds"
      ),
      genericQuoteLifetimeSeconds: positiveInteger(
        input.timeoutPolicy.genericQuoteLifetimeSeconds,
        "timeoutPolicy.genericQuoteLifetimeSeconds"
      ),
      settlementLifetimeSeconds: positiveInteger(
        input.timeoutPolicy.settlementLifetimeSeconds,
        "timeoutPolicy.settlementLifetimeSeconds"
      ),
    },
    economics: {
      defaultDealerSpreadBps: positiveInteger(
        input.economics.defaultDealerSpreadBps,
        "economics.defaultDealerSpreadBps"
      ),
      facilitatorFeeAtomic: nonnegativeAtomic(
        input.economics.facilitatorFeeAtomic,
        "economics.facilitatorFeeAtomic"
      ),
      onchainMaximumTrade: input.economics.onchainMaximumTrade,
      operatorLimitsAreOffchain: input.economics.operatorLimitsAreOffchain === true,
    },
  };
  if (!/^(public-testnet|mainnet)-v1-candidate$/.test(normalized.releaseStage)) {
    throw new FxMarketConfigError("releaseStage is unsupported");
  }
  if (normalized.economics.defaultDealerSpreadBps > 10_000) {
    throw new FxMarketConfigError("default dealer spread cannot exceed 10000 bps");
  }
  if (
    normalized.timeoutPolicy.minimumSeconds >=
      normalized.timeoutPolicy.maximumSeconds ||
    normalized.timeoutPolicy.minimumCrossChainDeltaSeconds >=
      normalized.timeoutPolicy.maximumSeconds ||
    normalized.timeoutPolicy.destinationRelayWindowSeconds >=
      normalized.timeoutPolicy.maximumSeconds ||
    normalized.timeoutPolicy.settlementLifetimeSeconds >
      normalized.timeoutPolicy.maximumSeconds
  ) {
    throw new FxMarketConfigError("timeout policy is internally inconsistent");
  }
  if (!normalized.sameChainRoutes) {
    throw new FxMarketConfigError("mainnet candidate must enable same-chain routes");
  }
  if (
    normalized.economics.onchainMaximumTrade !== null ||
    !normalized.economics.operatorLimitsAreOffchain
  ) {
    throw new FxMarketConfigError("trade ceilings must remain operator policy");
  }
  const marketId = keccak256(toUtf8Bytes(canonicalJson(normalized)));
  if (input.marketId != null && String(input.marketId).toLowerCase() !== marketId) {
    throw new FxMarketConfigError("marketId does not match the frozen market");
  }
  const routes = buildFxMarketRoutes(normalized);
  if (routes.length !== 30 || routes.filter((route) => route.sameChain).length !== 12) {
    throw new FxMarketConfigError("market route matrix is incomplete");
  }
  return { ...normalized, marketId, routes };
}

module.exports = {
  FX_MARKET_SCHEMA,
  FX_MARKET_SCHEMA_VERSION,
  FX_STABLE_SYMBOLS,
  FxMarketConfigError,
  buildFxMarketRoutes,
  validateFxMarketConfig,
};
