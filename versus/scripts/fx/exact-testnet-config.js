const fs = require("node:fs");
const path = require("node:path");
const {
  Contract,
  JsonRpcProvider,
  TypedDataEncoder,
  Wallet,
  getAddress,
  keccak256,
} = require("ethers");
const { buildExactFreezeRecord } = require("./exact-build-freeze");
const { buildV3FreezeRecord } = require("./v3-build-freeze");

const MINIMUM_SECONDS = 60;
const MAXIMUM_SECONDS = 7 * 24 * 60 * 60;
const NETWORKS = Object.freeze({
  "base-sepolia": Object.freeze({
    key: "baseSepolia",
    chainId: "84532",
    name: "Base Sepolia",
    rpcEnvironmentVariable: "BASE_SEPOLIA_RPC_URL",
    publicRpcUrl: "https://sepolia.base.org",
    usdc: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    tokenName: "USDC",
    tokenVersion: "2",
    explorer: "https://sepolia.basescan.org/address",
  }),
  "arbitrum-sepolia": Object.freeze({
    key: "arbitrumSepolia",
    chainId: "421614",
    name: "Arbitrum Sepolia",
    rpcEnvironmentVariable: "ARBITRUM_SEPOLIA_RPC_URL",
    publicRpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
    usdc: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d",
    tokenName: "USD Coin",
    tokenVersion: "2",
    explorer: "https://sepolia.arbiscan.io/address",
  }),
});

const TOKEN_ABI = Object.freeze([
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function decimals() view returns (uint8)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
]);
const ADAPTER_ABI = Object.freeze([
  "function ADAPTER_VERSION() view returns (uint16)",
  "function asset() view returns (address)",
  "function assetDecimals() view returns (uint8)",
  "function minimumLockDuration() view returns (uint64)",
  "function maximumLockDuration() view returns (uint64)",
]);
const FACTORY_ABI = Object.freeze([
  "function asset() view returns (address)",
  "function htlc() view returns (address)",
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function networkConfig(networkId) {
  const network = NETWORKS[networkId];
  assert(network, "generic exact deployment is restricted to public testnets");
  return network;
}

function providerFor(network) {
  return new JsonRpcProvider(
    process.env[network.rpcEnvironmentVariable] || network.publicRpcUrl,
    BigInt(network.chainId),
    { staticNetwork: true, cacheTimeout: -1 }
  );
}

async function decryptDeployer(repositoryRoot) {
  const directory = path.resolve(
    process.env.FX_PHASE5_IDENTITY_DIRECTORY ||
      path.join(repositoryRoot, ".local", "fx-phase5-testnet")
  );
  const password = fs.readFileSync(
    path.join(directory, "identity-password.txt"),
    "utf8"
  ).trim();
  return Wallet.fromEncryptedJson(
    fs.readFileSync(path.join(directory, "deployer.keystore.json"), "utf8"),
    password
  );
}

function artifact(contractsRoot, source, name) {
  return readJson(path.join(
    contractsRoot,
    "artifacts",
    "contracts",
    "fx",
    `${source}.sol`,
    `${name}.json`
  ));
}

function committedBuilds(contractsRoot) {
  const exact = readJson(path.join(
    contractsRoot,
    "deployments",
    "fx",
    "evm-exact-build.json"
  ));
  const v3 = readJson(path.join(
    contractsRoot,
    "deployments",
    "fx",
    "evm-htlc-v3-build.json"
  ));
  assert(
    JSON.stringify(exact) === JSON.stringify(buildExactFreezeRecord(contractsRoot)),
    "generic exact build differs from its committed freeze"
  );
  assert(
    JSON.stringify(v3) === JSON.stringify(buildV3FreezeRecord(contractsRoot)),
    "V3 build differs from its committed freeze"
  );
  return { exact, v3 };
}

async function preflightToken(provider, network) {
  const [connected, code] = await Promise.all([
    provider.getNetwork(),
    provider.getCode(network.usdc),
  ]);
  assert(String(connected.chainId) === network.chainId, "RPC chain mismatch");
  assert(code !== "0x", `${network.name} USDC has no runtime code`);
  const token = new Contract(network.usdc, TOKEN_ABI, provider);
  const [name, version, decimals, domainSeparator] = await Promise.all([
    token.name(),
    token.version(),
    token.decimals(),
    token.DOMAIN_SEPARATOR(),
  ]);
  const expectedDomain = TypedDataEncoder.hashDomain({
    name: network.tokenName,
    version: network.tokenVersion,
    chainId: BigInt(network.chainId),
    verifyingContract: network.usdc,
  });
  assert(
    name === network.tokenName &&
      version === network.tokenVersion &&
      decimals === 6n &&
      domainSeparator === expectedDomain,
    `${network.name} USDC EIP-3009 domain differs from frozen metadata`
  );
  return {
    address: getAddress(network.usdc).toLowerCase(),
    runtimeCodeHash: keccak256(code),
    symbol: "USDC",
    name,
    version,
    decimals: 6,
    domainSeparator,
  };
}

async function preflightDeployment(provider, network, record) {
  const [token, adapterCode, factoryCode] = await Promise.all([
    preflightToken(provider, network),
    provider.getCode(record.erc20.adapterAddress),
    provider.getCode(record.exactFactory.address),
  ]);
  assert(
    adapterCode !== "0x" && keccak256(adapterCode) === record.erc20.runtimeCodeHash,
    "generic V3 adapter runtime hash mismatch"
  );
  assert(
    factoryCode !== "0x" && keccak256(factoryCode) === record.exactFactory.runtimeCodeHash,
    "generic exact factory runtime hash mismatch"
  );
  const adapter = new Contract(record.erc20.adapterAddress, ADAPTER_ABI, provider);
  const factory = new Contract(record.exactFactory.address, FACTORY_ABI, provider);
  const [version, asset, decimals, minimum, maximum, factoryAsset, htlc] =
    await Promise.all([
      adapter.ADAPTER_VERSION(),
      adapter.asset(),
      adapter.assetDecimals(),
      adapter.minimumLockDuration(),
      adapter.maximumLockDuration(),
      factory.asset(),
      factory.htlc(),
    ]);
  assert(
    version === 3n &&
      getAddress(asset).toLowerCase() === token.address &&
      decimals === 6n &&
      minimum === BigInt(MINIMUM_SECONDS) &&
      maximum === BigInt(MAXIMUM_SECONDS),
    "generic V3 adapter immutable mismatch"
  );
  assert(
    getAddress(factoryAsset).toLowerCase() === token.address &&
      getAddress(htlc).toLowerCase() === record.erc20.adapterAddress,
    "generic exact factory immutable mismatch"
  );
  return {
    chainId: network.chainId,
    token,
    erc20AdapterVersion: Number(version),
    factoryAsset: getAddress(factoryAsset).toLowerCase(),
    factoryHtlc: getAddress(htlc).toLowerCase(),
  };
}

module.exports = {
  ADAPTER_ABI,
  FACTORY_ABI,
  MAXIMUM_SECONDS,
  MINIMUM_SECONDS,
  NETWORKS,
  TOKEN_ABI,
  artifact,
  assert,
  committedBuilds,
  decryptDeployer,
  networkConfig,
  preflightDeployment,
  preflightToken,
  providerFor,
  readJson,
};
