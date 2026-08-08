const { Interface, getAddress, isAddress, keccak256 } = require("ethers");

const FX_EVM_V2_SCHEMA = "versus-fx-evm-v2-capabilities";
const FX_EVM_V2_SCHEMA_VERSION = 2;
const FX_EVM_V2_DEPLOYMENT_MODE = "dealer-secret-source-first";
const FX_EVM_V2_LEGACY_DEPLOYMENT_MODE =
  "dealer-secret-destination-first";
const FX_EVM_V2_DEPLOYMENT_MODES = new Set([
  FX_EVM_V2_DEPLOYMENT_MODE,
  FX_EVM_V2_LEGACY_DEPLOYMENT_MODE,
]);
const FX_EVM_V2_NATIVE_ID = "evm-native-htlc-v2";
const FX_EVM_V2_ERC20_ID = "evm-htlc-v2";
const FX_EVM_V2_VERSION = 2;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;

const NATIVE_INTERFACE = new Interface([
  "function ADAPTER_VERSION() view returns (uint16)",
  "function minimumLockDuration() view returns (uint64)",
  "function maximumLockDuration() view returns (uint64)",
]);
const ERC20_INTERFACE = new Interface([
  "function ADAPTER_VERSION() view returns (uint16)",
  "function asset() view returns (address)",
  "function assetDecimals() view returns (uint8)",
  "function minimumLockDuration() view returns (uint64)",
  "function maximumLockDuration() view returns (uint64)",
]);
const TOKEN_INTERFACE = new Interface([
  "function decimals() view returns (uint8)",
]);

class FxEvmV2AdapterError extends Error {
  constructor(message, code = "INVALID_EVM_V2_ADAPTER") {
    super(message);
    this.name = "FxEvmV2AdapterError";
    this.code = code;
  }
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FxEvmV2AdapterError(`${label} must be an object`);
  }
}

function address(value, label) {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new FxEvmV2AdapterError(`${label} must be an EVM address`);
  }
  return getAddress(value).toLowerCase();
}

function hash(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (!HASH_PATTERN.test(normalized)) {
    throw new FxEvmV2AdapterError(`${label} must be a bytes32 hash`);
  }
  return normalized;
}

function uint(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const normalized =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < minimum ||
    normalized > maximum
  ) {
    throw new FxEvmV2AdapterError(`${label} is outside its supported range`);
  }
  return normalized;
}

function text(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new FxEvmV2AdapterError(`${label} must be a non-empty string`);
  }
  return value;
}

function normalizeBuild(value, kind) {
  object(value, `builds.${kind}`);
  const expectedContract =
    kind === "native" ? "EvmNativeHtlcV2" : "EvmHtlcV2";
  const expectedAdapterId =
    kind === "native" ? FX_EVM_V2_NATIVE_ID : FX_EVM_V2_ERC20_ID;
  if (
    value.adapterId !== expectedAdapterId ||
    value.adapterVersion !== FX_EVM_V2_VERSION ||
    value.contract !== expectedContract
  ) {
    throw new FxEvmV2AdapterError(`builds.${kind} identity is unsupported`);
  }
  return {
    adapterId: expectedAdapterId,
    adapterVersion: FX_EVM_V2_VERSION,
    contract: expectedContract,
    sourcePath: text(value.sourcePath, `builds.${kind}.sourcePath`),
    sourceTag: value.sourceTag === "agentic-fx-settlement-v2"
      ? value.sourceTag
      : (() => {
          throw new FxEvmV2AdapterError(`builds.${kind}.sourceTag is unsupported`);
        })(),
    compiler: text(value.compiler, `builds.${kind}.compiler`),
    evmVersion: text(value.evmVersion, `builds.${kind}.evmVersion`),
    optimizerRuns: uint(value.optimizerRuns, `builds.${kind}.optimizerRuns`),
    viaIR: value.viaIR === true
      ? true
      : (() => {
          throw new FxEvmV2AdapterError(`builds.${kind}.viaIR must be true`);
        })(),
    sourceSha256: hash(value.sourceSha256, `builds.${kind}.sourceSha256`),
    creationCodeHash: hash(
      value.creationCodeHash,
      `builds.${kind}.creationCodeHash`
    ),
  };
}

function normalizeCapability(value, index) {
  const label = `capabilities[${index}]`;
  object(value, label);
  object(value.native, `${label}.native`);
  object(value.erc20, `${label}.erc20`);
  object(value.erc20.asset, `${label}.erc20.asset`);
  object(value.confirmationPolicy, `${label}.confirmationPolicy`);
  object(value.timeoutPolicy, `${label}.timeoutPolicy`);
  const minimumSeconds = uint(
    value.timeoutPolicy.minimumSeconds,
    `${label}.timeoutPolicy.minimumSeconds`,
    1
  );
  const maximumSeconds = uint(
    value.timeoutPolicy.maximumSeconds,
    `${label}.timeoutPolicy.maximumSeconds`,
    minimumSeconds + 1
  );
  const minimumCrossChainDeltaSeconds = uint(
    value.timeoutPolicy.minimumCrossChainDeltaSeconds,
    `${label}.timeoutPolicy.minimumCrossChainDeltaSeconds`,
    1,
    maximumSeconds - 1
  );
  const minimumDestinationRelayWindowSeconds = uint(
    value.timeoutPolicy.minimumDestinationRelayWindowSeconds,
    `${label}.timeoutPolicy.minimumDestinationRelayWindowSeconds`,
    minimumCrossChainDeltaSeconds,
    maximumSeconds - 1
  );
  const requiredConfirmations = uint(
    value.confirmationPolicy.requiredConfirmations,
    `${label}.confirmationPolicy.requiredConfirmations`,
    1
  );
  return {
    chainId: String(BigInt(value.chainId)),
    native: {
      adapterAddress: address(
        value.native.adapterAddress,
        `${label}.native.adapterAddress`
      ),
      runtimeCodeHash: hash(
        value.native.runtimeCodeHash,
        `${label}.native.runtimeCodeHash`
      ),
      deploymentBlock: uint(
        value.native.deploymentBlock,
        `${label}.native.deploymentBlock`,
        1
      ),
      assetId: value.native.assetId === "native:eth"
        ? "native:eth"
        : (() => {
            throw new FxEvmV2AdapterError(`${label}.native.assetId is unsupported`);
          })(),
    },
    erc20: {
      adapterAddress: address(
        value.erc20.adapterAddress,
        `${label}.erc20.adapterAddress`
      ),
      runtimeCodeHash: hash(
        value.erc20.runtimeCodeHash,
        `${label}.erc20.runtimeCodeHash`
      ),
      deploymentBlock: uint(
        value.erc20.deploymentBlock,
        `${label}.erc20.deploymentBlock`,
        1
      ),
      asset: {
        address: address(value.erc20.asset.address, `${label}.erc20.asset.address`),
        runtimeCodeHash: hash(
          value.erc20.asset.runtimeCodeHash,
          `${label}.erc20.asset.runtimeCodeHash`
        ),
        symbol: text(value.erc20.asset.symbol, `${label}.erc20.asset.symbol`),
        decimals: uint(
          value.erc20.asset.decimals,
          `${label}.erc20.asset.decimals`,
          0,
          255
        ),
        standard: value.erc20.asset.standard === "ERC20"
          ? "ERC20"
          : (() => {
              throw new FxEvmV2AdapterError(
                `${label}.erc20.asset.standard must be ERC20`
              );
            })(),
      },
    },
    confirmationPolicy: {
      requiredConfirmations,
      reorgSafetyBlocks: uint(
        value.confirmationPolicy.reorgSafetyBlocks,
        `${label}.confirmationPolicy.reorgSafetyBlocks`,
        requiredConfirmations
      ),
    },
    timeoutPolicy: {
      minimumSeconds,
      maximumSeconds,
      minimumCrossChainDeltaSeconds,
      minimumDestinationRelayWindowSeconds,
    },
  };
}

function validateEvmV2Manifest(input) {
  object(input, "manifest");
  object(input.builds, "manifest.builds");
  if (
    input.schema !== FX_EVM_V2_SCHEMA ||
    input.schemaVersion !== FX_EVM_V2_SCHEMA_VERSION ||
    !FX_EVM_V2_DEPLOYMENT_MODES.has(input.settlementMode)
  ) {
    throw new FxEvmV2AdapterError("V2 adapter manifest schema is unsupported");
  }
  if (!Array.isArray(input.capabilities) || input.capabilities.length < 1) {
    throw new FxEvmV2AdapterError("manifest must contain capabilities");
  }
  const normalized = {
    schema: FX_EVM_V2_SCHEMA,
    schemaVersion: FX_EVM_V2_SCHEMA_VERSION,
    settlementMode: input.settlementMode,
    builds: {
      native: normalizeBuild(input.builds.native, "native"),
      erc20: normalizeBuild(input.builds.erc20, "erc20"),
    },
    capabilities: input.capabilities.map(normalizeCapability),
  };
  const ids = normalized.capabilities.map((item) => item.chainId);
  if (new Set(ids).size !== ids.length) {
    throw new FxEvmV2AdapterError("manifest repeats a chain capability");
  }
  normalized.capabilities.sort((left, right) =>
    BigInt(left.chainId) < BigInt(right.chainId) ? -1 : 1
  );
  return normalized;
}

function selectEvmV2Capability(manifestInput, { chainId, token }) {
  const manifest = validateEvmV2Manifest(manifestInput);
  const capability = manifest.capabilities.find(
    (item) => item.chainId === String(BigInt(chainId))
  );
  if (!capability) {
    throw new FxEvmV2AdapterError("chain is not allowlisted", "UNSUPPORTED_CHAIN");
  }
  const normalizedToken = String(token || "").toLowerCase();
  if (
    normalizedToken === "native:eth" ||
    normalizedToken === "0x0000000000000000000000000000000000000000"
  ) {
    return { ...capability.native, chainId: capability.chainId, kind: "native", policy: capability };
  }
  if (address(token, "token") !== capability.erc20.asset.address) {
    throw new FxEvmV2AdapterError("asset is not allowlisted", "UNSUPPORTED_ASSET");
  }
  return {
    ...capability.erc20,
    chainId: capability.chainId,
    kind: "erc20",
    policy: capability,
  };
}

function validateDestinationFirstTimeouts({
  now,
  sourceRefundTimestamp,
  destinationRefundTimestamp,
  sourceCapability,
  destinationCapability,
}) {
  const current = uint(now, "now", 1);
  const source = uint(sourceRefundTimestamp, "sourceRefundTimestamp", current + 1);
  const destination = uint(
    destinationRefundTimestamp,
    "destinationRefundTimestamp",
    current + 1
  );
  for (const [label, timeout, capability] of [
    ["source", source, sourceCapability],
    ["destination", destination, destinationCapability],
  ]) {
    const duration = timeout - current;
    if (
      duration < capability.timeoutPolicy.minimumSeconds ||
      duration > capability.timeoutPolicy.maximumSeconds
    ) {
      throw new FxEvmV2AdapterError(
        `${label} timeout violates adapter policy`,
        "BAD_TIMEOUT"
      );
    }
  }
  const minimumGap = Math.max(
    sourceCapability.timeoutPolicy.minimumCrossChainDeltaSeconds,
    destinationCapability.timeoutPolicy.minimumCrossChainDeltaSeconds,
    destinationCapability.timeoutPolicy.minimumDestinationRelayWindowSeconds
  );
  if (destination - source < minimumGap) {
    throw new FxEvmV2AdapterError(
      "destination timeout must safely follow source timeout",
      "UNSAFE_TIMEOUT_ORDER"
    );
  }
  return {
    sourceRefundTimestamp: source,
    destinationRefundTimestamp: destination,
    deltaSeconds: destination - source,
  };
}

function validateSourceFirstTimeouts({
  now,
  sourceRefundTimestamp,
  destinationRefundTimestamp,
  sourceCapability,
  destinationCapability,
}) {
  const current = uint(now, "now", 1);
  const source = uint(sourceRefundTimestamp, "sourceRefundTimestamp", current + 1);
  const destination = uint(
    destinationRefundTimestamp,
    "destinationRefundTimestamp",
    current + 1
  );
  for (const [label, timeout, capability] of [
    ["source", source, sourceCapability],
    ["destination", destination, destinationCapability],
  ]) {
    const duration = timeout - current;
    if (
      duration < capability.timeoutPolicy.minimumSeconds ||
      duration > capability.timeoutPolicy.maximumSeconds
    ) {
      throw new FxEvmV2AdapterError(
        `${label} timeout violates adapter policy`,
        "BAD_TIMEOUT"
      );
    }
  }
  const minimumGap = Math.max(
    sourceCapability.timeoutPolicy.minimumCrossChainDeltaSeconds,
    destinationCapability.timeoutPolicy.minimumCrossChainDeltaSeconds,
    destinationCapability.timeoutPolicy.minimumDestinationRelayWindowSeconds
  );
  if (source - destination < minimumGap) {
    throw new FxEvmV2AdapterError(
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

async function read(provider, iface, to, fragment) {
  const data = iface.encodeFunctionData(fragment);
  const result = await provider.call({ to, data });
  return iface.decodeFunctionResult(fragment, result)[0];
}

async function preflightEvmV2Capability(provider, manifestInput, request) {
  const capability = selectEvmV2Capability(manifestInput, request);
  const network = await provider.getNetwork();
  if (String(network.chainId) !== capability.chainId) {
    throw new FxEvmV2AdapterError("provider is connected to the wrong chain", "WRONG_CHAIN");
  }
  const iface = capability.kind === "native" ? NATIVE_INTERFACE : ERC20_INTERFACE;
  const code = await provider.getCode(capability.adapterAddress);
  if (
    code === "0x" ||
    keccak256(code).toLowerCase() !== capability.runtimeCodeHash
  ) {
    throw new FxEvmV2AdapterError(
      "adapter runtime bytecode does not match",
      "BYTECODE_MISMATCH"
    );
  }
  const [version, minimum, maximum] = await Promise.all([
    read(provider, iface, capability.adapterAddress, "ADAPTER_VERSION"),
    read(provider, iface, capability.adapterAddress, "minimumLockDuration"),
    read(provider, iface, capability.adapterAddress, "maximumLockDuration"),
  ]);
  if (
    Number(version) !== FX_EVM_V2_VERSION ||
    Number(minimum) !== capability.policy.timeoutPolicy.minimumSeconds ||
    Number(maximum) !== capability.policy.timeoutPolicy.maximumSeconds
  ) {
    throw new FxEvmV2AdapterError(
      "adapter immutables do not match the V2 manifest",
      "IMMUTABLE_MISMATCH"
    );
  }
  if (capability.kind === "erc20") {
    const [assetAddress, assetDecimals, tokenCode, tokenDecimalsResult] =
      await Promise.all([
        read(provider, iface, capability.adapterAddress, "asset"),
        read(provider, iface, capability.adapterAddress, "assetDecimals"),
        provider.getCode(capability.asset.address),
        provider.call({
          to: capability.asset.address,
          data: TOKEN_INTERFACE.encodeFunctionData("decimals"),
        }),
      ]);
    const tokenDecimals = Number(
      TOKEN_INTERFACE.decodeFunctionResult("decimals", tokenDecimalsResult)[0]
    );
    if (
      address(assetAddress, "adapter asset") !== capability.asset.address ||
      Number(assetDecimals) !== capability.asset.decimals ||
      tokenCode === "0x" ||
      keccak256(tokenCode).toLowerCase() !== capability.asset.runtimeCodeHash ||
      tokenDecimals !== capability.asset.decimals
    ) {
      throw new FxEvmV2AdapterError(
        "ERC-20 capability does not match deployed immutables",
        "IMMUTABLE_MISMATCH"
      );
    }
  }
  return capability;
}

module.exports = {
  FX_EVM_V2_DEPLOYMENT_MODE,
  FX_EVM_V2_ERC20_ID,
  FX_EVM_V2_NATIVE_ID,
  FX_EVM_V2_SCHEMA,
  FX_EVM_V2_SCHEMA_VERSION,
  FX_EVM_V2_VERSION,
  FxEvmV2AdapterError,
  preflightEvmV2Capability,
  selectEvmV2Capability,
  validateDestinationFirstTimeouts,
  validateSourceFirstTimeouts,
  validateEvmV2Manifest,
};
