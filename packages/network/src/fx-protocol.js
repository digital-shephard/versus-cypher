const {
  getAddress,
  isAddress,
  keccak256,
  toUtf8Bytes,
  verifyMessage,
} = require("ethers");

const FX_PROTOCOL = "versus-fx";
const FX_VERSION = 1;
const FX_QUOTE_TYPE = "fixed_exact_output";
const FX_MAX_CLOCK_SKEW_SECONDS = 300;
const FX_MAX_REFERENCE_AGE_SECONDS = 60;
const FX_MAX_INPUT_OPTIONS = 4;
const FX_MAX_EVIDENCE_IDS = 16;

const FX_MESSAGE_TYPES = Object.freeze([
  "fx_rfq",
  "fx_quote",
  "fx_accept",
  "fx_reserve",
  "fx_cancel",
  "fx_lock_source",
  "fx_lock_destination",
  "fx_claim",
  "fx_refund",
  "fx_complete",
  "fx_default",
  "fx_dispute",
]);

const FX_ROLES = Object.freeze(["requester", "dealer", "broker", "relayer"]);
const FX_ROUTE_POLICIES = Object.freeze(["lowest_all_in", "fastest"]);

const ROLE_BY_TYPE = Object.freeze({
  fx_rfq: Object.freeze(["requester"]),
  fx_quote: Object.freeze(["dealer"]),
  fx_accept: Object.freeze(["requester"]),
  fx_reserve: Object.freeze(["dealer"]),
  fx_cancel: Object.freeze(["requester"]),
  fx_lock_source: Object.freeze(["requester"]),
  fx_lock_destination: Object.freeze(["dealer"]),
  fx_claim: Object.freeze(["requester", "dealer", "relayer"]),
  fx_refund: Object.freeze(["requester", "dealer", "relayer"]),
  fx_complete: Object.freeze(["requester", "dealer", "broker", "relayer"]),
  fx_default: Object.freeze(["requester", "dealer"]),
  fx_dispute: Object.freeze(["requester", "dealer"]),
});

const MAX_LIFETIME_BY_TYPE = Object.freeze({
  fx_rfq: 60,
  fx_quote: 60,
  fx_accept: 10 * 60,
  fx_reserve: 10 * 60,
  fx_cancel: 60,
  fx_lock_source: 30 * 24 * 60 * 60,
  fx_lock_destination: 30 * 24 * 60 * 60,
  fx_claim: 30 * 24 * 60 * 60,
  fx_refund: 30 * 24 * 60 * 60,
  fx_complete: 30 * 24 * 60 * 60,
  fx_default: 30 * 24 * 60 * 60,
  fx_dispute: 30 * 24 * 60 * 60,
});

const FX_SETTLEMENT_TRANSITIONS = Object.freeze({
  idle: Object.freeze({ publish_rfq: "rfq_open" }),
  rfq_open: Object.freeze({
    accept_quote: "quote_accepted",
    expire_rfq: "expired",
  }),
  quote_accepted: Object.freeze({
    confirm_source_lock: "source_locked",
    cancel_before_source_lock: "cancelled",
  }),
  source_locked: Object.freeze({
    confirm_destination_lock: "destination_locked",
    confirm_source_refund: "refunded",
  }),
  destination_locked: Object.freeze({
    confirm_destination_claim: "destination_claimed",
    confirm_destination_refund: "destination_refunded",
  }),
  destination_claimed: Object.freeze({
    confirm_source_claim: "complete",
  }),
  destination_refunded: Object.freeze({
    confirm_source_refund: "refunded",
  }),
  complete: Object.freeze({}),
  refunded: Object.freeze({}),
  expired: Object.freeze({}),
  cancelled: Object.freeze({}),
});

const FX_CASE_TRANSITIONS = Object.freeze({
  none: Object.freeze({ report_default: "reported" }),
  reported: Object.freeze({
    open_dispute: "disputed",
    resolve_upheld: "resolved_upheld",
    resolve_rejected: "resolved_rejected",
  }),
  disputed: Object.freeze({
    resolve_upheld: "resolved_upheld",
    resolve_rejected: "resolved_rejected",
  }),
  resolved_upheld: Object.freeze({}),
  resolved_rejected: Object.freeze({}),
});

const FX_PRIVACY_CLASSES = Object.freeze({
  publicDiscovery: Object.freeze([
    "deploymentId",
    "type",
    "tradeId",
    "sender",
    "role",
    "sequence",
    "createdAt",
    "expiresAt",
    "outputChainId",
    "outputToken",
    "outputAmountAtomic",
    "inputOptions",
    "quotePolicy",
  ]),
  selectedCounterparty: Object.freeze([
    "sourceRefundAddress",
    "destinationClaimAddress",
    "dealerSourceClaimAddress",
    "dealerDestinationRefundAddress",
    "secretHash",
  ]),
  chainPublicAfterBroadcast: Object.freeze([
    "lockAddress",
    "beneficiary",
    "refundAddress",
    "transactionHash",
    "blockNumber",
    "timeout",
  ]),
  localSecret: Object.freeze(["secret", "walletPrivateKeys", "unrelatedWalletHistory"]),
});

const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;
const IDENTIFIER_PATTERN = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/;

class FxValidationError extends Error {
  constructor(message, code = "INVALID_FX_MESSAGE") {
    super(message);
    this.name = "FxValidationError";
    this.code = code;
  }
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FxValidationError(`${label} must be an object`);
  }
}

function assertAllowedKeys(value, keys, label) {
  assertPlainObject(value, label);
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new FxValidationError(`${label} contains unsupported field ${key}`, "UNKNOWN_FIELD");
    }
  }
}

function normalizeAddress(value, label) {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new FxValidationError(`${label} must be an ethereum address`);
  }
  return getAddress(value).toLowerCase();
}

function normalizeHash(value, label) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new FxValidationError(`${label} must be a lowercase bytes32 hash`);
  }
  return value;
}

function normalizeNullableHash(value, label) {
  if (value === null) return null;
  return normalizeHash(value, label);
}

function normalizeUintString(value, label, { allowZero = true, maxDigits = 78 } = {}) {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    throw new FxValidationError(`${label} must be an unsigned integer`);
  }
  const text = String(value);
  if (!/^\d+$/.test(text) || text.length > maxDigits) {
    throw new FxValidationError(`${label} must be an unsigned integer`);
  }
  const normalized = BigInt(text).toString();
  if (!allowZero && normalized === "0") {
    throw new FxValidationError(`${label} must be greater than zero`);
  }
  return normalized;
}

function normalizeSafeInteger(value, label, { allowZero = true } = {}) {
  if (typeof value === "string" && /^\d+$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new FxValidationError(`${label} must be a safe unsigned integer`);
  }
  return value;
}

function normalizeIdentifier(value, label, maxLength = 64) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new FxValidationError(`${label} must be a lowercase protocol identifier`);
  }
  return value;
}

function normalizeEnum(value, allowed, label) {
  const text = String(value || "");
  if (!allowed.includes(text)) {
    throw new FxValidationError(`${label} is unsupported`);
  }
  return text;
}

function normalizeEvidenceIds(value, label = "evidenceIds") {
  if (!Array.isArray(value) || value.length < 1 || value.length > FX_MAX_EVIDENCE_IDS) {
    throw new FxValidationError(`${label} must contain 1 to ${FX_MAX_EVIDENCE_IDS} message ids`);
  }
  const normalized = value.map((item, index) => normalizeHash(item, `${label}[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    throw new FxValidationError(`${label} must not contain duplicates`);
  }
  return [...normalized].sort();
}

function normalizeInputOption(value, index) {
  const label = `payload.inputOptions[${index}]`;
  assertAllowedKeys(value, ["chainId", "token", "maxInputAtomic"], label);
  return {
    chainId: normalizeUintString(value.chainId, `${label}.chainId`, { allowZero: false }),
    token: normalizeAddress(value.token, `${label}.token`),
    maxInputAtomic: normalizeUintString(value.maxInputAtomic, `${label}.maxInputAtomic`, {
      allowZero: false,
    }),
  };
}

function normalizeInputOptions(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > FX_MAX_INPUT_OPTIONS) {
    throw new FxValidationError(
      `payload.inputOptions must contain 1 to ${FX_MAX_INPUT_OPTIONS} options`
    );
  }
  const normalized = value.map(normalizeInputOption);
  normalized.sort((left, right) =>
    `${left.chainId}:${left.token}:${left.maxInputAtomic}`.localeCompare(
      `${right.chainId}:${right.token}:${right.maxInputAtomic}`
    )
  );
  const identities = normalized.map((item) => `${item.chainId}:${item.token}`);
  if (new Set(identities).size !== identities.length) {
    throw new FxValidationError("payload.inputOptions must not repeat a chain and token");
  }
  return normalized;
}

function normalizeRfqPayload(value, envelope) {
  assertAllowedKeys(value, [
    "outputChainId",
    "outputToken",
    "outputAmountAtomic",
    "inputOptions",
    "quoteDeadline",
    "settlementDeadline",
    "quotePolicy",
    "x402Commitment",
  ], "payload");
  const quoteDeadline = normalizeSafeInteger(value.quoteDeadline, "payload.quoteDeadline", {
    allowZero: false,
  });
  const settlementDeadline = normalizeSafeInteger(
    value.settlementDeadline,
    "payload.settlementDeadline",
    { allowZero: false }
  );
  if (quoteDeadline < envelope.createdAt || quoteDeadline > envelope.expiresAt) {
    throw new FxValidationError("payload.quoteDeadline must be within the RFQ lifetime");
  }
  if (settlementDeadline <= quoteDeadline) {
    throw new FxValidationError("payload.settlementDeadline must follow the quote deadline");
  }
  return {
    outputChainId: normalizeUintString(value.outputChainId, "payload.outputChainId", {
      allowZero: false,
    }),
    outputToken: normalizeAddress(value.outputToken, "payload.outputToken"),
    outputAmountAtomic: normalizeUintString(
      value.outputAmountAtomic,
      "payload.outputAmountAtomic",
      { allowZero: false }
    ),
    inputOptions: normalizeInputOptions(value.inputOptions),
    quoteDeadline,
    settlementDeadline,
    quotePolicy: normalizeEnum(value.quotePolicy, FX_ROUTE_POLICIES, "payload.quotePolicy"),
    x402Commitment: normalizeNullableHash(value.x402Commitment, "payload.x402Commitment"),
  };
}

function normalizeQuotePayload(value) {
  assertAllowedKeys(value, [
    "rfqId",
    "inputChainId",
    "inputToken",
    "inputAmountAtomic",
    "outputChainId",
    "outputToken",
    "outputAmountAtomic",
    "quoteType",
    "referenceSource",
    "referencePriceMicros",
    "referenceTimestamp",
    "spreadBps",
    "dealerSettlementCostAtomic",
    "estimatedCompletionSeconds",
    "adapterId",
    "adapterVersion",
  ], "payload");
  const spreadBps = normalizeSafeInteger(value.spreadBps, "payload.spreadBps");
  if (spreadBps > 10_000) {
    throw new FxValidationError("payload.spreadBps must not exceed 10000");
  }
  return {
    rfqId: normalizeHash(value.rfqId, "payload.rfqId"),
    inputChainId: normalizeUintString(value.inputChainId, "payload.inputChainId", {
      allowZero: false,
    }),
    inputToken: normalizeAddress(value.inputToken, "payload.inputToken"),
    inputAmountAtomic: normalizeUintString(value.inputAmountAtomic, "payload.inputAmountAtomic", {
      allowZero: false,
    }),
    outputChainId: normalizeUintString(value.outputChainId, "payload.outputChainId", {
      allowZero: false,
    }),
    outputToken: normalizeAddress(value.outputToken, "payload.outputToken"),
    outputAmountAtomic: normalizeUintString(
      value.outputAmountAtomic,
      "payload.outputAmountAtomic",
      { allowZero: false }
    ),
    quoteType: normalizeEnum(value.quoteType, [FX_QUOTE_TYPE], "payload.quoteType"),
    referenceSource: normalizeIdentifier(value.referenceSource, "payload.referenceSource"),
    referencePriceMicros: normalizeUintString(
      value.referencePriceMicros,
      "payload.referencePriceMicros",
      { allowZero: false }
    ),
    referenceTimestamp: normalizeSafeInteger(
      value.referenceTimestamp,
      "payload.referenceTimestamp",
      { allowZero: false }
    ),
    spreadBps,
    dealerSettlementCostAtomic: normalizeUintString(
      value.dealerSettlementCostAtomic,
      "payload.dealerSettlementCostAtomic"
    ),
    estimatedCompletionSeconds: normalizeSafeInteger(
      value.estimatedCompletionSeconds,
      "payload.estimatedCompletionSeconds",
      { allowZero: false }
    ),
    adapterId: normalizeIdentifier(value.adapterId, "payload.adapterId"),
    adapterVersion: normalizeSafeInteger(value.adapterVersion, "payload.adapterVersion", {
      allowZero: false,
    }),
  };
}

function normalizeAcceptPayload(value) {
  assertAllowedKeys(value, [
    "rfqId",
    "quoteId",
    "routeId",
    "dealerInputAmountAtomic",
    "brokerFeeAtomic",
    "totalInputAtomic",
    "outputAmountAtomic",
    "secretHash",
    "sourceRefundAddress",
    "destinationClaimAddress",
    "sourceAdapterId",
    "sourceAdapterVersion",
    "destinationAdapterId",
    "destinationAdapterVersion",
  ], "payload");
  const dealerInputAmountAtomic = normalizeUintString(
    value.dealerInputAmountAtomic,
    "payload.dealerInputAmountAtomic",
    { allowZero: false }
  );
  const brokerFeeAtomic = normalizeUintString(
    value.brokerFeeAtomic,
    "payload.brokerFeeAtomic"
  );
  const totalInputAtomic = normalizeUintString(
    value.totalInputAtomic,
    "payload.totalInputAtomic",
    { allowZero: false }
  );
  if (
    BigInt(dealerInputAmountAtomic) + BigInt(brokerFeeAtomic) !==
    BigInt(totalInputAtomic)
  ) {
    throw new FxValidationError(
      "payload.totalInputAtomic must equal dealer input plus broker fee",
      "INVALID_ECONOMICS"
    );
  }
  return {
    rfqId: normalizeHash(value.rfqId, "payload.rfqId"),
    quoteId: normalizeHash(value.quoteId, "payload.quoteId"),
    routeId: normalizeHash(value.routeId, "payload.routeId"),
    dealerInputAmountAtomic,
    brokerFeeAtomic,
    totalInputAtomic,
    outputAmountAtomic: normalizeUintString(
      value.outputAmountAtomic,
      "payload.outputAmountAtomic",
      { allowZero: false }
    ),
    secretHash: normalizeHash(value.secretHash, "payload.secretHash"),
    sourceRefundAddress: normalizeAddress(
      value.sourceRefundAddress,
      "payload.sourceRefundAddress"
    ),
    destinationClaimAddress: normalizeAddress(
      value.destinationClaimAddress,
      "payload.destinationClaimAddress"
    ),
    sourceAdapterId: normalizeIdentifier(value.sourceAdapterId, "payload.sourceAdapterId"),
    sourceAdapterVersion: normalizeSafeInteger(
      value.sourceAdapterVersion,
      "payload.sourceAdapterVersion",
      { allowZero: false }
    ),
    destinationAdapterId: normalizeIdentifier(
      value.destinationAdapterId,
      "payload.destinationAdapterId"
    ),
    destinationAdapterVersion: normalizeSafeInteger(
      value.destinationAdapterVersion,
      "payload.destinationAdapterVersion",
      { allowZero: false }
    ),
  };
}

function normalizeReservePayload(value, envelope) {
  assertAllowedKeys(value, [
    "acceptId",
    "quoteId",
    "dealerSourceClaimAddress",
    "dealerDestinationRefundAddress",
    "reservationDeadline",
  ], "payload");
  const reservationDeadline = normalizeSafeInteger(
    value.reservationDeadline,
    "payload.reservationDeadline",
    { allowZero: false }
  );
  if (reservationDeadline < envelope.createdAt || reservationDeadline > envelope.expiresAt) {
    throw new FxValidationError("payload.reservationDeadline must be within the message lifetime");
  }
  return {
    acceptId: normalizeHash(value.acceptId, "payload.acceptId"),
    quoteId: normalizeHash(value.quoteId, "payload.quoteId"),
    dealerSourceClaimAddress: normalizeAddress(
      value.dealerSourceClaimAddress,
      "payload.dealerSourceClaimAddress"
    ),
    dealerDestinationRefundAddress: normalizeAddress(
      value.dealerDestinationRefundAddress,
      "payload.dealerDestinationRefundAddress"
    ),
    reservationDeadline,
  };
}

function normalizeCancelPayload(value) {
  assertAllowedKeys(value, [
    "acceptId",
    "reserveId",
    "reason",
  ], "payload");
  return {
    acceptId: normalizeHash(value.acceptId, "payload.acceptId"),
    reserveId: normalizeHash(value.reserveId, "payload.reserveId"),
    reason: normalizeEnum(value.reason, ["owner_cancelled"], "payload.reason"),
  };
}

function normalizeLockPayload(value, envelope) {
  assertAllowedKeys(value, [
    "acceptId",
    "chainId",
    "token",
    "amountAtomic",
    "lockAddress",
    "beneficiary",
    "refundAddress",
    "secretHash",
    "timeout",
    "transactionHash",
    "blockNumber",
  ], "payload");
  const timeout = normalizeSafeInteger(value.timeout, "payload.timeout", { allowZero: false });
  if (timeout <= envelope.createdAt) {
    throw new FxValidationError("payload.timeout must follow the message timestamp");
  }
  return {
    acceptId: normalizeHash(value.acceptId, "payload.acceptId"),
    chainId: normalizeUintString(value.chainId, "payload.chainId", { allowZero: false }),
    token: normalizeAddress(value.token, "payload.token"),
    amountAtomic: normalizeUintString(value.amountAtomic, "payload.amountAtomic", {
      allowZero: false,
    }),
    lockAddress: normalizeAddress(value.lockAddress, "payload.lockAddress"),
    beneficiary: normalizeAddress(value.beneficiary, "payload.beneficiary"),
    refundAddress: normalizeAddress(value.refundAddress, "payload.refundAddress"),
    secretHash: normalizeHash(value.secretHash, "payload.secretHash"),
    timeout,
    transactionHash: normalizeHash(value.transactionHash, "payload.transactionHash"),
    blockNumber: normalizeUintString(value.blockNumber, "payload.blockNumber"),
  };
}

function normalizeClaimPayload(value) {
  assertAllowedKeys(value, [
    "lockMessageId",
    "chainId",
    "transactionHash",
    "blockNumber",
    "secretHash",
    "beneficiary",
  ], "payload");
  return {
    lockMessageId: normalizeHash(value.lockMessageId, "payload.lockMessageId"),
    chainId: normalizeUintString(value.chainId, "payload.chainId", { allowZero: false }),
    transactionHash: normalizeHash(value.transactionHash, "payload.transactionHash"),
    blockNumber: normalizeUintString(value.blockNumber, "payload.blockNumber"),
    secretHash: normalizeHash(value.secretHash, "payload.secretHash"),
    beneficiary: normalizeAddress(value.beneficiary, "payload.beneficiary"),
  };
}

function normalizeRefundPayload(value) {
  assertAllowedKeys(value, [
    "lockMessageId",
    "chainId",
    "transactionHash",
    "blockNumber",
    "beneficiary",
  ], "payload");
  return {
    lockMessageId: normalizeHash(value.lockMessageId, "payload.lockMessageId"),
    chainId: normalizeUintString(value.chainId, "payload.chainId", { allowZero: false }),
    transactionHash: normalizeHash(value.transactionHash, "payload.transactionHash"),
    blockNumber: normalizeUintString(value.blockNumber, "payload.blockNumber"),
    beneficiary: normalizeAddress(value.beneficiary, "payload.beneficiary"),
  };
}

function normalizeCompletePayload(value) {
  assertAllowedKeys(value, [
    "acceptId",
    "sourceClaimMessageId",
    "destinationClaimMessageId",
  ], "payload");
  return {
    acceptId: normalizeHash(value.acceptId, "payload.acceptId"),
    sourceClaimMessageId: normalizeHash(
      value.sourceClaimMessageId,
      "payload.sourceClaimMessageId"
    ),
    destinationClaimMessageId: normalizeHash(
      value.destinationClaimMessageId,
      "payload.destinationClaimMessageId"
    ),
  };
}

function normalizeDefaultPayload(value) {
  assertAllowedKeys(value, [
    "acceptId",
    "reason",
    "missingLeg",
    "observedAt",
    "evidenceIds",
  ], "payload");
  return {
    acceptId: normalizeHash(value.acceptId, "payload.acceptId"),
    reason: normalizeEnum(value.reason, [
      "requester_abandoned",
      "dealer_abandoned",
      "invalid_lock",
      "timeout",
      "chain_unavailable",
      "endpoint_failure",
    ], "payload.reason"),
    missingLeg: normalizeEnum(value.missingLeg, [
      "source_lock",
      "destination_lock",
      "destination_claim",
      "source_claim",
      "endpoint_delivery",
    ], "payload.missingLeg"),
    observedAt: normalizeSafeInteger(value.observedAt, "payload.observedAt", {
      allowZero: false,
    }),
    evidenceIds: normalizeEvidenceIds(value.evidenceIds),
  };
}

function normalizeDisputePayload(value) {
  assertAllowedKeys(value, ["defaultId", "reason", "evidenceIds"], "payload");
  return {
    defaultId: normalizeHash(value.defaultId, "payload.defaultId"),
    reason: normalizeIdentifier(value.reason, "payload.reason"),
    evidenceIds: normalizeEvidenceIds(value.evidenceIds),
  };
}

const PAYLOAD_NORMALIZERS = Object.freeze({
  fx_rfq: normalizeRfqPayload,
  fx_quote: normalizeQuotePayload,
  fx_accept: normalizeAcceptPayload,
  fx_reserve: normalizeReservePayload,
  fx_cancel: normalizeCancelPayload,
  fx_lock_source: normalizeLockPayload,
  fx_lock_destination: normalizeLockPayload,
  fx_claim: normalizeClaimPayload,
  fx_refund: normalizeRefundPayload,
  fx_complete: normalizeCompletePayload,
  fx_default: normalizeDefaultPayload,
  fx_dispute: normalizeDisputePayload,
});

function normalizeFxMessage(input) {
  assertAllowedKeys(input, [
    "protocol",
    "version",
    "deploymentId",
    "type",
    "tradeId",
    "sender",
    "role",
    "sequence",
    "createdAt",
    "expiresAt",
    "payload",
    "signature",
    "id",
  ], "message");

  if (input.protocol !== FX_PROTOCOL) {
    throw new FxValidationError("protocol is unsupported");
  }
  if (input.version !== FX_VERSION) {
    throw new FxValidationError("version is unsupported");
  }

  const type = normalizeEnum(input.type, FX_MESSAGE_TYPES, "type");
  const role = normalizeEnum(input.role, FX_ROLES, "role");
  if (!ROLE_BY_TYPE[type].includes(role)) {
    throw new FxValidationError(`${role} cannot send ${type}`, "ROLE_MISMATCH");
  }
  const createdAt = normalizeSafeInteger(input.createdAt, "createdAt", { allowZero: false });
  const expiresAt = normalizeSafeInteger(input.expiresAt, "expiresAt", { allowZero: false });
  if (
    expiresAt <= createdAt ||
    expiresAt - createdAt > MAX_LIFETIME_BY_TYPE[type]
  ) {
    throw new FxValidationError(`${type} has an invalid lifetime`);
  }

  const envelope = {
    protocol: FX_PROTOCOL,
    version: FX_VERSION,
    deploymentId: normalizeHash(input.deploymentId, "deploymentId"),
    type,
    tradeId: normalizeHash(input.tradeId, "tradeId"),
    sender: normalizeAddress(input.sender, "sender"),
    role,
    sequence: normalizeUintString(input.sequence, "sequence"),
    createdAt,
    expiresAt,
  };
  return {
    ...envelope,
    payload: PAYLOAD_NORMALIZERS[type](input.payload, envelope),
  };
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new FxValidationError("canonical JSON only supports safe integer numbers");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  assertPlainObject(value, "canonical value");
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function canonicalFxMessage(input) {
  return canonicalJson(normalizeFxMessage(input));
}

function computeFxMessageId(input) {
  return keccak256(toUtf8Bytes(canonicalFxMessage(input)));
}

function assembleFxEnvelope(input, signature) {
  const normalized = normalizeFxMessage(input);
  if (typeof signature !== "string" || !SIGNATURE_PATTERN.test(signature)) {
    throw new FxValidationError("signature must be a 65 byte hex value");
  }
  return {
    ...normalized,
    signature,
    id: computeFxMessageId(normalized),
  };
}

function verifyFxEnvelope(envelope, options = {}) {
  assertPlainObject(envelope, "envelope");
  const normalized = normalizeFxMessage(envelope);
  const expectedId = computeFxMessageId(normalized);
  if (envelope.id !== expectedId) {
    throw new FxValidationError("message id does not match its payload", "BAD_ID");
  }
  if (typeof envelope.signature !== "string" || !SIGNATURE_PATTERN.test(envelope.signature)) {
    throw new FxValidationError("signature must be a 65 byte hex value", "BAD_SIGNATURE");
  }
  let recovered;
  try {
    recovered = verifyMessage(canonicalFxMessage(normalized), envelope.signature).toLowerCase();
  } catch (_) {
    throw new FxValidationError("message signature is invalid", "BAD_SIGNATURE");
  }
  if (recovered !== normalized.sender) {
    throw new FxValidationError("message signature does not match sender", "BAD_SIGNATURE");
  }

  if (options.temporal !== false) {
    const now = options.now ?? Math.floor(Date.now() / 1000);
    const clockSkew = options.clockSkewSeconds ?? FX_MAX_CLOCK_SKEW_SECONDS;
    if (normalized.createdAt > now + clockSkew) {
      throw new FxValidationError("message is too far in the future", "FUTURE_MESSAGE");
    }
    if (normalized.expiresAt < now - clockSkew) {
      throw new FxValidationError("message has expired", "EXPIRED_MESSAGE");
    }
  }
  return {
    ...normalized,
    signature: envelope.signature,
    id: expectedId,
  };
}

function advanceFxState(currentState, event) {
  const transitions = FX_SETTLEMENT_TRANSITIONS[currentState];
  if (!transitions) throw new FxValidationError(`unknown settlement state ${currentState}`);
  const next = transitions[event];
  if (!next) {
    throw new FxValidationError(
      `event ${event} is invalid from settlement state ${currentState}`,
      "INVALID_STATE_TRANSITION"
    );
  }
  return next;
}

function advanceFxCaseState(currentState, event) {
  const transitions = FX_CASE_TRANSITIONS[currentState];
  if (!transitions) throw new FxValidationError(`unknown case state ${currentState}`);
  const next = transitions[event];
  if (!next) {
    throw new FxValidationError(
      `event ${event} is invalid from case state ${currentState}`,
      "INVALID_CASE_TRANSITION"
    );
  }
  return next;
}

function selectSingleDealerRoute(rfqEnvelope, candidates, options = {}) {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const maxReferenceAgeSeconds =
    options.maxReferenceAgeSeconds ?? FX_MAX_REFERENCE_AGE_SECONDS;
  const rfq = verifyFxEnvelope(rfqEnvelope, { now, clockSkewSeconds: 0 });
  if (rfq.type !== "fx_rfq") {
    throw new FxValidationError("route selection requires an fx_rfq");
  }
  if (!Array.isArray(candidates) || candidates.length < 1) {
    throw new FxValidationError("route selection requires at least one quote");
  }

  const valid = [];
  for (const candidate of candidates) {
    assertAllowedKeys(candidate, ["quote", "brokerFeeAtomic"], "route candidate");
    let quote;
    try {
      quote = verifyFxEnvelope(candidate.quote, { now, clockSkewSeconds: 0 });
    } catch (_) {
      continue;
    }
    if (quote.type !== "fx_quote") continue;
    if (quote.deploymentId !== rfq.deploymentId || quote.tradeId !== rfq.tradeId) continue;
    if (quote.payload.rfqId !== rfq.id) continue;
    if (quote.createdAt > rfq.payload.quoteDeadline || quote.expiresAt < now) continue;
    if (quote.payload.referenceTimestamp > now) continue;
    if (now - quote.payload.referenceTimestamp > maxReferenceAgeSeconds) continue;
    if (
      quote.payload.outputChainId !== rfq.payload.outputChainId ||
      quote.payload.outputToken !== rfq.payload.outputToken ||
      quote.payload.outputAmountAtomic !== rfq.payload.outputAmountAtomic
    ) {
      continue;
    }
    const inputOption = rfq.payload.inputOptions.find(
      (option) =>
        option.chainId === quote.payload.inputChainId &&
        option.token === quote.payload.inputToken
    );
    if (!inputOption) continue;
    const brokerFeeAtomic = normalizeUintString(
      candidate.brokerFeeAtomic,
      "route candidate brokerFeeAtomic"
    );
    const totalInputAtomic = (
      BigInt(quote.payload.inputAmountAtomic) + BigInt(brokerFeeAtomic)
    ).toString();
    if (BigInt(totalInputAtomic) > BigInt(inputOption.maxInputAtomic)) continue;
    valid.push({
      quote,
      brokerFeeAtomic,
      totalInputAtomic,
      estimatedCompletionSeconds: quote.payload.estimatedCompletionSeconds,
    });
  }
  if (valid.length < 1) {
    throw new FxValidationError("no valid route candidates", "NO_VALID_ROUTE");
  }

  const policy = options.policy ?? rfq.payload.quotePolicy;
  normalizeEnum(policy, FX_ROUTE_POLICIES, "route policy");
  valid.sort((left, right) => {
    if (policy === "fastest") {
      const duration = left.estimatedCompletionSeconds - right.estimatedCompletionSeconds;
      if (duration !== 0) return duration;
    }
    const leftTotal = BigInt(left.totalInputAtomic);
    const rightTotal = BigInt(right.totalInputAtomic);
    if (leftTotal !== rightTotal) return leftTotal < rightTotal ? -1 : 1;
    if (policy !== "fastest") {
      const duration = left.estimatedCompletionSeconds - right.estimatedCompletionSeconds;
      if (duration !== 0) return duration;
    }
    return left.quote.id.localeCompare(right.quote.id);
  });

  const selected = valid[0];
  const route = {
    policy,
    rfqId: rfq.id,
    quoteId: selected.quote.id,
    dealer: selected.quote.sender,
    inputChainId: selected.quote.payload.inputChainId,
    inputToken: selected.quote.payload.inputToken,
    totalInputAtomic: selected.totalInputAtomic,
    brokerFeeAtomic: selected.brokerFeeAtomic,
    outputChainId: selected.quote.payload.outputChainId,
    outputToken: selected.quote.payload.outputToken,
    outputAmountAtomic: selected.quote.payload.outputAmountAtomic,
    estimatedCompletionSeconds: selected.estimatedCompletionSeconds,
  };
  return {
    ...route,
    routeId: keccak256(toUtf8Bytes(canonicalJson(route))),
  };
}

module.exports = {
  FX_CASE_TRANSITIONS,
  FX_MAX_CLOCK_SKEW_SECONDS,
  FX_MAX_REFERENCE_AGE_SECONDS,
  FX_MESSAGE_TYPES,
  FX_PRIVACY_CLASSES,
  FX_PROTOCOL,
  FX_QUOTE_TYPE,
  FX_ROLES,
  FX_ROUTE_POLICIES,
  FX_SETTLEMENT_TRANSITIONS,
  FX_VERSION,
  FxValidationError,
  advanceFxCaseState,
  advanceFxState,
  assembleFxEnvelope,
  canonicalFxMessage,
  canonicalJson,
  computeFxMessageId,
  normalizeFxMessage,
  selectSingleDealerRoute,
  verifyFxEnvelope,
};
