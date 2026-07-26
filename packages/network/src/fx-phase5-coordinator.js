const path = require("node:path");
const {
  Contract,
  Interface,
  getAddress,
  hexlify,
  keccak256,
  randomBytes,
} = require("ethers");
const {
  preflightEvmCapability,
  verifyObservedLock,
} = require("./fx-evm-adapter");
const {
  createFxRecoveryPacket,
  restoreFxRecoveryPacket,
} = require("./fx-recovery");
const {
  phase5LockId,
  validatePhase5Route,
} = require("./fx-phase5-route");

const ADAPTER_ABI = [
  "function fund(bytes32 lockId,address beneficiary,address refundAddress,bytes32 secretHash,uint64 refundTimestamp,uint256 amount)",
  "function claim(bytes32 lockId,bytes32 secret)",
  "function refund(bytes32 lockId)",
  "function getLock(bytes32 lockId) view returns (tuple(address funder,address beneficiary,address refundAddress,bytes32 secretHash,uint64 refundTimestamp,uint8 state,uint256 amount))",
  "event LockClaimed(bytes32 indexed lockId,address indexed submitter,address indexed beneficiary,bytes32 secret,uint256 amount)",
];
const TOKEN_ABI = [
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
];
const ADAPTER_INTERFACE = new Interface(ADAPTER_ABI);

class FxPhase5CoordinatorError extends Error {
  constructor(message, code = "FX_PHASE5_COORDINATOR_ERROR") {
    super(message);
    this.name = "FxPhase5CoordinatorError";
    this.code = code;
  }
}

function hash(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new FxPhase5CoordinatorError(`${label} must be bytes32`);
  }
  return normalized;
}

function address(value, label) {
  try {
    return getAddress(value).toLowerCase();
  } catch {
    throw new FxPhase5CoordinatorError(`${label} must be an EVM address`);
  }
}

function serializableReceipt(receipt) {
  return {
    hash: String(receipt.hash || receipt.transactionHash).toLowerCase(),
    blockHash: String(receipt.blockHash).toLowerCase(),
    blockNumber: Number(receipt.blockNumber),
    status: Number(receipt.status),
    gasUsed: BigInt(receipt.gasUsed || 0).toString(),
    gasPrice: BigInt(receipt.gasPrice || 0).toString(),
  };
}

function chainSide(value) {
  if (!["source", "destination"].includes(value)) {
    throw new FxPhase5CoordinatorError("chain side is unsupported");
  }
  return value;
}

class FxPhase5Coordinator {
  constructor({
    route,
    manifest,
    journal,
    providers,
    signers,
    recoveryDirectory,
    maximumNativeFeeByChain = {},
    receiptTimeoutMs = 120_000,
    now = () => Math.floor(Date.now() / 1000),
  }) {
    this.route = validatePhase5Route(route, manifest, { now: now() });
    this.manifest = manifest;
    this.journal = journal;
    this.providers = providers;
    this.signers = signers;
    this.recoveryDirectory = path.resolve(recoveryDirectory);
    this.maximumNativeFeeByChain = Object.fromEntries(
      Object.entries(maximumNativeFeeByChain).map(([chainId, value]) => [
        String(BigInt(chainId)),
        BigInt(value),
      ])
    );
    this.receiptTimeoutMs = Number(receiptTimeoutMs);
    this.now = now;
    for (const side of ["source", "destination"]) {
      if (!providers?.[side]) {
        throw new FxPhase5CoordinatorError(`${side} provider is required`);
      }
      for (const role of ["requester", "dealer", "relayer"]) {
        if (!signers?.[side]?.[role]) {
          throw new FxPhase5CoordinatorError(`${side} ${role} signer is required`);
        }
      }
    }
  }

  async preflight() {
    const results = {};
    for (const side of ["source", "destination"]) {
      const leg = this.route[side];
      const provider = this.providers[side];
      const network = await provider.getNetwork();
      if (String(network.chainId) !== leg.chainId) {
        throw new FxPhase5CoordinatorError(
          `${side} provider is connected to the wrong chain`,
          "WRONG_CHAIN"
        );
      }
      results[side] = await preflightEvmCapability(provider, this.manifest, {
        chainId: leg.chainId,
        token: leg.tokenAddress,
        decimals: leg.decimals,
      });
      for (const role of ["requester", "dealer", "relayer"]) {
        const signerAddress = address(
          await this.signers[side][role].getAddress(),
          `${side} ${role}`
        );
        if (signerAddress !== this.route[role]) {
          throw new FxPhase5CoordinatorError(
            `${side} ${role} signer does not match the frozen route`,
            "WRONG_SIGNER"
          );
        }
      }
    }
    return results;
  }

  async prepareTrade({
    tradeId = hexlify(randomBytes(32)),
    recoveryPassword,
    recoveryFile,
    secret,
  }) {
    tradeId = hash(tradeId, "tradeId");
    const existing = this.journal.trade(tradeId);
    if (existing) {
      this.#assertTradeRoute(existing);
      restoreFxRecoveryPacket({
        filePath: existing.recoveryFile,
        password: recoveryPassword,
        deploymentId: this.route.deploymentId,
        tradeId,
      });
      return existing;
    }
    const [sourceBlock, destinationBlock] = await Promise.all([
      this.providers.source.getBlock("latest"),
      this.providers.destination.getBlock("latest"),
    ]);
    const calibratedNow = Math.max(
      Number(sourceBlock.timestamp),
      Number(destinationBlock.timestamp)
    );
    const executionRoute = {
      ...this.route,
      preparedAt: calibratedNow,
      sourceRefundTimestamp: calibratedNow + this.route.sourceLockSeconds,
      destinationRefundTimestamp:
        calibratedNow + this.route.destinationLockSeconds,
      sourceLockId: phase5LockId(tradeId, "source"),
      destinationLockId: phase5LockId(tradeId, "destination"),
    };
    const filePath = recoveryFile || path.join(
      this.recoveryDirectory,
      `${tradeId.slice(2)}.recovery.json`
    );
    const recovery = createFxRecoveryPacket({
      filePath,
      password: recoveryPassword,
      deploymentId: this.route.deploymentId,
      tradeId,
      createdAt: calibratedNow,
      secret,
      metadata: {
        routeId: this.route.routeId,
        environment: this.route.environment,
      },
    });
    return this.journal.prepareTrade({
      tradeId,
      route: executionRoute,
      recoveryFile: recovery.filePath,
      secretHash: recovery.secretHash,
    });
  }

  approveFromOwnerUi(tradeId, confirmed) {
    return this.journal.approveFromOwnerUi(tradeId, confirmed);
  }

  async fundSource(tradeId, recoveryPassword) {
    const trade = this.#trade(tradeId, "owner_approved");
    this.#restoreSecret(trade, recoveryPassword);
    await this.#ensureAllowance(
      trade,
      "source",
      "requester",
      "source_approval",
      trade.route.inputAmountAtomic
    );
    const adapter = this.#adapter("source", "requester");
    const transaction = await adapter.fund.populateTransaction(
      trade.route.sourceLockId,
      trade.route.dealer,
      trade.route.requester,
      trade.secretHash,
      trade.route.sourceRefundTimestamp,
      trade.route.inputAmountAtomic
    );
    await this.#execute(
      trade,
      "source",
      "requester",
      "source_fund",
      transaction
    );
    await this.observeLock(trade.tradeId, "source");
    return this.journal.trade(trade.tradeId);
  }

  async fundDestination(tradeId) {
    const trade = this.#trade(tradeId, "source_funded");
    await this.observeLock(trade.tradeId, "source");
    await this.#ensureAllowance(
      trade,
      "destination",
      "dealer",
      "destination_approval",
      trade.route.outputAmountAtomic
    );
    const adapter = this.#adapter("destination", "dealer");
    const transaction = await adapter.fund.populateTransaction(
      trade.route.destinationLockId,
      trade.route.requester,
      trade.route.dealer,
      trade.secretHash,
      trade.route.destinationRefundTimestamp,
      trade.route.outputAmountAtomic
    );
    await this.#execute(
      trade,
      "destination",
      "dealer",
      "destination_fund",
      transaction
    );
    await this.observeLock(trade.tradeId, "destination");
    return this.journal.trade(trade.tradeId);
  }

  async claimDestination(tradeId, recoveryPassword) {
    const trade = this.#trade(tradeId, "destination_funded");
    await this.observeLock(trade.tradeId, "destination");
    const secret = this.#restoreSecret(trade, recoveryPassword);
    const adapter = this.#adapter("destination", "requester");
    const transaction = await adapter.claim.populateTransaction(
      trade.route.destinationLockId,
      hexlify(secret)
    );
    await this.#execute(
      trade,
      "destination",
      "requester",
      "destination_claim",
      transaction
    );
    return this.journal.trade(trade.tradeId);
  }

  async extractPublishedSecret(tradeId) {
    const trade = this.#trade(tradeId, "destination_claimed");
    const action = this.journal.action(trade.tradeId, "destination_claim");
    const receipt = await this.providers.destination.getTransactionReceipt(
      action.transactionHash
    );
    if (!receipt || Number(receipt.status) !== 1) {
      throw new FxPhase5CoordinatorError(
        "destination claim receipt is unavailable",
        "MISSING_CLAIM_RECEIPT"
      );
    }
    for (const log of receipt.logs) {
      if (
        address(log.address, "claim log address") !==
        trade.route.destination.adapterAddress
      ) {
        continue;
      }
      try {
        const parsed = ADAPTER_INTERFACE.parseLog(log);
        if (
          parsed?.name === "LockClaimed" &&
          String(parsed.args.lockId).toLowerCase() ===
            trade.route.destinationLockId
        ) {
          const secret = String(parsed.args.secret).toLowerCase();
          if (keccak256(secret) !== trade.secretHash) {
            throw new FxPhase5CoordinatorError(
              "published secret does not match the accepted route",
              "WRONG_SECRET"
            );
          }
          return secret;
        }
      } catch (error) {
        if (error instanceof FxPhase5CoordinatorError) throw error;
      }
    }
    throw new FxPhase5CoordinatorError(
      "destination claim did not publish the expected secret",
      "MISSING_SECRET"
    );
  }

  async claimSource(tradeId) {
    const trade = this.#trade(tradeId, "destination_claimed");
    const secret = await this.extractPublishedSecret(trade.tradeId);
    const adapter = this.#adapter("source", "dealer");
    const transaction = await adapter.claim.populateTransaction(
      trade.route.sourceLockId,
      secret
    );
    await this.#execute(
      trade,
      "source",
      "dealer",
      "source_claim",
      transaction
    );
    return this.journal.trade(trade.tradeId);
  }

  async refundDestination(tradeId) {
    const trade = this.#trade(tradeId, "destination_funded");
    const adapter = this.#adapter("destination", "relayer");
    const transaction = await adapter.refund.populateTransaction(
      trade.route.destinationLockId
    );
    await this.#execute(
      trade,
      "destination",
      "relayer",
      "destination_refund",
      transaction
    );
    return this.journal.trade(trade.tradeId);
  }

  async refundSource(tradeId) {
    const trade = this.#approvedTrade(tradeId);
    if (!["source_funded", "destination_refunded"].includes(trade.state)) {
      throw new FxPhase5CoordinatorError(
        `source refund is unavailable from ${trade.state}`,
        "BAD_STATE"
      );
    }
    const adapter = this.#adapter("source", "relayer");
    const transaction = await adapter.refund.populateTransaction(
      trade.route.sourceLockId
    );
    await this.#execute(
      trade,
      "source",
      "relayer",
      "source_refund",
      transaction
    );
    return this.journal.trade(trade.tradeId);
  }

  async observeLock(tradeId, side) {
    side = chainSide(side);
    const trade = this.#approvedTrade(tradeId);
    const leg = trade.route[side];
    const lockId = trade.route[`${side}LockId`];
    const adapter = new Contract(
      leg.adapterAddress,
      ADAPTER_ABI,
      this.providers[side]
    );
    const lock = await adapter.getLock(lockId);
    if (Number(lock.state) !== 1) {
      throw new FxPhase5CoordinatorError(
        `${side} lock is not funded`,
        "LOCK_NOT_FUNDED"
      );
    }
    const expected = side === "source"
      ? {
          lockId,
          amountAtomic: trade.route.inputAmountAtomic,
          beneficiary: trade.route.dealer,
          refundAddress: trade.route.requester,
          secretHash: trade.secretHash,
          refundTimestamp: trade.route.sourceRefundTimestamp,
        }
      : {
          lockId,
          amountAtomic: trade.route.outputAmountAtomic,
          beneficiary: trade.route.requester,
          refundAddress: trade.route.dealer,
          secretHash: trade.secretHash,
          refundTimestamp: trade.route.destinationRefundTimestamp,
        };
    verifyObservedLock(
      {
        adapterAddress: leg.adapterAddress,
        chainId: leg.chainId,
        token: leg.tokenAddress,
        lockId,
        amountAtomic: lock.amount.toString(),
        beneficiary: lock.beneficiary,
        refundAddress: lock.refundAddress,
        secretHash: lock.secretHash,
        refundTimestamp: Number(lock.refundTimestamp),
      },
      expected,
      {
        chainId: leg.chainId,
        adapterAddress: leg.adapterAddress,
        asset: { address: leg.tokenAddress },
      }
    );
    return {
      ...expected,
      funder: address(lock.funder, "lock funder"),
      state: Number(lock.state),
    };
  }

  async reconcile(tradeId) {
    const trade = this.journal.trade(tradeId);
    if (!trade) return null;
    for (const action of trade.actions) {
      if (!["signed", "uncertain"].includes(action.state)) continue;
      const side =
        action.chainId === trade.route.source.chainId ? "source" : "destination";
      const provider = this.providers[side];
      const receipt = await provider.getTransactionReceipt(action.transactionHash);
      if (!receipt) {
        this.journal.markAction(trade.tradeId, action.slot, "uncertain");
        continue;
      }
      const latest = await provider.getBlockNumber();
      const required = trade.route[side].confirmationPolicy.requiredConfirmations;
      const confirmations = latest - Number(receipt.blockNumber) + 1;
      if (confirmations < required) continue;
      this.journal.markAction(
        trade.tradeId,
        action.slot,
        Number(receipt.status) === 1 ? "confirmed" : "reverted",
        serializableReceipt(receipt)
      );
    }
    return this.journal.trade(trade.tradeId);
  }

  async rebroadcastFromOwnerUi(tradeId, slot, confirmed) {
    if (confirmed !== true) {
      throw new FxPhase5CoordinatorError(
        "owner confirmation is required for rebroadcast",
        "OWNER_REQUIRED"
      );
    }
    const trade = this.#approvedTrade(tradeId);
    const action = this.journal.action(trade.tradeId, slot);
    if (!action || !["signed", "uncertain"].includes(action.state)) {
      throw new FxPhase5CoordinatorError(
        "action has no recoverable signed transaction",
        "BAD_STATE"
      );
    }
    const side =
      action.chainId === trade.route.source.chainId ? "source" : "destination";
    await this.providers[side].broadcastTransaction(action.rawTransaction);
    return this.#confirm(trade, side, action.slot, action.transactionHash);
  }

  #trade(tradeId, expectedState) {
    const trade = this.#approvedTrade(tradeId);
    if (trade.state !== expectedState) {
      throw new FxPhase5CoordinatorError(
        `trade must be ${expectedState}, not ${trade.state}`,
        "BAD_STATE"
      );
    }
    return trade;
  }

  #approvedTrade(tradeId) {
    const trade = this.journal.requireOwnerApproved(tradeId);
    this.#assertTradeRoute(trade);
    return trade;
  }

  #assertTradeRoute(trade) {
    if (
      trade.routeId !== this.route.routeId ||
      trade.route?.routeId !== this.route.routeId
    ) {
      throw new FxPhase5CoordinatorError(
        "durable trade belongs to another frozen route",
        "ROUTE_MISMATCH"
      );
    }
    return trade;
  }

  #restoreSecret(trade, password) {
    const restored = restoreFxRecoveryPacket({
      filePath: trade.recoveryFile,
      password,
      deploymentId: trade.route.deploymentId,
      tradeId: trade.tradeId,
    });
    if (restored.secretHash !== trade.secretHash) {
      throw new FxPhase5CoordinatorError(
        "recovery packet does not match the durable trade",
        "RECOVERY_MISMATCH"
      );
    }
    return restored.secret;
  }

  #adapter(side, role) {
    return new Contract(
      this.route[side].adapterAddress,
      ADAPTER_ABI,
      this.signers[side][role]
    );
  }

  async #ensureAllowance(trade, side, role, slot, amount) {
    const leg = trade.route[side];
    const signer = this.signers[side][role];
    const owner = address(await signer.getAddress(), `${side} ${role}`);
    const token = new Contract(leg.tokenAddress, TOKEN_ABI, signer);
    const allowance = await token.allowance(owner, leg.adapterAddress);
    if (allowance >= BigInt(amount)) return null;
    const transaction = await token.approve.populateTransaction(
      leg.adapterAddress,
      amount
    );
    return this.#execute(trade, side, role, slot, transaction);
  }

  async #execute(trade, side, role, slot, request) {
    const existing = this.journal.action(trade.tradeId, slot);
    if (existing?.state === "confirmed") return existing;
    if (existing) {
      throw new FxPhase5CoordinatorError(
        `${slot} requires reconciliation or exact-byte recovery`,
        "RECOVERY_REQUIRED"
      );
    }
    const provider = this.providers[side];
    const signer = this.signers[side][role];
    const signerAddress = await signer.getAddress();
    const [network, nonce, feeData] = await Promise.all([
      provider.getNetwork(),
      provider.getTransactionCount(signerAddress, "pending"),
      provider.getFeeData(),
    ]);
    if (String(network.chainId) !== trade.route[side].chainId) {
      throw new FxPhase5CoordinatorError(
        `${side} provider changed chains`,
        "WRONG_CHAIN"
      );
    }
    const gasLimit = await provider.estimateGas({
      ...request,
      from: signerAddress,
    });
    const transaction = {
      ...request,
      chainId: network.chainId,
      nonce,
      gasLimit,
    };
    let maximumFeePerGas;
    if (feeData.maxFeePerGas != null && feeData.maxPriorityFeePerGas != null) {
      transaction.type = 2;
      transaction.maxFeePerGas = feeData.maxFeePerGas;
      transaction.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
      maximumFeePerGas = feeData.maxFeePerGas;
    } else if (feeData.gasPrice != null) {
      transaction.type = 0;
      transaction.gasPrice = feeData.gasPrice;
      maximumFeePerGas = feeData.gasPrice;
    } else {
      throw new FxPhase5CoordinatorError("provider returned no usable fee quote");
    }
    const maximumNativeFee = gasLimit * maximumFeePerGas;
    const feeLimit = this.maximumNativeFeeByChain[trade.route[side].chainId];
    if (feeLimit !== undefined && maximumNativeFee > feeLimit) {
      throw new FxPhase5CoordinatorError(
        `${slot} exceeds the configured native fee ceiling`,
        "FEE_LIMIT"
      );
    }
    const raw = await signer.signTransaction(transaction);
    const transactionHash = keccak256(raw).toLowerCase();
    this.journal.recordSignedAction({
      tradeId: trade.tradeId,
      slot,
      chainId: network.chainId,
      transactionHash,
      rawTransaction: raw,
    });
    try {
      await provider.broadcastTransaction(raw);
    } catch (error) {
      this.journal.markAction(trade.tradeId, slot, "uncertain");
      throw error;
    }
    return this.#confirm(trade, side, slot, transactionHash);
  }

  async #confirm(trade, side, slot, transactionHash) {
    const confirmations =
      trade.route[side].confirmationPolicy.requiredConfirmations;
    const receipt = await this.providers[side].waitForTransaction(
      transactionHash,
      confirmations,
      this.receiptTimeoutMs
    );
    if (!receipt) {
      this.journal.markAction(trade.tradeId, slot, "uncertain");
      throw new FxPhase5CoordinatorError(
        `${slot} confirmation timed out`,
        "CONFIRMATION_TIMEOUT"
      );
    }
    const state = Number(receipt.status) === 1 ? "confirmed" : "reverted";
    this.journal.markAction(
      trade.tradeId,
      slot,
      state,
      serializableReceipt(receipt)
    );
    if (state === "reverted") {
      throw new FxPhase5CoordinatorError(
        `${slot} reverted`,
        "TRANSACTION_REVERTED"
      );
    }
    return this.journal.action(trade.tradeId, slot);
  }
}

module.exports = {
  ADAPTER_ABI,
  FxPhase5Coordinator,
  FxPhase5CoordinatorError,
  serializableReceipt,
};
