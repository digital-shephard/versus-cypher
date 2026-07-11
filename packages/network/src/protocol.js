const {
  getAddress,
  isAddress,
  keccak256,
  toUtf8Bytes,
  verifyMessage,
} = require("ethers");

const POSTCARD_PROTOCOL = "versus-postcard";
const POSTCARD_VERSION = 4;
const MAX_BODY_CHARS = 320;
const MAX_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_CLOCK_SKEW_SECONDS = 5 * 60;
const RATE_EPOCH_SECONDS = 10 * 60;
const RATE_SLOTS_PER_EPOCH = 32;
const VOICE_DAY_SECONDS = 24 * 60 * 60;

const POSTCARD_TYPES = Object.freeze([
  "observation",
  "question",
  "proposal",
  "critique",
  "endorsement",
  "prediction",
  "mission",
  "outcome",
  "receipt",
]);

const SIGNAL_TYPES = Object.freeze([
  "observation",
  "question",
  "proposal",
  "critique",
  "endorsement",
  "prediction",
  "mission",
  "outcome",
]);

const SIGNAL_INK_PENNIES = Object.freeze({
  observation: 1,
  question: 1,
  proposal: 3,
  critique: 1,
  endorsement: 1,
  prediction: 1,
  mission: 5,
  outcome: 2,
});

const BODY_PATTERN = /^[a-z0-9]+(?: [a-z0-9]+)*$/;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const ARTIFACT_PATTERN = /^[a-zA-Z0-9:_-]{1,200}$/;

class PostcardValidationError extends Error {
  constructor(message, code = "INVALID_POSTCARD") {
    super(message);
    this.name = "PostcardValidationError";
    this.code = code;
  }
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PostcardValidationError(`${label} must be an object`);
  }
}

function normalizeAddress(value) {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new PostcardValidationError("author must be an ethereum address");
  }
  return getAddress(value).toLowerCase();
}

function normalizeUnsignedInteger(value, label, { allowZero = true } = {}) {
  if (typeof value === "string" && /^\d+$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new PostcardValidationError(`${label} must be a safe unsigned integer`);
  }
  return value;
}

function normalizeUintString(value, label, { allowZero = true, maxDigits = 78 } = {}) {
  const text = typeof value === "bigint" ? value.toString() : String(value);
  if (!/^\d+$/.test(text) || text.length > maxDigits || (!allowZero && text === "0")) {
    throw new PostcardValidationError(`${label} must be an unsigned integer string`);
  }
  return BigInt(text).toString();
}

function normalizeOptionalHash(value, label) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new PostcardValidationError(`${label} must be a lowercase bytes32 hash`);
  }
  return value;
}

function normalizeOptionalArtifact(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !ARTIFACT_PATTERN.test(value)) {
    throw new PostcardValidationError("artifact must be a compact content reference");
  }
  return value;
}

function normalizeBody(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_BODY_CHARS) {
    throw new PostcardValidationError(`body must contain 1 to ${MAX_BODY_CHARS} characters`);
  }
  if (!BODY_PATTERN.test(value)) {
    throw new PostcardValidationError(
      "body may contain only lowercase ascii letters numbers and single spaces"
    );
  }
  return value;
}

function rateEpochFor(createdAt) {
  return Math.floor(Number(createdAt) / RATE_EPOCH_SECONDS);
}

function voiceDayFor(createdAt) {
  return Math.floor(Number(createdAt) / VOICE_DAY_SECONDS);
}

function computeRateNullifier({ launchId, cypherId, voiceDay, epoch, slot }) {
  return keccak256(
    toUtf8Bytes(
      JSON.stringify({
        protocol: POSTCARD_PROTOCOL,
        version: POSTCARD_VERSION,
        launchId: String(launchId),
        cypherId: String(cypherId),
        voiceDay: Number(voiceDay),
        epoch: Number(epoch),
        slot: Number(slot),
      })
    )
  );
}

function normalizePayload(input) {
  assertPlainObject(input, "postcard");

  const type = String(input.type || "");
  if (!POSTCARD_TYPES.includes(type)) {
    throw new PostcardValidationError(`unsupported postcard type ${type || "empty"}`);
  }

  const createdAt = normalizeUnsignedInteger(input.createdAt, "createdAt", { allowZero: false });
  const expiresAt = normalizeUnsignedInteger(input.expiresAt, "expiresAt", { allowZero: false });
  if (expiresAt <= createdAt || expiresAt - createdAt > MAX_LIFETIME_SECONDS) {
    throw new PostcardValidationError("expiresAt must be after createdAt and within seven days");
  }

  const amountMicros =
    input.amountMicros === undefined || input.amountMicros === null
      ? null
      : normalizeUintString(input.amountMicros, "amountMicros", { maxDigits: 39 });

  const launchId = normalizeUintString(input.launchId, "launchId");
  const cypherId = normalizeUintString(input.cypherId, "cypherId");
  const voiceDay = normalizeUnsignedInteger(input.voiceDay, "voiceDay");
  if (voiceDay !== voiceDayFor(createdAt)) {
    throw new PostcardValidationError("voiceDay does not match the postcard timestamp");
  }
  const epoch = normalizeUnsignedInteger(input.epoch, "epoch");
  const slot = normalizeUnsignedInteger(input.slot, "slot");
  if (epoch !== rateEpochFor(createdAt)) {
    throw new PostcardValidationError("epoch does not match the postcard timestamp");
  }
  if (slot >= RATE_SLOTS_PER_EPOCH) {
    throw new PostcardValidationError(`slot must be below ${RATE_SLOTS_PER_EPOCH}`);
  }
  const rateNullifier = computeRateNullifier({ launchId, cypherId, voiceDay, epoch, slot });
  if (input.rateNullifier !== undefined && input.rateNullifier !== rateNullifier) {
    throw new PostcardValidationError("rate nullifier does not match the Cypher epoch slot");
  }

  return {
    protocol: POSTCARD_PROTOCOL,
    version: POSTCARD_VERSION,
    type,
    launchId,
    author: normalizeAddress(input.author),
    cypherId,
    sequence: normalizeUnsignedInteger(input.sequence, "sequence"),
    voiceDay,
    epoch,
    slot,
    rateNullifier,
    createdAt,
    expiresAt,
    body: normalizeBody(input.body),
    replyTo: normalizeOptionalHash(input.replyTo, "replyTo"),
    artifact: normalizeOptionalArtifact(input.artifact),
    amountMicros,
  };
}

function canonicalPayload(payload) {
  return JSON.stringify(normalizePayload(payload));
}

function computePostcardId(payload) {
  return keccak256(toUtf8Bytes(canonicalPayload(payload)));
}

function assemblePostcard(payload, signature) {
  const normalized = normalizePayload(payload);
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new PostcardValidationError("signature must be a 65 byte hex value");
  }
  return {
    ...normalized,
    signature,
    id: computePostcardId(normalized),
  };
}

function verifyPostcard(postcard, options = {}) {
  assertPlainObject(postcard, "postcard");
  const payload = normalizePayload(postcard);
  const assembled = assemblePostcard(payload, postcard.signature);

  if (postcard.id !== assembled.id) {
    throw new PostcardValidationError("postcard id does not match its payload", "BAD_ID");
  }

  let recovered;
  try {
    recovered = verifyMessage(canonicalPayload(payload), postcard.signature).toLowerCase();
  } catch (_) {
    throw new PostcardValidationError("postcard signature is invalid", "BAD_SIGNATURE");
  }
  if (recovered !== payload.author) {
    throw new PostcardValidationError("postcard signature does not match author", "BAD_SIGNATURE");
  }

  if (options.temporal !== false) {
    const now = options.now ?? Math.floor(Date.now() / 1000);
    const clockSkew = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
    if (payload.createdAt > now + clockSkew) {
      throw new PostcardValidationError("postcard is too far in the future", "FUTURE_POSTCARD");
    }
    if (payload.expiresAt < now - clockSkew) {
      throw new PostcardValidationError("postcard has expired", "EXPIRED_POSTCARD");
    }
  }

  return assembled;
}

module.exports = {
  BODY_PATTERN,
  DEFAULT_CLOCK_SKEW_SECONDS,
  MAX_BODY_CHARS,
  MAX_LIFETIME_SECONDS,
  POSTCARD_PROTOCOL,
  POSTCARD_TYPES,
  POSTCARD_VERSION,
  RATE_EPOCH_SECONDS,
  RATE_SLOTS_PER_EPOCH,
  VOICE_DAY_SECONDS,
  SIGNAL_INK_PENNIES,
  SIGNAL_TYPES,
  PostcardValidationError,
  assemblePostcard,
  canonicalPayload,
  computePostcardId,
  computeRateNullifier,
  normalizePayload,
  rateEpochFor,
  voiceDayFor,
  verifyPostcard,
};
