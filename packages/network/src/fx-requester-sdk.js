const crypto = require("node:crypto");
const path = require("node:path");
const {
  getAddress,
  isAddress,
  keccak256,
  toUtf8Bytes,
} = require("ethers");
const {
  canonicalJson,
  FX_V2_VERSION,
  FX_V3_VERSION,
  verifyFxEnvelope,
} = require("./fx-protocol");
const { signFxMessage } = require("./fx-coordination");
const {
  queryBrokerRoutes,
} = require("./fx-broker-service");
const {
  verifyBrokerRouteProposal,
} = require("./fx-broker-protocol");
const {
  createFxRecoveryPacket,
  restoreFxRecoveryPacket,
} = require("./fx-recovery");

const FX_REQUESTER_FUNDING_SCHEMA = "versus-fx-funding-request";
const FX_REQUESTER_RECEIPT_SCHEMA = "versus-fx-funds-ready";
const FX_REQUESTER_VERSION = 1;

class FxRequesterSdkError extends Error {
  constructor(message, code = "FX_REQUESTER_SDK_ERROR") {
    super(message);
    this.name = "FxRequesterSdkError";
    this.code = code;
  }
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FxRequesterSdkError(`${label} must be an object`, "INVALID_REQUEST");
  }
  return value;
}

function address(value, label) {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new FxRequesterSdkError(`${label} must be an EVM address`, "INVALID_REQUEST");
  }
  return getAddress(value).toLowerCase();
}

function hash(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new FxRequesterSdkError(`${label} must be bytes32`, "INVALID_REQUEST");
  }
  return normalized;
}

function uint(value, label) {
  let normalized;
  try {
    normalized = BigInt(value);
  } catch {
    throw new FxRequesterSdkError(`${label} must be an unsigned integer`, "INVALID_REQUEST");
  }
  if (normalized <= 0n || normalized > (1n << 256n) - 1n) {
    throw new FxRequesterSdkError(`${label} must be greater than zero`, "INVALID_REQUEST");
  }
  return normalized.toString();
}

function timestamp(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new FxRequesterSdkError(`${label} must be a positive timestamp`, "INVALID_REQUEST");
  }
  return normalized;
}

function parseEvmNetwork(value) {
  const match = /^eip155:([1-9][0-9]*)$/.exec(String(value || ""));
  if (!match) {
    throw new FxRequesterSdkError(
      "Phase 9 supports EVM x402 funding requirements only",
      "UNSUPPORTED_NETWORK"
    );
  }
  return String(BigInt(match[1]));
}

function selectX402Requirement(input) {
  const challenge = object(input, "x402 challenge");
  if (Array.isArray(challenge.accepts)) {
    const candidate = challenge.accepts.find((item) =>
      item && typeof item === "object" && /^eip155:/.test(String(item.network || ""))
    );
    if (!candidate) {
      throw new FxRequesterSdkError(
        "x402 challenge has no supported EVM requirement",
        "UNSUPPORTED_NETWORK"
      );
    }
    return object(candidate, "x402 requirement");
  }
  return challenge;
}

function parseX402FundingRequirement(input) {
  const requirement = selectX402Requirement(input);
  const chainId = parseEvmNetwork(requirement.network);
  const token = address(requirement.asset, "x402 asset");
  const amountAtomic = uint(requirement.amount, "x402 amount");
  const x402Version = Number(requirement.x402Version ?? 2);
  if (!Number.isSafeInteger(x402Version) || x402Version < 1) {
    throw new FxRequesterSdkError("x402 version is invalid", "INVALID_REQUEST");
  }
  if (typeof requirement.scheme !== "string" || !requirement.scheme.trim()) {
    throw new FxRequesterSdkError("x402 scheme is required", "INVALID_REQUEST");
  }

  // This digest stays local. The endpoint, resource, and payTo fields never
  // enter the RFQ or the returned public funding specification.
  const localRequirementDigest = keccak256(
    toUtf8Bytes(canonicalJson(requirement))
  );
  return {
    schema: FX_REQUESTER_FUNDING_SCHEMA,
    schemaVersion: FX_REQUESTER_VERSION,
    source: "x402",
    x402Version,
    scheme: requirement.scheme.trim(),
    outputChainId: chainId,
    outputToken: token,
    outputAmountAtomic: amountAtomic,
    localRequirementDigest,
  };
}

function parseX402PaymentRequiredHeader(value) {
  let challenge;
  try {
    challenge = JSON.parse(
      Buffer.from(String(value || ""), "base64").toString("utf8")
    );
  } catch {
    throw new FxRequesterSdkError(
      "PAYMENT-REQUIRED is not valid base64 JSON",
      "INVALID_REQUEST"
    );
  }
  return parseX402FundingRequirement(challenge);
}

function parseManualFundingRequirement(input) {
  const requirement = object(input, "manual funding requirement");
  const normalized = {
    schema: FX_REQUESTER_FUNDING_SCHEMA,
    schemaVersion: FX_REQUESTER_VERSION,
    source: "manual",
    outputChainId: uint(requirement.outputChainId, "outputChainId"),
    outputToken: address(requirement.outputToken, "outputToken"),
    outputAmountAtomic: uint(requirement.outputAmountAtomic, "outputAmountAtomic"),
  };
  return {
    ...normalized,
    localRequirementDigest: keccak256(
      toUtf8Bytes(canonicalJson(normalized))
    ),
  };
}

function normalizeFundingRequirement(input) {
  if (
    input?.source === "manual" ||
    (
      input?.outputChainId !== undefined &&
      input?.outputToken !== undefined &&
      input?.outputAmountAtomic !== undefined &&
      input?.network === undefined &&
      input?.accepts === undefined
    )
  ) {
    return parseManualFundingRequirement(input);
  }
  return parseX402FundingRequirement(input);
}

function normalizeInputOptions(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 16) {
    throw new FxRequesterSdkError(
      "inputOptions must contain 1 to 16 assets",
      "INVALID_REQUEST"
    );
  }
  const normalized = input.map((option, index) => {
    object(option, `inputOptions[${index}]`);
    return {
      chainId: uint(option.chainId, `inputOptions[${index}].chainId`),
      token: address(option.token, `inputOptions[${index}].token`),
      maxInputAtomic: uint(
        option.maxInputAtomic,
        `inputOptions[${index}].maxInputAtomic`
      ),
    };
  });
  const identities = normalized.map((option) => `${option.chainId}:${option.token}`);
  if (new Set(identities).size !== identities.length) {
    throw new FxRequesterSdkError("inputOptions contains duplicate assets", "INVALID_REQUEST");
  }
  return normalized;
}

function sanitizeFundingQuote({
  funding,
  destinationAddress,
  sourceRefundAddress,
  rfq,
  comparison,
}) {
  const proposal = verifyBrokerRouteProposal(comparison.selected, {
    deploymentId: rfq.deploymentId,
    rfqId: rfq.id,
    temporal: false,
  });
  if (
    proposal.rfq.payload.outputChainId !== funding.outputChainId ||
    proposal.rfq.payload.outputToken !== funding.outputToken ||
    proposal.rfq.payload.outputAmountAtomic !== funding.outputAmountAtomic
  ) {
    throw new FxRequesterSdkError(
      "broker proposal does not satisfy the funding requirement",
      "OUTPUT_MISMATCH"
    );
  }
  return {
    schema: FX_REQUESTER_FUNDING_SCHEMA,
    schemaVersion: FX_REQUESTER_VERSION,
    tradeId: rfq.tradeId,
    requester: rfq.sender,
    sourceFundingAddress: rfq.sender,
    sourceRefundAddress,
    destinationAddress,
    outputChainId: funding.outputChainId,
    outputToken: funding.outputToken,
    outputAmountAtomic: funding.outputAmountAtomic,
    localRequirementDigest: funding.localRequirementDigest,
    rfq,
    proposal,
    brokerAttempts: comparison.attempts.map((attempt) => ({
      endpoint: attempt.endpoint,
      ok: attempt.ok,
      latencyMs: attempt.latencyMs,
      status: attempt.status,
      error: attempt.error,
      proposalId: attempt.proposal?.proposalId,
    })),
    endpointPaymentAuthorized: false,
  };
}

function normalizeDestinationObservation(observation, expected) {
  object(observation, "destination observation");
  if (observation.confirmed !== true) {
    throw new FxRequesterSdkError(
      "destination funds are not independently confirmed",
      "DESTINATION_UNCONFIRMED"
    );
  }
  const normalized = {
    confirmed: true,
    chainId: String(BigInt(observation.chainId)),
    token: address(observation.token, "destination observation token"),
    amountAtomic: uint(observation.amountAtomic, "destination observation amount"),
    beneficiary: address(
      observation.beneficiary,
      "destination observation beneficiary"
    ),
    transactionHash: hash(
      observation.transactionHash,
      "destination observation transactionHash"
    ),
    blockNumber: String(BigInt(observation.blockNumber)),
    confirmations: Number(observation.confirmations),
  };
  if (
    normalized.chainId !== expected.outputChainId ||
    normalized.token !== expected.outputToken ||
    BigInt(normalized.amountAtomic) < BigInt(expected.outputAmountAtomic) ||
    normalized.beneficiary !== expected.destinationAddress
  ) {
    throw new FxRequesterSdkError(
      "destination observation does not match the requester-bound output",
      "DESTINATION_MISMATCH"
    );
  }
  if (
    !Number.isSafeInteger(normalized.confirmations) ||
    normalized.confirmations < 1
  ) {
    throw new FxRequesterSdkError(
      "destination observation has no confirmations",
      "DESTINATION_UNCONFIRMED"
    );
  }
  return normalized;
}

function createFundsReadyReceipt({
  quote,
  observation,
  confirmedAt,
}) {
  const core = {
    schema: FX_REQUESTER_RECEIPT_SCHEMA,
    schemaVersion: FX_REQUESTER_VERSION,
    status: "funds_ready",
    tradeId: quote.tradeId,
    proposalId: quote.proposal.proposalId,
    requester: quote.requester,
    destinationAddress: quote.destinationAddress,
    outputChainId: quote.outputChainId,
    outputToken: quote.outputToken,
    requiredAmountAtomic: quote.outputAmountAtomic,
    observedAmountAtomic: observation.amountAtomic,
    destinationTransactionHash: observation.transactionHash,
    destinationBlockNumber: observation.blockNumber,
    confirmations: observation.confirmations,
    confirmedAt,
    endpointPaymentAuthorized: false,
    endpointPaymentSubmitted: false,
  };
  return {
    ...core,
    receiptId: keccak256(toUtf8Bytes(canonicalJson(core))),
  };
}

class FxRequesterFundingSdk {
  constructor({
    deploymentId,
    signer,
    brokerEndpoints,
    recoveryDirectory,
    settlementExecutor,
    destinationVerifier,
    queryRoutes = queryBrokerRoutes,
    now = () => Math.floor(Date.now() / 1000),
    randomSecret = () => crypto.randomBytes(32),
    protocolVersion = 1,
  } = {}) {
    this.deploymentId = hash(deploymentId, "deploymentId");
    if (
      !signer ||
      typeof signer.getAddress !== "function" ||
      typeof signer.signMessage !== "function"
    ) {
      throw new TypeError("requester SDK requires a wallet-compatible signer");
    }
    if (!Array.isArray(brokerEndpoints) || brokerEndpoints.length < 1) {
      throw new TypeError("requester SDK requires at least one broker endpoint");
    }
    if (typeof recoveryDirectory !== "string" || !recoveryDirectory.trim()) {
      throw new TypeError("requester SDK requires a recovery directory");
    }
    if (typeof settlementExecutor !== "function") {
      throw new TypeError("requester SDK requires a settlement executor");
    }
    if (typeof destinationVerifier !== "function") {
      throw new TypeError("requester SDK requires an independent destination verifier");
    }
    this.signer = signer;
    this.brokerEndpoints = [...brokerEndpoints];
    this.recoveryDirectory = path.resolve(recoveryDirectory);
    this.settlementExecutor = settlementExecutor;
    this.destinationVerifier = destinationVerifier;
    this.queryRoutes = queryRoutes;
    this.now = now;
    this.randomSecret = randomSecret;
    this.protocolVersion = Number(protocolVersion);
    if (![1, FX_V2_VERSION, FX_V3_VERSION].includes(this.protocolVersion)) {
      throw new TypeError("requester SDK protocol version is unsupported");
    }
  }

  async quoteFunding({
    requirement,
    destinationAddress,
    sourceRefundAddress,
    inputOptions,
    tradeId = `0x${crypto.randomBytes(32).toString("hex")}`,
    quoteLifetimeSeconds =
      [FX_V2_VERSION, FX_V3_VERSION].includes(this.protocolVersion) ? 120 : 60,
    settlementLifetimeSeconds = 7_200,
    quotePolicy = "lowest_all_in",
    timeoutMs = 20_000,
    inputChainId,
    inputToken,
  } = {}) {
    const funding = normalizeFundingRequirement(requirement);
    const requester = address(await this.signer.getAddress(), "requester signer");
    const destination = address(destinationAddress, "destinationAddress");
    const refundAddress = address(
      sourceRefundAddress || destination,
      "sourceRefundAddress"
    );
    if ((inputChainId === undefined) !== (inputToken === undefined)) {
      throw new FxRequesterSdkError(
        "inputChainId and inputToken must be selected together",
        "INVALID_REQUEST"
      );
    }
    const createdAt = timestamp(this.now(), "network time");
    const lifetime = Number(quoteLifetimeSeconds);
    const settlementLifetime = Number(settlementLifetimeSeconds);
    if (
      !Number.isSafeInteger(lifetime) ||
      lifetime < 10 ||
      lifetime > 300 ||
      !Number.isSafeInteger(settlementLifetime) ||
      settlementLifetime <= lifetime ||
      settlementLifetime > 86_400
    ) {
      throw new FxRequesterSdkError("request lifetimes are unsafe", "INVALID_REQUEST");
    }
    const rfq = await signFxMessage({
      protocol: "versus-fx",
      version: this.protocolVersion,
      deploymentId: this.deploymentId,
      type: "fx_rfq",
      tradeId: hash(tradeId, "tradeId"),
      role: "requester",
      sequence: "1",
      createdAt,
      expiresAt: createdAt + lifetime,
      payload: {
        outputChainId: funding.outputChainId,
        outputToken: funding.outputToken,
        outputAmountAtomic: funding.outputAmountAtomic,
        inputOptions: normalizeInputOptions(inputOptions),
        quoteDeadline: createdAt + lifetime - 5,
        settlementDeadline: createdAt + settlementLifetime,
        quotePolicy,
        x402Commitment: null,
      },
    }, this.signer);
    const comparison = await this.queryRoutes({
      endpoints: this.brokerEndpoints,
      rfq,
      timeoutMs,
      now: this.now,
      inputChainId,
      inputToken,
    });
    return sanitizeFundingQuote({
      funding,
      destinationAddress: destination,
      sourceRefundAddress: refundAddress,
      rfq,
      comparison,
    });
  }

  async prepareExternalFunding({
    quote,
    recoveryPassword,
    ownerApproved,
  } = {}) {
    if (ownerApproved !== true) {
      throw new FxRequesterSdkError(
        "explicit requester approval is required",
        "OWNER_REQUIRED"
      );
    }
    const verifiedRfq = verifyFxEnvelope(quote?.rfq, { temporal: false });
    if (verifiedRfq.version !== this.protocolVersion) {
      throw new FxRequesterSdkError(
        "funding quote uses another protocol version",
        "PROTOCOL_VERSION_MISMATCH"
      );
    }
    const proposal = verifyBrokerRouteProposal(quote?.proposal, {
      now: timestamp(this.now(), "network time"),
      deploymentId: this.deploymentId,
      rfqId: verifiedRfq.id,
    });
    const signerAddress = address(await this.signer.getAddress(), "requester signer");
    const destinationAddress = address(quote.destinationAddress, "destinationAddress");
    const sourceRefundAddress = address(
      quote.sourceRefundAddress,
      "sourceRefundAddress"
    );
    if (
      verifiedRfq.sender !== signerAddress ||
      address(quote.requester, "requester") !== signerAddress ||
      address(quote.sourceFundingAddress, "sourceFundingAddress") !== signerAddress
    ) {
      throw new FxRequesterSdkError(
        "funding quote is not bound to this requester identity",
        "REQUESTER_MISMATCH"
      );
    }
    if (
      proposal.rfq.payload.outputChainId !== String(quote.outputChainId) ||
      proposal.rfq.payload.outputToken !== address(quote.outputToken, "outputToken") ||
      proposal.rfq.payload.outputAmountAtomic !== uint(
        quote.outputAmountAtomic,
        "outputAmountAtomic"
      )
    ) {
      throw new FxRequesterSdkError(
        "funding quote output changed after route selection",
        "OUTPUT_MISMATCH"
      );
    }

    const recoveryFile = path.join(
      this.recoveryDirectory,
      `${verifiedRfq.tradeId.slice(2)}.recovery.json`
    );
    // V1 and V3 use this durable requester-owned settlement secret. V2 stores
    // only a requester-local recovery nonce because its dealer owns the secret.
    const recovery = createFxRecoveryPacket({
      filePath: recoveryFile,
      password: recoveryPassword,
      deploymentId: this.deploymentId,
      tradeId: verifiedRfq.tradeId,
      createdAt: timestamp(this.now(), "network time"),
      secret: this.randomSecret(),
      metadata: {
        phase:
          this.protocolVersion === FX_V3_VERSION
            ? "fx-v3"
            : this.protocolVersion === FX_V2_VERSION
              ? "fx-v2"
              : 9,
        proposalId: proposal.proposalId,
        purpose:
          this.protocolVersion === FX_V2_VERSION
            ? "requester-recovery-authentication"
            : "settlement-secret",
      },
    });
    const selectedQuote = proposal.quotes.find(
      (candidate) => candidate.id === proposal.route.quoteId
    );
    if (!selectedQuote) {
      throw new FxRequesterSdkError(
        "selected dealer quote is missing from the broker proposal",
        "ROUTE_MISMATCH"
      );
    }
    const acceptedAt = timestamp(this.now(), "network time");
    const acceptanceExpiresAt = Math.min(
      verifiedRfq.payload.settlementDeadline,
      acceptedAt + 600
    );
    if (acceptanceExpiresAt <= acceptedAt) {
      throw new FxRequesterSdkError(
        "settlement deadline has expired",
        "EXPIRED_PROPOSAL"
      );
    }
    const acceptance = await signFxMessage({
      protocol: "versus-fx",
      version: this.protocolVersion,
      deploymentId: this.deploymentId,
      type: "fx_accept",
      tradeId: verifiedRfq.tradeId,
      role: "requester",
      sequence: "2",
      createdAt: acceptedAt,
      expiresAt: acceptanceExpiresAt,
      payload: {
        rfqId: verifiedRfq.id,
        quoteId: proposal.route.quoteId,
        routeId: proposal.route.routeId,
        dealerInputAmountAtomic: selectedQuote.payload.inputAmountAtomic,
        brokerFeeAtomic: proposal.route.brokerFeeAtomic,
        totalInputAtomic: proposal.route.totalInputAtomic,
        outputAmountAtomic: proposal.route.outputAmountAtomic,
        secretHash:
          this.protocolVersion === FX_V2_VERSION
            ? selectedQuote.payload.secretHash
            : recovery.secretHash,
        sourceRefundAddress,
        destinationClaimAddress: destinationAddress,
        sourceAdapterId:
          selectedQuote.payload.sourceAdapterId || selectedQuote.payload.adapterId,
        sourceAdapterVersion:
          selectedQuote.payload.sourceAdapterVersion ||
          selectedQuote.payload.adapterVersion,
        destinationAdapterId:
          selectedQuote.payload.destinationAdapterId ||
          selectedQuote.payload.adapterId,
        destinationAdapterVersion:
          selectedQuote.payload.destinationAdapterVersion ||
          selectedQuote.payload.adapterVersion,
      },
    }, this.signer);
    const expected = {
      tradeId: verifiedRfq.tradeId,
      proposalId: proposal.proposalId,
      requester: signerAddress,
      destinationAddress,
      outputChainId: proposal.route.outputChainId,
      outputToken: proposal.route.outputToken,
      outputAmountAtomic: proposal.route.outputAmountAtomic,
    };
    return {
      schema: "versus-fx-external-funding",
      schemaVersion: FX_REQUESTER_VERSION,
      tradeId: verifiedRfq.tradeId,
      requester: signerAddress,
      proposal,
      acceptance,
      sourceFundingAddress: signerAddress,
      sourceRefundAddress,
      destinationAddress,
      inputChainId: proposal.route.inputChainId,
      inputToken: proposal.route.inputToken,
      inputAmountAtomic: proposal.route.totalInputAtomic,
      outputChainId: proposal.route.outputChainId,
      outputToken: proposal.route.outputToken,
      outputAmountAtomic: proposal.route.outputAmountAtomic,
      recoveryFile: recovery.filePath,
      secretHash:
        this.protocolVersion === FX_V2_VERSION
          ? selectedQuote.payload.secretHash
          : recovery.secretHash,
      expected,
      endpointPaymentAuthorized: false,
      endpointPaymentSubmitted: false,
    };
  }

  async executePreparedFunding({
    prepared,
    recoveryPassword,
  } = {}) {
    object(prepared, "prepared funding");
    const networkNow = timestamp(this.now(), "network time");
    const acceptance = verifyFxEnvelope(prepared.acceptance, {
      now: networkNow,
      clockSkewSeconds: 0,
    });
    if (acceptance.version !== this.protocolVersion) {
      throw new FxRequesterSdkError(
        "prepared funding uses another protocol version",
        "PROTOCOL_VERSION_MISMATCH"
      );
    }
    const proposal = verifyBrokerRouteProposal(prepared.proposal, {
      now: acceptance.createdAt,
      deploymentId: this.deploymentId,
      rfqId: acceptance.payload.rfqId,
    });
    const selectedQuote = proposal.quotes.find(
      (candidate) => candidate.id === proposal.route.quoteId
    );
    if (!selectedQuote) {
      throw new FxRequesterSdkError(
        "accepted route has no dealer quote",
        "ROUTE_MISMATCH"
      );
    }
    let reservation = null;
    if (prepared.reservation) {
      reservation = verifyFxEnvelope(prepared.reservation, {
        now: networkNow,
        clockSkewSeconds: 0,
      });
      if (
        reservation.type !== "fx_reserve" ||
        reservation.tradeId !== acceptance.tradeId ||
        reservation.sender !== selectedQuote.sender ||
        reservation.payload.acceptId !== acceptance.id ||
        reservation.payload.quoteId !== selectedQuote.id ||
        reservation.payload.reservationDeadline < networkNow
      ) {
        throw new FxRequesterSdkError(
          "dealer reservation does not match the accepted route",
          "RESERVATION_MISMATCH"
        );
      }
    }
    const signerAddress = address(await this.signer.getAddress(), "requester signer");
    if (
      address(prepared.requester, "prepared requester") !== signerAddress ||
      address(prepared.sourceFundingAddress, "sourceFundingAddress") !== signerAddress ||
      acceptance.sender !== signerAddress ||
      acceptance.payload.routeId !== proposal.route.routeId ||
      acceptance.payload.secretHash !== hash(prepared.secretHash, "secretHash")
    ) {
      throw new FxRequesterSdkError(
        "prepared funding no longer matches its signed order",
        "PREPARED_FUNDING_MISMATCH"
      );
    }
    const recovery = restoreFxRecoveryPacket({
      filePath: prepared.recoveryFile,
      password: recoveryPassword,
      deploymentId: this.deploymentId,
      tradeId: prepared.tradeId,
    });
    const expected = {
      tradeId: prepared.tradeId,
      proposalId: proposal.proposalId,
      requester: signerAddress,
      destinationAddress: address(
        prepared.destinationAddress,
        "destinationAddress"
      ),
      outputChainId: String(prepared.outputChainId),
      outputToken: address(prepared.outputToken, "outputToken"),
      outputAmountAtomic: uint(
        prepared.outputAmountAtomic,
        "outputAmountAtomic"
      ),
    };
    const settlement = await this.settlementExecutor({
      proposal,
      acceptance,
      reserve: reservation,
      requester: signerAddress,
      destinationAddress: expected.destinationAddress,
      sourceFundingAddress: signerAddress,
      sourceRefundAddress: address(
        prepared.sourceRefundAddress,
        "sourceRefundAddress"
      ),
      secret:
        acceptance.version === FX_V2_VERSION ? null : recovery.secret,
      secretHash: acceptance.payload.secretHash,
      recoveryFile: prepared.recoveryFile,
    });
    const observation = normalizeDestinationObservation(
      await this.destinationVerifier({ settlement, expected, proposal }),
      expected
    );
    const receipt = createFundsReadyReceipt({
      quote: {
        ...expected,
        proposal,
      },
      observation,
      confirmedAt: timestamp(this.now(), "network time"),
    });
    return {
      fundsReady: true,
      receipt,
      recoveryFile: prepared.recoveryFile,
      endpointPaymentAuthorized: false,
    };
  }

  async executeFunding({
    quote,
    recoveryPassword,
    ownerApproved,
  } = {}) {
    const prepared = await this.prepareExternalFunding({
      quote,
      recoveryPassword,
      ownerApproved,
    });
    return this.executePreparedFunding({
      prepared,
      recoveryPassword,
    });
  }

  async recoverFunding({
    quote,
    recoveryPassword,
    settlement,
  } = {}) {
    const verifiedRfq = verifyFxEnvelope(quote?.rfq, { temporal: false });
    const proposal = verifyBrokerRouteProposal(quote?.proposal, {
      deploymentId: this.deploymentId,
      rfqId: verifiedRfq.id,
      temporal: false,
    });
    const signerAddress = address(await this.signer.getAddress(), "requester signer");
    const destinationAddress = address(quote.destinationAddress, "destinationAddress");
    if (
      verifiedRfq.sender !== signerAddress ||
      address(quote.requester, "requester") !== signerAddress ||
      address(quote.sourceFundingAddress, "sourceFundingAddress") !== signerAddress
    ) {
      throw new FxRequesterSdkError(
        "recovery quote is not bound to this requester identity",
        "REQUESTER_MISMATCH"
      );
    }
    if (
      proposal.rfq.payload.outputChainId !== String(quote.outputChainId) ||
      proposal.rfq.payload.outputToken !== address(quote.outputToken, "outputToken") ||
      proposal.rfq.payload.outputAmountAtomic !== uint(
        quote.outputAmountAtomic,
        "outputAmountAtomic"
      )
    ) {
      throw new FxRequesterSdkError(
        "recovery quote output does not match its signed proposal",
        "OUTPUT_MISMATCH"
      );
    }
    const recoveryFile = path.join(
      this.recoveryDirectory,
      `${verifiedRfq.tradeId.slice(2)}.recovery.json`
    );
    restoreFxRecoveryPacket({
      filePath: recoveryFile,
      password: recoveryPassword,
      deploymentId: this.deploymentId,
      tradeId: verifiedRfq.tradeId,
    });
    const expected = {
      tradeId: verifiedRfq.tradeId,
      proposalId: proposal.proposalId,
      requester: signerAddress,
      destinationAddress,
      outputChainId: proposal.route.outputChainId,
      outputToken: proposal.route.outputToken,
      outputAmountAtomic: proposal.route.outputAmountAtomic,
    };
    const observation = normalizeDestinationObservation(
      await this.destinationVerifier({
        settlement,
        expected,
        proposal,
        recovery: true,
      }),
      expected
    );
    return {
      fundsReady: true,
      receipt: createFundsReadyReceipt({
        quote: {
          ...expected,
          proposal,
        },
        observation,
        confirmedAt: timestamp(this.now(), "network time"),
      }),
      recoveryFile,
      endpointPaymentAuthorized: false,
    };
  }
}

module.exports = {
  FX_REQUESTER_FUNDING_SCHEMA,
  FX_REQUESTER_RECEIPT_SCHEMA,
  FX_REQUESTER_VERSION,
  FxRequesterFundingSdk,
  FxRequesterSdkError,
  createFundsReadyReceipt,
  normalizeFundingRequirement,
  parseManualFundingRequirement,
  parseX402PaymentRequiredHeader,
  parseX402FundingRequirement,
};
