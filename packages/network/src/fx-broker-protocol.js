const {
  getAddress,
  isAddress,
  keccak256,
  toUtf8Bytes,
  verifyMessage,
} = require("ethers");
const {
  canonicalJson,
  selectSingleDealerRoute,
  verifyFxEnvelope,
} = require("./fx-protocol");

const FX_BROKER_ROUTE_SCHEMA = "versus-fx-broker-route";
const FX_BROKER_FEE_VOUCHER_SCHEMA = "versus-fx-broker-fee-voucher";
const FX_BROKER_METRICS_SCHEMA = "versus-fx-broker-metrics";
const FX_BROKER_VERSION = 1;
const FX_BROKER_PAYMENT_MODE = "verified-completion-v1";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;

class FxBrokerError extends Error {
  constructor(message, code = "FX_BROKER_ERROR") {
    super(message);
    this.name = "FxBrokerError";
    this.code = code;
  }
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FxBrokerError(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  object(value, label);
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw new FxBrokerError(`${label} contains unsupported field ${key}`, "UNKNOWN_FIELD");
    }
  }
  for (const key of expected) {
    if (!(key in value)) {
      throw new FxBrokerError(`${label} is missing ${key}`, "MISSING_FIELD");
    }
  }
}

function address(value, label, { allowZero = false } = {}) {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new FxBrokerError(`${label} must be an EVM address`);
  }
  const normalized = getAddress(value).toLowerCase();
  if (!allowZero && normalized === ZERO_ADDRESS) {
    throw new FxBrokerError(`${label} must not be the zero address`);
  }
  return normalized;
}

function hash(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (!HASH_PATTERN.test(normalized)) {
    throw new FxBrokerError(`${label} must be bytes32`);
  }
  return normalized;
}

function uint(value, label, { allowZero = true } = {}) {
  const text = String(value);
  if (!/^\d+$/.test(text) || text.length > 78) {
    throw new FxBrokerError(`${label} must be an unsigned integer`);
  }
  const normalized = BigInt(text).toString();
  if (!allowZero && normalized === "0") {
    throw new FxBrokerError(`${label} must be greater than zero`);
  }
  return normalized;
}

function integer(value, label, { allowZero = true } = {}) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < (allowZero ? 0 : 1)) {
    throw new FxBrokerError(`${label} must be a safe unsigned integer`);
  }
  return normalized;
}

function signature(value, label = "signature") {
  if (typeof value !== "string" || !SIGNATURE_PATTERN.test(value)) {
    throw new FxBrokerError(`${label} must be a 65-byte signature`, "BAD_SIGNATURE");
  }
  return value;
}

function jsonEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function normalizeFee(value, { broker, route } = {}) {
  exactKeys(
    value,
    ["recipient", "chainId", "token", "amountAtomic", "paymentMode"],
    "fee"
  );
  const fee = {
    recipient: address(value.recipient, "fee.recipient"),
    chainId: uint(value.chainId, "fee.chainId", { allowZero: false }),
    token: address(value.token, "fee.token", { allowZero: true }),
    amountAtomic: uint(value.amountAtomic, "fee.amountAtomic"),
    paymentMode: String(value.paymentMode || ""),
  };
  if (fee.paymentMode !== FX_BROKER_PAYMENT_MODE) {
    throw new FxBrokerError("fee payment mode is unsupported");
  }
  if (broker && fee.recipient !== address(broker, "broker")) {
    throw new FxBrokerError("fee recipient must equal the broker identity", "FEE_RECIPIENT_MISMATCH");
  }
  if (route) {
    if (
      fee.chainId !== route.inputChainId ||
      fee.token !== route.inputToken ||
      fee.amountAtomic !== route.brokerFeeAtomic
    ) {
      throw new FxBrokerError("fee disclosure does not match the compiled route", "FEE_MISMATCH");
    }
  }
  return fee;
}

function brokerProposalCore({
  deploymentId,
  broker,
  issuedAt,
  expiresAt,
  rfq,
  quotes,
  policy,
  fee,
  route,
}) {
  return {
    schema: FX_BROKER_ROUTE_SCHEMA,
    schemaVersion: FX_BROKER_VERSION,
    deploymentId,
    broker,
    issuedAt,
    expiresAt,
    rfq,
    quotes,
    policy,
    fee,
    route,
  };
}

function brokerProposalId(core) {
  return keccak256(toUtf8Bytes(canonicalJson(core)));
}

function verifyQuoteSet(rfq, quotes, { now, maxReferenceAgeSeconds } = {}) {
  if (!Array.isArray(quotes) || quotes.length < 1 || quotes.length > 128) {
    throw new FxBrokerError("broker proposal must include 1 to 128 dealer quotes");
  }
  const verified = quotes.map((candidate) => {
    const quote = verifyFxEnvelope(candidate, {
      now,
      clockSkewSeconds: 0,
      temporal: now !== undefined,
    });
    if (
      quote.type !== "fx_quote" ||
      quote.deploymentId !== rfq.deploymentId ||
      quote.tradeId !== rfq.tradeId ||
      quote.payload.rfqId !== rfq.id
    ) {
      throw new FxBrokerError("broker proposal contains an unrelated quote", "QUOTE_SCOPE_MISMATCH");
    }
    return quote;
  });
  verified.sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(verified.map((quote) => quote.id)).size !== verified.length) {
    throw new FxBrokerError("broker proposal contains duplicate quotes", "DUPLICATE_QUOTE");
  }
  // Route selection performs freshness, amount, asset, and maximum-input checks.
  selectSingleDealerRoute(
    rfq,
    verified.map((quote) => ({ quote, brokerFeeAtomic: "0" })),
    { now, maxReferenceAgeSeconds }
  );
  return verified;
}

async function createBrokerRouteProposal({
  signer,
  rfq,
  quotes,
  brokerFeeAtomic,
  policy,
  now = Math.floor(Date.now() / 1000),
  lifetimeSeconds = 30,
  maxReferenceAgeSeconds,
}) {
  if (!signer || typeof signer.signMessage !== "function") {
    throw new TypeError("broker proposal requires a signer");
  }
  const broker = address(await signer.getAddress(), "broker");
  const verifiedRfq = verifyFxEnvelope(rfq, {
    now,
    clockSkewSeconds: 0,
  });
  if (verifiedRfq.type !== "fx_rfq") {
    throw new FxBrokerError("broker proposal requires an fx_rfq");
  }
  const verifiedQuotes = verifyQuoteSet(verifiedRfq, quotes, {
    now,
    maxReferenceAgeSeconds,
  });
  const normalizedFee = uint(brokerFeeAtomic, "brokerFeeAtomic");
  const route = selectSingleDealerRoute(
    verifiedRfq,
    verifiedQuotes.map((quote) => ({
      quote,
      brokerFeeAtomic: normalizedFee,
    })),
    {
      now,
      policy: policy || verifiedRfq.payload.quotePolicy,
      maxReferenceAgeSeconds,
    }
  );
  const selectedQuote = verifiedQuotes.find((quote) => quote.id === route.quoteId);
  const expiresAt = Math.min(
    verifiedRfq.expiresAt,
    verifiedRfq.payload.quoteDeadline,
    selectedQuote.expiresAt,
    now + integer(lifetimeSeconds, "lifetimeSeconds", { allowZero: false })
  );
  if (expiresAt <= now) {
    throw new FxBrokerError("broker proposal would already be expired", "EXPIRED_PROPOSAL");
  }
  const fee = normalizeFee({
    recipient: broker,
    chainId: route.inputChainId,
    token: route.inputToken,
    amountAtomic: normalizedFee,
    paymentMode: FX_BROKER_PAYMENT_MODE,
  }, { broker, route });
  const core = brokerProposalCore({
    deploymentId: verifiedRfq.deploymentId,
    broker,
    issuedAt: now,
    expiresAt,
    rfq: verifiedRfq,
    quotes: verifiedQuotes,
    policy: route.policy,
    fee,
    route,
  });
  const proposalId = brokerProposalId(core);
  return {
    ...core,
    proposalId,
    signature: await signer.signMessage(canonicalJson(core)),
  };
}

function verifyBrokerRouteProposal(input, {
  now = Math.floor(Date.now() / 1000),
  deploymentId,
  rfqId,
  maxReferenceAgeSeconds,
  temporal = true,
} = {}) {
  exactKeys(input, [
    "schema",
    "schemaVersion",
    "deploymentId",
    "broker",
    "issuedAt",
    "expiresAt",
    "rfq",
    "quotes",
    "policy",
    "fee",
    "route",
    "proposalId",
    "signature",
  ], "broker proposal");
  if (
    input.schema !== FX_BROKER_ROUTE_SCHEMA ||
    input.schemaVersion !== FX_BROKER_VERSION
  ) {
    throw new FxBrokerError("broker proposal schema is unsupported");
  }
  const broker = address(input.broker, "broker");
  const issuedAt = integer(input.issuedAt, "issuedAt", { allowZero: false });
  const expiresAt = integer(input.expiresAt, "expiresAt", { allowZero: false });
  if (expiresAt <= issuedAt || (temporal && (issuedAt > now || expiresAt < now))) {
    throw new FxBrokerError("broker proposal lifetime is invalid", "EXPIRED_PROPOSAL");
  }
  const validationNow = temporal ? now : issuedAt;
  const rfq = verifyFxEnvelope(input.rfq, {
    now: validationNow,
    clockSkewSeconds: 0,
    temporal,
  });
  if (rfq.type !== "fx_rfq") {
    throw new FxBrokerError("broker proposal does not contain an RFQ");
  }
  const normalizedDeployment = hash(input.deploymentId, "deploymentId");
  if (rfq.deploymentId !== normalizedDeployment) {
    throw new FxBrokerError("broker proposal deployment does not match its RFQ");
  }
  if (deploymentId && normalizedDeployment !== hash(deploymentId, "expected deploymentId")) {
    throw new FxBrokerError("broker proposal targets another deployment", "DEPLOYMENT_MISMATCH");
  }
  if (rfqId && rfq.id !== hash(rfqId, "expected rfqId")) {
    throw new FxBrokerError("broker proposal targets another RFQ", "RFQ_MISMATCH");
  }
  const quotes = verifyQuoteSet(rfq, input.quotes, {
    now: validationNow,
    maxReferenceAgeSeconds,
  });
  const route = selectSingleDealerRoute(
    rfq,
    quotes.map((quote) => ({
      quote,
      brokerFeeAtomic: input.fee?.amountAtomic,
    })),
    {
      now: validationNow,
      policy: input.policy,
      maxReferenceAgeSeconds,
    }
  );
  if (!jsonEqual(route, input.route)) {
    throw new FxBrokerError(
      "broker route does not match local deterministic recomputation",
      "ROUTE_MISMATCH"
    );
  }
  const fee = normalizeFee(input.fee, { broker, route });
  if (input.expiresAt > rfq.expiresAt || input.expiresAt > rfq.payload.quoteDeadline) {
    throw new FxBrokerError("broker proposal outlives its RFQ");
  }
  const selectedQuote = quotes.find((quote) => quote.id === route.quoteId);
  if (!selectedQuote || input.expiresAt > selectedQuote.expiresAt) {
    throw new FxBrokerError("broker proposal outlives its selected quote");
  }
  const core = brokerProposalCore({
    deploymentId: normalizedDeployment,
    broker,
    issuedAt,
    expiresAt,
    rfq,
    quotes,
    policy: route.policy,
    fee,
    route,
  });
  const proposalId = brokerProposalId(core);
  if (hash(input.proposalId, "proposalId") !== proposalId) {
    throw new FxBrokerError("broker proposal id is invalid", "BAD_PROPOSAL_ID");
  }
  let recovered;
  try {
    recovered = verifyMessage(canonicalJson(core), signature(input.signature)).toLowerCase();
  } catch {
    throw new FxBrokerError("broker proposal signature is invalid", "BAD_SIGNATURE");
  }
  if (recovered !== broker) {
    throw new FxBrokerError("broker proposal signature does not match broker", "BAD_SIGNATURE");
  }
  return { ...core, proposalId, signature: input.signature };
}

function compileSelfRoutedProposal(rfq, quotes, {
  now = Math.floor(Date.now() / 1000),
  policy,
  maxReferenceAgeSeconds,
} = {}) {
  const verifiedRfq = verifyFxEnvelope(rfq, { now, clockSkewSeconds: 0 });
  if (verifiedRfq.type !== "fx_rfq") {
    throw new FxBrokerError("self-routing requires an fx_rfq");
  }
  const verifiedQuotes = verifyQuoteSet(verifiedRfq, quotes, {
    now,
    maxReferenceAgeSeconds,
  });
  const route = selectSingleDealerRoute(
    verifiedRfq,
    verifiedQuotes.map((quote) => ({ quote, brokerFeeAtomic: "0" })),
    { now, policy: policy || verifiedRfq.payload.quotePolicy, maxReferenceAgeSeconds }
  );
  return {
    mode: "self-routed",
    broker: ZERO_ADDRESS,
    fee: {
      recipient: ZERO_ADDRESS,
      chainId: route.inputChainId,
      token: route.inputToken,
      amountAtomic: "0",
      paymentMode: "none",
    },
    rfq: verifiedRfq,
    quotes: verifiedQuotes,
    route,
  };
}

function compareBrokerRouteProposals(inputs, options = {}) {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 16) {
    throw new FxBrokerError("broker comparison requires 1 to 16 proposals");
  }
  let proposals = inputs.map((proposal) =>
    verifyBrokerRouteProposal(proposal, options)
  );
  const rfqIds = new Set(proposals.map((proposal) => proposal.rfq.id));
  if (rfqIds.size !== 1) {
    throw new FxBrokerError("broker proposals do not answer the same RFQ", "RFQ_MISMATCH");
  }
  if ((options.inputChainId === undefined) !== (options.inputToken === undefined)) {
    throw new FxBrokerError("inputChainId and inputToken must be selected together");
  }
  if (options.inputChainId !== undefined) {
    const inputChainId = uint(options.inputChainId, "inputChainId", { allowZero: false });
    const inputToken = address(options.inputToken, "inputToken", { allowZero: true });
    proposals = proposals.filter((proposal) =>
      proposal.route.inputChainId === inputChainId &&
      proposal.route.inputToken === inputToken
    );
    if (proposals.length === 0) {
      throw new FxBrokerError("no broker route uses the selected input asset", "NO_VALID_BROKER");
    }
  }
  const inputAssets = new Set(proposals.map((proposal) =>
    `${proposal.route.inputChainId}:${proposal.route.inputToken}`
  ));
  if (inputAssets.size !== 1) {
    throw new FxBrokerError(
      "broker routes use incomparable input assets; select one input asset first",
      "AMBIGUOUS_INPUT_ASSET"
    );
  }
  const policy = proposals[0].route.policy;
  proposals.sort((left, right) => {
    if (
      policy === "fastest" &&
      left.route.estimatedCompletionSeconds !== right.route.estimatedCompletionSeconds
    ) {
      return left.route.estimatedCompletionSeconds - right.route.estimatedCompletionSeconds;
    }
    const leftInput = BigInt(left.route.totalInputAtomic);
    const rightInput = BigInt(right.route.totalInputAtomic);
    if (leftInput !== rightInput) return leftInput < rightInput ? -1 : 1;
    if (
      policy !== "fastest" &&
      left.route.estimatedCompletionSeconds !== right.route.estimatedCompletionSeconds
    ) {
      return left.route.estimatedCompletionSeconds - right.route.estimatedCompletionSeconds;
    }
    return left.proposalId.localeCompare(right.proposalId);
  });
  return {
    selected: proposals[0],
    proposals,
    inputAsset: {
      chainId: proposals[0].route.inputChainId,
      token: proposals[0].route.inputToken,
    },
  };
}

function feeVoucherCore({
  proposalId,
  tradeId,
  requester,
  broker,
  fee,
  issuedAt,
  expiresAt,
  nonce,
}) {
  return {
    schema: FX_BROKER_FEE_VOUCHER_SCHEMA,
    schemaVersion: FX_BROKER_VERSION,
    proposalId,
    tradeId,
    requester,
    broker,
    fee,
    issuedAt,
    expiresAt,
    nonce,
  };
}

async function createBrokerFeeVoucher({
  signer,
  proposal,
  nonce,
  now = Math.floor(Date.now() / 1000),
  expiresAt = proposal?.rfq?.payload?.settlementDeadline,
}) {
  if (!signer || typeof signer.signMessage !== "function") {
    throw new TypeError("fee voucher requires a requester signer");
  }
  const verifiedProposal = verifyBrokerRouteProposal(proposal, { now });
  const requester = address(await signer.getAddress(), "requester");
  if (requester !== verifiedProposal.rfq.sender) {
    throw new FxBrokerError("fee voucher signer does not own the RFQ", "WRONG_REQUESTER");
  }
  const normalizedExpiry = integer(expiresAt, "expiresAt", { allowZero: false });
  if (normalizedExpiry <= now || normalizedExpiry > verifiedProposal.rfq.payload.settlementDeadline) {
    throw new FxBrokerError("fee voucher expiry is invalid");
  }
  const core = feeVoucherCore({
    proposalId: verifiedProposal.proposalId,
    tradeId: verifiedProposal.rfq.tradeId,
    requester,
    broker: verifiedProposal.broker,
    fee: verifiedProposal.fee,
    issuedAt: now,
    expiresAt: normalizedExpiry,
    nonce: hash(nonce, "nonce"),
  });
  const voucherId = keccak256(toUtf8Bytes(canonicalJson(core)));
  return {
    ...core,
    voucherId,
    signature: await signer.signMessage(canonicalJson(core)),
  };
}

function verifyBrokerFeeVoucher(input, proposal, {
  now = Math.floor(Date.now() / 1000),
  temporal = true,
} = {}) {
  exactKeys(input, [
    "schema",
    "schemaVersion",
    "proposalId",
    "tradeId",
    "requester",
    "broker",
    "fee",
    "issuedAt",
    "expiresAt",
    "nonce",
    "voucherId",
    "signature",
  ], "fee voucher");
  if (
    input.schema !== FX_BROKER_FEE_VOUCHER_SCHEMA ||
    input.schemaVersion !== FX_BROKER_VERSION
  ) {
    throw new FxBrokerError("fee voucher schema is unsupported");
  }
  const verifiedProposal = verifyBrokerRouteProposal(proposal, { now, temporal });
  const core = feeVoucherCore({
    proposalId: hash(input.proposalId, "proposalId"),
    tradeId: hash(input.tradeId, "tradeId"),
    requester: address(input.requester, "requester"),
    broker: address(input.broker, "broker"),
    fee: normalizeFee(input.fee, {
      broker: verifiedProposal.broker,
      route: verifiedProposal.route,
    }),
    issuedAt: integer(input.issuedAt, "issuedAt", { allowZero: false }),
    expiresAt: integer(input.expiresAt, "expiresAt", { allowZero: false }),
    nonce: hash(input.nonce, "nonce"),
  });
  if (
    core.proposalId !== verifiedProposal.proposalId ||
    core.tradeId !== verifiedProposal.rfq.tradeId ||
    core.requester !== verifiedProposal.rfq.sender ||
    core.broker !== verifiedProposal.broker ||
    !jsonEqual(core.fee, verifiedProposal.fee)
  ) {
    throw new FxBrokerError("fee voucher does not match its broker proposal", "VOUCHER_MISMATCH");
  }
  if (
    core.expiresAt <= core.issuedAt ||
    core.expiresAt > verifiedProposal.rfq.payload.settlementDeadline ||
    (temporal && (core.issuedAt > now || core.expiresAt < now))
  ) {
    throw new FxBrokerError("fee voucher lifetime is invalid", "EXPIRED_VOUCHER");
  }
  const voucherId = keccak256(toUtf8Bytes(canonicalJson(core)));
  if (hash(input.voucherId, "voucherId") !== voucherId) {
    throw new FxBrokerError("fee voucher id is invalid", "BAD_VOUCHER_ID");
  }
  let recovered;
  try {
    recovered = verifyMessage(canonicalJson(core), signature(input.signature)).toLowerCase();
  } catch {
    throw new FxBrokerError("fee voucher signature is invalid", "BAD_SIGNATURE");
  }
  if (recovered !== core.requester) {
    throw new FxBrokerError("fee voucher signature does not match requester", "BAD_SIGNATURE");
  }
  return { ...core, voucherId, signature: input.signature };
}

function normalizeCompletionEvidence(evidence, proposal, voucher) {
  exactKeys(
    evidence,
    ["accept", "sourceClaim", "destinationClaim", "complete"],
    "completion evidence"
  );
  const accept = verifyFxEnvelope(evidence.accept, { temporal: false });
  const sourceClaim = verifyFxEnvelope(evidence.sourceClaim, { temporal: false });
  const destinationClaim = verifyFxEnvelope(evidence.destinationClaim, { temporal: false });
  const complete = verifyFxEnvelope(evidence.complete, { temporal: false });
  const messages = [accept, sourceClaim, destinationClaim, complete];
  if (messages.some((message) =>
    message.deploymentId !== proposal.deploymentId ||
    message.tradeId !== proposal.rfq.tradeId
  )) {
    throw new FxBrokerError("completion evidence belongs to another trade", "EVIDENCE_SCOPE_MISMATCH");
  }
  if (
    accept.type !== "fx_accept" ||
    accept.sender !== proposal.rfq.sender ||
    accept.payload.rfqId !== proposal.rfq.id ||
    accept.payload.quoteId !== proposal.route.quoteId ||
    accept.payload.routeId !== proposal.route.routeId ||
    accept.payload.dealerInputAmountAtomic !==
      proposal.quotes.find((quote) => quote.id === proposal.route.quoteId)
        ?.payload.inputAmountAtomic ||
    accept.payload.brokerFeeAtomic !== proposal.fee.amountAtomic ||
    accept.payload.totalInputAtomic !== proposal.route.totalInputAtomic ||
    accept.payload.outputAmountAtomic !== proposal.route.outputAmountAtomic ||
    sourceClaim.type !== "fx_claim" ||
    sourceClaim.payload.chainId !== proposal.route.inputChainId ||
    sourceClaim.payload.beneficiary !== proposal.route.dealer ||
    destinationClaim.type !== "fx_claim" ||
    destinationClaim.payload.chainId !== proposal.route.outputChainId ||
    destinationClaim.payload.beneficiary !== accept.payload.destinationClaimAddress ||
    sourceClaim.payload.secretHash !== accept.payload.secretHash ||
    destinationClaim.payload.secretHash !== accept.payload.secretHash ||
    complete.type !== "fx_complete" ||
    complete.payload.acceptId !== accept.id ||
    complete.payload.sourceClaimMessageId !== sourceClaim.id ||
    complete.payload.destinationClaimMessageId !== destinationClaim.id ||
    voucher.tradeId !== accept.tradeId
  ) {
    throw new FxBrokerError(
      "completion evidence does not prove the accepted route",
      "INVALID_COMPLETION_EVIDENCE"
    );
  }
  return { accept, sourceClaim, destinationClaim, complete };
}

async function verifyBrokerFeeClaim({
  proposal,
  voucher,
  evidence,
  verifyChainClaim,
  now = Math.floor(Date.now() / 1000),
}) {
  if (typeof verifyChainClaim !== "function") {
    throw new TypeError("fee claim requires an independent chain-claim verifier");
  }
  const verifiedProposal = verifyBrokerRouteProposal(proposal, {
    now,
    temporal: false,
  });
  const verifiedVoucher = verifyBrokerFeeVoucher(voucher, verifiedProposal, {
    now,
    temporal: false,
  });
  if (verifiedVoucher.expiresAt < now) {
    throw new FxBrokerError("fee voucher has expired", "EXPIRED_VOUCHER");
  }
  const verifiedEvidence = normalizeCompletionEvidence(
    evidence,
    verifiedProposal,
    verifiedVoucher
  );
  for (const [side, claim] of [
    ["source", verifiedEvidence.sourceClaim],
    ["destination", verifiedEvidence.destinationClaim],
  ]) {
    const result = await verifyChainClaim({
      side,
      claim,
      accept: verifiedEvidence.accept,
      proposal: verifiedProposal,
    });
    if (result !== true && result?.confirmed !== true) {
      throw new FxBrokerError(
        `${side} claim is not independently confirmed`,
        "UNCONFIRMED_COMPLETION"
      );
    }
  }
  return {
    claimId: keccak256(toUtf8Bytes(canonicalJson({
      voucherId: verifiedVoucher.voucherId,
      completionId: verifiedEvidence.complete.id,
    }))),
    proposal: verifiedProposal,
    voucher: verifiedVoucher,
    evidence: verifiedEvidence,
  };
}

class FxBrokerFeeLedger {
  constructor() {
    this.escrows = new Map();
    this.claims = new Map();
  }

  escrow(voucher, proposal, options = {}) {
    const verified = verifyBrokerFeeVoucher(voucher, proposal, options);
    const existing = this.escrows.get(verified.voucherId);
    if (existing) return structuredClone(existing);
    const entry = {
      voucherId: verified.voucherId,
      state: "escrowed",
      broker: verified.broker,
      fee: verified.fee,
    };
    this.escrows.set(verified.voucherId, entry);
    return structuredClone(entry);
  }

  async claim(input) {
    const verified = await verifyBrokerFeeClaim(input);
    const escrow = this.escrows.get(verified.voucher.voucherId);
    if (!escrow) {
      throw new FxBrokerError("fee voucher was never escrowed", "MISSING_ESCROW");
    }
    if (escrow.state !== "escrowed") {
      throw new FxBrokerError("fee voucher was already consumed", "DUPLICATE_FEE_CLAIM");
    }
    escrow.state = "paid";
    escrow.claimId = verified.claimId;
    escrow.completionId = verified.evidence.complete.id;
    this.claims.set(verified.claimId, { ...escrow });
    return structuredClone(escrow);
  }
}

module.exports = {
  FX_BROKER_FEE_VOUCHER_SCHEMA,
  FX_BROKER_METRICS_SCHEMA,
  FX_BROKER_PAYMENT_MODE,
  FX_BROKER_ROUTE_SCHEMA,
  FX_BROKER_VERSION,
  FxBrokerError,
  FxBrokerFeeLedger,
  ZERO_ADDRESS,
  brokerProposalId,
  compareBrokerRouteProposals,
  compileSelfRoutedProposal,
  createBrokerFeeVoucher,
  createBrokerRouteProposal,
  verifyBrokerFeeClaim,
  verifyBrokerFeeVoucher,
  verifyBrokerRouteProposal,
};
