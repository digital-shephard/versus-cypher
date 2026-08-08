const {
  Interface,
  getAddress,
  isAddress,
  keccak256,
} = require("ethers");

const EVM_ADAPTER_SCHEMA = "versus-fx-adapter-capabilities";
const EVM_ADAPTER_SCHEMA_VERSION = 1;
const EVM_ADAPTER_ID = "evm-htlc";
const EVM_ADAPTER_VERSION = 1;
const EVM_ADAPTER_SOURCE_TAG = "agentic-fx-phase3-v1";

const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const UNSUPPORTED_TOKEN_FEATURES = Object.freeze([
  "feeOnTransfer",
  "rebasing",
  "callbacks",
]);
const ISSUER_CONTROL_POLICIES = Object.freeze(["none", "documented"]);

const ADAPTER_INTERFACE = new Interface([
  "function ADAPTER_VERSION() view returns (uint16)",
  "function asset() view returns (address)",
  "function assetDecimals() view returns (uint8)",
  "function minimumLockDuration() view returns (uint64)",
  "function maximumLockDuration() view returns (uint64)",
]);
const TOKEN_INTERFACE = new Interface([
  "function decimals() view returns (uint8)",
]);

class FxEvmAdapterError extends Error {
  constructor(message, code = "INVALID_EVM_ADAPTER") {
    super(message);
    this.name = "FxEvmAdapterError";
    this.code = code;
  }
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FxEvmAdapterError(`${label} must be an object`);
  }
}

function normalizeAddress(value, label) {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new FxEvmAdapterError(`${label} must be an EVM address`);
  }
  return getAddress(value).toLowerCase();
}

function normalizeHash(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (!HASH_PATTERN.test(normalized)) {
    throw new FxEvmAdapterError(`${label} must be a bytes32 hash`);
  }
  return normalized;
}

function normalizeString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new FxEvmAdapterError(`${label} must be a non-empty string`);
  }
  return value;
}

function normalizeUint(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const normalized = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < minimum ||
    normalized > maximum
  ) {
    throw new FxEvmAdapterError(`${label} is outside its supported range`);
  }
  return normalized;
}

function normalizeCapability(input, index) {
  const label = `capabilities[${index}]`;
  assertObject(input, label);
  assertObject(input.asset, `${label}.asset`);
  assertObject(input.asset.features, `${label}.asset.features`);
  assertObject(input.confirmationPolicy, `${label}.confirmationPolicy`);
  assertObject(input.timeoutPolicy, `${label}.timeoutPolicy`);

  const features = {};
  for (const feature of UNSUPPORTED_TOKEN_FEATURES) {
    if (input.asset.features[feature] !== false) {
      throw new FxEvmAdapterError(
        `${label}.asset.features.${feature} must be false`,
        "UNSUPPORTED_TOKEN"
      );
    }
    features[feature] = false;
  }
  if (!ISSUER_CONTROL_POLICIES.includes(input.asset.features.issuerControls)) {
    throw new FxEvmAdapterError(
      `${label}.asset.features.issuerControls must be none or documented`
    );
  }
  features.issuerControls = input.asset.features.issuerControls;
  const minimumSeconds = normalizeUint(
    input.timeoutPolicy.minimumSeconds,
    `${label}.timeoutPolicy.minimumSeconds`,
    { minimum: 1 }
  );
  const maximumSeconds = normalizeUint(
    input.timeoutPolicy.maximumSeconds,
    `${label}.timeoutPolicy.maximumSeconds`,
    { minimum: minimumSeconds + 1 }
  );
  const minimumCrossChainDeltaSeconds = normalizeUint(
    input.timeoutPolicy.minimumCrossChainDeltaSeconds,
    `${label}.timeoutPolicy.minimumCrossChainDeltaSeconds`,
    { minimum: 1, maximum: maximumSeconds - 1 }
  );
  const requiredConfirmations = normalizeUint(
    input.confirmationPolicy.requiredConfirmations,
    `${label}.confirmationPolicy.requiredConfirmations`,
    { minimum: 1 }
  );
  const reorgSafetyBlocks = normalizeUint(
    input.confirmationPolicy.reorgSafetyBlocks,
    `${label}.confirmationPolicy.reorgSafetyBlocks`,
    { minimum: requiredConfirmations }
  );

  return {
    chainId: String(BigInt(input.chainId)),
    adapterAddress: normalizeAddress(input.adapterAddress, `${label}.adapterAddress`),
    runtimeCodeHash: normalizeHash(input.runtimeCodeHash, `${label}.runtimeCodeHash`),
    asset: {
      address: normalizeAddress(input.asset.address, `${label}.asset.address`),
      runtimeCodeHash: normalizeHash(
        input.asset.runtimeCodeHash,
        `${label}.asset.runtimeCodeHash`
      ),
      symbol: normalizeString(input.asset.symbol, `${label}.asset.symbol`),
      decimals: normalizeUint(input.asset.decimals, `${label}.asset.decimals`, {
        maximum: 255,
      }),
      standard: input.asset.standard === "ERC20" ? "ERC20" : (() => {
        throw new FxEvmAdapterError(`${label}.asset.standard must be ERC20`);
      })(),
      features,
    },
    confirmationPolicy: {
      requiredConfirmations,
      reorgSafetyBlocks,
    },
    timeoutPolicy: {
      minimumSeconds,
      maximumSeconds,
      minimumCrossChainDeltaSeconds,
    },
  };
}

function validateEvmAdapterManifest(input) {
  assertObject(input, "manifest");
  assertObject(input.adapter, "manifest.adapter");
  assertObject(input.build, "manifest.build");
  if (input.schema !== EVM_ADAPTER_SCHEMA || input.schemaVersion !== EVM_ADAPTER_SCHEMA_VERSION) {
    throw new FxEvmAdapterError("adapter manifest schema is unsupported");
  }
  if (
    input.adapter.id !== EVM_ADAPTER_ID ||
    input.adapter.version !== EVM_ADAPTER_VERSION ||
    input.adapter.contract !== "EvmHtlcV1"
  ) {
    throw new FxEvmAdapterError("adapter identity is unsupported");
  }
  if (!Array.isArray(input.capabilities) || input.capabilities.length < 1) {
    throw new FxEvmAdapterError("manifest must contain at least one capability");
  }

  const normalized = {
    schema: EVM_ADAPTER_SCHEMA,
    schemaVersion: EVM_ADAPTER_SCHEMA_VERSION,
    adapter: {
      id: EVM_ADAPTER_ID,
      version: EVM_ADAPTER_VERSION,
      contract: "EvmHtlcV1",
      sourcePath: normalizeString(input.adapter.sourcePath, "manifest.adapter.sourcePath"),
    },
    build: {
      compiler: normalizeString(input.build.compiler, "manifest.build.compiler"),
      evmVersion: normalizeString(input.build.evmVersion, "manifest.build.evmVersion"),
      sourceTag: (() => {
        if (input.build.sourceTag !== EVM_ADAPTER_SOURCE_TAG) {
          throw new FxEvmAdapterError("manifest.build.sourceTag is unsupported");
        }
        return EVM_ADAPTER_SOURCE_TAG;
      })(),
      optimizerRuns: normalizeUint(input.build.optimizerRuns, "manifest.build.optimizerRuns"),
      viaIR: (() => {
        if (input.build.viaIR !== true) {
          throw new FxEvmAdapterError("manifest.build.viaIR must be true");
        }
        return true;
      })(),
      sourceSha256: normalizeHash(input.build.sourceSha256, "manifest.build.sourceSha256"),
      creationCodeHash: normalizeHash(
        input.build.creationCodeHash,
        "manifest.build.creationCodeHash"
      ),
    },
    capabilities: input.capabilities.map(normalizeCapability),
  };

  const identities = normalized.capabilities.map(
    (capability) => `${capability.chainId}:${capability.asset.address}`
  );
  if (new Set(identities).size !== identities.length) {
    throw new FxEvmAdapterError("manifest repeats a chain and asset capability");
  }
  normalized.capabilities.sort((left, right) =>
    `${left.chainId}:${left.asset.address}`.localeCompare(
      `${right.chainId}:${right.asset.address}`
    )
  );
  return normalized;
}

function selectEvmCapability(manifestInput, { chainId, token, decimals }) {
  const manifest = validateEvmAdapterManifest(manifestInput);
  const normalizedChainId = String(BigInt(chainId));
  const normalizedToken = normalizeAddress(token, "token");
  const capability = manifest.capabilities.find(
    (candidate) =>
      candidate.chainId === normalizedChainId &&
      candidate.asset.address === normalizedToken
  );
  if (!capability) {
    throw new FxEvmAdapterError(
      "asset is not allowlisted for this exact chain and contract",
      "UNSUPPORTED_ASSET"
    );
  }
  if (decimals !== undefined && Number(decimals) !== capability.asset.decimals) {
    throw new FxEvmAdapterError("asset decimals do not match the manifest", "DECIMAL_MISMATCH");
  }
  return capability;
}

function validateOrderedTimeouts({
  now,
  sourceRefundTimestamp,
  destinationRefundTimestamp,
  sourceCapability,
  destinationCapability,
}) {
  const current = normalizeUint(now, "now", { minimum: 1 });
  const source = normalizeUint(sourceRefundTimestamp, "sourceRefundTimestamp", {
    minimum: current + 1,
  });
  const destination = normalizeUint(
    destinationRefundTimestamp,
    "destinationRefundTimestamp",
    { minimum: current + 1 }
  );
  const sourceDuration = source - current;
  const destinationDuration = destination - current;
  for (const [label, duration, capability] of [
    ["source", sourceDuration, sourceCapability],
    ["destination", destinationDuration, destinationCapability],
  ]) {
    if (
      duration < capability.timeoutPolicy.minimumSeconds ||
      duration > capability.timeoutPolicy.maximumSeconds
    ) {
      throw new FxEvmAdapterError(`${label} timeout violates adapter policy`, "BAD_TIMEOUT");
    }
  }
  const minimumDelta = Math.max(
    sourceCapability.timeoutPolicy.minimumCrossChainDeltaSeconds,
    destinationCapability.timeoutPolicy.minimumCrossChainDeltaSeconds
  );
  if (source - destination < minimumDelta) {
    throw new FxEvmAdapterError(
      "source timeout must safely follow destination timeout",
      "UNSAFE_TIMEOUT_ORDER"
    );
  }
  return {
    sourceRefundTimestamp: source,
    destinationRefundTimestamp: destination,
    deltaSeconds: source - destination,
  };
}

async function readCall(provider, to, fragment, args = []) {
  const data = ADAPTER_INTERFACE.encodeFunctionData(fragment, args);
  const result = await provider.call({ to, data });
  return ADAPTER_INTERFACE.decodeFunctionResult(fragment, result)[0];
}

async function preflightEvmCapability(provider, manifestInput, assetRequest) {
  const capability = selectEvmCapability(manifestInput, assetRequest);
  const network = await provider.getNetwork();
  if (String(network.chainId) !== capability.chainId) {
    throw new FxEvmAdapterError("provider is connected to the wrong chain", "WRONG_CHAIN");
  }
  const [adapterCode, tokenCode] = await Promise.all([
    provider.getCode(capability.adapterAddress),
    provider.getCode(capability.asset.address),
  ]);
  if (adapterCode === "0x" || tokenCode === "0x") {
    throw new FxEvmAdapterError("adapter or token has no deployed code", "MISSING_CODE");
  }
  if (keccak256(adapterCode).toLowerCase() !== capability.runtimeCodeHash) {
    throw new FxEvmAdapterError("adapter runtime bytecode does not match", "BYTECODE_MISMATCH");
  }
  if (keccak256(tokenCode).toLowerCase() !== capability.asset.runtimeCodeHash) {
    throw new FxEvmAdapterError("token runtime bytecode does not match", "TOKEN_BYTECODE_MISMATCH");
  }
  const tokenDecimalsData = TOKEN_INTERFACE.encodeFunctionData("decimals");
  const [
    tokenDecimalsResult,
    adapterVersion,
    adapterAsset,
    adapterDecimals,
    minimumDuration,
    maximumDuration,
  ] = await Promise.all([
    provider.call({ to: capability.asset.address, data: tokenDecimalsData }),
    readCall(provider, capability.adapterAddress, "ADAPTER_VERSION"),
    readCall(provider, capability.adapterAddress, "asset"),
    readCall(provider, capability.adapterAddress, "assetDecimals"),
    readCall(provider, capability.adapterAddress, "minimumLockDuration"),
    readCall(provider, capability.adapterAddress, "maximumLockDuration"),
  ]);
  const tokenDecimals = Number(
    TOKEN_INTERFACE.decodeFunctionResult("decimals", tokenDecimalsResult)[0]
  );
  if (
    Number(adapterVersion) !== EVM_ADAPTER_VERSION ||
    normalizeAddress(adapterAsset, "adapter asset") !== capability.asset.address ||
    Number(adapterDecimals) !== capability.asset.decimals ||
    tokenDecimals !== capability.asset.decimals ||
    Number(minimumDuration) !== capability.timeoutPolicy.minimumSeconds ||
    Number(maximumDuration) !== capability.timeoutPolicy.maximumSeconds
  ) {
    throw new FxEvmAdapterError(
      "deployed adapter immutables do not match the manifest",
      "IMMUTABLE_MISMATCH"
    );
  }
  return capability;
}

function estimateEvmActionFee({ gasEstimate, maxFeePerGas }) {
  const gas = BigInt(gasEstimate);
  const fee = BigInt(maxFeePerGas);
  if (gas <= 0n || fee <= 0n) {
    throw new FxEvmAdapterError("gas estimate and max fee must be positive", "BAD_FEE");
  }
  return {
    gasEstimate: gas.toString(),
    maxFeePerGas: fee.toString(),
    maximumNativeFee: (gas * fee).toString(),
  };
}

function evaluateReceiptFinality({ previousReceipt = null, receipt, latestBlock, capability }) {
  if (previousReceipt && !receipt) {
    return { state: "reorged", reason: "receipt_disappeared" };
  }
  if (
    previousReceipt &&
    receipt &&
    (previousReceipt.blockHash !== receipt.blockHash ||
      previousReceipt.blockNumber !== receipt.blockNumber)
  ) {
    return { state: "reorged", reason: "receipt_moved" };
  }
  if (!receipt) return { state: "pending", confirmations: 0 };
  if (receipt.status !== 1 && receipt.status !== 1n) {
    return { state: "reverted", confirmations: 0 };
  }
  const confirmations = Math.max(0, Number(latestBlock) - Number(receipt.blockNumber) + 1);
  if (confirmations < capability.confirmationPolicy.requiredConfirmations) {
    return { state: "confirming", confirmations };
  }
  return {
    state: "confirmed",
    confirmations,
    reorgSafe:
      confirmations >= capability.confirmationPolicy.reorgSafetyBlocks,
  };
}

function verifyObservedLock(observed, expected, capability) {
  assertObject(observed, "observed lock");
  assertObject(expected, "expected lock");
  if (
    normalizeAddress(observed.adapterAddress, "observed adapter") !==
      capability.adapterAddress ||
    String(BigInt(observed.chainId)) !== capability.chainId ||
    normalizeAddress(observed.token, "observed token") !== capability.asset.address ||
    normalizeHash(observed.lockId, "observed lockId") !==
      normalizeHash(expected.lockId, "expected lockId") ||
    String(BigInt(observed.amountAtomic)) !== String(BigInt(expected.amountAtomic)) ||
    normalizeAddress(observed.beneficiary, "observed beneficiary") !==
      normalizeAddress(expected.beneficiary, "expected beneficiary") ||
    normalizeAddress(observed.refundAddress, "observed refund") !==
      normalizeAddress(expected.refundAddress, "expected refund") ||
    normalizeHash(observed.secretHash, "observed secretHash") !==
      normalizeHash(expected.secretHash, "expected secretHash") ||
    Number(observed.refundTimestamp) !== Number(expected.refundTimestamp)
  ) {
    throw new FxEvmAdapterError("observed lock does not match the accepted route", "LOCK_MISMATCH");
  }
  return true;
}

module.exports = {
  EVM_ADAPTER_ID,
  EVM_ADAPTER_SCHEMA,
  EVM_ADAPTER_SCHEMA_VERSION,
  EVM_ADAPTER_SOURCE_TAG,
  EVM_ADAPTER_VERSION,
  FxEvmAdapterError,
  estimateEvmActionFee,
  evaluateReceiptFinality,
  preflightEvmCapability,
  selectEvmCapability,
  validateEvmAdapterManifest,
  validateOrderedTimeouts,
  verifyObservedLock,
};
