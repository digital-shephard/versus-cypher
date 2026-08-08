const {
  getAddress,
  isAddress,
  keccak256,
  toUtf8Bytes,
} = require("ethers");
const { canonicalJson } = require("./fx-protocol");
const {
  FxEvmAdapterError,
  validateEvmAdapterManifest,
  validateOrderedTimeouts,
} = require("./fx-evm-adapter");

const FX_PHASE5_ROUTE_SCHEMA = "versus-fx-phase5-route";
const FX_PHASE5_ROUTE_VERSION = 1;
const FX_PHASE5_ENVIRONMENT = "public-testnet";
const FX_PHASE5_ENVIRONMENTS = new Set(["local-lab", FX_PHASE5_ENVIRONMENT]);
const FX_PHASE5_MAX_INPUT_ATOMIC = 250_000n;
const FX_PHASE5_MAX_OUTPUT_ATOMIC = 250_000n;
const FX_PHASE5_MIN_AMOUNT_ATOMIC = 1_000n;

class FxPhase5RouteError extends Error {
  constructor(message, code = "FX_PHASE5_ROUTE_ERROR") {
    super(message);
    this.name = "FxPhase5RouteError";
    this.code = code;
  }
}

function address(value, label) {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new FxPhase5RouteError(`${label} must be an EVM address`);
  }
  return getAddress(value).toLowerCase();
}

function hash(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new FxPhase5RouteError(`${label} must be bytes32`);
  }
  return normalized;
}

function uint(value, label, {
  minimum = 0n,
  maximum = (1n << 256n) - 1n,
} = {}) {
  let normalized;
  try {
    normalized = BigInt(value);
  } catch {
    throw new FxPhase5RouteError(`${label} must be an unsigned integer`);
  }
  if (normalized < minimum || normalized > maximum) {
    throw new FxPhase5RouteError(`${label} is outside the Phase 5 limit`);
  }
  return normalized;
}

function positiveInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new FxPhase5RouteError(`${label} must be a positive integer`);
  }
  return normalized;
}

function string(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new FxPhase5RouteError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeLeg(input, label, manifest) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new FxPhase5RouteError(`${label} is required`);
  }
  const chainId = String(uint(input.chainId, `${label}.chainId`, { minimum: 1n }));
  const tokenAddress = address(input.tokenAddress, `${label}.tokenAddress`);
  const adapterAddress = address(input.adapterAddress, `${label}.adapterAddress`);
  const capability = manifest.capabilities.find(
    (candidate) =>
      candidate.chainId === chainId &&
      candidate.asset.address === tokenAddress &&
      candidate.adapterAddress === adapterAddress
  );
  if (!capability) {
    throw new FxPhase5RouteError(
      `${label} is not present in the frozen adapter manifest`,
      "UNSUPPORTED_LEG"
    );
  }
  if (input.decimals !== capability.asset.decimals) {
    throw new FxPhase5RouteError(`${label}.decimals does not match the manifest`);
  }
  return {
    chainId,
    name: string(input.name, `${label}.name`),
    rpcEnvironmentVariable: string(
      input.rpcEnvironmentVariable,
      `${label}.rpcEnvironmentVariable`
    ),
    explorerUrl: string(input.explorerUrl, `${label}.explorerUrl`),
    adapterAddress,
    adapterRuntimeCodeHash: hash(
      capability.runtimeCodeHash,
      `${label}.adapterRuntimeCodeHash`
    ),
    tokenAddress,
    tokenRuntimeCodeHash: hash(
      capability.asset.runtimeCodeHash,
      `${label}.tokenRuntimeCodeHash`
    ),
    symbol: capability.asset.symbol,
    decimals: capability.asset.decimals,
    confirmationPolicy: {
      requiredConfirmations: capability.confirmationPolicy.requiredConfirmations,
      reorgSafetyBlocks: capability.confirmationPolicy.reorgSafetyBlocks,
    },
    timeoutPolicy: { ...capability.timeoutPolicy },
  };
}

function routeIdentity(route) {
  const identity = {
    schema: route.schema,
    schemaVersion: route.schemaVersion,
    environment: route.environment,
    deploymentId: route.deploymentId,
    source: route.source,
    destination: route.destination,
    requester: route.requester,
    dealer: route.dealer,
    relayer: route.relayer,
    inputAmountAtomic: route.inputAmountAtomic,
    outputAmountAtomic: route.outputAmountAtomic,
    sourceLockSeconds: route.sourceLockSeconds,
    destinationLockSeconds: route.destinationLockSeconds,
    minimumTimeoutDeltaSeconds: route.minimumTimeoutDeltaSeconds,
  };
  return keccak256(toUtf8Bytes(canonicalJson(identity)));
}

function validatePhase5Route(input, manifestInput, {
  now = Math.floor(Date.now() / 1000),
} = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new FxPhase5RouteError("Phase 5 route is required");
  }
  const manifest = validateEvmAdapterManifest(manifestInput);
  if (
    input.schema !== FX_PHASE5_ROUTE_SCHEMA ||
    input.schemaVersion !== FX_PHASE5_ROUTE_VERSION ||
    !FX_PHASE5_ENVIRONMENTS.has(input.environment)
  ) {
    throw new FxPhase5RouteError("Phase 5 route schema is unsupported");
  }
  if (
    input.enabledByDefault !== false ||
    input.productionWaku !== false ||
    input.productionFunds !== false
  ) {
    throw new FxPhase5RouteError(
      "Phase 5 must remain disabled and disconnected from production",
      "PRODUCTION_CONNECTED"
    );
  }

  const route = {
    schema: FX_PHASE5_ROUTE_SCHEMA,
    schemaVersion: FX_PHASE5_ROUTE_VERSION,
    environment: input.environment,
    deploymentId: hash(input.deploymentId, "deploymentId"),
    enabledByDefault: false,
    productionWaku: false,
    productionFunds: false,
    source: normalizeLeg(input.source, "source", manifest),
    destination: normalizeLeg(input.destination, "destination", manifest),
    requester: address(input.requester, "requester"),
    dealer: address(input.dealer, "dealer"),
    relayer: address(input.relayer, "relayer"),
    inputAmountAtomic: uint(input.inputAmountAtomic, "inputAmountAtomic", {
      minimum: FX_PHASE5_MIN_AMOUNT_ATOMIC,
      maximum: FX_PHASE5_MAX_INPUT_ATOMIC,
    }).toString(),
    outputAmountAtomic: uint(input.outputAmountAtomic, "outputAmountAtomic", {
      minimum: FX_PHASE5_MIN_AMOUNT_ATOMIC,
      maximum: FX_PHASE5_MAX_OUTPUT_ATOMIC,
    }).toString(),
    sourceLockSeconds: positiveInteger(
      input.sourceLockSeconds,
      "sourceLockSeconds"
    ),
    destinationLockSeconds: positiveInteger(
      input.destinationLockSeconds,
      "destinationLockSeconds"
    ),
    minimumTimeoutDeltaSeconds: positiveInteger(
      input.minimumTimeoutDeltaSeconds,
      "minimumTimeoutDeltaSeconds"
    ),
  };
  if (route.source.chainId === route.destination.chainId) {
    throw new FxPhase5RouteError("Phase 5 requires two distinct chains");
  }
  if (route.requester === route.dealer) {
    throw new FxPhase5RouteError("requester and dealer must be distinct");
  }
  const sourceRefundTimestamp = now + route.sourceLockSeconds;
  const destinationRefundTimestamp = now + route.destinationLockSeconds;
  let ordered;
  try {
    ordered = validateOrderedTimeouts({
      now,
      sourceRefundTimestamp,
      destinationRefundTimestamp,
      sourceCapability: manifest.capabilities.find(
        (candidate) =>
          candidate.chainId === route.source.chainId &&
          candidate.adapterAddress === route.source.adapterAddress
      ),
      destinationCapability: manifest.capabilities.find(
        (candidate) =>
          candidate.chainId === route.destination.chainId &&
          candidate.adapterAddress === route.destination.adapterAddress
      ),
    });
  } catch (error) {
    if (error instanceof FxEvmAdapterError) {
      throw new FxPhase5RouteError(error.message, error.code);
    }
    throw error;
  }
  if (ordered.deltaSeconds < route.minimumTimeoutDeltaSeconds) {
    throw new FxPhase5RouteError(
      "route timeout delta is smaller than its advertised minimum",
      "UNSAFE_TIMEOUT_ORDER"
    );
  }
  const computedRouteId = routeIdentity(route);
  if (input.routeId && hash(input.routeId, "routeId") !== computedRouteId) {
    throw new FxPhase5RouteError("routeId does not match route contents");
  }
  return {
    ...route,
    routeId: computedRouteId,
  };
}

function phase5LockId(tradeId, leg) {
  const normalizedTrade = hash(tradeId, "tradeId");
  if (!["source", "destination"].includes(leg)) {
    throw new FxPhase5RouteError("lock leg is unsupported");
  }
  return keccak256(toUtf8Bytes(`${FX_PHASE5_ROUTE_SCHEMA}:${normalizedTrade}:${leg}`));
}

module.exports = {
  FX_PHASE5_ENVIRONMENT,
  FX_PHASE5_MAX_INPUT_ATOMIC,
  FX_PHASE5_MAX_OUTPUT_ATOMIC,
  FX_PHASE5_MIN_AMOUNT_ATOMIC,
  FX_PHASE5_ROUTE_SCHEMA,
  FX_PHASE5_ROUTE_VERSION,
  FxPhase5RouteError,
  phase5LockId,
  routeIdentity,
  validatePhase5Route,
};
