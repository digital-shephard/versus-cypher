const { keccak256, toUtf8Bytes } = require("ethers");
const { validateEvmV3Manifest } = require("./fx-evm-v3-adapter");
const { validateFxMarketConfig } = require("./fx-market-config");
const { canonicalJson } = require("./fx-protocol");

const FX_MARKET_DEPLOYMENT_SCHEMA = "versus-fx-market-deployment";
const FX_MARKET_DEPLOYMENT_SCHEMA_VERSION = 1;

class FxMarketDeploymentError extends Error {
  constructor(message, code = "INVALID_FX_MARKET_DEPLOYMENT") {
    super(message);
    this.name = "FxMarketDeploymentError";
    this.code = code;
  }
}

function requireCondition(condition, message) {
  if (!condition) throw new FxMarketDeploymentError(message);
}

function normalizedHash(value, label) {
  const result = String(value || "").toLowerCase();
  requireCondition(/^0x[0-9a-f]{64}$/.test(result), `${label} must be bytes32`);
  return result;
}

function normalizedAddress(value, label) {
  const result = String(value || "").toLowerCase();
  requireCondition(/^0x[0-9a-f]{40}$/.test(result), `${label} must be an address`);
  return result;
}

function deploymentEvidence(value, label) {
  requireCondition(value && typeof value === "object", `${label} is missing`);
  const deploymentBlock = Number(value.deploymentBlock);
  requireCondition(
    Number.isSafeInteger(deploymentBlock) && deploymentBlock > 0,
    `${label}.deploymentBlock must be a positive integer`
  );
  return {
    address: normalizedAddress(value.address, `${label}.address`),
    runtimeCodeHash: normalizedHash(
      value.runtimeCodeHash,
      `${label}.runtimeCodeHash`
    ),
    deploymentBlock,
  };
}

function validateExactBuild(value) {
  requireCondition(
    value?.schema === "versus-fx-evm-exact-build-freeze" &&
      value.schemaVersion === 1 &&
      value.settlementMode === "x402-exact-eip3009-to-v3" &&
      value.sourceTag === "generic-x402-exact-v1",
    "exact build freeze schema is unsupported"
  );
  const expected = ["EvmExactHtlcEscrow", "EvmExactHtlcFactory"];
  requireCondition(
    value.builds &&
      typeof value.builds === "object" &&
      !Array.isArray(value.builds) &&
      Object.keys(value.builds).sort().join(":") === expected.join(":"),
    "exact build freeze contracts are incomplete"
  );
  for (const contract of expected) {
    const build = value.builds[contract];
    requireCondition(build?.contract === contract, `${contract} build identity differs`);
    requireCondition(
      typeof build.sourcePath === "string" && build.sourcePath.length > 0 &&
        typeof build.compiler === "string" && build.compiler.length > 0 &&
        typeof build.evmVersion === "string" && build.evmVersion.length > 0 &&
        Number.isSafeInteger(build.optimizerRuns) && build.optimizerRuns >= 0 &&
        build.viaIR === true,
      `${contract} build settings are invalid`
    );
    normalizedHash(build.sourceSha256, `${contract}.sourceSha256`);
    normalizedHash(build.creationCodeHash, `${contract}.creationCodeHash`);
    normalizedHash(build.runtimeTemplateHash, `${contract}.runtimeTemplateHash`);
  }
  return value;
}

function assertCapabilityMatchesMarket(capability, chain, market) {
  requireCondition(
    capability.native.assetId === `native:${chain.nativeSymbol.toLowerCase()}`,
    `${chain.name} native capability differs from the market`
  );
  requireCondition(
    capability.confirmationPolicy.requiredConfirmations === chain.requiredConfirmations &&
      capability.confirmationPolicy.reorgSafetyBlocks === chain.reorgSafetyBlocks,
    `${chain.name} confirmation policy differs from the market`
  );
  requireCondition(
    capability.timeoutPolicy.minimumSeconds === market.timeoutPolicy.minimumSeconds &&
      capability.timeoutPolicy.maximumSeconds === market.timeoutPolicy.maximumSeconds &&
      capability.timeoutPolicy.minimumCrossChainDeltaSeconds ===
        market.timeoutPolicy.minimumCrossChainDeltaSeconds &&
      capability.timeoutPolicy.minimumDestinationRelayWindowSeconds ===
        market.timeoutPolicy.destinationRelayWindowSeconds,
    `${chain.name} timeout policy differs from the market`
  );
  const marketTokens = chain.assets.filter((asset) => asset.kind === "erc20");
  requireCondition(
    capability.erc20s.length === marketTokens.length,
    `${chain.name} ERC-20 capability count differs from the market`
  );
  for (const asset of marketTokens) {
    const deployed = capability.erc20s.find((item) => item.asset.address === asset.token);
    requireCondition(deployed, `${chain.name} ${asset.symbol} adapter is missing`);
    requireCondition(
      deployed.asset.symbol === asset.symbol &&
        deployed.asset.decimals === asset.decimals &&
        deployed.asset.runtimeCodeHash === asset.runtimeCodeHash,
      `${chain.name} ${asset.symbol} capability differs from the market`
    );
  }
}

function normalizeExactFactories(value, market, v3) {
  validateExactBuild(value?.build);
  const expectedCount = market.chains.reduce(
    (total, chain) => total + chain.assets.filter((asset) => asset.kind === "erc20").length,
    0
  );
  requireCondition(
    Array.isArray(value?.factories) && value.factories.length === expectedCount,
    "desktop exact factory count differs from the market"
  );
  const factories = new Map();
  for (const [index, input] of value.factories.entries()) {
    requireCondition(input && typeof input === "object", `exact.factories[${index}] is invalid`);
    const chainId = String(BigInt(input.chainId));
    const chain = market.chains.find((item) => item.chainId === chainId);
    requireCondition(chain, `exact factory chain ${chainId} is not in the market`);
    const token = normalizedAddress(input.token, `exact.factories[${index}].token`);
    const asset = chain.assets.find((item) => item.kind === "erc20" && item.token === token);
    requireCondition(asset, `${chain.name} exact factory token is not in the market`);
    const key = `${chainId}:${token}`;
    requireCondition(!factories.has(key), `${chain.name} ${asset.symbol} exact factory is duplicated`);
    const capability = v3.capabilities.find((item) => item.chainId === chainId);
    const adapter = capability?.erc20s.find((item) => item.asset.address === token);
    requireCondition(adapter, `${chain.name} ${asset.symbol} V3 adapter is missing`);
    requireCondition(
      input.symbol === asset.symbol &&
        input.tokenName === asset.name &&
        input.tokenVersion === asset.eip712Version &&
        normalizedAddress(input.htlc, `exact.factories[${index}].htlc`) ===
          adapter.adapterAddress &&
        String(input.facilitatorFeeAtomic) === market.economics.facilitatorFeeAtomic &&
        input.facilitatorRecipient === null,
      `${chain.name} ${asset.symbol} exact factory differs from the frozen market`
    );
    const evidence = deploymentEvidence(input, `exact.factories[${index}]`);
    factories.set(key, {
      chainId,
      symbol: asset.symbol,
      token,
      tokenName: asset.name,
      tokenVersion: asset.eip712Version,
      htlc: adapter.adapterAddress,
      facilitatorFeeAtomic: market.economics.facilitatorFeeAtomic,
      facilitatorRecipient: null,
      ...evidence,
    });
  }
  return factories;
}

function requireCanonicalMatch(actual, expected, message) {
  requireCondition(canonicalJson(actual) === canonicalJson(expected), message);
}

function assertChainRecord(record, chain, market, v3Builds, exactBuild) {
  const expectedSchema = market.releaseStage === "mainnet-v1-candidate"
    ? "versus-fx-market-v1-mainnet-chain"
    : "versus-fx-market-v1-testnet-chain";
  requireCondition(
    record?.schema === expectedSchema &&
      record.schemaVersion === 1,
    `chain ${chain.chainId} deployment record schema is unsupported`
  );
  requireCondition(String(record.chainId) === chain.chainId, `chain ${chain.chainId} record identity differs`);
  requireCondition(record.name === chain.name, `chain ${chain.chainId} record name differs`);
  requireCanonicalMatch(
    record.builds?.v3,
    v3Builds,
    `chain ${chain.chainId} V3 build freeze differs`
  );
  requireCanonicalMatch(
    record.builds?.exact,
    exactBuild,
    `chain ${chain.chainId} exact build freeze differs`
  );
  requireCanonicalMatch(
    record.confirmationPolicy,
    {
      requiredConfirmations: chain.requiredConfirmations,
      reorgSafetyBlocks: chain.reorgSafetyBlocks,
    },
    `chain ${chain.chainId} confirmation policy differs`
  );
  requireCanonicalMatch(
    record.timeoutPolicy,
    market.timeoutPolicy,
    `chain ${chain.chainId} timeout policy differs`
  );
  const expectedTokens = chain.assets.filter((asset) => asset.kind === "erc20");
  requireCondition(
    Array.isArray(record.erc20s) && record.erc20s.length === expectedTokens.length,
    `chain ${chain.chainId} token deployment count differs`
  );
  requireCondition(
    new Set(record.erc20s.map((item) => item.symbol)).size === record.erc20s.length,
    `chain ${chain.chainId} repeats a token deployment`
  );
  const verified = (status) => ["verified", "already-verified"].includes(status);
  requireCondition(
    record.evidence?.verificationStatus === "verified" &&
      verified(record.evidence.nativeVerification),
    `chain ${chain.chainId} is not fully explorer verified`
  );
  for (const asset of expectedTokens) {
    const deployed = record.erc20s.find((item) => item.symbol === asset.symbol);
    requireCondition(deployed?.asset, `chain ${chain.chainId} ${asset.symbol} deployment is missing`);
    requireCondition(
      deployed.asset.symbol === asset.symbol &&
        deployed.asset.kind === asset.kind &&
        String(deployed.asset.token).toLowerCase() === asset.token &&
        deployed.asset.decimals === asset.decimals &&
        deployed.asset.stable === asset.stable &&
        deployed.asset.x402ExactInput === asset.x402ExactInput &&
        deployed.asset.name === asset.name &&
        deployed.asset.eip712Version === asset.eip712Version &&
        String(deployed.asset.runtimeCodeHash).toLowerCase() === asset.runtimeCodeHash &&
        String(deployed.asset.domainSeparator).toLowerCase() === asset.domainSeparator,
      `chain ${chain.chainId} ${asset.symbol} asset evidence differs`
    );
    const verification = record.evidence.erc20Verification?.[asset.symbol];
    requireCondition(
      verified(verification?.adapterStatus) &&
        verified(verification?.exactFactoryStatus),
      `chain ${chain.chainId} ${asset.symbol} is not fully explorer verified`
    );
  }
}

function buildFxMarketDeployment({ market: marketInput, chainRecords, v3Builds, exactBuild } = {}) {
  const market = validateFxMarketConfig(marketInput);
  requireCondition(Array.isArray(chainRecords), "chain deployment records are missing");
  requireCondition(chainRecords.length === market.chains.length, "every market chain needs one deployment record");
  requireCondition(v3Builds && exactBuild, "frozen build evidence is missing");
  validateExactBuild(exactBuild);

  const records = new Map(chainRecords.map((record) => [String(record.chainId), record]));
  const exactFactories = [];
  const capabilities = market.chains.map((chain) => {
    const record = records.get(chain.chainId);
    requireCondition(record, `chain ${chain.chainId} deployment record is missing`);
    assertChainRecord(record, chain, market, v3Builds, exactBuild);
    requireCondition(record.marketId === market.marketId, `chain ${chain.chainId} marketId differs`);
    const native = deploymentEvidence(record.native, `chain ${chain.chainId} native adapter`);
    const recordTokens = new Map((record.erc20s || []).map((item) => [item.symbol, item]));
    const erc20s = chain.assets.filter((asset) => asset.kind === "erc20").map((asset) => {
      const deployed = recordTokens.get(asset.symbol);
      requireCondition(deployed, `chain ${chain.chainId} ${asset.symbol} deployment is missing`);
      requireCondition(
        String(deployed.asset?.token || "").toLowerCase() === asset.token,
        `chain ${chain.chainId} ${asset.symbol} token differs`
      );
      const adapter = deploymentEvidence(
        deployed.adapter,
        `chain ${chain.chainId} ${asset.symbol} adapter`
      );
      const factory = deploymentEvidence(
        deployed.exactFactory,
        `chain ${chain.chainId} ${asset.symbol} exact factory`
      );
      exactFactories.push({
        chainId: chain.chainId,
        symbol: asset.symbol,
        token: asset.token,
        tokenName: asset.name,
        tokenVersion: asset.eip712Version,
        htlc: adapter.address,
        facilitatorFeeAtomic: market.economics.facilitatorFeeAtomic,
        facilitatorRecipient: null,
        ...factory,
      });
      return {
        adapterAddress: adapter.address,
        runtimeCodeHash: adapter.runtimeCodeHash,
        deploymentBlock: adapter.deploymentBlock,
        asset: {
          address: asset.token,
          runtimeCodeHash: asset.runtimeCodeHash,
          symbol: asset.symbol,
          decimals: asset.decimals,
          standard: "ERC20",
        },
      };
    });
    return {
      chainId: chain.chainId,
      native: {
        adapterAddress: native.address,
        runtimeCodeHash: native.runtimeCodeHash,
        deploymentBlock: native.deploymentBlock,
        assetId: `native:${chain.nativeSymbol.toLowerCase()}`,
      },
      erc20s,
      confirmationPolicy: {
        requiredConfirmations: chain.requiredConfirmations,
        reorgSafetyBlocks: chain.reorgSafetyBlocks,
      },
      timeoutPolicy: {
        minimumSeconds: market.timeoutPolicy.minimumSeconds,
        maximumSeconds: market.timeoutPolicy.maximumSeconds,
        minimumCrossChainDeltaSeconds:
          market.timeoutPolicy.minimumCrossChainDeltaSeconds,
        minimumDestinationRelayWindowSeconds:
          market.timeoutPolicy.destinationRelayWindowSeconds,
      },
    };
  });

  const manifestCore = {
    schema: "versus-fx-evm-v3-capabilities",
    schemaVersion: 3,
    settlementMode: "requester-secret-source-first-compact",
    builds: v3Builds,
    capabilities,
  };
  const deploymentId = keccak256(toUtf8Bytes(canonicalJson(manifestCore)));
  const coordinationDomain = keccak256(
    toUtf8Bytes(`versus-fx-v1-coordination:${deploymentId}`)
  );
  const v3 = validateEvmV3Manifest({
    ...manifestCore,
    deploymentId,
    coordinationDomain,
  });
  return {
    schema: FX_MARKET_DEPLOYMENT_SCHEMA,
    schemaVersion: FX_MARKET_DEPLOYMENT_SCHEMA_VERSION,
    marketId: market.marketId,
    releaseStage: market.releaseStage,
    deploymentId,
    coordinationDomain,
    market,
    v3,
    exact: {
      build: exactBuild,
      factories: exactFactories.sort((left, right) =>
        `${left.chainId}:${left.symbol}`.localeCompare(`${right.chainId}:${right.symbol}`)
      ),
    },
  };
}

function buildFxDesktopMarket(deployment) {
  requireCondition(
    deployment?.schema === FX_MARKET_DEPLOYMENT_SCHEMA &&
      deployment.schemaVersion === FX_MARKET_DEPLOYMENT_SCHEMA_VERSION,
    "market deployment schema is unsupported"
  );
  const market = validateFxMarketConfig(deployment.market);
  const v3 = validateEvmV3Manifest(deployment.v3);
  requireCondition(deployment.marketId === market.marketId, "desktop marketId differs");
  requireCondition(
    deployment.releaseStage === market.releaseStage,
    "desktop release stage differs"
  );
  requireCondition(deployment.deploymentId === v3.deploymentId, "desktop deploymentId differs");
  requireCondition(
    deployment.coordinationDomain === v3.coordinationDomain,
    "desktop coordination domain differs"
  );
  requireCondition(
    v3.coordinationDomain === keccak256(
      toUtf8Bytes(`versus-fx-v1-coordination:${v3.deploymentId}`)
    ),
    "desktop coordination domain is not derived from its deployment"
  );
  const capabilities = new Map(v3.capabilities.map((capability) => [
    capability.chainId,
    capability,
  ]));
  requireCondition(
    capabilities.size === market.chains.length,
    "desktop capability count differs from the market"
  );
  for (const chain of market.chains) {
    const capability = capabilities.get(chain.chainId);
    requireCondition(capability, `desktop chain ${chain.chainId} capability is missing`);
    assertCapabilityMatchesMarket(capability, chain, market);
  }
  const factories = normalizeExactFactories(deployment.exact, market, v3);
  const chains = [];
  const positions = [];
  const configurations = {};
  for (const chain of market.chains) {
    const capability = capabilities.get(chain.chainId);
    requireCondition(capability, `desktop chain ${chain.chainId} capability is missing`);
    const chainKey = chain.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    chains.push({
      chainId: chain.chainId,
      chainKey,
      chain: chain.name.toUpperCase(),
      nativeAsset: chain.nativeSymbol,
      nativeDecimals: 18,
      nativeGasReserveAtomic: chain.nativeGasReserveAtomic,
      minimumGasUsd: chain.minimumGasUsd,
      rpcEnvironmentVariable: chain.rpcEnvironmentVariable,
    });
    const tokenCapabilities = chain.assets
      .filter((asset) => asset.kind === "erc20")
      .map((asset) => {
        const deployed = capability.erc20s.find(
          (item) => item.asset.address === asset.token
        );
        const exactFactory = factories.get(`${chain.chainId}:${asset.token}`);
        requireCondition(deployed, `${chain.name} ${asset.symbol} adapter is missing`);
        requireCondition(exactFactory, `${chain.name} ${asset.symbol} exact factory is missing`);
        return {
          symbol: asset.symbol,
          tokenAddress: asset.token,
          tokenDecimals: asset.decimals,
          tokenRuntimeCodeHash: asset.runtimeCodeHash,
          adapterV3Address: deployed.adapterAddress,
          adapterV3DeploymentBlock: deployed.deploymentBlock,
          adapterV3RuntimeCodeHash: deployed.runtimeCodeHash,
          exactFactoryAddress: exactFactory.address,
          exactFactoryDeploymentBlock: exactFactory.deploymentBlock,
          exactFactoryRuntimeCodeHash: exactFactory.runtimeCodeHash,
          x402ExactInput: asset.x402ExactInput,
        };
      });
    configurations[chain.chainId] = {
      chainId: chain.chainId,
      name: chain.name,
      nativeSymbol: chain.nativeSymbol,
      rpcEnvironmentVariable: chain.rpcEnvironmentVariable,
      nativeGasReserveWei: chain.nativeGasReserveAtomic,
      requiredConfirmations: chain.requiredConfirmations,
      nativeAdapterV3Address: capability.native.adapterAddress,
      nativeAdapterV3DeploymentBlock: capability.native.deploymentBlock,
      nativeAdapterV3RuntimeCodeHash: capability.native.runtimeCodeHash,
      tokenCapabilities,
      tokenAddress: tokenCapabilities.find((item) => item.symbol === "USDC")?.tokenAddress,
      tokenDecimals: tokenCapabilities.find((item) => item.symbol === "USDC")?.tokenDecimals,
    };
    positions.push(...chain.assets.map((asset) => ({
      id: `${chainKey}-${asset.symbol.toLowerCase()}`,
      chainId: chain.chainId,
      chainKey,
      chain: chain.name.toUpperCase(),
      asset: asset.symbol,
      decimals: asset.decimals,
      assetKind: asset.kind,
      assetAddress: asset.token,
    })));
  }
  return {
    marketId: market.marketId,
    releaseStage: market.releaseStage,
    deploymentId: v3.deploymentId,
    coordinationDomain: v3.coordinationDomain,
    chains,
    positions,
    routes: market.routes,
    configurations,
    exactFactories: [...factories.values()],
    nativePriceSymbols: chains.map((chain) => chain.nativeAsset),
  };
}

module.exports = {
  FX_MARKET_DEPLOYMENT_SCHEMA,
  FX_MARKET_DEPLOYMENT_SCHEMA_VERSION,
  FxMarketDeploymentError,
  buildFxDesktopMarket,
  buildFxMarketDeployment,
};
