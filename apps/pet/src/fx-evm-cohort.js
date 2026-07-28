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
const { phase5LockId } = require("@versus/network");

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
    requiredConfirmations: 2,
  }),
});

const TOKEN_INTERFACE = new Interface(FX_TOKEN_ABI);
const HTLC_INTERFACE = new Interface(FX_HTLC_ABI);
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
    this.providers = new Map();
    this.preflights = new Map();
    this.rpcOverrides = new Map();
  }

  configuration(chainId) {
    return chainConfiguration(chainId, this.configurations);
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
        const [tokenCode, adapterCode] = await Promise.all([
          provider.getCode(configuration.tokenAddress),
          provider.getCode(configuration.adapterAddress),
        ]);
        if (tokenCode === "0x" || adapterCode === "0x") {
          throw new FxEvmCohortError(
            `${configuration.name} cohort contracts are unavailable`,
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
    const normalizedToken = normalizedAddress(token, "funding token");
    if (normalizedToken !== configuration.tokenAddress) {
      throw new FxEvmCohortError(
        "funding token does not match the frozen cohort asset",
        "UNSUPPORTED_ASSET"
      );
    }
    const recipient = normalizedAddress(address, "funding address");
    const provider = this.provider(chainId);
    const contract = this.contractFactory(normalizedToken, FX_TOKEN_ABI, provider);
    const [blockNumber, balance] = await Promise.all([
      provider.getBlockNumber(),
      contract.balanceOf(recipient),
    ]);
    return {
      chainId: configuration.chainId,
      token: normalizedToken,
      address: recipient,
      requiredAtomic: BigInt(requiredAtomic).toString(),
      baselineBlockNumber: Number(blockNumber),
      baselineBalanceAtomic: BigInt(balance).toString(),
      capturedAt: new Date().toISOString(),
    };
  }

  async tokenBalance(chainId, token, owner = null) {
    const configuration = await this.preflight(chainId);
    const normalizedToken = normalizedAddress(token, "inventory token");
    if (normalizedToken !== configuration.tokenAddress) {
      throw new FxEvmCohortError(
        "inventory token does not match the frozen cohort asset",
        "UNSUPPORTED_ASSET"
      );
    }
    const address = normalizedAddress(
      owner || this.walletProvider("dealer")?.address,
      "inventory owner"
    );
    const contract = this.contractFactory(
      normalizedToken,
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
    const normalizedToken = normalizedAddress(token, "inventory token");
    if (normalizedToken !== configuration.tokenAddress) {
      throw new FxEvmCohortError(
        "inventory token does not match the frozen cohort asset",
        "UNSUPPORTED_ASSET"
      );
    }
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
    const contract = this.contractFactory(
      normalizedToken,
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
      token: normalizedToken,
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
    const token = normalizedAddress(baseline.token, "funding token");
    const recipient = normalizedAddress(baseline.address, "funding address");
    const contract = this.contractFactory(token, FX_TOKEN_ABI, provider);
    const latestBlock = await provider.getBlockNumber();
    const balance = BigInt(await contract.balanceOf(recipient));
    const baselineBalance = BigInt(baseline.baselineBalanceAtomic);
    const balanceIncrease = balance > baselineBalance ? balance - baselineBalance : 0n;
    const required = BigInt(requiredAtomic || baseline.requiredAtomic);
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

  async readLock(chainId, lockId) {
    const configuration = await this.preflight(chainId);
    const provider = this.provider(configuration.chainId);
    const adapter = this.contractFactory(
      configuration.adapterAddress,
      FX_HTLC_ABI,
      provider
    );
    const lock = await adapter.getLock(lockId);
    return {
      chainId: configuration.chainId,
      token: configuration.tokenAddress,
      adapterAddress: configuration.adapterAddress,
      lockId: String(lockId).toLowerCase(),
      funder: normalizedAddress(lock.funder, "lock funder"),
      beneficiary: normalizedAddress(lock.beneficiary, "lock beneficiary"),
      refundAddress: normalizedAddress(lock.refundAddress, "lock refund address"),
      secretHash: String(lock.secretHash).toLowerCase(),
      timeout: Number(lock.refundTimestamp),
      state: Number(lock.state),
      stateName: lockStateName(lock.state),
      amountAtomic: BigInt(lock.amount).toString(),
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
    beneficiary,
    refundAddress,
    secretHash,
    refundTimestamp,
    role = "requester",
  }) {
    const configuration = await this.preflight(chainId);
    const lockId = phase5LockId(tradeId, side);
    const existing = await this.readLock(chainId, lockId);
    if (existing.state !== 0) {
      if (
        existing.state === 1 &&
        existing.amountAtomic === BigInt(amountAtomic).toString() &&
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
    const token = this.contractFactory(
      configuration.tokenAddress,
      FX_TOKEN_ABI,
      signer
    );
    const adapter = this.contractFactory(
      configuration.adapterAddress,
      FX_HTLC_ABI,
      signer
    );
    const owner = normalizedAddress(await signer.getAddress(), "FX wallet");
    const amount = BigInt(amountAtomic);
    const allowance = BigInt(await token.allowance(owner, configuration.adapterAddress));
    if (allowance < amount) {
      const approval = await token.approve(configuration.adapterAddress, amount);
      await this.#confirmedReceipt(chainId, approval.hash);
    }
    const transaction = await adapter.fund(
      lockId,
      normalizedAddress(beneficiary, "beneficiary"),
      normalizedAddress(refundAddress, "refund address"),
      String(secretHash).toLowerCase(),
      Number(refundTimestamp),
      amount
    );
    const receipt = await this.#confirmedReceipt(chainId, transaction.hash);
    return {
      lock: await this.readLock(chainId, lockId),
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
  }) {
    const lockId = phase5LockId(tradeId, side);
    const existing = await this.readLock(chainId, lockId);
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
      this.configuration(chainId).adapterAddress,
      FX_HTLC_ABI,
      this.wallet(chainId, role)
    );
    const transaction = await adapter.claim(lockId, secret);
    const receipt = await this.#confirmedReceipt(chainId, transaction.hash);
    return {
      lock: await this.readLock(chainId, lockId),
      receipt,
      recovered: false,
    };
  }

  async refundLock({
    chainId,
    tradeId,
    side,
    role = "requester",
  }) {
    const lockId = phase5LockId(tradeId, side);
    const existing = await this.readLock(chainId, lockId);
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
      this.configuration(chainId).adapterAddress,
      FX_HTLC_ABI,
      this.wallet(chainId, role)
    );
    const transaction = await adapter.refund(lockId);
    const receipt = await this.#confirmedReceipt(chainId, transaction.hash);
    return {
      lock: await this.readLock(chainId, lockId),
      receipt,
      recovered: false,
    };
  }

  async verifyLockEnvelope({
    chainId,
    lockId,
    transactionHash: expectedTransactionHash,
  }) {
    const configuration = await this.preflight(chainId);
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
    const lock = await this.readLock(chainId, lockId);
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

  async extractClaimSecret({ chainId, tradeId, side, transactionHash: hash }) {
    const provider = this.provider(chainId);
    const receipt = await provider.getTransactionReceipt(transactionHash(hash));
    if (!receipt || Number(receipt.status) !== 1) {
      throw new FxEvmCohortError("claim receipt is unavailable", "CLAIM_UNCONFIRMED");
    }
    const lockId = phase5LockId(tradeId, side);
    for (const log of receipt.logs) {
      if (
        normalizedAddress(log.address, "claim log address") !==
        this.configuration(chainId).adapterAddress
      ) {
        continue;
      }
      try {
        const parsed = HTLC_INTERFACE.parseLog(log);
        if (
          parsed?.name === "LockClaimed" &&
          String(parsed.args.lockId).toLowerCase() === lockId
        ) {
          const secret = String(parsed.args.secret).toLowerCase();
          const lock = await this.readLock(chainId, lockId);
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
  }) {
    const configuration = await this.preflight(chainId);
    const provider = this.provider(chainId);
    const lockId = phase5LockId(tradeId, side);
    const event = HTLC_INTERFACE.getEvent(eventName);
    if (!event) {
      throw new FxEvmCohortError("HTLC event is unsupported", "UNSUPPORTED_EVENT");
    }
    const logs = await provider.getLogs({
      address: configuration.adapterAddress,
      topics: [
        event.topicHash,
        lockId,
      ],
      fromBlock: configuration.adapterDeploymentBlock,
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
  FX_TESTNET_CHAINS,
  FX_TOKEN_ABI,
  FxEvmCohort,
  FxEvmCohortError,
  chainConfiguration,
  lockStateName,
  serializableReceipt,
};
