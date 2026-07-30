const { Interface, getAddress, isAddress, keccak256 } = require("ethers");

const FX_EVM_V3_SCHEMA = "versus-fx-evm-v3-capabilities";
const FX_EVM_V3_SCHEMA_VERSION = 3;
const FX_EVM_V3_DEPLOYMENT_MODE = "requester-secret-source-first-compact";
const FX_EVM_V3_NATIVE_ID = "evm-native-htlc-v3";
const FX_EVM_V3_ERC20_ID = "evm-htlc-v3";
const FX_EVM_V3_VERSION = 3;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;

const NATIVE_INTERFACE = new Interface([
  "function ADAPTER_VERSION() view returns (uint16)",
  "function minimumLockDuration() view returns (uint64)",
  "function maximumLockDuration() view returns (uint64)",
]);
const ERC20_INTERFACE = new Interface([
  "function ADAPTER_VERSION() view returns (uint16)",
  "function minimumLockDuration() view returns (uint64)",
  "function maximumLockDuration() view returns (uint64)",
  "function asset() view returns (address)",
  "function assetDecimals() view returns (uint8)",
]);
const TOKEN_INTERFACE = new Interface([
  "function decimals() view returns (uint8)",
]);

class FxEvmV3AdapterError extends Error {
  constructor(message, code = "INVALID_EVM_V3_ADAPTER") {
    super(message);
    this.name = "FxEvmV3AdapterError";
    this.code = code;
  }
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FxEvmV3AdapterError(`${label} must be an object`);
  }
}

function address(value, label) {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new FxEvmV3AdapterError(`${label} must be an EVM address`);
  }
  return getAddress(value).toLowerCase();
}

function hash(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (!HASH_PATTERN.test(normalized)) {
    throw new FxEvmV3AdapterError(`${label} must be a bytes32 hash`);
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
    throw new FxEvmV3AdapterError(`${label} is outside its supported range`);
  }
  return normalized;
}

function text(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new FxEvmV3AdapterError(`${label} must be a non-empty string`);
  }
  return value;
}

function normalizeBuild(value, kind) {
  object(value, `builds.${kind}`);
  const expectedContract =
    kind === "native" ? "EvmNativeHtlcV3" : "EvmHtlcV3";
  const expectedAdapterId =
    kind === "native" ? FX_EVM_V3_NATIVE_ID : FX_EVM_V3_ERC20_ID;
  if (
    value.adapterId !== expectedAdapterId ||
    value.adapterVersion !== FX_EVM_V3_VERSION ||
    value.contract !== expectedContract ||
    value.sourceTag !== "agentic-fx-requester-secret-v3"
  ) {
    throw new FxEvmV3AdapterError(`builds.${kind} identity is unsupported`);
  }
  return {
    adapterId: expectedAdapterId,
    adapterVersion: FX_EVM_V3_VERSION,
    contract: expectedContract,
    sourcePath: text(value.sourcePath, `builds.${kind}.sourcePath`),
    sourceTag: value.sourceTag,
    compiler: text(value.compiler, `builds.${kind}.compiler`),
    evmVersion: text(value.evmVersion, `builds.${kind}.evmVersion`),
    optimizerRuns: uint(value.optimizerRuns, `builds.${kind}.optimizerRuns`),
    viaIR: value.viaIR === true,
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
            throw new FxEvmV3AdapterError(
              `${label}.native.assetId is unsupported`
            );
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
              throw new FxEvmV3AdapterError(
                `${label}.erc20.asset.standard must be ERC20`
              );
            })(),
      },
    },
    confirmationPolicy: {
      requiredConfirmations: uint(
        value.confirmationPolicy.requiredConfirmations,
        `${label}.confirmationPolicy.requiredConfirmations`,
        1
      ),
      reorgSafetyBlocks: uint(
        value.confirmationPolicy.reorgSafetyBlocks,
        `${label}.confirmationPolicy.reorgSafetyBlocks`,
        1
      ),
    },
    timeoutPolicy: {
      minimumSeconds,
      maximumSeconds,
      minimumCrossChainDeltaSeconds: uint(
        value.timeoutPolicy.minimumCrossChainDeltaSeconds,
        `${label}.timeoutPolicy.minimumCrossChainDeltaSeconds`,
        1,
        maximumSeconds - 1
      ),
      minimumDestinationRelayWindowSeconds: uint(
        value.timeoutPolicy.minimumDestinationRelayWindowSeconds,
        `${label}.timeoutPolicy.minimumDestinationRelayWindowSeconds`,
        1,
        maximumSeconds - 1
      ),
    },
  };
}

function validateEvmV3Manifest(input) {
  object(input, "manifest");
  object(input.builds, "manifest.builds");
  if (
    input.schema !== FX_EVM_V3_SCHEMA ||
    input.schemaVersion !== FX_EVM_V3_SCHEMA_VERSION ||
    input.settlementMode !== FX_EVM_V3_DEPLOYMENT_MODE
  ) {
    throw new FxEvmV3AdapterError("V3 adapter manifest schema is unsupported");
  }
  if (!Array.isArray(input.capabilities) || input.capabilities.length < 1) {
    throw new FxEvmV3AdapterError("manifest must contain capabilities");
  }
  const normalized = {
    schema: FX_EVM_V3_SCHEMA,
    schemaVersion: FX_EVM_V3_SCHEMA_VERSION,
    settlementMode: FX_EVM_V3_DEPLOYMENT_MODE,
    deploymentId: hash(input.deploymentId, "manifest.deploymentId"),
    coordinationDomain: hash(
      input.coordinationDomain,
      "manifest.coordinationDomain"
    ),
    builds: {
      native: normalizeBuild(input.builds.native, "native"),
      erc20: normalizeBuild(input.builds.erc20, "erc20"),
    },
    capabilities: input.capabilities.map(normalizeCapability),
  };
  const ids = normalized.capabilities.map((item) => item.chainId);
  if (new Set(ids).size !== ids.length) {
    throw new FxEvmV3AdapterError("manifest repeats a chain capability");
  }
  normalized.capabilities.sort((left, right) =>
    BigInt(left.chainId) < BigInt(right.chainId) ? -1 : 1
  );
  return normalized;
}

function selectEvmV3Capability(manifestInput, { chainId, token }) {
  const manifest = validateEvmV3Manifest(manifestInput);
  const capability = manifest.capabilities.find(
    (item) => item.chainId === String(BigInt(chainId))
  );
  if (!capability) {
    throw new FxEvmV3AdapterError("chain is not allowlisted", "UNSUPPORTED_CHAIN");
  }
  const normalizedToken = String(token || "").toLowerCase();
  if (
    normalizedToken === "native:eth" ||
    normalizedToken === "0x0000000000000000000000000000000000000000"
  ) {
    return {
      ...capability.native,
      chainId: capability.chainId,
      kind: "native",
      policy: capability,
    };
  }
  if (address(token, "token") !== capability.erc20.asset.address) {
    throw new FxEvmV3AdapterError("asset is not allowlisted", "UNSUPPORTED_ASSET");
  }
  return {
    ...capability.erc20,
    chainId: capability.chainId,
    kind: "erc20",
    policy: capability,
  };
}

function validateSourceFirstTimeoutsV3({
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
      throw new FxEvmV3AdapterError(
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
    throw new FxEvmV3AdapterError(
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
  const result = await provider.call({
    to,
    data: iface.encodeFunctionData(fragment),
  });
  return iface.decodeFunctionResult(fragment, result)[0];
}

async function preflightEvmV3Capability(provider, manifestInput, request) {
  const capability = selectEvmV3Capability(manifestInput, request);
  const network = await provider.getNetwork();
  if (String(network.chainId) !== capability.chainId) {
    throw new FxEvmV3AdapterError(
      "provider is connected to the wrong chain",
      "WRONG_CHAIN"
    );
  }
  const iface = capability.kind === "native" ? NATIVE_INTERFACE : ERC20_INTERFACE;
  const code = await provider.getCode(capability.adapterAddress);
  if (
    code === "0x" ||
    keccak256(code).toLowerCase() !== capability.runtimeCodeHash
  ) {
    throw new FxEvmV3AdapterError(
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
    Number(version) !== FX_EVM_V3_VERSION ||
    Number(minimum) !== capability.policy.timeoutPolicy.minimumSeconds ||
    Number(maximum) !== capability.policy.timeoutPolicy.maximumSeconds
  ) {
    throw new FxEvmV3AdapterError(
      "adapter immutables do not match the V3 manifest",
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
      throw new FxEvmV3AdapterError(
        "ERC-20 capability does not match deployed immutables",
        "IMMUTABLE_MISMATCH"
      );
    }
  }
  return capability;
}

module.exports = {
  FX_EVM_V3_DEPLOYMENT_MODE,
  FX_EVM_V3_ERC20_ID,
  FX_EVM_V3_NATIVE_ID,
  FX_EVM_V3_SCHEMA,
  FX_EVM_V3_SCHEMA_VERSION,
  FX_EVM_V3_VERSION,
  FxEvmV3AdapterError,
  preflightEvmV3Capability,
  selectEvmV3Capability,
  validateEvmV3Manifest,
  validateSourceFirstTimeoutsV3,
};
