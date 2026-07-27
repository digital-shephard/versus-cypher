const {
  getAddress,
  isAddress,
  keccak256,
  toUtf8Bytes,
  verifyMessage,
} = require("ethers");
const {
  canonicalJson,
  FX_MAX_REFERENCE_AGE_SECONDS,
  selectSingleDealerRoute,
  verifyFxEnvelope,
} = require("./fx-protocol");
const { phase5LockId } = require("./fx-phase5-route");

const FX_PHASE8_POLICY_SCHEMA = "versus-fx-phase8-policy";
const FX_PHASE8_NO_SHOW_SCHEMA = "versus-fx-phase8-dealer-no-show";
const FX_PHASE8_REQUESTER_ABANDONMENT_SCHEMA =
  "versus-fx-phase8-requester-abandonment";
const FX_PHASE8_SLICE_PLAN_SCHEMA = "versus-fx-phase8-independent-slices";
const FX_PHASE8_VERSION = 1;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;

const DEFAULT_PHASE8_POLICY = Object.freeze({
  schema: FX_PHASE8_POLICY_SCHEMA,
  schemaVersion: FX_PHASE8_VERSION,
  environment: "laboratory",
  enabledByDefault: false,
  productionFunds: false,
  sourceRefundSeconds: 7_200,
  destinationRefundSeconds: 600,
  minimumTimeoutDeltaSeconds: 3_600,
  minimumSourceRemainingSeconds: 6_600,
  minimumDealerResponseSeconds: 60,
  minimumSourceConfirmations: 2,
  chainVerificationTimeoutMs: 5_000,
  reputationHalfLifeSeconds: 2_592_000,
  maximumReferenceAgeSeconds: FX_MAX_REFERENCE_AGE_SECONDS,
  minimumTradeInputAtomic: "1000",
  maximumTradeInputAtomic: "100000000",
  maximumRequesterGasInputAtomic: "2000000",
  maximumOverheadBps: 500,
  maximumActiveLocksGlobal: 32,
  maximumActiveLocksPerRequester: 2,
  maximumActiveLocksPerAsset: 16,
  maximumActiveValueMicrosGlobal: "1000000000",
  maximumActiveValueMicrosPerRequester: "200000000",
  maximumActiveValueMicrosPerAsset: "500000000",
  capacityBandsAtomic: Object.freeze([
    "1000",
    "10000",
    "50000",
    "100000",
    "250000",
    "1000000",
    "10000000",
    "100000000",
  ]),
});

class FxPhase8PolicyError extends Error {
  constructor(message, code = "FX_PHASE8_POLICY_ERROR") {
    super(message);
    this.name = "FxPhase8PolicyError";
    this.code = code;
  }
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FxPhase8PolicyError(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  object(value, label);
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw new FxPhase8PolicyError(
        `${label} contains unsupported field ${key}`,
        "UNKNOWN_FIELD"
      );
    }
  }
  for (const key of expected) {
    if (!(key in value)) {
      throw new FxPhase8PolicyError(`${label} is missing ${key}`, "MISSING_FIELD");
    }
  }
}

function hash(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (!HASH_PATTERN.test(normalized)) {
    throw new FxPhase8PolicyError(`${label} must be bytes32`);
  }
  return normalized;
}

function address(value, label) {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new FxPhase8PolicyError(`${label} must be an EVM address`);
  }
  const normalized = getAddress(value).toLowerCase();
  if (normalized === ZERO_ADDRESS) {
    throw new FxPhase8PolicyError(`${label} must not be zero`);
  }
  return normalized;
}

function uint(value, label, { allowZero = true } = {}) {
  const text = String(value);
  if (!/^\d+$/.test(text) || text.length > 78) {
    throw new FxPhase8PolicyError(`${label} must be an unsigned integer`);
  }
  const normalized = BigInt(text).toString();
  if (!allowZero && normalized === "0") {
    throw new FxPhase8PolicyError(`${label} must be greater than zero`);
  }
  return normalized;
}

function integer(value, label, { allowZero = true } = {}) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < (allowZero ? 0 : 1)) {
    throw new FxPhase8PolicyError(`${label} must be a safe unsigned integer`);
  }
  return normalized;
}

function normalizePhase8Policy(input = {}) {
  object(input, "Phase 8 policy overrides");
  const allowed = new Set(Object.keys(DEFAULT_PHASE8_POLICY));
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new FxPhase8PolicyError(
        `Phase 8 policy contains unsupported field ${key}`,
        "UNKNOWN_FIELD"
      );
    }
  }
  const merged = { ...DEFAULT_PHASE8_POLICY, ...input };
  if (
    merged.schema !== FX_PHASE8_POLICY_SCHEMA ||
    merged.schemaVersion !== FX_PHASE8_VERSION ||
    merged.environment !== "laboratory" ||
    merged.enabledByDefault !== false ||
    merged.productionFunds !== false
  ) {
    throw new FxPhase8PolicyError(
      "Phase 8 policy must remain disabled laboratory configuration",
      "PRODUCTION_CONNECTED"
    );
  }
  const policy = {
    schema: merged.schema,
    schemaVersion: merged.schemaVersion,
    environment: merged.environment,
    enabledByDefault: false,
    productionFunds: false,
    sourceRefundSeconds: integer(
      merged.sourceRefundSeconds,
      "sourceRefundSeconds",
      { allowZero: false }
    ),
    destinationRefundSeconds: integer(
      merged.destinationRefundSeconds,
      "destinationRefundSeconds",
      { allowZero: false }
    ),
    minimumTimeoutDeltaSeconds: integer(
      merged.minimumTimeoutDeltaSeconds,
      "minimumTimeoutDeltaSeconds",
      { allowZero: false }
    ),
    minimumSourceRemainingSeconds: integer(
      merged.minimumSourceRemainingSeconds,
      "minimumSourceRemainingSeconds",
      { allowZero: false }
    ),
    minimumDealerResponseSeconds: integer(
      merged.minimumDealerResponseSeconds,
      "minimumDealerResponseSeconds",
      { allowZero: false }
    ),
    minimumSourceConfirmations: integer(
      merged.minimumSourceConfirmations,
      "minimumSourceConfirmations",
      { allowZero: false }
    ),
    chainVerificationTimeoutMs: integer(
      merged.chainVerificationTimeoutMs,
      "chainVerificationTimeoutMs",
      { allowZero: false }
    ),
    reputationHalfLifeSeconds: integer(
      merged.reputationHalfLifeSeconds,
      "reputationHalfLifeSeconds",
      { allowZero: false }
    ),
    maximumReferenceAgeSeconds: integer(
      merged.maximumReferenceAgeSeconds,
      "maximumReferenceAgeSeconds",
      { allowZero: false }
    ),
    minimumTradeInputAtomic: uint(
      merged.minimumTradeInputAtomic,
      "minimumTradeInputAtomic",
      { allowZero: false }
    ),
    maximumTradeInputAtomic: uint(
      merged.maximumTradeInputAtomic,
      "maximumTradeInputAtomic",
      { allowZero: false }
    ),
    maximumRequesterGasInputAtomic: uint(
      merged.maximumRequesterGasInputAtomic,
      "maximumRequesterGasInputAtomic"
    ),
    maximumOverheadBps: integer(merged.maximumOverheadBps, "maximumOverheadBps"),
    maximumActiveLocksGlobal: integer(
      merged.maximumActiveLocksGlobal,
      "maximumActiveLocksGlobal",
      { allowZero: false }
    ),
    maximumActiveLocksPerRequester: integer(
      merged.maximumActiveLocksPerRequester,
      "maximumActiveLocksPerRequester",
      { allowZero: false }
    ),
    maximumActiveLocksPerAsset: integer(
      merged.maximumActiveLocksPerAsset,
      "maximumActiveLocksPerAsset",
      { allowZero: false }
    ),
    maximumActiveValueMicrosGlobal: uint(
      merged.maximumActiveValueMicrosGlobal,
      "maximumActiveValueMicrosGlobal",
      { allowZero: false }
    ),
    maximumActiveValueMicrosPerRequester: uint(
      merged.maximumActiveValueMicrosPerRequester,
      "maximumActiveValueMicrosPerRequester",
      { allowZero: false }
    ),
    maximumActiveValueMicrosPerAsset: uint(
      merged.maximumActiveValueMicrosPerAsset,
      "maximumActiveValueMicrosPerAsset",
      { allowZero: false }
    ),
    capacityBandsAtomic: [...merged.capacityBandsAtomic].map((value, index) =>
      uint(value, `capacityBandsAtomic[${index}]`, { allowZero: false })
    ),
  };
  if (
    policy.sourceRefundSeconds <
      policy.destinationRefundSeconds + policy.minimumTimeoutDeltaSeconds ||
    policy.minimumSourceRemainingSeconds <
      policy.destinationRefundSeconds + policy.minimumTimeoutDeltaSeconds ||
    policy.minimumDealerResponseSeconds >= policy.destinationRefundSeconds ||
    BigInt(policy.minimumTradeInputAtomic) > BigInt(policy.maximumTradeInputAtomic) ||
    policy.maximumOverheadBps > 10_000
  ) {
    throw new FxPhase8PolicyError(
      "Phase 8 timeout or economic bounds are internally inconsistent"
    );
  }
  for (let index = 1; index < policy.capacityBandsAtomic.length; index += 1) {
    if (
      BigInt(policy.capacityBandsAtomic[index]) <=
      BigInt(policy.capacityBandsAtomic[index - 1])
    ) {
      throw new FxPhase8PolicyError("capacity bands must be unique and ascending");
    }
  }
  return policy;
}

function coarseCapacityBand(availableInputAtomic, policyInput = {}) {
  const policy = normalizePhase8Policy(policyInput);
  const available = BigInt(uint(availableInputAtomic, "availableInputAtomic"));
  let band = "0";
  for (const candidate of policy.capacityBandsAtomic) {
    if (BigInt(candidate) > available) break;
    band = candidate;
  }
  return {
    lowerBoundAtomic: band,
    exactBalanceDisclosed: false,
  };
}

function evaluatePhase8Economics({
  route,
  referenceInputAtomic,
  requesterGasInputAtomic = "0",
  policy: policyInput = {},
}) {
  object(route, "route");
  const policy = normalizePhase8Policy(policyInput);
  const routeInput = BigInt(uint(route.totalInputAtomic, "route.totalInputAtomic", {
    allowZero: false,
  }));
  const referenceInput = BigInt(uint(
    referenceInputAtomic,
    "referenceInputAtomic",
    { allowZero: false }
  ));
  const requesterGas = BigInt(uint(
    requesterGasInputAtomic,
    "requesterGasInputAtomic"
  ));
  const allIn = routeInput + requesterGas;
  const overhead = allIn > referenceInput ? allIn - referenceInput : 0n;
  const overheadBps = Number(
    (overhead * 10_000n + referenceInput - 1n) / referenceInput
  );
  const reasons = [];
  if (routeInput < BigInt(policy.minimumTradeInputAtomic)) reasons.push("trade_below_minimum");
  if (routeInput > BigInt(policy.maximumTradeInputAtomic)) reasons.push("trade_above_maximum");
  if (requesterGas > BigInt(policy.maximumRequesterGasInputAtomic)) {
    reasons.push("requester_gas_above_maximum");
  }
  if (overheadBps > policy.maximumOverheadBps) reasons.push("overhead_above_maximum");
  return {
    accepted: reasons.length === 0,
    reasons,
    referenceInputAtomic: referenceInput.toString(),
    routeInputAtomic: routeInput.toString(),
    requesterGasInputAtomic: requesterGas.toString(),
    allInInputAtomic: allIn.toString(),
    overheadInputAtomic: overhead.toString(),
    overheadBps,
  };
}

async function boundedChainRead(read, input, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => read(input)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new FxPhase8PolicyError(
          "chain verifier timed out",
          "CHAIN_VERIFIER_UNAVAILABLE"
        )), timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof FxPhase8PolicyError) throw error;
    throw new FxPhase8PolicyError(
      `chain verifier failed: ${error?.message || "unknown error"}`,
      "CHAIN_VERIFIER_UNAVAILABLE"
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function verifyStaticSourcePackage({
  rfq,
  quote,
  accept,
  reserve,
  sourceLock,
  now,
  temporal,
}) {
  const options = temporal
    ? { now, clockSkewSeconds: 0 }
    : { temporal: false };
  const verified = {
    rfq: verifyFxEnvelope(rfq, options),
    quote: verifyFxEnvelope(quote, options),
    accept: verifyFxEnvelope(accept, options),
    reserve: verifyFxEnvelope(reserve, options),
    sourceLock: verifyFxEnvelope(sourceLock, options),
  };
  const messages = Object.values(verified);
  if (
    verified.rfq.type !== "fx_rfq" ||
    verified.quote.type !== "fx_quote" ||
    verified.accept.type !== "fx_accept" ||
    verified.reserve.type !== "fx_reserve" ||
    verified.sourceLock.type !== "fx_lock_source" ||
    new Set(messages.map((message) => message.deploymentId)).size !== 1 ||
    new Set(messages.map((message) => message.tradeId)).size !== 1
  ) {
    throw new FxPhase8PolicyError(
      "source-lock package contains unrelated messages",
      "PACKAGE_SCOPE_MISMATCH"
    );
  }
  const route = selectSingleDealerRoute(
    verified.rfq,
    [{
      quote: verified.quote,
      brokerFeeAtomic: verified.accept.payload.brokerFeeAtomic,
    }],
    {
      now: verified.accept.createdAt,
      policy: verified.rfq.payload.quotePolicy,
    }
  );
  if (
    verified.quote.payload.rfqId !== verified.rfq.id ||
    verified.accept.sender !== verified.rfq.sender ||
    verified.accept.payload.rfqId !== verified.rfq.id ||
    verified.accept.payload.quoteId !== verified.quote.id ||
    verified.accept.payload.routeId !== route.routeId ||
    verified.accept.payload.totalInputAtomic !== route.totalInputAtomic ||
    verified.accept.payload.outputAmountAtomic !== route.outputAmountAtomic ||
    verified.reserve.sender !== verified.quote.sender ||
    verified.reserve.payload.acceptId !== verified.accept.id ||
    verified.reserve.payload.quoteId !== verified.quote.id ||
    verified.sourceLock.sender !== verified.rfq.sender ||
    verified.sourceLock.payload.acceptId !== verified.accept.id ||
    verified.sourceLock.payload.chainId !== route.inputChainId ||
    verified.sourceLock.payload.token !== route.inputToken ||
    verified.sourceLock.payload.amountAtomic !== route.totalInputAtomic ||
    verified.sourceLock.payload.beneficiary !==
      verified.reserve.payload.dealerSourceClaimAddress ||
    verified.sourceLock.payload.refundAddress !==
      verified.accept.payload.sourceRefundAddress ||
    verified.sourceLock.payload.secretHash !== verified.accept.payload.secretHash
  ) {
    throw new FxPhase8PolicyError(
      "source-lock package does not match the accepted route",
      "PACKAGE_LINEAGE_MISMATCH"
    );
  }
  return { ...verified, route };
}

async function verifyPhase8SourceLockPackage({
  rfq,
  quote,
  accept,
  reserve,
  sourceLock,
  referenceInputAtomic,
  exposureValueMicros,
  requesterGasInputAtomic = "0",
  verifyChainLock,
  policy: policyInput = {},
  now = Math.floor(Date.now() / 1000),
}) {
  if (typeof verifyChainLock !== "function") {
    throw new TypeError("source-lock verification requires a chain verifier");
  }
  const policy = normalizePhase8Policy(policyInput);
  const verified = verifyStaticSourcePackage({
    rfq,
    quote,
    accept,
    reserve,
    sourceLock,
    now,
    temporal: true,
  });
  const economics = evaluatePhase8Economics({
    route: verified.route,
    referenceInputAtomic,
    requesterGasInputAtomic,
    policy,
  });
  if (!economics.accepted) {
    throw new FxPhase8PolicyError(
      `route fails economic policy: ${economics.reasons.join(",")}`,
      "UNECONOMICAL_ROUTE"
    );
  }
  const normalizedExposureValueMicros = uint(
    exposureValueMicros,
    "exposureValueMicros",
    { allowZero: false }
  );
  if (
    verified.quote.payload.referenceTimestamp > now ||
    now - verified.quote.payload.referenceTimestamp >
      policy.maximumReferenceAgeSeconds
  ) {
    throw new FxPhase8PolicyError(
      "dealer price reference is stale at source-lock firming",
      "STALE_PRICE_REFERENCE"
    );
  }
  const expectedSourceLockId = phase5LockId(verified.rfq.tradeId, "source");
  const chain = await boundedChainRead(verifyChainLock, {
    side: "source",
    lockId: expectedSourceLockId,
    sourceLock: verified.sourceLock,
    route: verified.route,
    accept: verified.accept,
    reserve: verified.reserve,
  }, policy.chainVerificationTimeoutMs);
  if (
    chain?.confirmed !== true ||
    chain?.canonical !== true ||
    integer(chain.confirmations, "source confirmations") <
      policy.minimumSourceConfirmations ||
    hash(chain.lockId, "source lock id") !== expectedSourceLockId ||
    hash(chain.transactionHash, "source transaction hash") !==
      verified.sourceLock.payload.transactionHash ||
    String(chain.chainId) !== verified.sourceLock.payload.chainId ||
    address(chain.token, "source chain token") !==
      verified.sourceLock.payload.token ||
    uint(chain.amountAtomic, "source chain amount", { allowZero: false }) !==
      verified.sourceLock.payload.amountAtomic ||
    address(chain.beneficiary, "source chain beneficiary") !==
      verified.sourceLock.payload.beneficiary ||
    address(chain.refundAddress, "source chain refund address") !==
      verified.sourceLock.payload.refundAddress ||
    hash(chain.secretHash, "source chain secret hash") !==
      verified.sourceLock.payload.secretHash ||
    integer(chain.timeout, "source chain timeout", { allowZero: false }) !==
      verified.sourceLock.payload.timeout ||
    integer(chain.blockTimestamp, "source block timestamp", { allowZero: false }) >
      verified.reserve.payload.reservationDeadline -
        policy.minimumDealerResponseSeconds
  ) {
    throw new FxPhase8PolicyError(
      "source lock is not independently confirmed before the dealer deadline",
      "SOURCE_LOCK_NOT_FIRM"
    );
  }
  const sourceDuration =
    verified.sourceLock.payload.timeout - Number(chain.blockTimestamp);
  const sourceRemaining = verified.sourceLock.payload.timeout - now;
  const destinationRefundTimestamp = now + policy.destinationRefundSeconds;
  if (
    sourceDuration < policy.sourceRefundSeconds ||
    sourceRemaining < policy.minimumSourceRemainingSeconds ||
    verified.sourceLock.payload.timeout <
      destinationRefundTimestamp + policy.minimumTimeoutDeltaSeconds
  ) {
    throw new FxPhase8PolicyError(
      "source lock does not provide the required asymmetric timeout safety",
      "UNSAFE_TIMEOUT_ORDER"
    );
  }
  return {
    ...verified,
    policy,
    economics,
    exposureValueMicros: normalizedExposureValueMicros,
    chain,
    expectedSourceLockId,
    expectedDestinationLockId: phase5LockId(verified.rfq.tradeId, "destination"),
    destinationRefundTimestamp,
  };
}

function noShowCore({
  deploymentId,
  observer,
  observedAt,
  rfq,
  quote,
  accept,
  reserve,
  sourceLock,
  destinationObservation,
}) {
  return {
    schema: FX_PHASE8_NO_SHOW_SCHEMA,
    schemaVersion: FX_PHASE8_VERSION,
    deploymentId,
    observer,
    observedAt,
    rfq,
    quote,
    accept,
    reserve,
    sourceLock,
    destinationObservation,
  };
}

function requesterAbandonmentCore({
  deploymentId,
  observer,
  observedAt,
  rfq,
  quote,
  accept,
  reserve,
  sourceLock,
  destinationLock,
  destinationObservation,
}) {
  return {
    schema: FX_PHASE8_REQUESTER_ABANDONMENT_SCHEMA,
    schemaVersion: FX_PHASE8_VERSION,
    deploymentId,
    observer,
    observedAt,
    rfq,
    quote,
    accept,
    reserve,
    sourceLock,
    destinationLock,
    destinationObservation,
  };
}

function normalizeDestinationObservation(value) {
  exactKeys(value, [
    "chainId",
    "expectedLockId",
    "deadline",
    "blockNumber",
    "blockHash",
    "blockTimestamp",
  ], "destinationObservation");
  return {
    chainId: uint(value.chainId, "destinationObservation.chainId", {
      allowZero: false,
    }),
    expectedLockId: hash(
      value.expectedLockId,
      "destinationObservation.expectedLockId"
    ),
    deadline: integer(value.deadline, "destinationObservation.deadline", {
      allowZero: false,
    }),
    blockNumber: uint(value.blockNumber, "destinationObservation.blockNumber"),
    blockHash: hash(value.blockHash, "destinationObservation.blockHash"),
    blockTimestamp: integer(
      value.blockTimestamp,
      "destinationObservation.blockTimestamp",
      { allowZero: false }
    ),
  };
}

async function createDealerNoShowEvidence({
  signer,
  rfq,
  quote,
  accept,
  reserve,
  sourceLock,
  destinationObservation,
  observedAt = Math.floor(Date.now() / 1000),
}) {
  if (!signer || typeof signer.signMessage !== "function") {
    throw new TypeError("dealer no-show evidence requires an observer signer");
  }
  const verified = verifyStaticSourcePackage({
    rfq,
    quote,
    accept,
    reserve,
    sourceLock,
    temporal: false,
  });
  const observer = address(await signer.getAddress(), "observer");
  const observation = normalizeDestinationObservation(destinationObservation);
  const expectedLockId = phase5LockId(verified.rfq.tradeId, "destination");
  if (
    observation.chainId !== verified.route.outputChainId ||
    observation.expectedLockId !== expectedLockId ||
    observation.deadline !== verified.reserve.payload.reservationDeadline ||
    observation.blockTimestamp < observation.deadline ||
    observedAt < observation.blockTimestamp
  ) {
    throw new FxPhase8PolicyError(
      "destination observation is not at the promised no-show boundary"
    );
  }
  const core = noShowCore({
    deploymentId: verified.rfq.deploymentId,
    observer,
    observedAt: integer(observedAt, "observedAt", { allowZero: false }),
    rfq: verified.rfq,
    quote: verified.quote,
    accept: verified.accept,
    reserve: verified.reserve,
    sourceLock: verified.sourceLock,
    destinationObservation: observation,
  });
  const evidenceId = keccak256(toUtf8Bytes(canonicalJson(core)));
  return {
    ...core,
    evidenceId,
    signature: await signer.signMessage(canonicalJson(core)),
  };
}

async function verifyDealerNoShowEvidence(input, {
  verifySourceLock,
  readDestinationLock,
  policy: policyInput = {},
} = {}) {
  if (
    typeof verifySourceLock !== "function" ||
    typeof readDestinationLock !== "function"
  ) {
    throw new TypeError(
      "dealer no-show verification requires source and destination chain readers"
    );
  }
  exactKeys(input, [
    "schema",
    "schemaVersion",
    "deploymentId",
    "observer",
    "observedAt",
    "rfq",
    "quote",
    "accept",
    "reserve",
    "sourceLock",
    "destinationObservation",
    "evidenceId",
    "signature",
  ], "dealer no-show evidence");
  if (
    input.schema !== FX_PHASE8_NO_SHOW_SCHEMA ||
    input.schemaVersion !== FX_PHASE8_VERSION
  ) {
    throw new FxPhase8PolicyError("dealer no-show evidence schema is unsupported");
  }
  const policy = normalizePhase8Policy(policyInput);
  const verified = verifyStaticSourcePackage({
    rfq: input.rfq,
    quote: input.quote,
    accept: input.accept,
    reserve: input.reserve,
    sourceLock: input.sourceLock,
    temporal: false,
  });
  const deploymentId = hash(input.deploymentId, "deploymentId");
  const observer = address(input.observer, "observer");
  const observedAt = integer(input.observedAt, "observedAt", { allowZero: false });
  const observation = normalizeDestinationObservation(input.destinationObservation);
  const expectedDestinationLockId = phase5LockId(
    verified.rfq.tradeId,
    "destination"
  );
  if (
    deploymentId !== verified.rfq.deploymentId ||
    observation.chainId !== verified.route.outputChainId ||
    observation.expectedLockId !== expectedDestinationLockId ||
    observation.deadline !== verified.reserve.payload.reservationDeadline ||
    observation.blockTimestamp < observation.deadline ||
    observedAt < observation.blockTimestamp
  ) {
    throw new FxPhase8PolicyError(
      "dealer no-show evidence scope or deadline is invalid",
      "INVALID_NO_SHOW"
    );
  }
  const core = noShowCore({
    deploymentId,
    observer,
    observedAt,
    rfq: verified.rfq,
    quote: verified.quote,
    accept: verified.accept,
    reserve: verified.reserve,
    sourceLock: verified.sourceLock,
    destinationObservation: observation,
  });
  const evidenceId = keccak256(toUtf8Bytes(canonicalJson(core)));
  if (hash(input.evidenceId, "evidenceId") !== evidenceId) {
    throw new FxPhase8PolicyError("dealer no-show evidence id is invalid");
  }
  if (
    typeof input.signature !== "string" ||
    !SIGNATURE_PATTERN.test(input.signature)
  ) {
    throw new FxPhase8PolicyError(
      "dealer no-show evidence signature is invalid",
      "BAD_SIGNATURE"
    );
  }
  let recovered;
  try {
    recovered = verifyMessage(canonicalJson(core), input.signature).toLowerCase();
  } catch {
    throw new FxPhase8PolicyError(
      "dealer no-show evidence signature is invalid",
      "BAD_SIGNATURE"
    );
  }
  if (recovered !== observer) {
    throw new FxPhase8PolicyError(
      "dealer no-show evidence signature does not match observer",
      "BAD_SIGNATURE"
    );
  }
  const source = await verifySourceLock({
    lockId: phase5LockId(verified.rfq.tradeId, "source"),
    sourceLock: verified.sourceLock,
    accept: verified.accept,
    reserve: verified.reserve,
  });
  if (
    source?.confirmed !== true ||
    source?.canonical !== true ||
    integer(source.confirmations, "source confirmations") <
      policy.minimumSourceConfirmations ||
    integer(source.blockTimestamp, "source block timestamp", {
      allowZero: false,
    }) >
      verified.reserve.payload.reservationDeadline -
        policy.minimumDealerResponseSeconds ||
    hash(source.lockId, "source lock id") !==
      phase5LockId(verified.rfq.tradeId, "source") ||
    hash(source.transactionHash, "source transaction hash") !==
      verified.sourceLock.payload.transactionHash ||
    String(source.chainId) !== verified.sourceLock.payload.chainId ||
    address(source.token, "source token") !==
      verified.sourceLock.payload.token ||
    uint(source.amountAtomic, "source amount", { allowZero: false }) !==
      verified.sourceLock.payload.amountAtomic ||
    address(source.beneficiary, "source beneficiary") !==
      verified.sourceLock.payload.beneficiary ||
    address(source.refundAddress, "source refund address") !==
      verified.sourceLock.payload.refundAddress ||
    hash(source.secretHash, "source secret hash") !==
      verified.sourceLock.payload.secretHash ||
    integer(source.timeout, "source timeout", { allowZero: false }) !==
      verified.sourceLock.payload.timeout
  ) {
    throw new FxPhase8PolicyError(
      "dealer no-show report lacks a timely confirmed source lock",
      "INVALID_NO_SHOW"
    );
  }
  const destination = await readDestinationLock({
    chainId: observation.chainId,
    lockId: expectedDestinationLockId,
    blockNumber: observation.blockNumber,
    blockHash: observation.blockHash,
  });
  if (
    destination?.canonical !== true ||
    destination?.exists !== false ||
    uint(destination.blockNumber, "destination block number") !==
      observation.blockNumber ||
    hash(destination.blockHash, "destination block hash") !==
      observation.blockHash ||
    integer(destination.blockTimestamp, "destination block timestamp", {
      allowZero: false,
    }) !== observation.blockTimestamp
  ) {
    throw new FxPhase8PolicyError(
      "destination chain does not prove the promised lock was absent",
      "INVALID_NO_SHOW"
    );
  }
  return {
    ...core,
    evidenceId,
    signature: input.signature,
    dealer: verified.quote.sender,
    requester: verified.rfq.sender,
    expectedDestinationLockId,
    source,
    destination,
  };
}

function verifyDestinationLockLineage(destinationLock, verified) {
  const lock = verifyFxEnvelope(destinationLock, { temporal: false });
  if (
    lock.type !== "fx_lock_destination" ||
    lock.deploymentId !== verified.rfq.deploymentId ||
    lock.tradeId !== verified.rfq.tradeId ||
    lock.sender !== verified.quote.sender ||
    lock.payload.acceptId !== verified.accept.id ||
    lock.payload.chainId !== verified.route.outputChainId ||
    lock.payload.token !== verified.route.outputToken ||
    lock.payload.amountAtomic !== verified.route.outputAmountAtomic ||
    lock.payload.beneficiary !==
      verified.accept.payload.destinationClaimAddress ||
    lock.payload.refundAddress !==
      verified.reserve.payload.dealerDestinationRefundAddress ||
    lock.payload.secretHash !== verified.accept.payload.secretHash
  ) {
    throw new FxPhase8PolicyError(
      "destination lock does not match the accepted route",
      "PACKAGE_LINEAGE_MISMATCH"
    );
  }
  return lock;
}

function verifyEvidenceSignature({ core, evidenceId, signature, observer, label }) {
  const expectedEvidenceId = keccak256(toUtf8Bytes(canonicalJson(core)));
  if (
    hash(evidenceId, "evidenceId") !== expectedEvidenceId ||
    typeof signature !== "string" ||
    !SIGNATURE_PATTERN.test(signature)
  ) {
    throw new FxPhase8PolicyError(
      `${label} signature or id is invalid`,
      "BAD_SIGNATURE"
    );
  }
  let recovered;
  try {
    recovered = verifyMessage(canonicalJson(core), signature).toLowerCase();
  } catch {
    throw new FxPhase8PolicyError(
      `${label} signature is invalid`,
      "BAD_SIGNATURE"
    );
  }
  if (recovered !== observer) {
    throw new FxPhase8PolicyError(
      `${label} observer signature does not match`,
      "BAD_SIGNATURE"
    );
  }
  return expectedEvidenceId;
}

function verifyPhase8EvidenceAttestation(input) {
  object(input, "Phase 8 evidence");
  const commonKeys = [
    "schema",
    "schemaVersion",
    "deploymentId",
    "observer",
    "observedAt",
    "rfq",
    "quote",
    "accept",
    "reserve",
    "sourceLock",
  ];
  const isNoShow = input.schema === FX_PHASE8_NO_SHOW_SCHEMA;
  const isRequesterAbandonment =
    input.schema === FX_PHASE8_REQUESTER_ABANDONMENT_SCHEMA;
  if (!isNoShow && !isRequesterAbandonment) {
    throw new FxPhase8PolicyError("Phase 8 evidence schema is unsupported");
  }
  exactKeys(input, [
    ...commonKeys,
    ...(isRequesterAbandonment ? ["destinationLock"] : []),
    "destinationObservation",
    "evidenceId",
    "signature",
  ], "Phase 8 evidence");
  if (input.schemaVersion !== FX_PHASE8_VERSION) {
    throw new FxPhase8PolicyError("Phase 8 evidence version is unsupported");
  }
  const verified = verifyStaticSourcePackage({
    rfq: input.rfq,
    quote: input.quote,
    accept: input.accept,
    reserve: input.reserve,
    sourceLock: input.sourceLock,
    temporal: false,
  });
  const deploymentId = hash(input.deploymentId, "deploymentId");
  const observer = address(input.observer, "observer");
  const observedAt = integer(input.observedAt, "observedAt", {
    allowZero: false,
  });
  const observation = normalizeDestinationObservation(
    input.destinationObservation
  );
  const expectedLockId = phase5LockId(verified.rfq.tradeId, "destination");
  const destinationLock = isRequesterAbandonment
    ? verifyDestinationLockLineage(input.destinationLock, verified)
    : null;
  const deadline = destinationLock
    ? destinationLock.payload.timeout
    : verified.reserve.payload.reservationDeadline;
  if (
    deploymentId !== verified.rfq.deploymentId ||
    observation.chainId !== verified.route.outputChainId ||
    observation.expectedLockId !== expectedLockId ||
    observation.deadline !== deadline ||
    observation.blockTimestamp < deadline ||
    observedAt < observation.blockTimestamp
  ) {
    throw new FxPhase8PolicyError(
      "Phase 8 evidence scope or deadline is invalid",
      isNoShow ? "INVALID_NO_SHOW" : "INVALID_ABANDONMENT"
    );
  }
  const core = isNoShow
    ? noShowCore({
      deploymentId,
      observer,
      observedAt,
      rfq: verified.rfq,
      quote: verified.quote,
      accept: verified.accept,
      reserve: verified.reserve,
      sourceLock: verified.sourceLock,
      destinationObservation: observation,
    })
    : requesterAbandonmentCore({
      deploymentId,
      observer,
      observedAt,
      rfq: verified.rfq,
      quote: verified.quote,
      accept: verified.accept,
      reserve: verified.reserve,
      sourceLock: verified.sourceLock,
      destinationLock,
      destinationObservation: observation,
    });
  const evidenceId = verifyEvidenceSignature({
    core,
    evidenceId: input.evidenceId,
    signature: input.signature,
    observer,
    label: isNoShow
      ? "dealer no-show evidence"
      : "requester abandonment evidence",
  });
  return {
    ...core,
    evidenceId,
    signature: input.signature,
    tradeId: verified.rfq.tradeId,
    requester: verified.rfq.sender,
    dealer: verified.quote.sender,
    expectedDestinationLockId: expectedLockId,
  };
}

async function createRequesterAbandonmentEvidence({
  signer,
  rfq,
  quote,
  accept,
  reserve,
  sourceLock,
  destinationLock,
  destinationObservation,
  observedAt = Math.floor(Date.now() / 1000),
}) {
  if (!signer || typeof signer.signMessage !== "function") {
    throw new TypeError(
      "requester abandonment evidence requires an observer signer"
    );
  }
  const verified = verifyStaticSourcePackage({
    rfq,
    quote,
    accept,
    reserve,
    sourceLock,
    temporal: false,
  });
  const destination = verifyDestinationLockLineage(destinationLock, verified);
  const observer = address(await signer.getAddress(), "observer");
  const observation = normalizeDestinationObservation(destinationObservation);
  const expectedLockId = phase5LockId(verified.rfq.tradeId, "destination");
  if (
    observation.chainId !== verified.route.outputChainId ||
    observation.expectedLockId !== expectedLockId ||
    observation.deadline !== destination.payload.timeout ||
    observation.blockTimestamp < observation.deadline ||
    observedAt < observation.blockTimestamp
  ) {
    throw new FxPhase8PolicyError(
      "destination observation is not at the requester abandonment boundary",
      "INVALID_ABANDONMENT"
    );
  }
  const core = requesterAbandonmentCore({
    deploymentId: verified.rfq.deploymentId,
    observer,
    observedAt: integer(observedAt, "observedAt", { allowZero: false }),
    rfq: verified.rfq,
    quote: verified.quote,
    accept: verified.accept,
    reserve: verified.reserve,
    sourceLock: verified.sourceLock,
    destinationLock: destination,
    destinationObservation: observation,
  });
  return {
    ...core,
    evidenceId: keccak256(toUtf8Bytes(canonicalJson(core))),
    signature: await signer.signMessage(canonicalJson(core)),
  };
}

async function verifyRequesterAbandonmentEvidence(input, {
  verifySourceLock,
  readDestinationLock,
  policy: policyInput = {},
} = {}) {
  if (
    typeof verifySourceLock !== "function" ||
    typeof readDestinationLock !== "function"
  ) {
    throw new TypeError(
      "requester abandonment verification requires both chain readers"
    );
  }
  exactKeys(input, [
    "schema",
    "schemaVersion",
    "deploymentId",
    "observer",
    "observedAt",
    "rfq",
    "quote",
    "accept",
    "reserve",
    "sourceLock",
    "destinationLock",
    "destinationObservation",
    "evidenceId",
    "signature",
  ], "requester abandonment evidence");
  if (
    input.schema !== FX_PHASE8_REQUESTER_ABANDONMENT_SCHEMA ||
    input.schemaVersion !== FX_PHASE8_VERSION
  ) {
    throw new FxPhase8PolicyError(
      "requester abandonment evidence schema is unsupported"
    );
  }
  const policy = normalizePhase8Policy(policyInput);
  const verified = verifyStaticSourcePackage({
    rfq: input.rfq,
    quote: input.quote,
    accept: input.accept,
    reserve: input.reserve,
    sourceLock: input.sourceLock,
    temporal: false,
  });
  const destinationLock = verifyDestinationLockLineage(
    input.destinationLock,
    verified
  );
  const deploymentId = hash(input.deploymentId, "deploymentId");
  const observer = address(input.observer, "observer");
  const observedAt = integer(input.observedAt, "observedAt", {
    allowZero: false,
  });
  const observation = normalizeDestinationObservation(
    input.destinationObservation
  );
  const expectedLockId = phase5LockId(verified.rfq.tradeId, "destination");
  if (
    deploymentId !== verified.rfq.deploymentId ||
    observation.chainId !== verified.route.outputChainId ||
    observation.expectedLockId !== expectedLockId ||
    observation.deadline !== destinationLock.payload.timeout ||
    observation.blockTimestamp < observation.deadline ||
    observedAt < observation.blockTimestamp
  ) {
    throw new FxPhase8PolicyError(
      "requester abandonment evidence scope or deadline is invalid",
      "INVALID_ABANDONMENT"
    );
  }
  const core = requesterAbandonmentCore({
    deploymentId,
    observer,
    observedAt,
    rfq: verified.rfq,
    quote: verified.quote,
    accept: verified.accept,
    reserve: verified.reserve,
    sourceLock: verified.sourceLock,
    destinationLock,
    destinationObservation: observation,
  });
  const evidenceId = keccak256(toUtf8Bytes(canonicalJson(core)));
  if (
    hash(input.evidenceId, "evidenceId") !== evidenceId ||
    typeof input.signature !== "string" ||
    !SIGNATURE_PATTERN.test(input.signature)
  ) {
    throw new FxPhase8PolicyError(
      "requester abandonment evidence signature or id is invalid",
      "BAD_SIGNATURE"
    );
  }
  let recovered;
  try {
    recovered = verifyMessage(canonicalJson(core), input.signature).toLowerCase();
  } catch {
    throw new FxPhase8PolicyError(
      "requester abandonment evidence signature is invalid",
      "BAD_SIGNATURE"
    );
  }
  if (recovered !== observer) {
    throw new FxPhase8PolicyError(
      "requester abandonment observer signature does not match",
      "BAD_SIGNATURE"
    );
  }
  const source = await verifySourceLock({
    lockId: phase5LockId(verified.rfq.tradeId, "source"),
    sourceLock: verified.sourceLock,
    accept: verified.accept,
    reserve: verified.reserve,
  });
  if (
    source?.confirmed !== true ||
    source?.canonical !== true ||
    integer(source.confirmations, "source confirmations") <
      policy.minimumSourceConfirmations ||
    hash(source.lockId, "source lock id") !==
      phase5LockId(verified.rfq.tradeId, "source") ||
    hash(source.transactionHash, "source transaction hash") !==
      verified.sourceLock.payload.transactionHash
  ) {
    throw new FxPhase8PolicyError(
      "requester abandonment lacks a confirmed source lock",
      "INVALID_ABANDONMENT"
    );
  }
  const destination = await readDestinationLock({
    chainId: observation.chainId,
    lockId: expectedLockId,
    blockNumber: observation.blockNumber,
    blockHash: observation.blockHash,
  });
  if (
    destination?.canonical !== true ||
    destination?.exists !== true ||
    destination?.claimed !== false ||
    uint(destination.blockNumber, "destination block number") !==
      observation.blockNumber ||
    hash(destination.blockHash, "destination block hash") !==
      observation.blockHash ||
    integer(destination.blockTimestamp, "destination block timestamp", {
      allowZero: false,
    }) !== observation.blockTimestamp ||
    hash(destination.transactionHash, "destination transaction hash") !==
      destinationLock.payload.transactionHash ||
    integer(destination.timeout, "destination timeout", {
      allowZero: false,
    }) !== destinationLock.payload.timeout
  ) {
    throw new FxPhase8PolicyError(
      "destination chain does not prove requester abandonment",
      "INVALID_ABANDONMENT"
    );
  }
  return {
    ...core,
    evidenceId,
    signature: input.signature,
    requester: verified.rfq.sender,
    dealer: verified.quote.sender,
    expectedDestinationLockId: expectedLockId,
    source,
    destination,
  };
}

function createIndependentSlicePlan({ parentRequestId, slices }) {
  if (!Array.isArray(slices) || slices.length < 2 || slices.length > 16) {
    throw new FxPhase8PolicyError(
      "independent slicing requires 2 to 16 slices"
    );
  }
  const normalized = slices.map((slice, index) => {
    exactKeys(slice, [
      "tradeId",
      "secretHash",
      "dealer",
      "inputAmountAtomic",
      "outputAmountAtomic",
    ], `slices[${index}]`);
    return {
      tradeId: hash(slice.tradeId, `slices[${index}].tradeId`),
      secretHash: hash(slice.secretHash, `slices[${index}].secretHash`),
      dealer: address(slice.dealer, `slices[${index}].dealer`),
      inputAmountAtomic: uint(
        slice.inputAmountAtomic,
        `slices[${index}].inputAmountAtomic`,
        { allowZero: false }
      ),
      outputAmountAtomic: uint(
        slice.outputAmountAtomic,
        `slices[${index}].outputAmountAtomic`,
        { allowZero: false }
      ),
    };
  });
  if (
    new Set(normalized.map((slice) => slice.tradeId)).size !== normalized.length ||
    new Set(normalized.map((slice) => slice.secretHash)).size !== normalized.length
  ) {
    throw new FxPhase8PolicyError(
      "independent slices require distinct trade IDs and secrets",
      "COUPLED_SLICES"
    );
  }
  const core = {
    schema: FX_PHASE8_SLICE_PLAN_SCHEMA,
    schemaVersion: FX_PHASE8_VERSION,
    parentRequestId: hash(parentRequestId, "parentRequestId"),
    atomicAcrossSlices: false,
    failureIsolation: "independent",
    slices: normalized,
    totalInputAtomic: normalized
      .reduce((total, slice) => total + BigInt(slice.inputAmountAtomic), 0n)
      .toString(),
    totalOutputAtomic: normalized
      .reduce((total, slice) => total + BigInt(slice.outputAmountAtomic), 0n)
      .toString(),
  };
  return {
    ...core,
    planId: keccak256(toUtf8Bytes(canonicalJson(core))),
  };
}

module.exports = {
  DEFAULT_PHASE8_POLICY,
  FX_PHASE8_NO_SHOW_SCHEMA,
  FX_PHASE8_POLICY_SCHEMA,
  FX_PHASE8_REQUESTER_ABANDONMENT_SCHEMA,
  FX_PHASE8_SLICE_PLAN_SCHEMA,
  FX_PHASE8_VERSION,
  FxPhase8PolicyError,
  coarseCapacityBand,
  createDealerNoShowEvidence,
  createIndependentSlicePlan,
  createRequesterAbandonmentEvidence,
  evaluatePhase8Economics,
  normalizePhase8Policy,
  verifyDealerNoShowEvidence,
  verifyPhase8EvidenceAttestation,
  verifyPhase8SourceLockPackage,
  verifyRequesterAbandonmentEvidence,
};
