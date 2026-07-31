const {
  Contract,
  Interface,
  JsonRpcProvider,
  Wallet,
  getAddress,
  id,
  keccak256,
  zeroPadValue,
} = require("ethers");
const { FX_NATIVE_ETH_ADDRESS, phase5LockId } = require("@versus/network");

const FX_HTLC_ABI = Object.freeze([
  "function fund(bytes32 lockId,address beneficiary,address refundAddress,bytes32 secretHash,uint64 refundTimestamp,uint256 amount)",
  "function claim(bytes32 lockId,bytes32 secret)",
  "function refund(bytes32 lockId)",
  "function getLock(bytes32 lockId) view returns (tuple(address funder,address beneficiary,address refundAddress,bytes32 secretHash,uint64 refundTimestamp,uint8 state,uint256 amount))",
  "event LockFunded(bytes32 indexed lockId,address indexed funder,address indexed beneficiary,address refundAddress,bytes32 secretHash,uint64 refundTimestamp,uint256 amount)",
  "event LockClaimed(bytes32 indexed lockId,address indexed submitter,address indexed beneficiary,bytes32 secret,uint256 amount)",
  "event LockRefunded(bytes32 indexed lockId,address indexed submitter,address indexed refundAddress,uint256 amount)",
]);

const FX_TOKEN_ABI = Object.freeze([
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function transfer(address recipient,uint256 amount) returns (bool)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const FX_NATIVE_HTLC_ABI = Object.freeze([
  "function fund(bytes32 lockId,address beneficiary,address refundAddress,bytes32 secretHash,uint64 refundTimestamp) payable",
  "function claim(bytes32 lockId,bytes32 secret)",
  "function refund(bytes32 lockId)",
  "function getLock(bytes32 lockId) view returns (tuple(address funder,address beneficiary,address refundAddress,bytes32 secretHash,uint64 refundTimestamp,uint8 state,uint256 amount))",
  "event LockFunded(bytes32 indexed lockId,address indexed funder,address indexed beneficiary,address refundAddress,bytes32 secretHash,uint64 refundTimestamp,uint256 amount)",
  "event LockClaimed(bytes32 indexed lockId,address indexed submitter,address indexed beneficiary,bytes32 secret,uint256 amount)",
  "event LockRefunded(bytes32 indexed lockId,address indexed submitter,address indexed refundAddress,uint256 amount)",
]);
const FX_HTLC_V2_ABI = Object.freeze([
  "function fund(bytes32 lockId,address beneficiary,address refundAddress,bytes32 secretHash,uint64 refundTimestamp,uint256 beneficiaryAmount,uint256 executorAmount)",
  "function claim(bytes32 lockId,bytes32 secret)",
  "function refund(bytes32 lockId)",
  "function getLock(bytes32 lockId) view returns (tuple(address funder,address beneficiary,address refundAddress,bytes32 secretHash,uint64 refundTimestamp,uint8 state,uint256 beneficiaryAmount,uint256 executorAmount))",
  "event LockFunded(bytes32 indexed lockId,address indexed funder,address indexed beneficiary,address refundAddress,bytes32 secretHash,uint64 refundTimestamp,uint256 beneficiaryAmount,uint256 executorAmount)",
  "event LockClaimed(bytes32 indexed lockId,address indexed submitter,address indexed beneficiary,bytes32 secret,uint256 beneficiaryAmount,uint256 executorAmount)",
  "event LockRefunded(bytes32 indexed lockId,address indexed submitter,address indexed refundAddress,uint256 amount)",
]);
const FX_NATIVE_HTLC_V2_ABI = Object.freeze([
  "function fund(bytes32 lockId,address beneficiary,address refundAddress,bytes32 secretHash,uint64 refundTimestamp,uint256 beneficiaryAmount,uint256 executorAmount) payable",
  "function claim(bytes32 lockId,bytes32 secret)",
  "function refund(bytes32 lockId)",
  "function getLock(bytes32 lockId) view returns (tuple(address funder,address beneficiary,address refundAddress,bytes32 secretHash,uint64 refundTimestamp,uint8 state,uint256 beneficiaryAmount,uint256 executorAmount))",
  "event LockFunded(bytes32 indexed lockId,address indexed funder,address indexed beneficiary,address refundAddress,bytes32 secretHash,uint64 refundTimestamp,uint256 beneficiaryAmount,uint256 executorAmount)",
  "event LockClaimed(bytes32 indexed lockId,address indexed submitter,address indexed beneficiary,bytes32 secret,uint256 beneficiaryAmount,uint256 executorAmount)",
  "event LockRefunded(bytes32 indexed lockId,address indexed submitter,address indexed refundAddress,uint256 amount)",
]);
const FX_HTLC_V3_ABI = Object.freeze([
  "function ADAPTER_VERSION() view returns (uint16)",
  "function minimumLockDuration() view returns (uint64)",
  "function maximumLockDuration() view returns (uint64)",
  "function asset() view returns (address)",
  "function assetDecimals() view returns (uint8)",
  "function stateOf(bytes32 lockDigest) view returns (uint8)",
  "function lockDigest((bytes32 tradeId,address funder,address beneficiary,bytes32 secretHash,uint64 refundTimestamp,uint128 beneficiaryAmount,uint128 executorAmount) terms) view returns (bytes32)",
  "function fund(bytes32 tradeId,address beneficiary,bytes32 secretHash,uint256 settlement)",
  "function claim(bytes32 tradeId,address funder,address beneficiary,uint256 settlement,bytes32 secret)",
  "function refund((bytes32 tradeId,address funder,address beneficiary,bytes32 secretHash,uint64 refundTimestamp,uint128 beneficiaryAmount,uint128 executorAmount) terms)",
  "event LockFunded(bytes32 indexed lockDigest,bytes32 indexed tradeId,address indexed funder,address beneficiary,bytes32 secretHash,uint64 refundTimestamp,uint128 beneficiaryAmount,uint128 executorAmount)",
  "event LockClaimed(bytes32 indexed lockDigest,bytes32 indexed tradeId,address indexed submitter,bytes32 secret)",
  "event LockRefunded(bytes32 indexed lockDigest,bytes32 indexed tradeId,address indexed submitter)",
]);
const FX_NATIVE_HTLC_V3_ABI = Object.freeze([
  ...FX_HTLC_V3_ABI.filter(
    (fragment) =>
      ![
        "function asset() view returns (address)",
        "function assetDecimals() view returns (uint8)",
        "function fund(bytes32 tradeId,address beneficiary,bytes32 secretHash,uint256 settlement)",
      ].includes(fragment)
  ),
  "function fund(bytes32 tradeId,address beneficiary,bytes32 secretHash,uint256 settlement) payable",
]);

const FX_TESTNET_CHAINS = Object.freeze({
  "84532": Object.freeze({
    chainId: "84532",
    name: "Base Sepolia",
    rpcUrl: "https://sepolia.base.org",
    rpcEnvironmentVariable: "BASE_SEPOLIA_RPC_URL",
    explorerUrl: "https://sepolia-explorer.base.org",
    tokenAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    adapterAddress: "0xe7a02dd38f9191d8ee20daa24b4feee911da334d",
    adapterDeploymentBlock: 44662322,
    nativeAdapterAddress: "0x7c917f09e1de03977acc14575b56932aa55da543",
    nativeAdapterDeploymentBlock: 44762481,
    adapterV2Address: "0x0fa1152f8c51ce05cd61d1ca98515a409ed23c14",
    adapterV2DeploymentBlock: 44781962,
    nativeAdapterV2Address: "0x1e933ccffaa2cd384d3df751ff7a25183682dc61",
    nativeAdapterV2DeploymentBlock: 44781959,
    adapterV3Address: "0x4b7603b6731b2fc10064e2bda099ce291398c826",
    adapterV3DeploymentBlock: 44877926,
    adapterV3RuntimeCodeHash:
      "0x6ab5286c04e4fe1409256bcde79b4d370b37acb342c85d38c4720ea6202d1cb0",
    nativeAdapterV3Address: "0x9ff9e978801b7819fa4169638814543028d0c0f2",
    nativeAdapterV3DeploymentBlock: 44804172,
    nativeAdapterV3RuntimeCodeHash:
      "0x41690a8f1d61c02dfa80d021f7fea384718d8203f379a9677de960db647e7d9b",
    tokenDecimals: 6,
    nativeGasReserveWei: "100000000000000",
    requiredConfirmations: 2,
  }),
  "421614": Object.freeze({
    chainId: "421614",
    name: "Arbitrum Sepolia",
    rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
    rpcEnvironmentVariable: "ARBITRUM_SEPOLIA_RPC_URL",
    explorerUrl: "https://sepolia.arbiscan.io",
    tokenAddress: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d",
    adapterAddress: "0xe7a02dd38f9191d8ee20daa24b4feee911da334d",
    adapterDeploymentBlock: 291630348,
    nativeAdapterAddress: "0x7c917f09e1de03977acc14575b56932aa55da543",
    nativeAdapterDeploymentBlock: 292433456,
    adapterV2Address: "0x0fa1152f8c51ce05cd61d1ca98515a409ed23c14",
    adapterV2DeploymentBlock: 292589984,
    nativeAdapterV2Address: "0x1e933ccffaa2cd384d3df751ff7a25183682dc61",
    nativeAdapterV2DeploymentBlock: 292589965,
    adapterV3Address: "0x77484fc7203f25b92e95327116b4d5ca92c8b019",
    adapterV3DeploymentBlock: 293360293,
    adapterV3RuntimeCodeHash:
      "0xd1d39b642470aeb2cbdcc4246247db50c55fa73f3aa1d33ced90a70cc1bc8aa3",
    nativeAdapterV3Address: "0x9ff9e978801b7819fa4169638814543028d0c0f2",
    nativeAdapterV3DeploymentBlock: 292768615,
    nativeAdapterV3RuntimeCodeHash:
      "0x4a2d48e907b541f3934e2a57368b0a82abc1af6420170d00c592bcbee19b3453",
    tokenDecimals: 6,
    nativeGasReserveWei: "100000000000000",
    requiredConfirmations: 2,
  }),
});

const TOKEN_INTERFACE = new Interface(FX_TOKEN_ABI);
const HTLC_INTERFACE = new Interface(FX_HTLC_ABI);
const NATIVE_HTLC_INTERFACE = new Interface(FX_NATIVE_HTLC_ABI);
const HTLC_V2_INTERFACE = new Interface(FX_HTLC_V2_ABI);
const NATIVE_HTLC_V2_INTERFACE = new Interface(FX_NATIVE_HTLC_V2_ABI);
const HTLC_V3_INTERFACE = new Interface(FX_HTLC_V3_ABI);
const NATIVE_HTLC_V3_INTERFACE = new Interface(FX_NATIVE_HTLC_V3_ABI);
const TRANSFER_TOPIC = id("Transfer(address,address,uint256)");
const FX_NATIVE_FUNDING_GAS_UNITS = 250_000n;
const FX_NATIVE_FUNDING_FEE_BUFFER_BPS = 12_500n;

class FxEvmCohortError extends Error {
  constructor(message, code = "FX_EVM_COHORT_ERROR") {
    super(message);
    this.name = "FxEvmCohortError";
    this.code = code;
  }
}

function normalizedAddress(value, label) {
  try {
    return getAddress(value).toLowerCase();
  } catch {
    throw new FxEvmCohortError(`${label} is not a valid address`, "INVALID_ADDRESS");
  }
}

function transactionHash(value, label = "transaction hash") {
  const normalized = String(value || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new FxEvmCohortError(`${label} is invalid`, "INVALID_TRANSACTION");
  }
  return normalized;
}

function chainConfiguration(chainId, configurations = FX_TESTNET_CHAINS) {
  const key = String(BigInt(chainId));
  const configuration = configurations[key];
  if (!configuration) {
    throw new FxEvmCohortError(`chain ${key} is unsupported`, "UNSUPPORTED_CHAIN");
  }
  return configuration;
}

function isNativeAsset(value) {
  return String(value || "").toLowerCase() === FX_NATIVE_ETH_ADDRESS;
}

function assetConfiguration(configuration, token, settlementVersion = 1) {
  const version = Number(settlementVersion);
  if (![1, 2, 3].includes(version)) {
    throw new FxEvmCohortError(
      "settlement adapter version is unsupported",
      "UNSUPPORTED_ADAPTER"
    );
  }
  if (isNativeAsset(token)) {
    const adapterAddress =
      version === 3
        ? configuration.nativeAdapterV3Address
        : version === 2
          ? configuration.nativeAdapterV2Address
          : configuration.nativeAdapterAddress;
    if (!adapterAddress) {
      throw new FxEvmCohortError(
        "native ETH adapter is not frozen for this chain",
        "UNSUPPORTED_ASSET"
      );
    }
    return {
      token: FX_NATIVE_ETH_ADDRESS,
      adapterAddress,
      adapterDeploymentBlock:
        version === 3
          ? configuration.nativeAdapterV3DeploymentBlock
          : version === 2
            ? configuration.nativeAdapterV2DeploymentBlock
            : configuration.nativeAdapterDeploymentBlock,
      runtimeCodeHash:
        version === 3
          ? configuration.nativeAdapterV3RuntimeCodeHash
          : null,
      abi:
        version === 3
          ? FX_NATIVE_HTLC_V3_ABI
          : version === 2
            ? FX_NATIVE_HTLC_V2_ABI
            : FX_NATIVE_HTLC_ABI,
      interface:
        version === 3
          ? NATIVE_HTLC_V3_INTERFACE
          : version === 2
            ? NATIVE_HTLC_V2_INTERFACE
            : NATIVE_HTLC_INTERFACE,
      native: true,
      settlementVersion: version,
    };
  }
  const normalized = normalizedAddress(token, "asset token");
  if (normalized !== configuration.tokenAddress) {
    throw new FxEvmCohortError(
      "asset does not match a frozen cohort capability",
      "UNSUPPORTED_ASSET"
    );
  }
  return {
    token: normalized,
    adapterAddress:
      version === 3
        ? configuration.adapterV3Address
        : version === 2
          ? configuration.adapterV2Address
          : configuration.adapterAddress,
    adapterDeploymentBlock:
      version === 3
        ? configuration.adapterV3DeploymentBlock
        : version === 2
          ? configuration.adapterV2DeploymentBlock
          : configuration.adapterDeploymentBlock,
    runtimeCodeHash:
      version === 3 ? configuration.adapterV3RuntimeCodeHash : null,
    abi:
      version === 3
        ? FX_HTLC_V3_ABI
        : version === 2
          ? FX_HTLC_V2_ABI
          : FX_HTLC_ABI,
    interface:
      version === 3
        ? HTLC_V3_INTERFACE
        : version === 2
          ? HTLC_V2_INTERFACE
          : HTLC_INTERFACE,
    native: false,
    settlementVersion: version,
  };
}

function lockStateName(value) {
  return ["empty", "funded", "claimed", "refunded"][Number(value)] || "unknown";
}

function packSettlementV3(
  refundTimestamp,
  beneficiaryAmountAtomic,
  executorAmountAtomic
) {
  const timeout = BigInt(refundTimestamp);
  const beneficiaryAmount = BigInt(beneficiaryAmountAtomic);
  const executorAmount = BigInt(executorAmountAtomic);
  const maximum = (1n << 96n) - 1n;
  if (
    timeout < 0n ||
    timeout > (1n << 64n) - 1n ||
    beneficiaryAmount <= 0n ||
    beneficiaryAmount > maximum ||
    executorAmount < 0n ||
    executorAmount > maximum
  ) {
    throw new FxEvmCohortError(
      "V3 compact settlement terms are outside their supported range",
      "INVALID_AMOUNT"
    );
  }
  return (
    (timeout << 192n) |
    (beneficiaryAmount << 96n) |
    executorAmount
  );
}

function serializableReceipt(receipt) {
  return {
    transactionHash: transactionHash(receipt.hash || receipt.transactionHash),
    blockHash: String(receipt.blockHash || "").toLowerCase(),
    blockNumber: Number(receipt.blockNumber),
    status: Number(receipt.status),
    gasUsed: BigInt(receipt.gasUsed || 0).toString(),
    gasPrice: BigInt(receipt.gasPrice || 0).toString(),
  };
}

class FxEvmCohort {
  constructor({
    walletProvider,
    configurations = FX_TESTNET_CHAINS,
    environment = process.env,
    providerFactory = (url, chainId) =>
      new JsonRpcProvider(url, Number(chainId), { staticNetwork: true }),
    contractFactory = (address, abi, runner) =>
      new Contract(address, abi, runner),
    walletFactory = (privateKey, provider) =>
      new Wallet(privateKey, provider),
    settlementVersion = 1,
  } = {}) {
    if (typeof walletProvider !== "function") {
      throw new TypeError("FX EVM cohort requires a wallet provider");
    }
    this.walletProvider = walletProvider;
    this.configurations = configurations;
    this.environment = environment;
    this.providerFactory = providerFactory;
    this.contractFactory = contractFactory;
    this.walletFactory = walletFactory;
    this.settlementVersion = Number(settlementVersion);
    if (![1, 2, 3].includes(this.settlementVersion)) {
      throw new TypeError("FX EVM cohort settlement version is unsupported");
    }
    this.providers = new Map();
    this.preflights = new Map();
    this.rpcOverrides = new Map();
  }

  configuration(chainId) {
    return chainConfiguration(chainId, this.configurations);
  }

  adapterAddress(chainId, token) {
    return assetConfiguration(
      this.configuration(chainId),
      token,
      this.settlementVersion
    ).adapterAddress;
  }

  provider(chainId) {
    const configuration = this.configuration(chainId);
    if (!this.providers.has(configuration.chainId)) {
      const url = String(
        this.rpcOverrides.get(configuration.chainId) ||
          this.environment[configuration.rpcEnvironmentVariable] ||
          configuration.rpcUrl
      ).trim();
      this.providers.set(
        configuration.chainId,
        this.providerFactory(url, configuration.chainId)
      );
    }
    return this.providers.get(configuration.chainId);
  }

  async #getLogs(provider, filter) {
    if (
      filter.toBlock === "latest" &&
      typeof provider.getBlockNumber !== "function"
    ) {
      return provider.getLogs(filter);
    }
    const fromBlock = Number(filter.fromBlock);
    const toBlock = filter.toBlock === "latest"
      ? Number(await provider.getBlockNumber())
      : Number(filter.toBlock);
    if (toBlock < fromBlock) {
      return provider.getLogs(filter);
    }
    if (
      !Number.isSafeInteger(fromBlock) ||
      !Number.isSafeInteger(toBlock) ||
      fromBlock < 0 ||
      toBlock < 0
    ) {
      return [];
    }
    const logs = [];
    for (let start = fromBlock; start <= toBlock; start += 2_000) {
      const end = Math.min(toBlock, start + 1_999);
      logs.push(
        ...(await provider.getLogs({
          ...filter,
          fromBlock: start,
          toBlock: end,
        }))
      );
    }
    return logs;
  }

  setRpcUrl(chainId, rpcUrl = "") {
    const configuration = this.configuration(chainId);
    const normalized = String(rpcUrl || "").trim();
    if (normalized) this.rpcOverrides.set(configuration.chainId, normalized);
    else this.rpcOverrides.delete(configuration.chainId);
    const provider = this.providers.get(configuration.chainId);
    provider?.destroy?.();
    this.providers.delete(configuration.chainId);
    this.preflights.delete(configuration.chainId);
    return normalized;
  }

  wallet(chainId, role = "requester") {
    const local = this.walletProvider(role);
    if (!local?.privateKey) {
      throw new FxEvmCohortError("local FX wallet is unavailable", "WALLET_UNAVAILABLE");
    }
    return this.walletFactory(local.privateKey, this.provider(chainId));
  }

  async preflight(chainId) {
    const configuration = this.configuration(chainId);
    if (!this.preflights.has(configuration.chainId)) {
      const promise = (async () => {
        const provider = this.provider(configuration.chainId);
        const network = await provider.getNetwork();
        if (String(network.chainId) !== configuration.chainId) {
          throw new FxEvmCohortError(
            `${configuration.name} RPC returned the wrong chain`,
            "WRONG_CHAIN"
          );
        }
        const erc20Asset = assetConfiguration(
          configuration,
          configuration.tokenAddress,
          this.settlementVersion
        );
        const nativeAsset = assetConfiguration(
          configuration,
          FX_NATIVE_ETH_ADDRESS,
          this.settlementVersion
        );
        const adapterAddress = erc20Asset.adapterAddress;
        const nativeAdapterAddress = nativeAsset.adapterAddress;
        const [tokenCode, adapterCode, nativeAdapterCode] = await Promise.all([
          provider.getCode(configuration.tokenAddress),
          provider.getCode(adapterAddress),
          nativeAdapterAddress
            ? provider.getCode(nativeAdapterAddress)
            : Promise.resolve("0x"),
        ]);
        if (tokenCode === "0x" || adapterCode === "0x") {
          throw new FxEvmCohortError(
            `${configuration.name} cohort contracts are unavailable`,
            "COHORT_CONTRACT_UNAVAILABLE"
          );
        }
        if (
          nativeAdapterAddress &&
          nativeAdapterCode === "0x"
        ) {
          throw new FxEvmCohortError(
            `${configuration.name} native adapter is unavailable`,
            "COHORT_CONTRACT_UNAVAILABLE"
          );
        }
        if (
          this.settlementVersion === 3 &&
          (
            keccak256(adapterCode).toLowerCase() !==
              erc20Asset.runtimeCodeHash ||
            keccak256(nativeAdapterCode).toLowerCase() !==
              nativeAsset.runtimeCodeHash
          )
        ) {
          throw new FxEvmCohortError(
            `${configuration.name} V3 runtime bytecode is not frozen`,
            "BYTECODE_MISMATCH"
          );
        }
        if (this.settlementVersion === 3) {
          const erc20Adapter = this.contractFactory(
            adapterAddress,
            erc20Asset.abi,
            provider
          );
          const nativeAdapter = this.contractFactory(
            nativeAdapterAddress,
            nativeAsset.abi,
            provider
          );
          const token = this.contractFactory(
            configuration.tokenAddress,
            FX_TOKEN_ABI,
            provider
          );
          const [
            erc20Version,
            erc20Minimum,
            erc20Maximum,
            erc20Token,
            erc20Decimals,
            nativeVersion,
            nativeMinimum,
            nativeMaximum,
            tokenDecimals,
          ] = await Promise.all([
            erc20Adapter.ADAPTER_VERSION(),
            erc20Adapter.minimumLockDuration(),
            erc20Adapter.maximumLockDuration(),
            erc20Adapter.asset(),
            erc20Adapter.assetDecimals(),
            nativeAdapter.ADAPTER_VERSION(),
            nativeAdapter.minimumLockDuration(),
            nativeAdapter.maximumLockDuration(),
            token.decimals(),
          ]);
          if (
            Number(erc20Version) !== 3 ||
            Number(nativeVersion) !== 3 ||
            Number(erc20Minimum) !== 60 ||
            Number(nativeMinimum) !== 60 ||
            Number(erc20Maximum) !== 604800 ||
            Number(nativeMaximum) !== 604800 ||
            normalizedAddress(erc20Token, "V3 adapter asset") !==
              configuration.tokenAddress.toLowerCase() ||
            Number(erc20Decimals) !== configuration.tokenDecimals ||
            Number(tokenDecimals) !== configuration.tokenDecimals
          ) {
            throw new FxEvmCohortError(
              `${configuration.name} V3 immutables are not frozen`,
              "IMMUTABLE_MISMATCH"
            );
          }
        }
        return configuration;
      })().catch((error) => {
        this.preflights.delete(configuration.chainId);
        throw error;
      });
      this.preflights.set(configuration.chainId, promise);
    }
    return this.preflights.get(configuration.chainId);
  }

  async captureFunding({
    chainId,
    token,
    address,
    requiredAtomic,
  }) {
    const configuration = await this.preflight(chainId);
    const asset = assetConfiguration(
      configuration,
      token,
      this.settlementVersion
    );
    const recipient = normalizedAddress(address, "funding address");
    const provider = this.provider(chainId);
    const contract = asset.native
      ? null
      : this.contractFactory(asset.token, FX_TOKEN_ABI, provider);
    const [blockNumber, balance, feeData] = await Promise.all([
      provider.getBlockNumber(),
      asset.native ? provider.getBalance(recipient) : contract.balanceOf(recipient),
      asset.native && typeof provider.getFeeData === "function"
        ? provider.getFeeData()
        : Promise.resolve(null),
    ]);
    const lockAmount = BigInt(requiredAtomic);
    const currentBalance = BigInt(balance);
    const maxFeePerGas = BigInt(
      feeData?.maxFeePerGas || feeData?.gasPrice || 0
    );
    const bufferedFundingFee =
      (
        FX_NATIVE_FUNDING_GAS_UNITS *
        maxFeePerGas *
        FX_NATIVE_FUNDING_FEE_BUFFER_BPS +
        9_999n
      ) / 10_000n;
    const sourceGasBuffer = asset.native
      ? BigInt(configuration.nativeGasReserveWei || 0) + bufferedFundingFee
      : 0n;
    const minimumWalletBalance = lockAmount + sourceGasBuffer;
    const requiredFunding = asset.native
      ? minimumWalletBalance > currentBalance
        ? minimumWalletBalance - currentBalance
        : 0n
      : lockAmount;
    return {
      chainId: configuration.chainId,
      token: asset.token,
      address: recipient,
      requiredAtomic: lockAmount.toString(),
      requiredFundingAtomic: requiredFunding.toString(),
      sourceGasBufferAtomic: sourceGasBuffer.toString(),
      minimumWalletBalanceAtomic: minimumWalletBalance.toString(),
      baselineBlockNumber: Number(blockNumber),
      baselineBalanceAtomic: currentBalance.toString(),
      capturedAt: new Date().toISOString(),
    };
  }

  async tokenBalance(chainId, token, owner = null) {
    const configuration = await this.preflight(chainId);
    const asset = assetConfiguration(
      configuration,
      token,
      this.settlementVersion
    );
    const address = normalizedAddress(
      owner || this.walletProvider("dealer")?.address,
      "inventory owner"
    );
    if (asset.native) {
      return BigInt(await this.provider(chainId).getBalance(address)).toString();
    }
    const contract = this.contractFactory(
      asset.token,
      FX_TOKEN_ABI,
      this.provider(chainId)
    );
    return BigInt(await contract.balanceOf(address)).toString();
  }

  async nativeBalance(chainId, role = "dealer") {
    const configuration = await this.preflight(chainId);
    const owner = normalizedAddress(
      this.walletProvider(role)?.address,
      `${role} FX wallet`
    );
    return {
      chainId: configuration.chainId,
      address: owner,
      balanceAtomic: BigInt(
        await this.provider(chainId).getBalance(owner)
      ).toString(),
    };
  }

  async transferToken({
    chainId,
    token,
    destination,
    amountAtomic,
    role = "dealer",
  }) {
    const configuration = await this.preflight(chainId);
    const asset = assetConfiguration(
      configuration,
      token,
      this.settlementVersion
    );
    const recipient = normalizedAddress(destination, "withdrawal destination");
    const amount = BigInt(amountAtomic);
    if (amount <= 0n) {
      throw new FxEvmCohortError(
        "withdrawal amount must be positive",
        "INVALID_AMOUNT"
      );
    }
    const signer = this.wallet(chainId, role);
    const owner = normalizedAddress(await signer.getAddress(), "FX wallet");
    if (asset.native) {
      const feeData = await this.provider(chainId).getFeeData();
      const transfer = { to: recipient, value: amount };
      const estimatedGas =
        typeof signer.estimateGas === "function"
          ? BigInt(await signer.estimateGas(transfer))
          : 21_000n;
      const gasLimit = (estimatedGas * 120n + 99n) / 100n;
      const maxFeePerGas = BigInt(
        feeData.maxFeePerGas || feeData.gasPrice || 0
      );
      const gasReserve = BigInt(configuration.nativeGasReserveWei || 0);
      const balance = BigInt(await this.provider(chainId).getBalance(owner));
      const transactionFeeReserve = gasLimit * maxFeePerGas;
      if (balance < amount + gasReserve + transactionFeeReserve) {
        throw new FxEvmCohortError(
          "native inventory withdrawal would consume the operating gas reserve",
          "GAS_RESERVE_REQUIRED"
        );
      }
      const transaction = await signer.sendTransaction({
        ...transfer,
        gasLimit,
      });
      const receipt = await this.#confirmedReceipt(
        configuration.chainId,
        transaction.hash
      );
      return {
        chainId: configuration.chainId,
        token: asset.token,
        destination: recipient,
        amountAtomic: amount.toString(),
        transactionHash: receipt.transactionHash,
        receipt,
      };
    }
    const contract = this.contractFactory(
      asset.token,
      FX_TOKEN_ABI,
      signer
    );
    const balance = BigInt(await contract.balanceOf(owner));
    if (balance < amount) {
      throw new FxEvmCohortError(
        "inventory balance is below the withdrawal amount",
        "INSUFFICIENT_INVENTORY"
      );
    }
    const transaction = await contract.transfer(recipient, amount);
    const receipt = await this.#confirmedReceipt(
      configuration.chainId,
      transaction.hash
    );
    return {
      chainId: configuration.chainId,
      token: asset.token,
      destination: recipient,
      amountAtomic: amount.toString(),
      transactionHash: receipt.transactionHash,
      receipt,
    };
  }

  async verifyFunding({ baseline, requiredAtomic }) {
    if (!baseline) {
      throw new FxEvmCohortError(
        "source funding baseline is unavailable",
        "FUNDING_BASELINE_UNAVAILABLE"
      );
    }
    const configuration = await this.preflight(baseline.chainId);
    const provider = this.provider(configuration.chainId);
    const asset = assetConfiguration(
      configuration,
      baseline.token,
      this.settlementVersion
    );
    const token = asset.token;
    const recipient = normalizedAddress(baseline.address, "funding address");
    const contract = asset.native
      ? null
      : this.contractFactory(token, FX_TOKEN_ABI, provider);
    const latestBlock = await provider.getBlockNumber();
    const balance = BigInt(
      asset.native
        ? await provider.getBalance(recipient)
        : await contract.balanceOf(recipient)
    );
    const baselineBalance = BigInt(baseline.baselineBalanceAtomic);
    const balanceIncrease = balance > baselineBalance ? balance - baselineBalance : 0n;
    const required = BigInt(
      requiredAtomic ??
      baseline.requiredFundingAtomic ??
      baseline.requiredAtomic
    );
    const minimumWalletBalance = baseline.minimumWalletBalanceAtomic == null
      ? null
      : BigInt(baseline.minimumWalletBalanceAtomic);
    if (asset.native) {
      const confirmations = Math.max(
        0,
        latestBlock - Number(baseline.baselineBlockNumber)
      );
      return {
        confirmed:
          balanceIncrease >= required &&
          (
            minimumWalletBalance == null ||
            balance >= minimumWalletBalance
          ) &&
          confirmations >= configuration.requiredConfirmations,
        amountAtomic: balanceIncrease.toString(),
        inboundAtomic: balanceIncrease.toString(),
        confirmations,
        transactionHash: null,
        blockNumber: confirmations > 0 ? Number(baseline.baselineBlockNumber) + 1 : null,
      };
    }
    const logs = latestBlock <= Number(baseline.baselineBlockNumber)
      ? []
      : await this.#getLogs(provider, {
          address: token,
          topics: [
            TRANSFER_TOPIC,
            null,
            zeroPadValue(recipient, 32),
          ],
          fromBlock: Number(baseline.baselineBlockNumber) + 1,
          toBlock: latestBlock,
        });
    let inbound = 0n;
    let latestMatchingLog = null;
    for (const log of logs) {
      const parsed = TOKEN_INTERFACE.parseLog(log);
      if (!parsed || normalizedAddress(parsed.args.to, "transfer recipient") !== recipient) {
        continue;
      }
      inbound += BigInt(parsed.args.value);
      latestMatchingLog = log;
    }
    const confirmations = latestMatchingLog
      ? latestBlock - Number(latestMatchingLog.blockNumber) + 1
      : 0;
    const confirmed =
      balanceIncrease >= required &&
      inbound >= required &&
      confirmations >= configuration.requiredConfirmations;
    return {
      confirmed,
      amountAtomic: balanceIncrease.toString(),
      inboundAtomic: inbound.toString(),
      confirmations,
      transactionHash: latestMatchingLog?.transactionHash
        ? transactionHash(latestMatchingLog.transactionHash)
        : null,
      blockNumber: latestMatchingLog ? Number(latestMatchingLog.blockNumber) : null,
    };
  }

  async #v3LockFromFundedLog(configuration, asset, adapter, log, lockId) {
    const parsed = asset.interface.parseLog(log);
    if (
      parsed?.name !== "LockFunded" ||
      String(parsed.args.tradeId).toLowerCase() !==
        String(lockId).toLowerCase()
    ) {
      throw new FxEvmCohortError(
        "V3 funding event does not match the deterministic trade leg",
        "LOCK_EVENT_MISMATCH"
      );
    }
    const lockDigest = String(parsed.args.lockDigest).toLowerCase();
    const state = Number(await adapter.stateOf(lockDigest));
    const beneficiaryAmountAtomic = BigInt(
      parsed.args.beneficiaryAmount
    ).toString();
    const executorAmountAtomic = BigInt(
      parsed.args.executorAmount
    ).toString();
    return {
      chainId: configuration.chainId,
      token: asset.token,
      adapterAddress: asset.adapterAddress,
      lockId: String(parsed.args.tradeId).toLowerCase(),
      lockDigest,
      funder: normalizedAddress(parsed.args.funder, "lock funder"),
      beneficiary: normalizedAddress(
        parsed.args.beneficiary,
        "lock beneficiary"
      ),
      refundAddress: normalizedAddress(parsed.args.funder, "lock funder"),
      secretHash: String(parsed.args.secretHash).toLowerCase(),
      timeout: Number(parsed.args.refundTimestamp),
      state,
      stateName: lockStateName(state),
      beneficiaryAmountAtomic,
      executorAmountAtomic,
      amountAtomic: (
        BigInt(beneficiaryAmountAtomic) + BigInt(executorAmountAtomic)
      ).toString(),
    };
  }

  async readLock(
    chainId,
    lockId,
    token = null,
    expectedTransactionHash = null
  ) {
    const configuration = await this.preflight(chainId);
    const asset = assetConfiguration(
      configuration,
      token || configuration.tokenAddress,
      this.settlementVersion
    );
    const provider = this.provider(configuration.chainId);
    const adapter = this.contractFactory(
      asset.adapterAddress,
      asset.abi,
      provider
    );
    if (asset.settlementVersion === 3) {
      let logs;
      if (expectedTransactionHash) {
        const receipt = await provider.getTransactionReceipt(
          transactionHash(expectedTransactionHash)
        );
        logs = (receipt?.logs || []).filter(
          (log) =>
            String(log.address || "").toLowerCase() === asset.adapterAddress
        );
      } else {
        const event = asset.interface.getEvent("LockFunded");
        logs = await this.#getLogs(provider, {
          address: asset.adapterAddress,
          topics: [event.topicHash, null, String(lockId).toLowerCase()],
          fromBlock: asset.adapterDeploymentBlock,
          toBlock: "latest",
        });
      }
      const matchingLogs = logs.filter((log) => {
        try {
          const parsed = asset.interface.parseLog(log);
          return (
            parsed?.name === "LockFunded" &&
            String(parsed.args.tradeId).toLowerCase() ===
              String(lockId).toLowerCase()
          );
        } catch {
          return false;
        }
      });
      if (expectedTransactionHash && matchingLogs.length !== 1) {
        throw new FxEvmCohortError(
          "funding transaction does not contain exactly one expected V3 lock",
          "LOCK_EVENT_MISMATCH"
        );
      }
      const log = matchingLogs.at(-1);
      if (!log) {
        return {
          chainId: configuration.chainId,
          token: asset.token,
          adapterAddress: asset.adapterAddress,
          lockId: String(lockId).toLowerCase(),
          lockDigest: null,
          funder: null,
          beneficiary: null,
          refundAddress: null,
          secretHash: null,
          timeout: 0,
          state: 0,
          stateName: "empty",
          beneficiaryAmountAtomic: "0",
          executorAmountAtomic: "0",
          amountAtomic: "0",
        };
      }
      return this.#v3LockFromFundedLog(
        configuration,
        asset,
        adapter,
        log,
        lockId
      );
    }
    const lock = await adapter.getLock(lockId);
    return {
      chainId: configuration.chainId,
      token: asset.token,
      adapterAddress: asset.adapterAddress,
      lockId: String(lockId).toLowerCase(),
      funder: normalizedAddress(lock.funder, "lock funder"),
      beneficiary: normalizedAddress(lock.beneficiary, "lock beneficiary"),
      refundAddress: normalizedAddress(lock.refundAddress, "lock refund address"),
      secretHash: String(lock.secretHash).toLowerCase(),
      timeout: Number(lock.refundTimestamp),
      state: Number(lock.state),
      stateName: lockStateName(lock.state),
      beneficiaryAmountAtomic: BigInt(
        asset.settlementVersion === 2 ? lock.beneficiaryAmount : lock.amount
      ).toString(),
      executorAmountAtomic: BigInt(
        asset.settlementVersion === 2 ? lock.executorAmount : 0
      ).toString(),
      amountAtomic: BigInt(
        asset.settlementVersion === 2
          ? BigInt(lock.beneficiaryAmount) + BigInt(lock.executorAmount)
          : lock.amount
      ).toString(),
    };
  }

  async #confirmedReceipt(chainId, hash) {
    const configuration = this.configuration(chainId);
    const provider = this.provider(chainId);
    const receipt = await provider.waitForTransaction(
      transactionHash(hash),
      configuration.requiredConfirmations,
      180_000
    );
    if (!receipt || Number(receipt.status) !== 1) {
      throw new FxEvmCohortError(
        `${configuration.name} transaction reverted or timed out`,
        "TRANSACTION_UNCONFIRMED"
      );
    }
    return serializableReceipt(receipt);
  }

  async fundLock({
    chainId,
    tradeId,
    side,
    amountAtomic,
    beneficiaryAmountAtomic = amountAtomic,
    executorAmountAtomic = "0",
    beneficiary,
    refundAddress,
    secretHash,
    refundTimestamp,
    role = "requester",
    token = null,
  }) {
    const configuration = await this.preflight(chainId);
    const asset = assetConfiguration(
      configuration,
      token || configuration.tokenAddress,
      this.settlementVersion
    );
    const lockId = phase5LockId(tradeId, side);
    const beneficiaryAmount = BigInt(beneficiaryAmountAtomic);
    const executorAmount = BigInt(executorAmountAtomic);
    const amount = beneficiaryAmount + executorAmount;
    if (amount !== BigInt(amountAtomic)) {
      throw new FxEvmCohortError(
        "lock amount does not equal beneficiary plus executor liabilities",
        "INVALID_AMOUNT"
      );
    }
    const signer = this.wallet(chainId, role);
    const owner = normalizedAddress(await signer.getAddress(), "FX wallet");
    const normalizedBeneficiary = normalizedAddress(
      beneficiary,
      "beneficiary"
    );
    const normalizedRefundAddress = normalizedAddress(
      refundAddress,
      "refund address"
    );
    if (
      asset.settlementVersion === 3 &&
      owner !== normalizedRefundAddress
    ) {
      throw new FxEvmCohortError(
        "V3 refunds are bound to the funding wallet",
        "REFUND_ADDRESS_MISMATCH"
      );
    }
    const compactSettlement =
      asset.settlementVersion === 3
        ? packSettlementV3(
            refundTimestamp,
            beneficiaryAmount,
            executorAmount
          )
        : null;
    let existing;
    if (asset.settlementVersion === 3) {
      const adapter = this.contractFactory(
        asset.adapterAddress,
        asset.abi,
        signer
      );
      const terms = {
        tradeId: lockId,
        funder: owner,
        beneficiary: normalizedBeneficiary,
        secretHash: String(secretHash).toLowerCase(),
        refundTimestamp: Number(refundTimestamp),
        beneficiaryAmount,
        executorAmount,
      };
      const lockDigest = String(await adapter.lockDigest(terms)).toLowerCase();
      const state = Number(await adapter.stateOf(lockDigest));
      existing = {
        chainId: configuration.chainId,
        token: asset.token,
        adapterAddress: asset.adapterAddress,
        lockId,
        lockDigest,
        funder: owner,
        beneficiary: normalizedBeneficiary,
        refundAddress: owner,
        secretHash: String(secretHash).toLowerCase(),
        timeout: Number(refundTimestamp),
        state,
        stateName: lockStateName(state),
        beneficiaryAmountAtomic: beneficiaryAmount.toString(),
        executorAmountAtomic: executorAmount.toString(),
        amountAtomic: amount.toString(),
      };
    } else {
      existing = await this.readLock(chainId, lockId, asset.token);
    }
    if (existing.state !== 0) {
      if (
        existing.state === 1 &&
        existing.amountAtomic === BigInt(amountAtomic).toString() &&
        existing.beneficiaryAmountAtomic === beneficiaryAmount.toString() &&
        existing.executorAmountAtomic === executorAmount.toString() &&
        existing.beneficiary === normalizedBeneficiary &&
        existing.refundAddress === normalizedRefundAddress &&
        existing.secretHash === String(secretHash).toLowerCase() &&
        existing.timeout === Number(refundTimestamp)
      ) {
        return { lock: existing, receipt: null, recovered: true };
      }
      throw new FxEvmCohortError(
        "deterministic lock ID is already occupied by different terms",
        "LOCK_CONFLICT"
      );
    }
    if (asset.native) {
      const adapter = this.contractFactory(
        asset.adapterAddress,
        asset.abi,
        signer
      );
      const fundArguments =
        asset.settlementVersion === 3
          ? [
              lockId,
              normalizedBeneficiary,
              String(secretHash).toLowerCase(),
              compactSettlement,
              { value: amount },
            ]
          : [
              lockId,
              normalizedBeneficiary,
              normalizedRefundAddress,
              String(secretHash).toLowerCase(),
              Number(refundTimestamp),
              ...(asset.settlementVersion === 2
                ? [beneficiaryAmount, executorAmount]
                : []),
              { value: amount },
            ];
      const feeData = await this.provider(chainId).getFeeData();
      const maxFeePerGas = BigInt(feeData.maxFeePerGas || feeData.gasPrice || 0);
      const estimatedGas =
        typeof adapter.fund.estimateGas === "function"
          ? BigInt(await adapter.fund.estimateGas(...fundArguments))
          : 180_000n;
      const gasReserve = BigInt(configuration.nativeGasReserveWei || 0);
      const balance = BigInt(await this.provider(chainId).getBalance(owner));
      if (balance < amount + gasReserve + estimatedGas * maxFeePerGas) {
        throw new FxEvmCohortError(
          "native lock would consume the operating gas reserve",
          "GAS_RESERVE_REQUIRED"
        );
      }
      const transaction = await adapter.fund(...fundArguments);
      const receipt = await this.#confirmedReceipt(chainId, transaction.hash);
      return {
        lock: await this.readLock(
          chainId,
          lockId,
          asset.token,
          asset.settlementVersion === 3 ? receipt.transactionHash : null
        ),
        receipt,
        recovered: false,
      };
    }
    const tokenContract = this.contractFactory(
      asset.token,
      FX_TOKEN_ABI,
      signer
    );
    const adapter = this.contractFactory(
      asset.adapterAddress,
      asset.abi,
      signer
    );
    const allowance = BigInt(
      await tokenContract.allowance(owner, asset.adapterAddress)
    );
    if (allowance < amount) {
      const approval = await tokenContract.approve(
        asset.adapterAddress,
        amount
      );
      await this.#confirmedReceipt(chainId, approval.hash);
    }
    const transaction =
      asset.settlementVersion === 3
        ? await adapter.fund(
            lockId,
            normalizedBeneficiary,
            String(secretHash).toLowerCase(),
            compactSettlement
          )
        : asset.settlementVersion === 2
        ? await adapter.fund(
            lockId,
            normalizedBeneficiary,
            normalizedRefundAddress,
            String(secretHash).toLowerCase(),
            Number(refundTimestamp),
            beneficiaryAmount,
            executorAmount
          )
        : await adapter.fund(
            lockId,
            normalizedBeneficiary,
            normalizedRefundAddress,
            String(secretHash).toLowerCase(),
            Number(refundTimestamp),
            amount
          );
    const receipt = await this.#confirmedReceipt(chainId, transaction.hash);
    return {
      lock: await this.readLock(
        chainId,
        lockId,
        asset.token,
        asset.settlementVersion === 3 ? receipt.transactionHash : null
      ),
      receipt,
      recovered: false,
    };
  }

  async claimLock({
    chainId,
    tradeId,
    side,
    secret,
    role = "requester",
    token = null,
    fundingTransactionHash = null,
  }) {
    const configuration = await this.preflight(chainId);
    const asset = assetConfiguration(
      configuration,
      token || configuration.tokenAddress,
      this.settlementVersion
    );
    if (asset.settlementVersion === 3 && !fundingTransactionHash) {
      throw new FxEvmCohortError(
        "V3 claims require the exact funding transaction",
        "MISSING_LOCK_PROVENANCE"
      );
    }
    const lockId = phase5LockId(tradeId, side);
    const existing = await this.readLock(
      chainId,
      lockId,
      asset.token,
      asset.settlementVersion === 3 ? fundingTransactionHash : null
    );
    if (existing.state === 2) {
      return { lock: existing, receipt: null, recovered: true };
    }
    if (existing.state !== 1) {
      throw new FxEvmCohortError(
        `lock cannot be claimed from ${existing.stateName}`,
        "LOCK_NOT_CLAIMABLE"
      );
    }
    const adapter = this.contractFactory(
      asset.adapterAddress,
      asset.abi,
      this.wallet(chainId, role)
    );
    const transaction =
      asset.settlementVersion === 3
        ? await adapter.claim(
            lockId,
            existing.funder,
            existing.beneficiary,
            packSettlementV3(
              existing.timeout,
              existing.beneficiaryAmountAtomic,
              existing.executorAmountAtomic
            ),
            secret
          )
        : await adapter.claim(lockId, secret);
    const receipt = await this.#confirmedReceipt(chainId, transaction.hash);
    return {
      lock: await this.readLock(
        chainId,
        lockId,
        asset.token,
        asset.settlementVersion === 3 ? fundingTransactionHash : null
      ),
      receipt,
      recovered: false,
    };
  }

  async refundLock({
    chainId,
    tradeId,
    side,
    role = "requester",
    token = null,
    fundingTransactionHash = null,
  }) {
    const configuration = await this.preflight(chainId);
    const asset = assetConfiguration(
      configuration,
      token || configuration.tokenAddress,
      this.settlementVersion
    );
    if (asset.settlementVersion === 3 && !fundingTransactionHash) {
      throw new FxEvmCohortError(
        "V3 refunds require the exact funding transaction",
        "MISSING_LOCK_PROVENANCE"
      );
    }
    const lockId = phase5LockId(tradeId, side);
    const existing = await this.readLock(
      chainId,
      lockId,
      asset.token,
      asset.settlementVersion === 3 ? fundingTransactionHash : null
    );
    if (existing.state === 3) {
      return { lock: existing, receipt: null, recovered: true };
    }
    if (existing.state !== 1) {
      throw new FxEvmCohortError(
        `lock cannot be refunded from ${existing.stateName}`,
        "LOCK_NOT_REFUNDABLE"
      );
    }
    const adapter = this.contractFactory(
      asset.adapterAddress,
      asset.abi,
      this.wallet(chainId, role)
    );
    const transaction =
      asset.settlementVersion === 3
        ? await adapter.refund({
            tradeId: lockId,
            funder: existing.funder,
            beneficiary: existing.beneficiary,
            secretHash: existing.secretHash,
            refundTimestamp: existing.timeout,
            beneficiaryAmount: existing.beneficiaryAmountAtomic,
            executorAmount: existing.executorAmountAtomic,
          })
        : await adapter.refund(lockId);
    const receipt = await this.#confirmedReceipt(chainId, transaction.hash);
    return {
      lock: await this.readLock(
        chainId,
        lockId,
        asset.token,
        asset.settlementVersion === 3 ? fundingTransactionHash : null
      ),
      receipt,
      recovered: false,
    };
  }

  async verifyLockEnvelope({
    chainId,
    lockId,
    transactionHash: expectedTransactionHash,
    token = null,
  }) {
    const configuration = await this.preflight(chainId);
    const asset = assetConfiguration(
      configuration,
      token || configuration.tokenAddress,
      this.settlementVersion
    );
    const provider = this.provider(chainId);
    const receipt = await provider.getTransactionReceipt(
      transactionHash(expectedTransactionHash)
    );
    if (!receipt || Number(receipt.status) !== 1) {
      return { confirmed: false, canonical: false };
    }
    const latest = await provider.getBlockNumber();
    const confirmations = latest - Number(receipt.blockNumber) + 1;
    const block = await provider.getBlock(receipt.blockNumber);
    const canonical =
      !receipt.blockHash ||
      !block?.hash ||
      String(receipt.blockHash).toLowerCase() ===
        String(block.hash).toLowerCase();
    const lock = await this.readLock(
      chainId,
      lockId,
      asset.token,
      asset.settlementVersion === 3 ? expectedTransactionHash : null
    );
    return {
      confirmed:
        canonical && confirmations >= configuration.requiredConfirmations,
      canonical,
      confirmations,
      transactionHash: transactionHash(expectedTransactionHash),
      blockNumber: Number(receipt.blockNumber),
      blockHash: String(receipt.blockHash).toLowerCase(),
      blockTimestamp: Number(block.timestamp),
      ...lock,
    };
  }

  async extractClaimSecret({
    chainId,
    tradeId,
    side,
    transactionHash: hash,
    token = null,
  }) {
    const configuration = await this.preflight(chainId);
    const asset = assetConfiguration(
      configuration,
      token || configuration.tokenAddress,
      this.settlementVersion
    );
    const provider = this.provider(chainId);
    const receipt = await provider.getTransactionReceipt(transactionHash(hash));
    if (!receipt || Number(receipt.status) !== 1) {
      throw new FxEvmCohortError("claim receipt is unavailable", "CLAIM_UNCONFIRMED");
    }
    const lockId = phase5LockId(tradeId, side);
    for (const log of receipt.logs) {
      if (
        normalizedAddress(log.address, "claim log address") !==
        asset.adapterAddress
      ) {
        continue;
      }
      try {
        const parsed = asset.interface.parseLog(log);
        if (
          parsed?.name === "LockClaimed" &&
          String(
            asset.settlementVersion === 3
              ? parsed.args.tradeId
              : parsed.args.lockId
          ).toLowerCase() === lockId
        ) {
          const secret = String(parsed.args.secret).toLowerCase();
          let lock;
          if (asset.settlementVersion === 3) {
            const fundedEvent = asset.interface.getEvent("LockFunded");
            const fundedLogs = await this.#getLogs(provider, {
              address: asset.adapterAddress,
              topics: [
                fundedEvent.topicHash,
                String(parsed.args.lockDigest).toLowerCase(),
                lockId,
              ],
              fromBlock: asset.adapterDeploymentBlock,
              toBlock: "latest",
            });
            if (fundedLogs.length !== 1) {
              throw new FxEvmCohortError(
                "claim does not resolve to exactly one V3 funding event",
                "LOCK_EVENT_MISMATCH"
              );
            }
            const adapter = this.contractFactory(
              asset.adapterAddress,
              asset.abi,
              provider
            );
            lock = await this.#v3LockFromFundedLog(
              configuration,
              asset,
              adapter,
              fundedLogs[0],
              lockId
            );
          } else {
            lock = await this.readLock(chainId, lockId, asset.token);
          }
          if (keccak256(secret) !== lock.secretHash) {
            throw new FxEvmCohortError("claim secret hash is wrong", "WRONG_SECRET");
          }
          return secret;
        }
      } catch (error) {
        if (error instanceof FxEvmCohortError) throw error;
      }
    }
    throw new FxEvmCohortError("claim did not publish the expected secret", "MISSING_SECRET");
  }

  async findLockEvent({
    chainId,
    tradeId,
    side,
    eventName,
    token = null,
    fundingTransactionHash = null,
    expectedLockDigest = null,
  }) {
    const configuration = await this.preflight(chainId);
    const asset = assetConfiguration(
      configuration,
      token || configuration.tokenAddress,
      this.settlementVersion
    );
    const provider = this.provider(chainId);
    const lockId = phase5LockId(tradeId, side);
    const event = asset.interface.getEvent(eventName);
    if (!event) {
      throw new FxEvmCohortError("HTLC event is unsupported", "UNSUPPORTED_EVENT");
    }
    let lockDigest = expectedLockDigest
      ? String(expectedLockDigest).toLowerCase()
      : null;
    if (asset.settlementVersion === 3 && fundingTransactionHash) {
      const fundedLock = await this.readLock(
        chainId,
        lockId,
        asset.token,
        fundingTransactionHash
      );
      lockDigest = fundedLock.lockDigest;
    }
    const logs = await this.#getLogs(provider, {
      address: asset.adapterAddress,
      topics: [
        event.topicHash,
        ...(asset.settlementVersion === 3
          ? [lockDigest, lockId]
          : [lockId]),
      ],
      fromBlock: asset.adapterDeploymentBlock,
      toBlock: "latest",
    });
    const log = logs.at(-1);
    if (!log) {
      throw new FxEvmCohortError(
        `${eventName} was not found for the deterministic lock`,
        "MISSING_CHAIN_EVENT"
      );
    }
    const latest = await provider.getBlockNumber();
    return {
      transactionHash: transactionHash(log.transactionHash),
      blockNumber: Number(log.blockNumber),
      confirmations: latest - Number(log.blockNumber) + 1,
    };
  }
}

module.exports = {
  FX_HTLC_ABI,
  FX_HTLC_V2_ABI,
  FX_HTLC_V3_ABI,
  FX_NATIVE_HTLC_ABI,
  FX_NATIVE_HTLC_V2_ABI,
  FX_NATIVE_HTLC_V3_ABI,
  FX_TESTNET_CHAINS,
  FX_TOKEN_ABI,
  FxEvmCohort,
  FxEvmCohortError,
  chainConfiguration,
  lockStateName,
  isNativeAsset,
  packSettlementV3,
  serializableReceipt,
};
