const fs = require("node:fs");
const path = require("node:path");
const { Contract, JsonRpcProvider, getAddress, keccak256 } = require("ethers");
const {
  validateFxMarketConfig,
} = require("../../../packages/network/src/fx-market-config");

const TOKEN_ABI = Object.freeze([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function version() view returns (string)",
  "function decimals() view returns (uint8)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function authorizationState(address authorizer,bytes32 nonce) view returns (bool)",
]);
const ADAPTER_ABI = Object.freeze([
  "function ADAPTER_VERSION() view returns (uint16)",
  "function asset() view returns (address)",
  "function assetDecimals() view returns (uint8)",
  "function minimumLockDuration() view returns (uint64)",
  "function maximumLockDuration() view returns (uint64)",
]);
const NATIVE_ADAPTER_ABI = Object.freeze([
  "function ADAPTER_VERSION() view returns (uint16)",
  "function minimumLockDuration() view returns (uint64)",
  "function maximumLockDuration() view returns (uint64)",
]);
const FACTORY_ABI = Object.freeze([
  "function asset() view returns (address)",
  "function htlc() view returns (address)",
]);
const PROFILE_FILES = Object.freeze({
  testnet: "public-testnet-v1-market-candidate.json",
  mainnet: "mainnet-v1-market-candidate.json",
});
const NETWORKS = Object.freeze({
  "84532": Object.freeze({
    key: "baseSepolia",
    id: "base-sepolia",
    publicRpcUrl: "https://sepolia.base.org",
    publicRpcUrls: Object.freeze(["https://sepolia.base.org"]),
    rpcListEnvironmentVariable: "BASE_SEPOLIA_RPC_URLS",
    explorerAddressUrl: "https://sepolia.basescan.org/address",
    deploymentAllowed: true,
  }),
  "43113": Object.freeze({
    key: "avalancheFuji",
    id: "avalanche-fuji",
    publicRpcUrl: "https://api.avax-test.network/ext/bc/C/rpc",
    publicRpcUrls: Object.freeze([
      "https://api.avax-test.network/ext/bc/C/rpc",
    ]),
    rpcListEnvironmentVariable: "AVALANCHE_FUJI_RPC_URLS",
    explorerAddressUrl: "https://testnet.snowtrace.io/address",
    deploymentAllowed: true,
  }),
  "8453": Object.freeze({
    key: "base",
    id: "base",
    publicRpcUrl: "https://public.1rpc.io/base",
    publicRpcUrls: Object.freeze([
      "https://public.1rpc.io/base",
      "https://base-mainnet.public.blastapi.io",
    ]),
    rpcListEnvironmentVariable: "BASE_RPC_URLS",
    explorerAddressUrl: "https://basescan.org/address",
    deploymentAllowed: false,
  }),
  "43114": Object.freeze({
    key: "avalanche",
    id: "avalanche",
    publicRpcUrl: "https://api.avax.network/ext/bc/C/rpc",
    publicRpcUrls: Object.freeze([
      "https://api.avax.network/ext/bc/C/rpc",
      "https://avalanche-c-chain-rpc.publicnode.com",
    ]),
    rpcListEnvironmentVariable: "AVALANCHE_RPC_URLS",
    explorerAddressUrl: "https://snowtrace.io/address",
    deploymentAllowed: false,
  }),
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sanitizedRpcFailure(error) {
  return String(error?.message || error || "unknown failure").replace(
    /https?:\/\/[^\s"')]+/gi,
    "[redacted-rpc]"
  );
}

function readMarket(contractsRoot, profile) {
  const file = PROFILE_FILES[profile];
  assert(file, `profile must be one of ${Object.keys(PROFILE_FILES).join(", ")}`);
  return validateFxMarketConfig(JSON.parse(fs.readFileSync(
    path.join(contractsRoot, "deployments", "fx", file),
    "utf8"
  )));
}

function networkFor(market, networkId) {
  const chain = market.chains.find((candidate) =>
    candidate.chainId === String(networkId) || NETWORKS[candidate.chainId]?.id === networkId
  );
  assert(chain, `network ${networkId} is not frozen in ${market.releaseStage}`);
  const network = NETWORKS[chain.chainId];
  assert(network, `chain ${chain.chainId} has no reviewed network configuration`);
  return { ...network, ...chain };
}

function rpcUrlsFor(network, environment = process.env) {
  const configured = String(
    environment[network.rpcListEnvironmentVariable] ||
      environment[network.rpcEnvironmentVariable] ||
      ""
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const defaults = network.publicRpcUrls || [network.publicRpcUrl];
  return [...new Set(configured.length ? configured : defaults)];
}

function providerFor(network, rpcUrl = rpcUrlsFor(network)[0]) {
  assert(rpcUrl, `${network.rpcEnvironmentVariable} is required`);
  return new JsonRpcProvider(rpcUrl, BigInt(network.chainId), {
    staticNetwork: true,
    cacheTimeout: -1,
    // Some public providers reject JSON-RPC batches even for ordinary view
    // calls. Sequential requests make the cross-provider preflight comparable.
    batchMaxCount: 1,
  });
}

async function preflightMarketChain(provider, network) {
  const connected = await provider.getNetwork();
  assert(String(connected.chainId) === network.chainId, "RPC chain mismatch");
  const assets = [];
  for (const asset of network.assets) {
    if (asset.kind === "native") {
      assets.push({
        symbol: asset.symbol,
        kind: "native",
        decimals: asset.decimals,
      });
      continue;
    }
    const code = await provider.getCode(asset.token);
    assert(code !== "0x", `${network.name} ${asset.symbol} has no runtime code`);
    assert(
      keccak256(code).toLowerCase() === asset.runtimeCodeHash,
      `${network.name} ${asset.symbol} runtime hash changed`
    );
    const token = new Contract(asset.token, TOKEN_ABI, provider);
    const [name, symbol, version, decimals, domainSeparator, authorizationUsed] =
      await Promise.all([
        token.name(),
        token.symbol(),
        token.version(),
        token.decimals(),
        token.DOMAIN_SEPARATOR(),
        token.authorizationState(
          "0x0000000000000000000000000000000000000001",
          `0x${"00".repeat(32)}`
        ),
      ]);
    assert(name === asset.name, `${network.name} ${asset.symbol} name changed`);
    assert(symbol === asset.symbol, `${network.name} ${asset.symbol} symbol changed`);
    assert(version === asset.eip712Version, `${network.name} ${asset.symbol} version changed`);
    assert(Number(decimals) === asset.decimals, `${network.name} ${asset.symbol} decimals changed`);
    assert(
      String(domainSeparator).toLowerCase() === asset.domainSeparator,
      `${network.name} ${asset.symbol} domain separator changed`
    );
    assert(authorizationUsed === false, `${network.name} ${asset.symbol} probe nonce is used`);
    assets.push({
      symbol: asset.symbol,
      kind: "erc20",
      address: getAddress(asset.token).toLowerCase(),
      decimals: asset.decimals,
      runtimeCodeHash: asset.runtimeCodeHash,
      domainSeparator: asset.domainSeparator,
      eip3009: true,
    });
  }
  return {
    chainId: network.chainId,
    name: network.name,
    requiredConfirmations: network.requiredConfirmations,
    reorgSafetyBlocks: network.reorgSafetyBlocks,
    assets,
  };
}

async function preflightMarketChainAcrossRpcs(
  network,
  {
    environment = process.env,
    providerFactory = providerFor,
    preflight = preflightMarketChain,
  } = {}
) {
  const rpcUrls = rpcUrlsFor(network, environment);
  if (!network.deploymentAllowed) {
    assert(
      rpcUrls.length >= 2,
      `${network.name} mainnet preflight requires pinned primary and fallback RPCs`
    );
  }
  const results = [];
  for (let index = 0; index < rpcUrls.length; index += 1) {
    try {
      results.push(await preflight(providerFactory(network, rpcUrls[index]), network));
    } catch (error) {
      throw new Error(
        `${network.name} RPC ${index + 1}/${rpcUrls.length} preflight failed: ${sanitizedRpcFailure(error)}`
      );
    }
  }
  const baseline = JSON.stringify(results[0]);
  assert(
    results.every((result) => JSON.stringify(result) === baseline),
    `${network.name} primary and fallback RPC preflight results differ`
  );
  return {
    evidence: results[0],
    consensus: {
      chainId: network.chainId,
      endpointCount: rpcUrls.length,
      identical: true,
    },
  };
}

async function preflightMarketDeploymentAcrossRpcs(
  network,
  record,
  {
    environment = process.env,
    providerFactory = providerFor,
    preflight = preflightMarketDeployment,
  } = {}
) {
  const rpcUrls = rpcUrlsFor(network, environment);
  assert(
    rpcUrls.length >= 2,
    `${network.name} mainnet deployment preflight requires pinned primary and fallback RPCs`
  );
  const results = [];
  for (let index = 0; index < rpcUrls.length; index += 1) {
    try {
      results.push(await preflight(
        providerFactory(network, rpcUrls[index]),
        network,
        record
      ));
    } catch (error) {
      throw new Error(
        `${network.name} RPC ${index + 1}/${rpcUrls.length} deployment preflight failed: ${sanitizedRpcFailure(error)}`
      );
    }
  }
  const baseline = JSON.stringify(results[0]);
  assert(
    results.every((result) => JSON.stringify(result) === baseline),
    `${network.name} primary and fallback deployment evidence differs`
  );
  return {
    evidence: results[0],
    consensus: {
      chainId: network.chainId,
      endpointCount: rpcUrls.length,
      identical: true,
    },
  };
}

async function preflightMarketDeployment(provider, network, record) {
  assert(record.marketId, "deployment record is missing marketId");
  const nativeCode = await provider.getCode(record.native.address);
  assert(
    nativeCode !== "0x" && keccak256(nativeCode) === record.native.runtimeCodeHash,
    `${network.name} native adapter runtime differs`
  );
  const native = new Contract(record.native.address, NATIVE_ADAPTER_ABI, provider);
  const [nativeVersion, nativeMinimum, nativeMaximum] = await Promise.all([
    native.ADAPTER_VERSION(),
    native.minimumLockDuration(),
    native.maximumLockDuration(),
  ]);
  assert(
    nativeVersion === 3n &&
      nativeMinimum === BigInt(record.timeoutPolicy.minimumSeconds) &&
      nativeMaximum === BigInt(record.timeoutPolicy.maximumSeconds),
    `${network.name} native adapter immutables differ`
  );

  const expectedTokens = network.assets.filter((asset) => asset.kind === "erc20");
  assert(record.erc20s?.length === expectedTokens.length, `${network.name} token deployments are incomplete`);
  for (const asset of expectedTokens) {
    const deployed = record.erc20s.find((item) => item.symbol === asset.symbol);
    assert(deployed, `${network.name} ${asset.symbol} deployment is missing`);
    const [adapterCode, factoryCode] = await Promise.all([
      provider.getCode(deployed.adapter.address),
      provider.getCode(deployed.exactFactory.address),
    ]);
    assert(
      adapterCode !== "0x" && keccak256(adapterCode) === deployed.adapter.runtimeCodeHash,
      `${network.name} ${asset.symbol} adapter runtime differs`
    );
    assert(
      factoryCode !== "0x" && keccak256(factoryCode) === deployed.exactFactory.runtimeCodeHash,
      `${network.name} ${asset.symbol} exact factory runtime differs`
    );
    const adapter = new Contract(deployed.adapter.address, ADAPTER_ABI, provider);
    const factory = new Contract(deployed.exactFactory.address, FACTORY_ABI, provider);
    const [
      version,
      token,
      decimals,
      minimum,
      maximum,
      factoryToken,
      factoryHtlc,
    ] = await Promise.all([
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
        token.toLowerCase() === asset.token &&
        Number(decimals) === asset.decimals &&
        minimum === BigInt(record.timeoutPolicy.minimumSeconds) &&
        maximum === BigInt(record.timeoutPolicy.maximumSeconds),
      `${network.name} ${asset.symbol} adapter immutables differ`
    );
    assert(
      factoryToken.toLowerCase() === asset.token &&
        factoryHtlc.toLowerCase() === deployed.adapter.address,
      `${network.name} ${asset.symbol} exact factory immutables differ`
    );
  }
  return {
    chainId: network.chainId,
    native: record.native.address,
    erc20s: record.erc20s.map((item) => ({
      symbol: item.symbol,
      adapter: item.adapter.address,
      exactFactory: item.exactFactory.address,
    })),
  };
}

module.exports = {
  NETWORKS,
  PROFILE_FILES,
  TOKEN_ABI,
  assert,
  networkFor,
  preflightMarketChain,
  preflightMarketChainAcrossRpcs,
  preflightMarketDeployment,
  preflightMarketDeploymentAcrossRpcs,
  providerFor,
  readMarket,
  rpcUrlsFor,
};
