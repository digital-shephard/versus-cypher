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

const FX_TESTNET_CHAINS = Object.freeze({
  "84532": Object.freeze({
    chainId: "84532",
    name: "Base Sepolia",
    rpcUrl: "https://sepolia.base.org",
    rpcEnvironmentVariable: "BASE_SEPOLIA_RPC_URL",
    explorerUrl: "https://sepolia-explorer.base.org",
    tokenAddress: "0xcba3d9354dd4c30bb6961abb4473a6340486e01b",
    adapterAddress: "0xe7a02dd38f9191d8ee20daa24b4feee911da334d",
    adapterDeploymentBlock: 44662322,
    nativeAdapterAddress: "0x7c917f09e1de03977acc14575b56932aa55da543",
    nativeAdapterDeploymentBlock: 44762481,
    adapterV2Address: "0x0fa1152f8c51ce05cd61d1ca98515a409ed23c14",
    adapterV2DeploymentBlock: 44781962,
    nativeAdapterV2Address: "0x1e933ccffaa2cd384d3df751ff7a25183682dc61",
    nativeAdapterV2DeploymentBlock: 44781959,
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
    tokenAddress: "0xcba3d9354dd4c30bb6961abb4473a6340486e01b",
    adapterAddress: "0xe7a02dd38f9191d8ee20daa24b4feee911da334d",
    adapterDeploymentBlock: 291630348,
    nativeAdapterAddress: "0x7c917f09e1de03977acc14575b56932aa55da543",
    nativeAdapterDeploymentBlock: 292433456,
    adapterV2Address: "0x0fa1152f8c51ce05cd61d1ca98515a409ed23c14",
    adapterV2DeploymentBlock: 292589984,
    nativeAdapterV2Address: "0x1e933ccffaa2cd384d3df751ff7a25183682dc61",
    nativeAdapterV2DeploymentBlock: 292589965,
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
const TRANSFER_TOPIC = id("Transfer(address,address,uint256)");

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
  if (![1, 2].includes(version)) {
    throw new FxEvmCohortError(
      "settlement adapter version is unsupported",
      "UNSUPPORTED_ADAPTER"
    );
  }
  if (isNativeAsset(token)) {
    const adapterAddress =
      version === 2
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
        version === 2
          ? configuration.nativeAdapterV2DeploymentBlock
          : configuration.nativeAdapterDeploymentBlock,
      abi: version === 2 ? FX_NATIVE_HTLC_V2_ABI : FX_NATIVE_HTLC_ABI,
      interface:
        version === 2 ? NATIVE_HTLC_V2_INTERFACE : NATIVE_HTLC_INTERFACE,
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
      version === 2 ? configuration.adapterV2Address : configuration.adapterAddress,
    adapterDeploymentBlock:
      version === 2
        ? configuration.adapterV2DeploymentBlock
        : configuration.adapterDeploymentBlock,
    abi: version === 2 ? FX_HTLC_V2_ABI : FX_HTLC_ABI,
    interface: version === 2 ? HTLC_V2_INTERFACE : HTLC_INTERFACE,
    native: false,
    settlementVersion: version,
  };
}

function lockStateName(value) {
  return ["empty", "funded", "claimed", "refunded"][Number(value)] || "unknown";
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
    if (![1, 2].includes(this.settlementVersion)) {
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
        const adapterAddress =
          this.settlementVersion === 2
            ? configuration.adapterV2Address
            : configuration.adapterAddress;
        const nativeAdapterAddress =
          this.settlementVersion === 2
            ? configuration.nativeAdapterV2Address
            : configuration.nativeAdapterAddress;
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
    const [blockNumber, balance] = await Promise.all([
      provider.getBlockNumber(),
      asset.native ? provider.getBalance(recipient) : contract.balanceOf(recipient),
    ]);
    return {
      chainId: configuration.chainId,
      token: asset.token,
      address: recipient,
      requiredAtomic: BigInt(requiredAtomic).toString(),
      baselineBlockNumber: Number(blockNumber),
      baselineBalanceAtomic: BigInt(balance).toString(),
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
    const required = BigInt(requiredAtomic || baseline.requiredAtomic);
    if (asset.native) {
      const confirmations = Math.max(
        0,
        latestBlock - Number(baseline.baselineBlockNumber)
      );
      return {
        confirmed:
          balanceIncrease >= required &&
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
      : await provider.getLogs({
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

  async readLock(chainId, lockId, token = null) {
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
    const existing = await this.readLock(chainId, lockId, asset.token);
    if (existing.state !== 0) {
      if (
        existing.state === 1 &&
        existing.amountAtomic === BigInt(amountAtomic).toString() &&
        existing.beneficiaryAmountAtomic === beneficiaryAmount.toString() &&
        existing.executorAmountAtomic === executorAmount.toString() &&
        existing.beneficiary === normalizedAddress(beneficiary, "beneficiary") &&
        existing.refundAddress === normalizedAddress(refundAddress, "refund address") &&
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
    const signer = this.wallet(chainId, role);
    if (asset.native) {
      const owner = normalizedAddress(await signer.getAddress(), "FX wallet");
      const adapter = this.contractFactory(
        asset.adapterAddress,
        asset.abi,
        signer
      );
      const fundArguments = [
        lockId,
        normalizedAddress(beneficiary, "beneficiary"),
        normalizedAddress(refundAddress, "refund address"),
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
        lock: await this.readLock(chainId, lockId, asset.token),
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
    const owner = normalizedAddress(await signer.getAddress(), "FX wallet");
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
      asset.settlementVersion === 2
        ? await adapter.fund(
            lockId,
            normalizedAddress(beneficiary, "beneficiary"),
            normalizedAddress(refundAddress, "refund address"),
            String(secretHash).toLowerCase(),
            Number(refundTimestamp),
            beneficiaryAmount,
            executorAmount
          )
        : await adapter.fund(
            lockId,
            normalizedAddress(beneficiary, "beneficiary"),
            normalizedAddress(refundAddress, "refund address"),
            String(secretHash).toLowerCase(),
            Number(refundTimestamp),
            amount
          );
    const receipt = await this.#confirmedReceipt(chainId, transaction.hash);
    return {
      lock: await this.readLock(chainId, lockId, asset.token),
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
  }) {
    const configuration = await this.preflight(chainId);
    const asset = assetConfiguration(
      configuration,
      token || configuration.tokenAddress,
      this.settlementVersion
    );
    const lockId = phase5LockId(tradeId, side);
    const existing = await this.readLock(chainId, lockId, asset.token);
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
    const transaction = await adapter.claim(lockId, secret);
    const receipt = await this.#confirmedReceipt(chainId, transaction.hash);
    return {
      lock: await this.readLock(chainId, lockId, asset.token),
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
  }) {
    const configuration = await this.preflight(chainId);
    const asset = assetConfiguration(
      configuration,
      token || configuration.tokenAddress,
      this.settlementVersion
    );
    const lockId = phase5LockId(tradeId, side);
    const existing = await this.readLock(chainId, lockId, asset.token);
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
    const transaction = await adapter.refund(lockId);
    const receipt = await this.#confirmedReceipt(chainId, transaction.hash);
    return {
      lock: await this.readLock(chainId, lockId, asset.token),
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
    const lock = await this.readLock(chainId, lockId, asset.token);
    return {
      confirmed: confirmations >= configuration.requiredConfirmations,
      canonical: true,
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
          String(parsed.args.lockId).toLowerCase() === lockId
        ) {
          const secret = String(parsed.args.secret).toLowerCase();
          const lock = await this.readLock(chainId, lockId, asset.token);
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
    const logs = await provider.getLogs({
      address: asset.adapterAddress,
      topics: [
        event.topicHash,
        lockId,
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
  FX_NATIVE_HTLC_ABI,
  FX_NATIVE_HTLC_V2_ABI,
  FX_TESTNET_CHAINS,
  FX_TOKEN_ABI,
  FxEvmCohort,
  FxEvmCohortError,
  chainConfiguration,
  lockStateName,
  isNativeAsset,
  serializableReceipt,
};
