const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  Interface,
  Transaction,
  getAddress,
  isAddress,
  keccak256,
  toUtf8Bytes,
} = require("ethers");
const {
  canonicalJson,
  FX_NATIVE_ETH_ADDRESS,
  FX_V3_VERSION,
  verifyFxEnvelope,
} = require("./fx-protocol");
const { signFxMessage } = require("./fx-coordination");
const {
  verifyBrokerRouteProposal,
} = require("./fx-broker-protocol");
const {
  phase5LockId,
} = require("./fx-phase5-route");
const {
  selectEvmV3Capability,
  validateEvmV3Manifest,
} = require("./fx-evm-v3-adapter");
const {
  createFxRecoveryPacket,
} = require("./fx-recovery");
const {
  PAYMENT_REQUIRED,
  PAYMENT_RESPONSE,
  PAYMENT_SIGNATURE,
  base64Json,
  parseBase64Json,
} = require("./fx-x402-fixture");

const FX_X402_SWAP_SCHEME = "versus-atomic-fx-v3";
const FX_X402_SWAP_SCHEMA = "versus-x402-atomic-swap";
const FX_X402_SWAP_VERSION = 1;
const FX_X402_MAX_BODY_BYTES = 256 * 1024;
const UINT96_MAX = (1n << 96n) - 1n;

const NATIVE_INTERFACE = new Interface([
  "function fund(bytes32 tradeId,address beneficiary,bytes32 secretHash,uint256 settlement) payable",
]);
const ERC20_INTERFACE = new Interface([
  "function fund(bytes32 tradeId,address beneficiary,bytes32 secretHash,uint256 settlement)",
]);
const TOKEN_INTERFACE = new Interface([
  "function allowance(address owner,address spender) view returns (uint256)",
]);

class FxX402SwapError extends Error {
  constructor(message, code = "FX_X402_SWAP_ERROR") {
    super(message);
    this.name = "FxX402SwapError";
    this.code = code;
  }
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FxX402SwapError(`${label} must be an object`, "INVALID_REQUEST");
  }
  return value;
}

function address(value, label) {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new FxX402SwapError(`${label} must be an EVM address`, "INVALID_REQUEST");
  }
  return getAddress(value).toLowerCase();
}

function hash(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new FxX402SwapError(`${label} must be bytes32`, "INVALID_REQUEST");
  }
  return normalized;
}

function uint(value, label, { allowZero = false } = {}) {
  let normalized;
  try {
    normalized = BigInt(value);
  } catch {
    throw new FxX402SwapError(`${label} must be an unsigned integer`, "INVALID_REQUEST");
  }
  if (normalized < 0n || (!allowZero && normalized === 0n)) {
    throw new FxX402SwapError(`${label} is outside its supported range`, "INVALID_REQUEST");
  }
  return normalized;
}

function integer(value, label, minimum = 0) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum) {
    throw new FxX402SwapError(`${label} is outside its supported range`, "INVALID_REQUEST");
  }
  return normalized;
}

function canonicalAsset(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "native:eth" || normalized === FX_NATIVE_ETH_ADDRESS) {
    return FX_NATIVE_ETH_ADDRESS;
  }
  return address(value, "asset");
}

function x402SwapIntent({
  inputChainId,
  inputToken,
  outputChainId,
  outputToken,
  outputAmountAtomic,
  destinationAddress,
  sourceRefundAddress,
  secretHash,
}) {
  return {
    schema: FX_X402_SWAP_SCHEMA,
    schemaVersion: FX_X402_SWAP_VERSION,
    inputChainId: String(BigInt(inputChainId)),
    inputToken: canonicalAsset(inputToken),
    outputChainId: String(BigInt(outputChainId)),
    outputToken: canonicalAsset(outputToken),
    outputAmountAtomic: uint(
      outputAmountAtomic,
      "outputAmountAtomic"
    ).toString(),
    destinationAddress: address(destinationAddress, "destinationAddress"),
    sourceRefundAddress: address(sourceRefundAddress, "sourceRefundAddress"),
    secretHash: hash(secretHash, "secretHash"),
  };
}

function x402SwapCommitment(intent) {
  return keccak256(toUtf8Bytes(canonicalJson(intent)));
}

function packSettlementV3(refundTimestamp, beneficiaryAmount, executorAmount = 0n) {
  const timeout = BigInt(integer(refundTimestamp, "refundTimestamp", 1));
  const beneficiary = uint(beneficiaryAmount, "beneficiaryAmount");
  const executor = uint(executorAmount, "executorAmount", { allowZero: true });
  if (beneficiary > UINT96_MAX || executor > UINT96_MAX) {
    throw new FxX402SwapError(
      "V3 compact settlement amount exceeds uint96",
      "AMOUNT_TOO_LARGE"
    );
  }
  return (timeout << 192n) | (beneficiary << 96n) | executor;
}

function sourceFundingSpecification({
  manifest,
  proposal,
  acceptance,
  reservation,
  sourceChainTimestamp,
  sourceRefundTimestamp,
}) {
  const route = proposal.route;
  const selectedQuote = proposal.quotes.find(
    (candidate) => candidate.id === route.quoteId
  );
  if (!selectedQuote) {
    throw new FxX402SwapError(
      "selected quote is absent from the broker proposal",
      "QUOTE_MISMATCH"
    );
  }
  const capability = selectEvmV3Capability(manifest, {
    chainId: route.inputChainId,
    token: route.inputToken,
  });
  const adapterId = manifest.builds[capability.kind].adapterId;
  const sourceNow = integer(
    sourceChainTimestamp,
    "sourceChainTimestamp",
    1
  );
  const sourceTimeout = integer(
    sourceRefundTimestamp,
    "sourceRefundTimestamp",
    sourceNow + 1
  );
  const sourceDuration = sourceTimeout - sourceNow;
  if (
    sourceDuration < capability.policy.timeoutPolicy.minimumSeconds ||
    sourceDuration > capability.policy.timeoutPolicy.maximumSeconds
  ) {
    throw new FxX402SwapError(
      "source timeout violates the frozen V3 adapter policy",
      "BAD_TIMEOUT"
    );
  }
  if (
    acceptance.version !== FX_V3_VERSION ||
    reservation.version !== FX_V3_VERSION ||
    Number(selectedQuote.payload.sourceAdapterVersion) !== FX_V3_VERSION ||
    selectedQuote.payload.sourceAdapterId !== adapterId
  ) {
    throw new FxX402SwapError(
      "selected route is not bound to the frozen V3 source adapter",
      "ADAPTER_MISMATCH"
    );
  }
  const amount = uint(route.totalInputAtomic, "route total input");
  const settlement = packSettlementV3(sourceTimeout, amount, 0n);
  const lockId = phase5LockId(acceptance.tradeId, "source");
  const beneficiary = reservation.payload.dealerSourceClaimAddress;
  const iface = capability.kind === "native" ? NATIVE_INTERFACE : ERC20_INTERFACE;
  const data = iface.encodeFunctionData("fund(bytes32,address,bytes32,uint256)", [
    lockId,
    beneficiary,
    acceptance.payload.secretHash,
    settlement,
  ]);
  return {
    schema: FX_X402_SWAP_SCHEMA,
    schemaVersion: FX_X402_SWAP_VERSION,
    stage: "fund",
    tradeId: acceptance.tradeId,
    acceptanceId: acceptance.id,
    reservationId: reservation.id,
    chainId: route.inputChainId,
    asset: route.inputToken,
    amountAtomic: amount.toString(),
    adapterId,
    adapterVersion: FX_V3_VERSION,
    adapterAddress: capability.adapterAddress,
    lockId,
    beneficiary,
    refundAddress: acceptance.payload.sourceRefundAddress,
    secretHash: acceptance.payload.secretHash,
    refundTimestamp: sourceTimeout,
    requiredConfirmations:
      capability.policy.confirmationPolicy.requiredConfirmations,
    beneficiaryAmountAtomic: amount.toString(),
    executorAmountAtomic: "0",
    transaction: {
      to: capability.adapterAddress,
      data,
      value: capability.kind === "native" ? amount.toString() : "0",
    },
  };
}

function verifySignedSourceFundingTransaction(rawTransaction, specification) {
  object(specification, "source funding specification");
  let transaction;
  try {
    transaction = Transaction.from(String(rawTransaction || ""));
  } catch {
    throw new FxX402SwapError(
      "PAYMENT-SIGNATURE does not contain a signed EVM transaction",
      "INVALID_SOURCE_TRANSACTION"
    );
  }
  if (!transaction.signature || !transaction.from) {
    throw new FxX402SwapError(
      "source funding transaction is unsigned",
      "INVALID_SOURCE_TRANSACTION"
    );
  }
  const expected = specification.transaction;
  if (
    String(transaction.chainId) !== String(specification.chainId) ||
    address(transaction.from, "transaction signer") !==
      address(specification.refundAddress, "source refund address") ||
    address(transaction.to, "transaction recipient") !==
      address(expected.to, "source adapter") ||
    String(transaction.data || "0x").toLowerCase() !==
      String(expected.data).toLowerCase() ||
    BigInt(transaction.value || 0) !== BigInt(expected.value)
  ) {
    throw new FxX402SwapError(
      "signed source transaction does not match the reserved V3 lock",
      "SOURCE_TRANSACTION_MISMATCH"
    );
  }
  if (transaction.type === 3 || transaction.blobVersionedHashes?.length) {
    throw new FxX402SwapError(
      "blob transactions are unsupported for source funding",
      "INVALID_SOURCE_TRANSACTION"
    );
  }
  return {
    rawTransaction: transaction.serialized,
    transactionHash: transaction.hash.toLowerCase(),
    from: transaction.from.toLowerCase(),
    nonce: transaction.nonce,
  };
}

function verifyAcceptanceForSwap({
  acceptance,
  state,
  now,
}) {
  const verified = verifyFxEnvelope(acceptance, {
    now,
    clockSkewSeconds: 0,
  });
  const proposal = verifyBrokerRouteProposal(state.proposal, {
    now,
    deploymentId: state.rfq.deploymentId,
    rfqId: state.rfq.id,
  });
  const route = proposal.route;
  const quote = proposal.quotes.find(
    (candidate) => candidate.id === route.quoteId
  );
  if (
    !quote ||
    verified.type !== "fx_accept" ||
    verified.version !== FX_V3_VERSION ||
    verified.tradeId !== state.tradeId ||
    verified.sender !== state.rfq.sender ||
    verified.payload.rfqId !== state.rfq.id ||
    verified.payload.quoteId !== route.quoteId ||
    verified.payload.routeId !== route.routeId ||
    verified.payload.dealerInputAmountAtomic !== quote.payload.inputAmountAtomic ||
    verified.payload.brokerFeeAtomic !== route.brokerFeeAtomic ||
    verified.payload.totalInputAtomic !== route.totalInputAtomic ||
    verified.payload.outputAmountAtomic !== route.outputAmountAtomic ||
    verified.payload.secretHash !== state.secretHash ||
    verified.payload.sourceRefundAddress !== state.sourceRefundAddress ||
    verified.payload.destinationClaimAddress !== state.destinationAddress ||
    verified.payload.sourceAdapterId !== quote.payload.sourceAdapterId ||
    Number(verified.payload.sourceAdapterVersion) !== FX_V3_VERSION ||
    verified.payload.destinationAdapterId !==
      quote.payload.destinationAdapterId ||
    Number(verified.payload.destinationAdapterVersion) !== FX_V3_VERSION
  ) {
    throw new FxX402SwapError(
      "requester acceptance does not match the quoted x402 swap",
      "ACCEPTANCE_MISMATCH"
    );
  }
  return verified;
}

function verifyReservationForSwap({
  reservation,
  acceptance,
  proposal,
  now,
}) {
  const verified = verifyFxEnvelope(reservation, {
    now,
    clockSkewSeconds: 0,
  });
  const quote = proposal.quotes.find(
    (candidate) => candidate.id === proposal.route.quoteId
  );
  if (
    !quote ||
    verified.type !== "fx_reserve" ||
    verified.version !== FX_V3_VERSION ||
    verified.tradeId !== acceptance.tradeId ||
    verified.sender !== quote.sender ||
    verified.payload.acceptId !== acceptance.id ||
    verified.payload.quoteId !== quote.id ||
    verified.payload.reservationDeadline <= now
  ) {
    throw new FxX402SwapError(
      "dealer reservation does not match the accepted x402 route",
      "RESERVATION_MISMATCH"
    );
  }
  return verified;
}

function verifySourceLockAnnouncement({
  envelope,
  state,
  now,
}) {
  const verified = verifyFxEnvelope(envelope, {
    now,
    clockSkewSeconds: 0,
  });
  const specification = state.funding;
  if (
    verified.type !== "fx_lock_source" ||
    verified.version !== FX_V3_VERSION ||
    verified.tradeId !== state.tradeId ||
    verified.sender !== state.rfq.sender ||
    verified.payload.acceptId !== state.acceptance.id ||
    verified.payload.chainId !== specification.chainId ||
    verified.payload.token !== specification.asset ||
    verified.payload.amountAtomic !== specification.amountAtomic ||
    verified.payload.beneficiaryAmountAtomic !==
      specification.beneficiaryAmountAtomic ||
    verified.payload.executorAmountAtomic !== "0" ||
    verified.payload.lockAddress !== specification.adapterAddress ||
    verified.payload.beneficiary !== specification.beneficiary ||
    verified.payload.refundAddress !== specification.refundAddress ||
    verified.payload.secretHash !== specification.secretHash ||
    Number(verified.payload.timeout) !== specification.refundTimestamp ||
    verified.payload.transactionHash !== state.sourceTransactionHash ||
    String(verified.payload.blockNumber) !== String(state.sourceBlockNumber)
  ) {
    throw new FxX402SwapError(
      "source lock announcement does not match the settled x402 payment",
      "SOURCE_LOCK_MISMATCH"
    );
  }
  return verified;
}

function verifyRevealForSwap({ envelope, state, now }) {
  const verified = verifyFxEnvelope(envelope, {
    now,
    clockSkewSeconds: 0,
  });
  if (
    verified.type !== "fx_reveal" ||
    verified.version !== FX_V3_VERSION ||
    verified.tradeId !== state.tradeId ||
    verified.sender !== state.rfq.sender ||
    verified.payload.acceptId !== state.acceptance.id ||
    verified.payload.destinationLockMessageId !==
      state.destinationLockMessageId ||
    verified.payload.secretHash !== state.secretHash
  ) {
    throw new FxX402SwapError(
      "secret reveal does not match the confirmed destination lock",
      "REVEAL_MISMATCH"
    );
  }
  return verified;
}

const STATUS_RANK = new Map([
  ["quote_ready", 1],
  ["awaiting_reservation", 2],
  ["reserved", 3],
  ["source_confirmed", 4],
  ["source_announced", 5],
  ["destination_locked", 6],
  ["secret_revealed", 7],
  ["claim_observed", 8],
  ["complete", 9],
]);

function laterStatus(current, candidate) {
  if (["refunded", "defaulted"].includes(current)) return current;
  if (["refunded", "defaulted"].includes(candidate)) return candidate;
  return (STATUS_RANK.get(candidate) || 0) >= (STATUS_RANK.get(current) || 0)
    ? candidate
    : current;
}

class FxX402SwapStore {
  constructor({ directory = null } = {}) {
    this.directory = directory ? path.resolve(directory) : null;
    this.memory = new Map();
    if (this.directory) fs.mkdirSync(this.directory, { recursive: true });
  }

  filePath(tradeId) {
    return path.join(this.directory, `${hash(tradeId, "tradeId").slice(2)}.json`);
  }

  get(tradeId) {
    const id = hash(tradeId, "tradeId");
    if (this.memory.has(id)) return structuredClone(this.memory.get(id));
    if (!this.directory) return null;
    const file = this.filePath(id);
    if (!fs.existsSync(file)) return null;
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    this.memory.set(id, state);
    return structuredClone(state);
  }

  put(state) {
    object(state, "swap state");
    const id = hash(state.tradeId, "tradeId");
    const serializable = JSON.parse(JSON.stringify({ ...state, tradeId: id }));
    const serialized = JSON.stringify(serializable, null, 2);
    if (/\"secret\"\s*:|rawTransaction|privateKey/i.test(serialized)) {
      throw new FxX402SwapError(
        "swap store refuses plaintext secrets or signed transactions",
        "UNSAFE_PERSISTENCE"
      );
    }
    this.memory.set(id, serializable);
    if (this.directory) {
      const target = this.filePath(id);
      const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
      fs.writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporary, target);
    }
    return structuredClone(serializable);
  }

  update(tradeId, patch) {
    const current = this.get(tradeId);
    if (!current) {
      throw new FxX402SwapError("x402 swap is unknown", "TRADE_NOT_FOUND");
    }
    return this.put({ ...current, ...patch });
  }
}

function publicSwapState(state) {
  if (!state) return null;
  const {
    rfq,
    proposal,
    acceptance,
    reservation,
    funding,
    ...summary
  } = state;
  return {
    ...summary,
    requester: rfq?.sender || summary.requester,
    proposalId: proposal?.proposalId || summary.proposalId,
    acceptanceId: acceptance?.id || summary.acceptanceId,
    reservationId: reservation?.id || summary.reservationId,
    funding: funding
      ? {
          chainId: funding.chainId,
          asset: funding.asset,
          amountAtomic: funding.amountAtomic,
          adapterAddress: funding.adapterAddress,
          refundTimestamp: funding.refundTimestamp,
        }
      : null,
  };
}

class FxX402SwapCoordinator {
  constructor({
    broker,
    session,
    manifest,
    providers,
    store = new FxX402SwapStore(),
    now = () => Math.floor(Date.now() / 1000),
    sourceRefundSeconds = 7_200,
    reservationTimeoutMs = 30_000,
  } = {}) {
    if (!broker || typeof broker.requestRoute !== "function") {
      throw new TypeError("x402 swap coordinator requires a public broker");
    }
    if (!session || !session.transport || typeof session.ingest !== "function") {
      throw new TypeError("x402 swap coordinator requires a broker coordination session");
    }
    this.broker = broker;
    this.session = session;
    this.manifest = validateEvmV3Manifest(manifest);
    this.providers = providers instanceof Map
      ? providers
      : new Map(Object.entries(providers || {}).map(([key, value]) => [String(key), value]));
    this.store = store;
    this.now = now;
    this.sourceRefundSeconds = integer(
      sourceRefundSeconds,
      "sourceRefundSeconds",
      60
    );
    this.reservationTimeoutMs = integer(
      reservationTimeoutMs,
      "reservationTimeoutMs",
      1
    );
    this.boundAccepted = (message) => this.observe(message);
    this.session.on("accepted", this.boundAccepted);
  }

  provider(chainId) {
    const provider = this.providers.get(String(chainId));
    if (!provider) {
      throw new FxX402SwapError(
        `no source provider is configured for chain ${chainId}`,
        "PROVIDER_UNAVAILABLE"
      );
    }
    return provider;
  }

  async publish(envelope) {
    const local = this.session.ingest(envelope, { x402Ingress: true });
    if (!["accepted", "duplicate"].includes(local.status)) {
      throw new FxX402SwapError(
        `coordination rejected ${envelope.type}`,
        local.error || "COORDINATION_REJECTED"
      );
    }
    await this.session.transport.publish(envelope);
    return envelope;
  }

  observe(envelope) {
    const state = this.store.get(envelope.tradeId);
    if (!state) return;
    const next = {
      fx_lock_destination: "destination_locked",
      fx_reveal: "secret_revealed",
      fx_claim: "claim_observed",
      fx_complete: "complete",
      fx_refund: "refunded",
      fx_default: "defaulted",
    }[envelope.type];
    if (!next) return;
    const patch = {
      status: laterStatus(state.status, next),
      updatedAt: new Date(this.now() * 1000).toISOString(),
    };
    if (envelope.type === "fx_lock_destination") {
      patch.destinationLockMessageId = envelope.id;
    } else if (envelope.type !== "fx_reveal") {
      patch.lastMessageId = envelope.id;
    }
    this.store.update(envelope.tradeId, patch);
  }

  async open({ rfq, destinationAddress, sourceRefundAddress, secretHash }) {
    const verifiedRfq = verifyFxEnvelope(rfq, {
      now: this.now(),
      clockSkewSeconds: 0,
    });
    if (
      verifiedRfq.type !== "fx_rfq" ||
      verifiedRfq.version !== FX_V3_VERSION
    ) {
      throw new FxX402SwapError(
        "x402 swaps require a requester-signed V3 RFQ",
        "UNSUPPORTED_RFQ"
      );
    }
    const destination = address(destinationAddress, "destinationAddress");
    const refund = address(sourceRefundAddress, "sourceRefundAddress");
    const commitment = hash(secretHash, "secretHash");
    if (refund !== verifiedRfq.sender) {
      throw new FxX402SwapError(
        "V3 source refunds must return to the requester signer",
        "REFUND_ADDRESS_MISMATCH"
      );
    }
    if (verifiedRfq.payload.inputOptions.length !== 1) {
      throw new FxX402SwapError(
        "x402 swaps require exactly one source asset option",
        "AMBIGUOUS_SOURCE"
      );
    }
    const input = verifiedRfq.payload.inputOptions[0];
    const intent = x402SwapIntent({
      inputChainId: input.chainId,
      inputToken: input.token,
      outputChainId: verifiedRfq.payload.outputChainId,
      outputToken: verifiedRfq.payload.outputToken,
      outputAmountAtomic: verifiedRfq.payload.outputAmountAtomic,
      destinationAddress: destination,
      sourceRefundAddress: refund,
      secretHash: commitment,
    });
    if (verifiedRfq.payload.x402Commitment !== x402SwapCommitment(intent)) {
      throw new FxX402SwapError(
        "request body does not match the requester-signed x402 commitment",
        "COMMITMENT_MISMATCH"
      );
    }
    const existing = this.store.get(verifiedRfq.tradeId);
    if (existing) {
      if (
        existing.rfq.id !== verifiedRfq.id ||
        existing.destinationAddress !== destination ||
        existing.sourceRefundAddress !== refund ||
        existing.secretHash !== commitment
      ) {
        throw new FxX402SwapError(
          "trade ID is already bound to another x402 request",
          "TRADE_CONFLICT"
        );
      }
      return existing;
    }
    const proposal = await this.broker.requestRoute(verifiedRfq);
    const verifiedProposal = verifyBrokerRouteProposal(proposal, {
      now: this.now(),
      deploymentId: verifiedRfq.deploymentId,
      rfqId: verifiedRfq.id,
    });
    const quote = verifiedProposal.quotes.find(
      (candidate) => candidate.id === verifiedProposal.route.quoteId
    );
    if (
      !quote ||
      quote.version !== FX_V3_VERSION ||
      verifiedProposal.route.brokerFeeAtomic !== "0" ||
      Number(quote.payload.sourceAdapterVersion) !== FX_V3_VERSION ||
      Number(quote.payload.destinationAdapterVersion) !== FX_V3_VERSION
    ) {
      throw new FxX402SwapError(
        "broker did not return a zero-broker-fee V3 route",
        "UNSUPPORTED_ROUTE"
      );
    }
    return this.store.put({
      schema: FX_X402_SWAP_SCHEMA,
      schemaVersion: FX_X402_SWAP_VERSION,
      tradeId: verifiedRfq.tradeId,
      status: "quote_ready",
      createdAt: new Date(this.now() * 1000).toISOString(),
      updatedAt: new Date(this.now() * 1000).toISOString(),
      destinationAddress: destination,
      sourceRefundAddress: refund,
      secretHash: commitment,
      rfq: verifiedRfq,
      proposal: verifiedProposal,
    });
  }

  waitForReservation(tradeId, acceptance, proposal) {
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (error, reservation) => {
        this.session.off("accepted", onAccepted);
        if (timer) clearTimeout(timer);
        if (error) reject(error);
        else resolve(reservation);
      };
      const onAccepted = (message) => {
        if (
          message.type !== "fx_reserve" ||
          message.tradeId !== tradeId ||
          message.payload?.acceptId !== acceptance.id
        ) {
          return;
        }
        try {
          finish(null, verifyReservationForSwap({
            reservation: message,
            acceptance,
            proposal,
            now: this.now(),
          }));
        } catch (error) {
          finish(error);
        }
      };
      this.session.on("accepted", onAccepted);
      timer = setTimeout(
        () => finish(new FxX402SwapError(
          "selected dealer did not reserve the route",
          "RESERVATION_TIMEOUT"
        )),
        this.reservationTimeoutMs
      );
    });
  }

  async accept({ tradeId, acceptance }) {
    let state = this.store.get(tradeId);
    if (!state) {
      throw new FxX402SwapError("x402 swap is unknown", "TRADE_NOT_FOUND");
    }
    let verifiedAcceptance;
    if (state.acceptance) {
      if (state.acceptance.id !== acceptance?.id) {
        throw new FxX402SwapError(
          "trade already has another acceptance",
          "ACCEPTANCE_CONFLICT"
        );
      }
      if (state.funding && state.reservation) return state;
      verifiedAcceptance = state.acceptance;
    } else {
      verifiedAcceptance = verifyAcceptanceForSwap({
        acceptance,
        state,
        now: this.now(),
      });
      state = this.store.update(state.tradeId, {
        status: "awaiting_reservation",
        updatedAt: new Date(this.now() * 1000).toISOString(),
        acceptance: verifiedAcceptance,
      });
    }
    const reservationPromise = this.waitForReservation(
      state.tradeId,
      verifiedAcceptance,
      state.proposal
    );
    await this.publish(verifiedAcceptance);
    const reservation = await reservationPromise;
    const sourceProvider = this.provider(state.proposal.route.inputChainId);
    const latest = await sourceProvider.getBlock("latest");
    const sourceRefundTimestamp =
      integer(latest.timestamp, "source chain timestamp", 1) +
      this.sourceRefundSeconds;
    const funding = sourceFundingSpecification({
      manifest: this.manifest,
      proposal: state.proposal,
      acceptance: verifiedAcceptance,
      reservation,
      sourceChainTimestamp: integer(
        latest.timestamp,
        "source chain timestamp",
        1
      ),
      sourceRefundTimestamp,
    });
    state = this.store.update(state.tradeId, {
      status: "reserved",
      updatedAt: new Date(this.now() * 1000).toISOString(),
      acceptance: verifiedAcceptance,
      reservation,
      funding,
    });
    return state;
  }

  async settle({ tradeId, rawTransaction }) {
    let state = this.store.get(tradeId);
    if (!state?.funding || !state.reservation) {
      throw new FxX402SwapError(
        "dealer reservation is required before source settlement",
        "RESERVATION_REQUIRED"
      );
    }
    const verified = verifySignedSourceFundingTransaction(
      rawTransaction,
      state.funding
    );
    if (state.sourceTransactionHash) {
      if (state.sourceTransactionHash !== verified.transactionHash) {
        throw new FxX402SwapError(
          "trade was already settled with another transaction",
          "SETTLEMENT_CONFLICT"
        );
      }
      return state;
    }
    const provider = this.provider(state.funding.chainId);
    let broadcast;
    try {
      broadcast = await provider.broadcastTransaction(verified.rawTransaction);
    } catch (error) {
      const receipt = await provider.getTransactionReceipt(
        verified.transactionHash
      );
      if (!receipt) throw error;
      broadcast = { hash: verified.transactionHash };
    }
    if (String(broadcast.hash).toLowerCase() !== verified.transactionHash) {
      throw new FxX402SwapError(
        "provider returned another source transaction hash",
        "BROADCAST_MISMATCH"
      );
    }
    const receipt = typeof broadcast.wait === "function"
      ? await broadcast.wait(state.funding.requiredConfirmations)
      : await provider.waitForTransaction(
          verified.transactionHash,
          state.funding.requiredConfirmations
        );
    if (!receipt || Number(receipt.status) !== 1) {
      throw new FxX402SwapError(
        "source lock transaction did not confirm successfully",
        "SOURCE_TRANSACTION_FAILED"
      );
    }
    state = this.store.update(state.tradeId, {
      status: "source_confirmed",
      updatedAt: new Date(this.now() * 1000).toISOString(),
      sourceTransactionHash: verified.transactionHash,
      sourceBlockNumber: Number(receipt.blockNumber),
    });
    return state;
  }

  async announceSourceLock({ tradeId, envelope }) {
    let state = this.store.get(tradeId);
    if (!state?.sourceTransactionHash) {
      throw new FxX402SwapError(
        "source transaction must confirm before announcement",
        "SOURCE_CONFIRMATION_REQUIRED"
      );
    }
    if (state.sourceLockEnvelope) {
      if (state.sourceLockEnvelope.id !== envelope?.id) {
        throw new FxX402SwapError(
          "another source lock announcement already exists",
          "SOURCE_LOCK_CONFLICT"
        );
      }
      return state;
    }
    const verified = verifySourceLockAnnouncement({
      envelope,
      state,
      now: this.now(),
    });
    await this.publish(verified);
    const latest = this.store.get(state.tradeId);
    state = this.store.update(state.tradeId, {
      status: laterStatus(latest.status, "source_announced"),
      updatedAt: new Date(this.now() * 1000).toISOString(),
      sourceLockEnvelope: verified,
    });
    return state;
  }

  async reveal({ tradeId, envelope }) {
    let state = this.store.get(tradeId);
    if (!state?.destinationLockMessageId) {
      throw new FxX402SwapError(
        "destination lock must confirm before the requester reveals",
        "DESTINATION_LOCK_REQUIRED"
      );
    }
    if (state.revealMessageId) {
      if (state.revealMessageId !== envelope?.id) {
        throw new FxX402SwapError(
          "another requester reveal already exists",
          "REVEAL_CONFLICT"
        );
      }
      return state;
    }
    const verified = verifyRevealForSwap({
      envelope,
      state,
      now: this.now(),
    });
    await this.publish(verified);
    const latest = this.store.get(state.tradeId);
    state = this.store.update(state.tradeId, {
      status: laterStatus(latest.status, "secret_revealed"),
      updatedAt: new Date(this.now() * 1000).toISOString(),
      revealMessageId: verified.id,
    });
    return state;
  }

  status(tradeId) {
    const state = this.store.get(tradeId);
    if (!state) {
      throw new FxX402SwapError("x402 swap is unknown", "TRADE_NOT_FOUND");
    }
    return publicSwapState(state);
  }

  close() {
    this.session.off("accepted", this.boundAccepted);
  }
}

function paymentRequirement(state, stage, resource) {
  const route = state.proposal.route;
  const extension = {
    schema: FX_X402_SWAP_SCHEMA,
    schemaVersion: FX_X402_SWAP_VERSION,
    stage,
    tradeId: state.tradeId,
    proposal: stage === "accept" ? state.proposal : undefined,
    acceptanceId: state.acceptance?.id,
    reservation: stage === "fund" ? state.reservation : undefined,
    funding: stage === "fund" ? state.funding : undefined,
    destinationAddress: state.destinationAddress,
    sourceRefundAddress: state.sourceRefundAddress,
    secretHash: state.secretHash,
  };
  return {
    x402Version: 2,
    scheme: FX_X402_SWAP_SCHEME,
    network: `eip155:${route.inputChainId}`,
    asset: route.inputToken,
    amount: route.totalInputAtomic,
    payTo: state.funding?.adapterAddress ||
      selectEvmV3Capability(state.manifest || {}, {
        chainId: route.inputChainId,
        token: route.inputToken,
      }).adapterAddress,
    maxTimeoutSeconds: Math.max(
      1,
      Math.min(
        7_200,
        (state.reservation?.payload?.reservationDeadline || state.rfq.expiresAt) -
          Math.floor(Date.now() / 1000)
      )
    ),
    resource,
    description: "Reserve and fund an exact-output Versus atomic FX swap",
    extensions: {
      versus: Object.fromEntries(
        Object.entries(extension).filter(([, value]) => value !== undefined)
      ),
    },
  };
}

async function readJsonBody(request, limit = FX_X402_MAX_BODY_BYTES) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) {
      throw new FxX402SwapError("request body is too large", "BODY_TOO_LARGE");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new FxX402SwapError("request body is not valid JSON", "BAD_JSON");
  }
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function createFxX402SwapHttpHandler({
  coordinator,
  resource = "/v1/fx/swaps",
} = {}) {
  if (!coordinator || typeof coordinator.open !== "function") {
    throw new TypeError("x402 swap HTTP handler requires a coordinator");
  }
  return async function handle(request, response) {
    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": `content-type,${PAYMENT_SIGNATURE}`,
        }).end();
        return true;
      }
      const statusMatch = /^\/v1\/fx\/swaps\/(0x[0-9a-fA-F]{64})$/.exec(
        url.pathname
      );
      if (request.method === "GET" && statusMatch) {
        json(response, 200, { swap: coordinator.status(statusMatch[1]) });
        return true;
      }
      const announceMatch =
        /^\/v1\/fx\/swaps\/(0x[0-9a-fA-F]{64})\/source-lock$/.exec(
          url.pathname
        );
      if (request.method === "POST" && announceMatch) {
        const body = await readJsonBody(request);
        const state = await coordinator.announceSourceLock({
          tradeId: announceMatch[1],
          envelope: body.envelope,
        });
        json(response, 202, { swap: publicSwapState(state) });
        return true;
      }
      const revealMatch =
        /^\/v1\/fx\/swaps\/(0x[0-9a-fA-F]{64})\/reveal$/.exec(
          url.pathname
        );
      if (request.method === "POST" && revealMatch) {
        const body = await readJsonBody(request);
        const state = await coordinator.reveal({
          tradeId: revealMatch[1],
          envelope: body.envelope,
        });
        json(response, 202, { swap: publicSwapState(state) });
        return true;
      }
      if (request.method !== "POST" || url.pathname !== resource) return false;
      const body = await readJsonBody(request);
      const encodedPayment =
        request.headers[PAYMENT_SIGNATURE.toLowerCase()];
      if (!encodedPayment) {
        const state = await coordinator.open(body);
        const requirement = paymentRequirement(
          { ...state, manifest: coordinator.manifest },
          "accept",
          resource
        );
        json(response, 402, {
          error: "payment_required",
          tradeId: state.tradeId,
          stage: "accept",
        }, {
          [PAYMENT_REQUIRED]: base64Json({
            x402Version: 2,
            accepts: [requirement],
          }),
        });
        return true;
      }
      const payment = parseBase64Json(encodedPayment, PAYMENT_SIGNATURE);
      if (payment.scheme !== FX_X402_SWAP_SCHEME) {
        throw new FxX402SwapError("payment scheme is unsupported", "BAD_PAYMENT");
      }
      if (payment.stage === "accept") {
        const state = await coordinator.accept({
          tradeId: payment.tradeId,
          acceptance: payment.acceptance,
        });
        const requirement = paymentRequirement(
          { ...state, manifest: coordinator.manifest },
          "fund",
          resource
        );
        json(response, 402, {
          error: "payment_required",
          tradeId: state.tradeId,
          stage: "fund",
        }, {
          [PAYMENT_REQUIRED]: base64Json({
            x402Version: 2,
            accepts: [requirement],
          }),
        });
        return true;
      }
      if (payment.stage === "fund") {
        const state = await coordinator.settle({
          tradeId: payment.tradeId,
          rawTransaction: payment.rawTransaction,
        });
        json(response, 202, { swap: publicSwapState(state) }, {
          [PAYMENT_RESPONSE]: base64Json({
            success: true,
            network: `eip155:${state.funding.chainId}`,
            transaction: state.sourceTransactionHash,
            tradeId: state.tradeId,
            status: state.status,
          }),
        });
        return true;
      }
      throw new FxX402SwapError("payment stage is unsupported", "BAD_PAYMENT");
    } catch (error) {
      const status = {
        BODY_TOO_LARGE: 413,
        TRADE_NOT_FOUND: 404,
        TRADE_CONFLICT: 409,
        ACCEPTANCE_CONFLICT: 409,
        SETTLEMENT_CONFLICT: 409,
        RESERVATION_TIMEOUT: 504,
      }[error.code] || 400;
      json(response, status, {
        error: error.code || "fx_x402_swap_failed",
        message: error.message,
      });
      return true;
    }
  };
}

function selectSwapRequirement(response, expectedStage) {
  const header = response.headers.get(PAYMENT_REQUIRED);
  if (!header) {
    throw new FxX402SwapError(
      "x402 response omitted PAYMENT-REQUIRED",
      "MISSING_PAYMENT_REQUIREMENT"
    );
  }
  const challenge = parseBase64Json(header, PAYMENT_REQUIRED);
  const requirement = challenge.accepts?.find(
    (candidate) =>
      candidate?.scheme === FX_X402_SWAP_SCHEME &&
      candidate?.extensions?.versus?.stage === expectedStage
  );
  if (!requirement) {
    throw new FxX402SwapError(
      `x402 response has no ${expectedStage} requirement`,
      "MISSING_PAYMENT_REQUIREMENT"
    );
  }
  return requirement;
}

async function postJson(fetchImpl, url, body, payment = null) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(payment ? { [PAYMENT_SIGNATURE]: base64Json(payment) } : {}),
    },
    body: JSON.stringify(body),
  });
  const parsed = await response.json();
  if (![202, 402].includes(response.status)) {
    throw new FxX402SwapError(
      parsed.message || parsed.error || "x402 swap endpoint rejected the request",
      parsed.error || "HTTP_ERROR"
    );
  }
  return { response, body: parsed };
}

async function getJson(fetchImpl, url) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  const parsed = await response.json();
  if (response.status !== 200) {
    throw new FxX402SwapError(
      parsed.message || parsed.error || "x402 swap status request failed",
      parsed.error || "HTTP_ERROR"
    );
  }
  return parsed;
}

class FxX402RequesterClient {
  constructor({
    endpoint,
    deploymentId,
    manifest,
    signer,
    providers,
    recoveryDirectory,
    fetchImpl = fetch,
    now = () => Math.floor(Date.now() / 1000),
    randomSecret = () => crypto.randomBytes(32),
    sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {}) {
    this.endpoint = new URL(endpoint);
    if (
      this.endpoint.protocol !== "https:" &&
      !["127.0.0.1", "localhost", "::1"].includes(this.endpoint.hostname)
    ) {
      throw new FxX402SwapError(
        "public x402 swap endpoints require HTTPS",
        "UNSAFE_ENDPOINT"
      );
    }
    this.deploymentId = hash(deploymentId, "deploymentId");
    this.manifest = validateEvmV3Manifest(manifest);
    if (
      !signer ||
      typeof signer.getAddress !== "function" ||
      typeof signer.signMessage !== "function" ||
      typeof signer.signTransaction !== "function"
    ) {
      throw new TypeError("x402 requester requires a local transaction signer");
    }
    this.signer = signer;
    this.providers = providers instanceof Map
      ? providers
      : new Map(Object.entries(providers || {}).map(([key, value]) => [String(key), value]));
    this.recoveryDirectory = path.resolve(recoveryDirectory);
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.randomSecret = randomSecret;
    this.sleep = sleep;
  }

  provider(chainId) {
    const provider = this.providers.get(String(chainId));
    if (!provider) {
      throw new FxX402SwapError(
        `no requester provider is configured for chain ${chainId}`,
        "PROVIDER_UNAVAILABLE"
      );
    }
    return provider;
  }

  async execute({
    inputChainId,
    inputToken,
    maxInputAtomic,
    outputChainId,
    outputToken,
    outputAmountAtomic,
    destinationAddress,
    sourceRefundAddress,
    recoveryPassword,
    tradeId = `0x${crypto.randomBytes(32).toString("hex")}`,
    quotePolicy = "lowest_all_in",
    quoteLifetimeSeconds = 120,
    settlementLifetimeSeconds = 7_200,
    statusPollMs = 1_000,
    completionTimeoutMs = 5 * 60 * 1000,
  } = {}) {
    const requester = address(await this.signer.getAddress(), "requester");
    const destination = address(destinationAddress, "destinationAddress");
    const refund = address(sourceRefundAddress || requester, "sourceRefundAddress");
    if (refund !== requester) {
      throw new FxX402SwapError(
        "V3 source refunds must return to the requester signer",
        "REFUND_ADDRESS_MISMATCH"
      );
    }
    const secret = this.randomSecret();
    if (!Buffer.isBuffer(secret) || secret.length !== 32) {
      throw new FxX402SwapError("requester secret must contain 32 bytes");
    }
    const secretHash = keccak256(secret);
    const recoveryFile = path.join(
      this.recoveryDirectory,
      `${hash(tradeId, "tradeId").slice(2)}.recovery.json`
    );
    createFxRecoveryPacket({
      filePath: recoveryFile,
      password: recoveryPassword,
      deploymentId: this.deploymentId,
      tradeId,
      createdAt: this.now(),
      secret,
      metadata: {
        phase: "x402-v3",
        purpose: "settlement-secret",
      },
    });
    const createdAt = this.now();
    const intent = x402SwapIntent({
      inputChainId: String(BigInt(inputChainId)),
      inputToken: canonicalAsset(inputToken),
      outputChainId: String(BigInt(outputChainId)),
      outputToken: canonicalAsset(outputToken),
      outputAmountAtomic: uint(outputAmountAtomic, "outputAmountAtomic").toString(),
      destinationAddress: destination,
      sourceRefundAddress: refund,
      secretHash,
    });
    const rfq = await signFxMessage({
      protocol: "versus-fx",
      version: FX_V3_VERSION,
      deploymentId: this.deploymentId,
      type: "fx_rfq",
      tradeId: hash(tradeId, "tradeId"),
      role: "requester",
      sequence: "1",
      createdAt,
      expiresAt: createdAt + quoteLifetimeSeconds,
      payload: {
        outputChainId: intent.outputChainId,
        outputToken: intent.outputToken,
        outputAmountAtomic: intent.outputAmountAtomic,
        inputOptions: [{
          chainId: intent.inputChainId,
          token: intent.inputToken,
          maxInputAtomic: uint(maxInputAtomic, "maxInputAtomic").toString(),
        }],
        quoteDeadline: createdAt + quoteLifetimeSeconds - 5,
        settlementDeadline: createdAt + settlementLifetimeSeconds,
        quotePolicy,
        x402Commitment: x402SwapCommitment(intent),
      },
    }, this.signer);
    const requestBody = {
      rfq,
      destinationAddress: destination,
      sourceRefundAddress: refund,
      secretHash,
    };
    const opened = await postJson(
      this.fetchImpl,
      this.endpoint,
      requestBody
    );
    if (opened.response.status !== 402) {
      throw new FxX402SwapError("endpoint did not return an acceptance challenge");
    }
    const acceptRequirement = selectSwapRequirement(opened.response, "accept");
    const extension = acceptRequirement.extensions.versus;
    const proposal = verifyBrokerRouteProposal(extension.proposal, {
      now: this.now(),
      deploymentId: this.deploymentId,
      rfqId: rfq.id,
    });
    if (
      extension.tradeId !== rfq.tradeId ||
      extension.secretHash !== secretHash ||
      extension.destinationAddress !== destination ||
      extension.sourceRefundAddress !== refund ||
      proposal.route.inputChainId !== intent.inputChainId ||
      proposal.route.inputToken !== intent.inputToken ||
      proposal.route.outputChainId !== intent.outputChainId ||
      proposal.route.outputToken !== intent.outputToken ||
      proposal.route.outputAmountAtomic !== intent.outputAmountAtomic
    ) {
      throw new FxX402SwapError(
        "endpoint acceptance challenge changed the signed swap intent",
        "REQUIREMENT_MISMATCH"
      );
    }
    const selectedQuote = proposal.quotes.find(
      (candidate) => candidate.id === proposal.route.quoteId
    );
    const acceptedAt = this.now();
    const acceptance = await signFxMessage({
      protocol: "versus-fx",
      version: FX_V3_VERSION,
      deploymentId: this.deploymentId,
      type: "fx_accept",
      tradeId: rfq.tradeId,
      role: "requester",
      sequence: "2",
      createdAt: acceptedAt,
      expiresAt: Math.min(rfq.payload.settlementDeadline, acceptedAt + 600),
      payload: {
        rfqId: rfq.id,
        quoteId: proposal.route.quoteId,
        routeId: proposal.route.routeId,
        dealerInputAmountAtomic: selectedQuote.payload.inputAmountAtomic,
        brokerFeeAtomic: proposal.route.brokerFeeAtomic,
        totalInputAtomic: proposal.route.totalInputAtomic,
        outputAmountAtomic: proposal.route.outputAmountAtomic,
        secretHash,
        sourceRefundAddress: refund,
        destinationClaimAddress: destination,
        sourceAdapterId: selectedQuote.payload.sourceAdapterId,
        sourceAdapterVersion: selectedQuote.payload.sourceAdapterVersion,
        destinationAdapterId: selectedQuote.payload.destinationAdapterId,
        destinationAdapterVersion: selectedQuote.payload.destinationAdapterVersion,
      },
    }, this.signer);
    const accepted = await postJson(
      this.fetchImpl,
      this.endpoint,
      requestBody,
      {
        scheme: FX_X402_SWAP_SCHEME,
        stage: "accept",
        tradeId: rfq.tradeId,
        acceptance,
      }
    );
    if (accepted.response.status !== 402) {
      throw new FxX402SwapError("endpoint did not return a source funding challenge");
    }
    const fundRequirement = selectSwapRequirement(accepted.response, "fund");
    const funding = fundRequirement.extensions.versus.funding;
    if (
      funding.tradeId !== rfq.tradeId ||
      funding.acceptanceId !== acceptance.id ||
      funding.refundAddress !== refund ||
      funding.secretHash !== secretHash ||
      funding.chainId !== intent.inputChainId ||
      funding.asset !== intent.inputToken ||
      BigInt(funding.amountAtomic) !== BigInt(proposal.route.totalInputAtomic)
    ) {
      throw new FxX402SwapError(
        "endpoint funding challenge changed the accepted V3 lock",
        "REQUIREMENT_MISMATCH"
      );
    }
    const capability = selectEvmV3Capability(this.manifest, {
      chainId: funding.chainId,
      token: funding.asset,
    });
    const adapterId = this.manifest.builds[capability.kind].adapterId;
    if (
      capability.adapterAddress !== funding.adapterAddress ||
      adapterId !== funding.adapterId
    ) {
      throw new FxX402SwapError(
        "endpoint selected an unfrozen source adapter",
        "ADAPTER_MISMATCH"
      );
    }
    const provider = this.provider(funding.chainId);
    if (capability.kind === "erc20") {
      const result = await provider.call({
        to: capability.asset.address,
        data: TOKEN_INTERFACE.encodeFunctionData("allowance", [
          requester,
          capability.adapterAddress,
        ]),
      });
      const allowance = TOKEN_INTERFACE.decodeFunctionResult("allowance", result)[0];
      if (BigInt(allowance) < BigInt(funding.amountAtomic)) {
        throw new FxX402SwapError(
          "source token approval is required before x402 funding",
          "SOURCE_APPROVAL_REQUIRED"
        );
      }
    }
    const transaction = {
      chainId: BigInt(funding.chainId),
      to: funding.transaction.to,
      data: funding.transaction.data,
      value: BigInt(funding.transaction.value),
      nonce: await provider.getTransactionCount(requester, "pending"),
    };
    const estimatedGas = BigInt(await provider.estimateGas({
      ...transaction,
      from: requester,
    }));
    transaction.gasLimit = (estimatedGas * 120n + 99n) / 100n;
    const feeData = await provider.getFeeData();
    if (feeData.maxFeePerGas != null) {
      transaction.type = 2;
      transaction.maxFeePerGas = BigInt(feeData.maxFeePerGas);
      transaction.maxPriorityFeePerGas = BigInt(
        feeData.maxPriorityFeePerGas || 0
      );
    } else {
      transaction.gasPrice = BigInt(feeData.gasPrice);
    }
    const rawTransaction = await this.signer.signTransaction(transaction);
    verifySignedSourceFundingTransaction(rawTransaction, funding);
    const funded = await postJson(
      this.fetchImpl,
      this.endpoint,
      requestBody,
      {
        scheme: FX_X402_SWAP_SCHEME,
        stage: "fund",
        tradeId: rfq.tradeId,
        rawTransaction,
      }
    );
    if (funded.response.status !== 202) {
      throw new FxX402SwapError("endpoint did not confirm source settlement");
    }
    const swap = funded.body.swap;
    const lockCreatedAt = this.now();
    const sourceLock = await signFxMessage({
      protocol: "versus-fx",
      version: FX_V3_VERSION,
      deploymentId: this.deploymentId,
      type: "fx_lock_source",
      tradeId: rfq.tradeId,
      role: "requester",
      sequence: "3",
      createdAt: lockCreatedAt,
      expiresAt: funding.refundTimestamp,
      payload: {
        acceptId: acceptance.id,
        chainId: funding.chainId,
        token: funding.asset,
        amountAtomic: funding.amountAtomic,
        beneficiaryAmountAtomic: funding.beneficiaryAmountAtomic,
        executorAmountAtomic: funding.executorAmountAtomic,
        lockAddress: funding.adapterAddress,
        beneficiary: funding.beneficiary,
        refundAddress: funding.refundAddress,
        secretHash: funding.secretHash,
        timeout: funding.refundTimestamp,
        transactionHash: swap.sourceTransactionHash,
        blockNumber: String(swap.sourceBlockNumber),
      },
    }, this.signer);
    const announceUrl = new URL(
      `/v1/fx/swaps/${rfq.tradeId}/source-lock`,
      this.endpoint
    );
    const announced = await postJson(
      this.fetchImpl,
      announceUrl,
      { envelope: sourceLock }
    );
    const statusUrl = new URL(
      `/v1/fx/swaps/${rfq.tradeId}`,
      this.endpoint
    );
    const deadline = Date.now() + integer(
      completionTimeoutMs,
      "completionTimeoutMs",
      1
    );
    const pollMilliseconds = integer(statusPollMs, "statusPollMs", 1);
    let status = announced.body.swap;
    while (
      !["destination_locked", "complete", "refunded", "defaulted"].includes(
        status.status
      ) &&
      Date.now() < deadline
    ) {
      await this.sleep(pollMilliseconds);
      status = (await getJson(this.fetchImpl, statusUrl)).swap;
    }
    if (status.status !== "destination_locked") {
      if (status.status === "complete") {
        return {
          tradeId: rfq.tradeId,
          status: status.status,
          swap: status,
          recoveryFile,
          endpointPaymentAuthorized: true,
          endpointPaymentSubmitted: true,
        };
      }
      throw new FxX402SwapError(
        `swap did not reach a destination lock (${status.status})`,
        "DESTINATION_LOCK_TIMEOUT"
      );
    }
    const revealCreatedAt = this.now();
    const reveal = await signFxMessage({
      protocol: "versus-fx",
      version: FX_V3_VERSION,
      deploymentId: this.deploymentId,
      type: "fx_reveal",
      tradeId: rfq.tradeId,
      role: "requester",
      sequence: "4",
      createdAt: revealCreatedAt,
      expiresAt: funding.refundTimestamp,
      payload: {
        acceptId: acceptance.id,
        destinationLockMessageId: status.destinationLockMessageId,
        secret: `0x${secret.toString("hex")}`,
        secretHash,
      },
    }, this.signer);
    const revealUrl = new URL(
      `/v1/fx/swaps/${rfq.tradeId}/reveal`,
      this.endpoint
    );
    const revealed = await postJson(
      this.fetchImpl,
      revealUrl,
      { envelope: reveal }
    );
    status = revealed.body.swap;
    while (
      !["complete", "refunded", "defaulted"].includes(status.status) &&
      Date.now() < deadline
    ) {
      await this.sleep(pollMilliseconds);
      status = (await getJson(this.fetchImpl, statusUrl)).swap;
    }
    if (status.status !== "complete") {
      throw new FxX402SwapError(
        `swap did not complete (${status.status})`,
        "SETTLEMENT_TIMEOUT"
      );
    }
    return {
      tradeId: rfq.tradeId,
      status: status.status,
      swap: status,
      recoveryFile,
      endpointPaymentAuthorized: true,
      endpointPaymentSubmitted: true,
    };
  }
}

module.exports = {
  FX_X402_MAX_BODY_BYTES,
  FX_X402_SWAP_SCHEMA,
  FX_X402_SWAP_SCHEME,
  FX_X402_SWAP_VERSION,
  FxX402RequesterClient,
  FxX402SwapCoordinator,
  FxX402SwapError,
  FxX402SwapStore,
  createFxX402SwapHttpHandler,
  packSettlementV3,
  paymentRequirement,
  publicSwapState,
  sourceFundingSpecification,
  verifyAcceptanceForSwap,
  verifyReservationForSwap,
  verifySignedSourceFundingTransaction,
  verifySourceLockAnnouncement,
  verifyRevealForSwap,
  x402SwapCommitment,
  x402SwapIntent,
};
