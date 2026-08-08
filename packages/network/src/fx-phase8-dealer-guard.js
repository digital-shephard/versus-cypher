const { getAddress, isAddress } = require("ethers");
const {
  verifyFxEnvelope,
} = require("./fx-protocol");
const {
  verifyDealerNoShowEvidence,
  normalizePhase8Policy,
  verifyPhase8SourceLockPackage,
  verifyRequesterAbandonmentEvidence,
} = require("./fx-phase8-policy");

class FxPhase8DealerGuardError extends Error {
  constructor(message, code = "FX_PHASE8_DEALER_GUARD_ERROR") {
    super(message);
    this.name = "FxPhase8DealerGuardError";
    this.code = code;
  }
}

function same(value, expected, label) {
  if (String(value).toLowerCase() !== String(expected).toLowerCase()) {
    throw new FxPhase8DealerGuardError(
      `${label} does not match the durable trade`,
      "DESTINATION_LOCK_MISMATCH"
    );
  }
}

class FxPhase8DealerGuard {
  constructor({
    journal,
    dealerAddress,
    verifySourceLock,
    verifyDestinationLock,
    readDestinationLock,
    policy = {},
    now = () => Math.floor(Date.now() / 1000),
  } = {}) {
    if (!journal) {
      throw new TypeError("Phase 8 dealer guard requires an exposure journal");
    }
    if (typeof dealerAddress !== "string" || !isAddress(dealerAddress)) {
      throw new TypeError("Phase 8 dealer guard requires its dealer address");
    }
    if (
      typeof verifySourceLock !== "function" ||
      typeof verifyDestinationLock !== "function" ||
      typeof readDestinationLock !== "function"
    ) {
      throw new TypeError(
        "Phase 8 dealer guard requires independent chain readers"
      );
    }
    this.journal = journal;
    this.dealerAddress = getAddress(dealerAddress).toLowerCase();
    this.verifySourceLock = verifySourceLock;
    this.verifyDestinationLock = verifyDestinationLock;
    this.readDestinationLock = readDestinationLock;
    this.policy = normalizePhase8Policy(policy);
    this.now = now;
  }

  async readChain(reader, input, label) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => reader(input)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new FxPhase8DealerGuardError(
            `${label} timed out`,
            "CHAIN_VERIFIER_UNAVAILABLE"
          )), this.policy.chainVerificationTimeoutMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof FxPhase8DealerGuardError) throw error;
      throw new FxPhase8DealerGuardError(
        `${label} failed: ${error?.message || "unknown error"}`,
        "CHAIN_VERIFIER_UNAVAILABLE"
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async firmSource({
    rfq,
    quote,
    accept,
    reserve,
    sourceLock,
    referenceInputAtomic,
    exposureValueMicros,
    requesterGasInputAtomic = "0",
  }) {
    const verified = await verifyPhase8SourceLockPackage({
      rfq,
      quote,
      accept,
      reserve,
      sourceLock,
      referenceInputAtomic,
      exposureValueMicros,
      requesterGasInputAtomic,
      verifyChainLock: this.verifySourceLock,
      policy: this.policy,
      now: this.now(),
    });
    if (verified.quote.sender !== this.dealerAddress) {
      throw new FxPhase8DealerGuardError(
        "accepted quote belongs to another dealer",
        "WRONG_DEALER"
      );
    }
    const trade = this.journal.admitSource(verified);
    return {
      trade,
      destinationPlan: {
        tradeId: trade.tradeId,
        lockId: trade.destinationLockId,
        chainId: verified.route.outputChainId,
        token: verified.route.outputToken,
        amountAtomic: verified.route.outputAmountAtomic,
        beneficiary: verified.accept.payload.destinationClaimAddress,
        refundAddress:
          verified.reserve.payload.dealerDestinationRefundAddress,
        secretHash: verified.accept.payload.secretHash,
        refundTimestamp: trade.destinationRefundTimestamp,
        atomicWithOtherTrades: false,
      },
      verified,
    };
  }

  async confirmDestinationLock(destinationLockEnvelope) {
    const destinationLock = verifyFxEnvelope(destinationLockEnvelope, {
      now: this.now(),
      clockSkewSeconds: 0,
    });
    if (destinationLock.type !== "fx_lock_destination") {
      throw new FxPhase8DealerGuardError(
        "destination confirmation requires fx_lock_destination"
      );
    }
    const trade = this.journal.trade(destinationLock.tradeId);
    if (!trade) {
      throw new FxPhase8DealerGuardError(
        "destination lock has no admitted source lock",
        "SOURCE_NOT_FIRM"
      );
    }
    const { quote, accept, reserve } = trade.package;
    same(destinationLock.deploymentId, trade.deploymentId, "deployment");
    same(destinationLock.sender, trade.dealer, "dealer");
    same(destinationLock.payload.acceptId, accept.id, "accept");
    same(destinationLock.payload.chainId, quote.payload.outputChainId, "chain");
    same(destinationLock.payload.token, quote.payload.outputToken, "token");
    same(
      destinationLock.payload.amountAtomic,
      quote.payload.outputAmountAtomic,
      "amount"
    );
    same(
      destinationLock.payload.beneficiary,
      accept.payload.destinationClaimAddress,
      "beneficiary"
    );
    same(
      destinationLock.payload.refundAddress,
      reserve.payload.dealerDestinationRefundAddress,
      "refund address"
    );
    same(
      destinationLock.payload.secretHash,
      accept.payload.secretHash,
      "secret hash"
    );
    if (destinationLock.payload.timeout !== trade.destinationRefundTimestamp) {
      throw new FxPhase8DealerGuardError(
        "destination timeout does not match the ten-minute durable plan",
        "DESTINATION_LOCK_MISMATCH"
      );
    }
    const chain = await this.readChain(this.verifyDestinationLock, {
      side: "destination",
      lockId: trade.destinationLockId,
      destinationLock,
      trade,
    }, "destination chain verifier");
    if (chain?.confirmed !== true || chain?.canonical !== true) {
      throw new FxPhase8DealerGuardError(
        "destination lock is not independently confirmed",
        "DESTINATION_LOCK_UNCONFIRMED"
      );
    }
    same(chain.lockId, trade.destinationLockId, "chain lock id");
    same(
      chain.transactionHash,
      destinationLock.payload.transactionHash,
      "chain transaction"
    );
    same(chain.chainId, destinationLock.payload.chainId, "chain identity");
    same(chain.token, destinationLock.payload.token, "chain token");
    same(chain.amountAtomic, destinationLock.payload.amountAtomic, "chain amount");
    same(
      chain.beneficiary,
      destinationLock.payload.beneficiary,
      "chain beneficiary"
    );
    same(
      chain.refundAddress,
      destinationLock.payload.refundAddress,
      "chain refund address"
    );
    same(
      chain.secretHash,
      destinationLock.payload.secretHash,
      "chain secret hash"
    );
    if (Number(chain.timeout) !== destinationLock.payload.timeout) {
      throw new FxPhase8DealerGuardError(
        "chain destination timeout is inconsistent",
        "DESTINATION_LOCK_MISMATCH"
      );
    }
    return {
      trade: this.journal.markDestinationLocked(trade.tradeId, {
        lockId: trade.destinationLockId,
        transactionHash: destinationLock.payload.transactionHash,
        timeout: destinationLock.payload.timeout,
      }),
      destinationLock,
      chain,
    };
  }

  markDestinationClaimed(tradeId) {
    return this.journal.markDestinationClaimed(tradeId);
  }

  markCompleted(tradeId, evidence) {
    const evidenceId = evidence?.id || evidence?.evidenceId;
    const trade = this.journal.markTerminal(tradeId, "completed", evidenceId);
    if (evidenceId) {
      this.journal.recordVerifiedOutcome({
        evidenceId,
        tradeId,
        subject: trade.dealer,
        outcome: "completed",
        evidence,
      });
    }
    return trade;
  }

  async recordDealerNoShow(evidence) {
    const verified = await verifyDealerNoShowEvidence(evidence, {
      verifySourceLock: (input) =>
        this.readChain(this.verifySourceLock, input, "source chain verifier"),
      readDestinationLock: (input) =>
        this.readChain(
          this.readDestinationLock,
          input,
          "destination chain reader"
        ),
      policy: this.policy,
    });
    const trade = this.journal.trade(verified.rfq.tradeId);
    if (!trade || trade.package.sourceLock.id !== verified.sourceLock.id) {
      throw new FxPhase8DealerGuardError(
        "dealer no-show does not match a locally admitted source",
        "UNKNOWN_TRADE"
      );
    }
    this.journal.recordVerifiedOutcome({
      evidenceId: verified.evidenceId,
      tradeId: trade.tradeId,
      subject: verified.dealer,
      outcome: "dealer_no_show",
      evidence: verified,
    });
    return this.journal.markTerminal(
      trade.tradeId,
      "dealer_no_show",
      verified.evidenceId
    );
  }

  async recordRequesterAbandonment(evidence) {
    const verified = await verifyRequesterAbandonmentEvidence(evidence, {
      verifySourceLock: (input) =>
        this.readChain(this.verifySourceLock, input, "source chain verifier"),
      readDestinationLock: (input) =>
        this.readChain(
          this.readDestinationLock,
          input,
          "destination chain reader"
        ),
      policy: this.policy,
    });
    const trade = this.journal.trade(verified.rfq.tradeId);
    if (!trade || trade.state !== "destination_locked") {
      throw new FxPhase8DealerGuardError(
        "requester abandonment lacks local destination exposure",
        "UNKNOWN_TRADE"
      );
    }
    this.journal.recordVerifiedOutcome({
      evidenceId: verified.evidenceId,
      tradeId: trade.tradeId,
      subject: verified.requester,
      outcome: "requester_abandoned",
      evidence: verified,
    });
    return this.journal.markTerminal(
      trade.tradeId,
      "destination_refunded",
      verified.evidenceId
    );
  }

  recover() {
    return {
      active: this.journal.activeTrades(),
      exposure: this.journal.exposureSummary(),
    };
  }
}

module.exports = {
  FxPhase8DealerGuard,
  FxPhase8DealerGuardError,
};
