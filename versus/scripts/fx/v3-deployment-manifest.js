const fs = require("node:fs");
const path = require("node:path");
const {
  AbiCoder,
  Contract,
  Interface,
  JsonRpcProvider,
  Wallet,
  getAddress,
  keccak256,
  toUtf8Bytes,
} = require("ethers");
const { phase5Network } = require("./phase5-testnet-config");
const { buildV3FreezeRecord } = require("./v3-build-freeze");

const SCHEMA = "versus-fx-evm-v3-capabilities";
const SCHEMA_VERSION = 3;
const SETTLEMENT_MODE = "requester-secret-source-first-compact";
const TOKEN_ADDRESS = "0xcba3d9354dd4c30bb6961abb4473a6340486e01b";
const TOKEN_DECIMALS = 6;
const MINIMUM_SECONDS = 60;
const MAXIMUM_SECONDS = 7 * 24 * 60 * 60;
const MINIMUM_DELTA_SECONDS = 3_600;
const MINIMUM_RELAY_WINDOW_SECONDS = 3_600;
const DOMAIN_TYPEHASH = keccak256(
  toUtf8Bytes("VersusFxHtlcV3Domain(uint256 chainId,address adapter)")
);
const FILE_KEYS = Object.freeze({
  "base-sepolia": "baseSepolia",
  "arbitrum-sepolia": "arbitrumSepolia",
});
const HARDHAT_NETWORK_IDS = Object.freeze({
  baseSepolia: "base-sepolia",
  arbitrumSepolia: "arbitrum-sepolia",
});
const EXPLORER_ADDRESS_URLS = Object.freeze({
  "84532": "https://sepolia.basescan.org/address",
  "421614": "https://sepolia.arbiscan.io/address",
});
const FORBIDDEN_FUNCTION_NAMES = Object.freeze([
  "admin",
  "implementation",
  "owner",
  "pause",
  "proxiableuuid",
  "renounceownership",
  "selfdestruct",
  "sweep",
  "transferownership",
  "upgrade",
]);
const NATIVE_READ_ABI = Object.freeze([
  "function ADAPTER_VERSION() view returns (uint16)",
  "function minimumLockDuration() view returns (uint64)",
  "function maximumLockDuration() view returns (uint64)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
]);
const ERC20_READ_ABI = Object.freeze([
  ...NATIVE_READ_ABI,
  "function asset() view returns (address)",
  "function assetDecimals() view returns (uint8)",
]);
const TOKEN_READ_ABI = Object.freeze([
  "function decimals() view returns (uint8)",
]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function artifact(root, name) {
  return readJson(path.join(
    root,
    "artifacts",
    "contracts",
    "fx",
    `${name}.sol`,
    `${name}.json`
  ));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertHex(value, bytes, label) {
  assert(
    typeof value === "string" &&
      new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value),
    `${label} must be ${bytes} bytes`
  );
}

function normalizeAddress(value, label) {
  try {
    return getAddress(value).toLowerCase();
  } catch {
    throw new Error(`${label} is not a valid address`);
  }
}

function assertNoPrivilegedSurface(build, label) {
  const functions = build.abi
    .filter((entry) => entry.type === "function")
    .map((entry) => String(entry.name).toLowerCase());
  for (const name of functions) {
    assert(
      !FORBIDDEN_FUNCTION_NAMES.some((forbidden) => name.includes(forbidden)),
      `${label} exposes forbidden function ${name}`
    );
  }
  const constructors = build.abi.filter((entry) => entry.type === "constructor");
  assert(constructors.length === 1, `${label} must have exactly one constructor`);
  const expectedInputs = label === "native" ? 2 : 4;
  assert(
    constructors[0].inputs.length === expectedInputs,
    `${label} constructor shape changed`
  );
}

function deploymentPaths(contractsRoot, networkId) {
  const network = phase5Network(networkId);
  const fileKey = FILE_KEYS[networkId];
  assert(fileKey, "V3 deployment is restricted to public testnets");
  return {
    network,
    fileKey,
    outputPath: path.join(
      contractsRoot,
      "deployments",
      "fx",
      `${fileKey}-${network.chainId}-evm-htlc-v3.json`
    ),
  };
}

function providerFor(network) {
  const rpcUrl =
    process.env[network.rpcEnvironmentVariable] || network.publicRpcUrl;
  return new JsonRpcProvider(rpcUrl, BigInt(network.chainId), {
    staticNetwork: true,
    cacheTimeout: -1,
  });
}

async function decryptDeployer(repositoryRoot) {
  const directory = path.resolve(
    process.env.FX_PHASE5_IDENTITY_DIRECTORY ||
      path.join(repositoryRoot, ".local", "fx-phase5-testnet")
  );
  const password = fs
    .readFileSync(path.join(directory, "identity-password.txt"), "utf8")
    .trim();
  return Wallet.fromEncryptedJson(
    fs.readFileSync(path.join(directory, "deployer.keystore.json"), "utf8"),
    password
  );
}

function assertCommittedFreeze(contractsRoot) {
  const committedPath = path.join(
    contractsRoot,
    "deployments",
    "fx",
    "evm-htlc-v3-build.json"
  );
  const committed = readJson(committedPath);
  const regenerated = buildV3FreezeRecord(contractsRoot);
  assert(
    JSON.stringify(regenerated) === JSON.stringify(committed),
    "regenerated V3 build evidence differs from the committed freeze"
  );
  const nativeBuild = artifact(contractsRoot, "EvmNativeHtlcV3");
  const erc20Build = artifact(contractsRoot, "EvmHtlcV3");
  assert(
    keccak256(nativeBuild.bytecode) ===
      committed.builds.native.creationCodeHash,
    "native V3 creation-code hash differs from the committed freeze"
  );
  assert(
    keccak256(erc20Build.bytecode) ===
      committed.builds.erc20.creationCodeHash,
    "ERC-20 V3 creation-code hash differs from the committed freeze"
  );
  assertNoPrivilegedSurface(nativeBuild, "native");
  assertNoPrivilegedSurface(erc20Build, "erc20");
  return { freeze: committed, nativeBuild, erc20Build };
}

function validateCapability(capability, freeze) {
  assert(
    capability && typeof capability === "object",
    "V3 capability is required"
  );
  const network = Object.values(FILE_KEYS)
    .map((key) => HARDHAT_NETWORK_IDS[key])
    .map((id) => phase5Network(id))
    .find((candidate) => candidate.chainId === String(capability.chainId));
  assert(network, `unsupported V3 chain ${capability.chainId}`);
  const chainId = String(capability.chainId);
  const nativeAddress = normalizeAddress(
    capability.native?.adapterAddress,
    "native adapter"
  );
  const erc20Address = normalizeAddress(
    capability.erc20?.adapterAddress,
    "ERC-20 adapter"
  );
  assertHex(capability.native.runtimeCodeHash, 32, "native runtime hash");
  assertHex(capability.erc20.runtimeCodeHash, 32, "ERC-20 runtime hash");
  assert(
    Number.isSafeInteger(capability.native.deploymentBlock) &&
      capability.native.deploymentBlock > 0,
    "native deployment block is invalid"
  );
  assert(
    Number.isSafeInteger(capability.erc20.deploymentBlock) &&
      capability.erc20.deploymentBlock > 0,
    "ERC-20 deployment block is invalid"
  );
  assert(
    capability.native.assetId === "native:eth",
    "native asset ID must be native:eth"
  );
  assert(
    normalizeAddress(capability.erc20.asset?.address, "ERC-20 asset") ===
      TOKEN_ADDRESS,
    "ERC-20 asset differs from the frozen test token"
  );
  assertHex(
    capability.erc20.asset.runtimeCodeHash,
    32,
    "token runtime hash"
  );
  assert(
    capability.erc20.asset.decimals === TOKEN_DECIMALS &&
      capability.erc20.asset.standard === "ERC20",
    "ERC-20 asset metadata differs from the frozen test token"
  );
  assert(
    capability.confirmationPolicy?.requiredConfirmations ===
      network.requiredConfirmations &&
      capability.confirmationPolicy?.reorgSafetyBlocks ===
        network.reorgSafetyBlocks,
    "confirmation policy differs from the frozen network policy"
  );
  const timeout = capability.timeoutPolicy;
  assert(
    timeout?.minimumSeconds === MINIMUM_SECONDS &&
      timeout?.maximumSeconds === MAXIMUM_SECONDS &&
      timeout?.minimumCrossChainDeltaSeconds === MINIMUM_DELTA_SECONDS &&
      timeout?.minimumDestinationRelayWindowSeconds ===
        MINIMUM_RELAY_WINDOW_SECONDS,
    "timeout policy differs from the frozen V3 policy"
  );
  assert(
    freeze.builds.native.adapterVersion === 3 &&
      freeze.builds.erc20.adapterVersion === 3,
    "V3 build evidence has the wrong adapter version"
  );
  return {
    ...capability,
    chainId,
    native: { ...capability.native, adapterAddress: nativeAddress },
    erc20: {
      ...capability.erc20,
      adapterAddress: erc20Address,
      asset: {
        ...capability.erc20.asset,
        address: TOKEN_ADDRESS,
      },
    },
  };
}

function validateV3Manifest(input, contractsRoot) {
  assert(input?.schema === SCHEMA, "unexpected V3 manifest schema");
  assert(input?.schemaVersion === SCHEMA_VERSION, "unexpected V3 schema version");
  assert(
    input?.settlementMode === SETTLEMENT_MODE,
    "unexpected V3 settlement mode"
  );
  const freeze =
    contractsRoot == null
      ? input
      : assertCommittedFreeze(contractsRoot).freeze;
  assert(
    JSON.stringify(input.builds) === JSON.stringify(freeze.builds),
    "V3 manifest build evidence differs from the committed freeze"
  );
  assert(
    Array.isArray(input.capabilities) &&
      input.capabilities.length >= 1 &&
      input.capabilities.length <= 2,
    "V3 manifest must contain one or two capabilities"
  );
  const capabilities = input.capabilities.map((capability) =>
    validateCapability(capability, freeze)
  );
  assert(
    new Set(capabilities.map((capability) => capability.chainId)).size ===
      capabilities.length,
    "V3 manifest contains a duplicate chain"
  );
  return {
    schema: SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    settlementMode: SETTLEMENT_MODE,
    builds: input.builds,
    capabilities,
  };
}

function expectedDomain(chainId, adapterAddress) {
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256", "address"],
      [DOMAIN_TYPEHASH, BigInt(chainId), adapterAddress]
    )
  );
}

async function preflightV3Capability(provider, manifest, chainId) {
  const capability = manifest.capabilities.find(
    (candidate) => candidate.chainId === String(chainId)
  );
  assert(capability, `manifest has no capability for chain ${chainId}`);
  const connected = await provider.getNetwork();
  assert(
    String(connected.chainId) === String(chainId),
    `RPC returned chain ${connected.chainId}, expected ${chainId}`
  );
  const [nativeCode, erc20Code, tokenCode] = await Promise.all([
    provider.getCode(capability.native.adapterAddress),
    provider.getCode(capability.erc20.adapterAddress),
    provider.getCode(capability.erc20.asset.address),
  ]);
  assert(nativeCode !== "0x", "native V3 adapter has no runtime code");
  assert(erc20Code !== "0x", "ERC-20 V3 adapter has no runtime code");
  assert(tokenCode !== "0x", "V3 test token has no runtime code");
  assert(
    keccak256(nativeCode) === capability.native.runtimeCodeHash,
    "native V3 runtime-code hash mismatch"
  );
  assert(
    keccak256(erc20Code) === capability.erc20.runtimeCodeHash,
    "ERC-20 V3 runtime-code hash mismatch"
  );
  assert(
    keccak256(tokenCode) === capability.erc20.asset.runtimeCodeHash,
    "V3 test-token runtime-code hash mismatch"
  );
  const native = new Contract(
    capability.native.adapterAddress,
    NATIVE_READ_ABI,
    provider
  );
  const erc20 = new Contract(
    capability.erc20.adapterAddress,
    ERC20_READ_ABI,
    provider
  );
  const token = new Contract(
    capability.erc20.asset.address,
    TOKEN_READ_ABI,
    provider
  );
  const [
    nativeVersion,
    nativeMinimum,
    nativeMaximum,
    nativeDomain,
    erc20Version,
    erc20Minimum,
    erc20Maximum,
    erc20Domain,
    asset,
    assetDecimals,
    tokenDecimals,
  ] = await Promise.all([
    native.ADAPTER_VERSION(),
    native.minimumLockDuration(),
    native.maximumLockDuration(),
    native.DOMAIN_SEPARATOR(),
    erc20.ADAPTER_VERSION(),
    erc20.minimumLockDuration(),
    erc20.maximumLockDuration(),
    erc20.DOMAIN_SEPARATOR(),
    erc20.asset(),
    erc20.assetDecimals(),
    token.decimals(),
  ]);
  assert(nativeVersion === 3n && erc20Version === 3n, "adapter version mismatch");
  assert(
    nativeMinimum === BigInt(MINIMUM_SECONDS) &&
      erc20Minimum === BigInt(MINIMUM_SECONDS) &&
      nativeMaximum === BigInt(MAXIMUM_SECONDS) &&
      erc20Maximum === BigInt(MAXIMUM_SECONDS),
    "deployed V3 timeout immutables differ"
  );
  assert(
    normalizeAddress(asset, "deployed ERC-20 asset") === TOKEN_ADDRESS &&
      assetDecimals === BigInt(TOKEN_DECIMALS) &&
      tokenDecimals === BigInt(TOKEN_DECIMALS),
    "deployed V3 token immutables differ"
  );
  assert(
    nativeDomain ===
      expectedDomain(chainId, capability.native.adapterAddress) &&
      erc20Domain ===
        expectedDomain(chainId, capability.erc20.adapterAddress),
    "deployed V3 domain separator differs"
  );
  return {
    chainId: String(chainId),
    native: {
      adapterAddress: capability.native.adapterAddress,
      runtimeCodeHash: keccak256(nativeCode),
      deploymentBlock: capability.native.deploymentBlock,
      adapterVersion: Number(nativeVersion),
      minimumLockDuration: Number(nativeMinimum),
      maximumLockDuration: Number(nativeMaximum),
      domainSeparator: nativeDomain,
    },
    erc20: {
      adapterAddress: capability.erc20.adapterAddress,
      runtimeCodeHash: keccak256(erc20Code),
      deploymentBlock: capability.erc20.deploymentBlock,
      adapterVersion: Number(erc20Version),
      asset: normalizeAddress(asset, "deployed ERC-20 asset"),
      assetDecimals: Number(assetDecimals),
      minimumLockDuration: Number(erc20Minimum),
      maximumLockDuration: Number(erc20Maximum),
      domainSeparator: erc20Domain,
    },
    tokenRuntimeCodeHash: keccak256(tokenCode),
  };
}

function explorerUrl(chainId, address) {
  const root = EXPLORER_ADDRESS_URLS[String(chainId)];
  assert(root, `no V3 explorer configured for chain ${chainId}`);
  return `${root}/${address}#code`;
}

module.exports = {
  ERC20_READ_ABI,
  FILE_KEYS,
  HARDHAT_NETWORK_IDS,
  MAXIMUM_SECONDS,
  MINIMUM_DELTA_SECONDS,
  MINIMUM_RELAY_WINDOW_SECONDS,
  MINIMUM_SECONDS,
  NATIVE_READ_ABI,
  SCHEMA,
  SCHEMA_VERSION,
  SETTLEMENT_MODE,
  TOKEN_ADDRESS,
  TOKEN_DECIMALS,
  artifact,
  assert,
  assertCommittedFreeze,
  decryptDeployer,
  deploymentPaths,
  explorerUrl,
  expectedDomain,
  preflightV3Capability,
  providerFor,
  readJson,
  validateV3Manifest,
};
