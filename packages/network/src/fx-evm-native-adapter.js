const { Interface, getAddress, isAddress, keccak256 } = require("ethers");

const EVM_NATIVE_ADAPTER_SCHEMA = "versus-fx-native-adapter-capabilities";
const EVM_NATIVE_ADAPTER_SCHEMA_VERSION = 1;
const EVM_NATIVE_ADAPTER_ID = "evm-native-htlc";
const EVM_NATIVE_ADAPTER_VERSION = 1;
const EVM_NATIVE_ADAPTER_SOURCE_TAG = "agentic-fx-native-v1";
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;

const ADAPTER_INTERFACE = new Interface([
  "function ADAPTER_VERSION() view returns (uint16)",
  "function minimumLockDuration() view returns (uint64)",
  "function maximumLockDuration() view returns (uint64)",
]);

class FxEvmNativeAdapterError extends Error {
  constructor(message, code = "INVALID_EVM_NATIVE_ADAPTER") {
    super(message);
    this.name = "FxEvmNativeAdapterError";
    this.code = code;
  }
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FxEvmNativeAdapterError(`${label} must be an object`);
  }
}

function string(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new FxEvmNativeAdapterError(`${label} must be a non-empty string`);
  }
  return value;
}

function uint(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const normalized = typeof value === "string" && /^\d+$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new FxEvmNativeAdapterError(`${label} is outside its supported range`);
  }
  return normalized;
}

function address(value, label) {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new FxEvmNativeAdapterError(`${label} must be an EVM address`);
  }
  return getAddress(value).toLowerCase();
}

function hash(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (!HASH_PATTERN.test(normalized)) {
    throw new FxEvmNativeAdapterError(`${label} must be a bytes32 hash`);
  }
  return normalized;
}

function normalizeCapability(input, index) {
  const label = `capabilities[${index}]`;
  object(input, label);
  object(input.asset, `${label}.asset`);
  object(input.confirmationPolicy, `${label}.confirmationPolicy`);
  object(input.timeoutPolicy, `${label}.timeoutPolicy`);
  const minimumSeconds = uint(
    input.timeoutPolicy.minimumSeconds,
    `${label}.timeoutPolicy.minimumSeconds`,
    1
  );
  const maximumSeconds = uint(
    input.timeoutPolicy.maximumSeconds,
    `${label}.timeoutPolicy.maximumSeconds`,
    minimumSeconds + 1
  );
  return {
    chainId: String(BigInt(input.chainId)),
    adapterAddress: address(input.adapterAddress, `${label}.adapterAddress`),
    runtimeCodeHash: hash(input.runtimeCodeHash, `${label}.runtimeCodeHash`),
    deploymentBlock: uint(input.deploymentBlock, `${label}.deploymentBlock`, 1),
    asset: {
      assetId: (() => {
        if (input.asset.assetId !== "native:eth") {
          throw new FxEvmNativeAdapterError(`${label}.asset.assetId must be native:eth`);
        }
        return "native:eth";
      })(),
      symbol: input.asset.symbol === "ETH" ? "ETH" : (() => {
        throw new FxEvmNativeAdapterError(`${label}.asset.symbol must be ETH`);
      })(),
      decimals: input.asset.decimals === 18 ? 18 : (() => {
        throw new FxEvmNativeAdapterError(`${label}.asset.decimals must be 18`);
      })(),
      standard: input.asset.standard === "NATIVE" ? "NATIVE" : (() => {
        throw new FxEvmNativeAdapterError(`${label}.asset.standard must be NATIVE`);
      })(),
    },
    confirmationPolicy: {
      requiredConfirmations: uint(
        input.confirmationPolicy.requiredConfirmations,
        `${label}.confirmationPolicy.requiredConfirmations`,
        1
      ),
      reorgSafetyBlocks: uint(
        input.confirmationPolicy.reorgSafetyBlocks,
        `${label}.confirmationPolicy.reorgSafetyBlocks`,
        input.confirmationPolicy.requiredConfirmations
      ),
    },
    timeoutPolicy: {
      minimumSeconds,
      maximumSeconds,
      minimumCrossChainDeltaSeconds: uint(
        input.timeoutPolicy.minimumCrossChainDeltaSeconds,
        `${label}.timeoutPolicy.minimumCrossChainDeltaSeconds`,
        1,
        maximumSeconds - 1
      ),
    },
  };
}

function validateEvmNativeAdapterManifest(input) {
  object(input, "manifest");
  object(input.adapter, "manifest.adapter");
  object(input.build, "manifest.build");
  if (
    input.schema !== EVM_NATIVE_ADAPTER_SCHEMA ||
    input.schemaVersion !== EVM_NATIVE_ADAPTER_SCHEMA_VERSION
  ) {
    throw new FxEvmNativeAdapterError("native adapter manifest schema is unsupported");
  }
  if (
    input.adapter.id !== EVM_NATIVE_ADAPTER_ID ||
    input.adapter.version !== EVM_NATIVE_ADAPTER_VERSION ||
    input.adapter.contract !== "EvmNativeHtlcV1"
  ) {
    throw new FxEvmNativeAdapterError("native adapter identity is unsupported");
  }
  if (!Array.isArray(input.capabilities) || input.capabilities.length < 1) {
    throw new FxEvmNativeAdapterError("manifest must contain at least one capability");
  }
  const normalized = {
    schema: EVM_NATIVE_ADAPTER_SCHEMA,
    schemaVersion: EVM_NATIVE_ADAPTER_SCHEMA_VERSION,
    adapter: {
      id: EVM_NATIVE_ADAPTER_ID,
      version: EVM_NATIVE_ADAPTER_VERSION,
      contract: "EvmNativeHtlcV1",
      sourcePath: string(input.adapter.sourcePath, "manifest.adapter.sourcePath"),
    },
    build: {
      compiler: string(input.build.compiler, "manifest.build.compiler"),
      evmVersion: string(input.build.evmVersion, "manifest.build.evmVersion"),
      sourceTag: input.build.sourceTag === EVM_NATIVE_ADAPTER_SOURCE_TAG
        ? EVM_NATIVE_ADAPTER_SOURCE_TAG
        : (() => {
            throw new FxEvmNativeAdapterError("manifest.build.sourceTag is unsupported");
          })(),
      optimizerRuns: uint(input.build.optimizerRuns, "manifest.build.optimizerRuns"),
      viaIR: input.build.viaIR === true ? true : (() => {
        throw new FxEvmNativeAdapterError("manifest.build.viaIR must be true");
      })(),
      sourceSha256: hash(input.build.sourceSha256, "manifest.build.sourceSha256"),
      creationCodeHash: hash(input.build.creationCodeHash, "manifest.build.creationCodeHash"),
    },
    capabilities: input.capabilities.map(normalizeCapability),
  };
  const chainIds = normalized.capabilities.map((capability) => capability.chainId);
  if (new Set(chainIds).size !== chainIds.length) {
    throw new FxEvmNativeAdapterError("manifest repeats a native chain capability");
  }
  normalized.capabilities.sort((left, right) =>
    BigInt(left.chainId) < BigInt(right.chainId) ? -1 : 1
  );
  return normalized;
}

function selectEvmNativeCapability(manifestInput, { chainId, assetId = "native:eth" }) {
  if (assetId !== "native:eth") {
    throw new FxEvmNativeAdapterError("native asset is unsupported", "UNSUPPORTED_ASSET");
  }
  const manifest = validateEvmNativeAdapterManifest(manifestInput);
  const capability = manifest.capabilities.find(
    (candidate) => candidate.chainId === String(BigInt(chainId))
  );
  if (!capability) {
    throw new FxEvmNativeAdapterError(
      "native asset is not allowlisted for this chain",
      "UNSUPPORTED_ASSET"
    );
  }
  return capability;
}

async function readCall(provider, to, fragment) {
  const data = ADAPTER_INTERFACE.encodeFunctionData(fragment);
  const result = await provider.call({ to, data });
  return ADAPTER_INTERFACE.decodeFunctionResult(fragment, result)[0];
}

async function preflightEvmNativeCapability(provider, manifestInput, request) {
  const capability = selectEvmNativeCapability(manifestInput, request);
  const network = await provider.getNetwork();
  if (String(network.chainId) !== capability.chainId) {
    throw new FxEvmNativeAdapterError("provider is connected to the wrong chain", "WRONG_CHAIN");
  }
  const code = await provider.getCode(capability.adapterAddress);
  if (code === "0x") {
    throw new FxEvmNativeAdapterError("native adapter has no deployed code", "MISSING_CODE");
  }
  if (keccak256(code).toLowerCase() !== capability.runtimeCodeHash) {
    throw new FxEvmNativeAdapterError(
      "native adapter runtime bytecode does not match",
      "BYTECODE_MISMATCH"
    );
  }
  const [version, minimum, maximum] = await Promise.all([
    readCall(provider, capability.adapterAddress, "ADAPTER_VERSION"),
    readCall(provider, capability.adapterAddress, "minimumLockDuration"),
    readCall(provider, capability.adapterAddress, "maximumLockDuration"),
  ]);
  if (
    Number(version) !== EVM_NATIVE_ADAPTER_VERSION ||
    Number(minimum) !== capability.timeoutPolicy.minimumSeconds ||
    Number(maximum) !== capability.timeoutPolicy.maximumSeconds
  ) {
    throw new FxEvmNativeAdapterError(
      "deployed native adapter immutables do not match the manifest",
      "IMMUTABLE_MISMATCH"
    );
  }
  return capability;
}

module.exports = {
  EVM_NATIVE_ADAPTER_ID,
  EVM_NATIVE_ADAPTER_SCHEMA,
  EVM_NATIVE_ADAPTER_SCHEMA_VERSION,
  EVM_NATIVE_ADAPTER_SOURCE_TAG,
  EVM_NATIVE_ADAPTER_VERSION,
  FxEvmNativeAdapterError,
  preflightEvmNativeCapability,
  selectEvmNativeCapability,
  validateEvmNativeAdapterManifest,
};
