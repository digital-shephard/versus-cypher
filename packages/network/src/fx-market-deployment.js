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
  return {
    address: normalizedAddress(value.address, `${label}.address`),
    runtimeCodeHash: normalizedHash(
      value.runtimeCodeHash,
      `${label}.runtimeCodeHash`
    ),
    deploymentBlock: Number(value.deploymentBlock),
  };
}

function buildFxMarketDeployment({ market: marketInput, chainRecords, v3Builds, exactBuild } = {}) {
  const market = validateFxMarketConfig(marketInput);
  requireCondition(Array.isArray(chainRecords), "chain deployment records are missing");
  requireCondition(chainRecords.length === market.chains.length, "every market chain needs one deployment record");
  requireCondition(v3Builds && exactBuild, "frozen build evidence is missing");

  const records = new Map(chainRecords.map((record) => [String(record.chainId), record]));
  const exactFactories = [];
  const capabilities = market.chains.map((chain) => {
    const record = records.get(chain.chainId);
    requireCondition(record, `chain ${chain.chainId} deployment record is missing`);
    requireCondition(record.marketId === market.marketId, `chain ${chain.chainId} marketId differs`);
    requireCondition(record.evidence?.verificationStatus === "verified", `chain ${chain.chainId} is not verified`);
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
  requireCondition(deployment.deploymentId === v3.deploymentId, "desktop deploymentId differs");
  requireCondition(
    deployment.coordinationDomain === v3.coordinationDomain,
    "desktop coordination domain differs"
  );
  const factories = new Map((deployment.exact?.factories || []).map((factory) => [
    `${factory.chainId}:${factory.token}`,
    factory,
  ]));
  const capabilities = new Map(v3.capabilities.map((capability) => [
    capability.chainId,
    capability,
  ]));
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
