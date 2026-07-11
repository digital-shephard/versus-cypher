const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { getAddress, isAddress } = require("ethers");

const ARTIFACT_PROTOCOL = "versus:sha256";
const ARTIFACT_REFERENCE_PATTERN = /^versus:sha256:([0-9a-f]{64})$/;
const MAX_ARTIFACT_BYTES = 12_000;
const MISSION_MANIFEST_VERSION = 1;
const OUTCOME_MANIFEST_VERSION = 1;
const OUTCOME_STATUSES = Object.freeze(["success", "partial", "failure", "disputed"]);
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;

class ArtifactValidationError extends Error {
  constructor(message, code = "INVALID_ARTIFACT") {
    super(message);
    this.name = "ArtifactValidationError";
    this.code = code;
  }
}

function canonicalJson(value, state = { entries: 0 }, depth = 0) {
  if (depth > 16) throw new ArtifactValidationError("artifact nesting exceeds sixteen levels");
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new ArtifactValidationError("artifact numbers must be safe integers");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    state.entries += value.length;
    if (state.entries > 1024) throw new ArtifactValidationError("artifact contains too many values");
    return `[${value.map((item) => canonicalJson(item, state, depth + 1)).join(",")}]`;
  }
  if (!value || typeof value !== "object") {
    throw new ArtifactValidationError("artifact must contain only json values");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ArtifactValidationError("artifact objects must be plain objects");
  }
  const keys = Object.keys(value).sort();
  state.entries += keys.length;
  if (state.entries > 1024) throw new ArtifactValidationError("artifact contains too many values");
  return `{${keys
    .map((key) => {
      if (value[key] === undefined) throw new ArtifactValidationError("artifact values cannot be undefined");
      return `${JSON.stringify(key)}:${canonicalJson(value[key], state, depth + 1)}`;
    })
    .join(",")}}`;
}

function encodeArtifact(value, maxBytes = MAX_ARTIFACT_BYTES) {
  const canonical = canonicalJson(value);
  const bytes = Buffer.byteLength(canonical, "utf8");
  if (bytes > maxBytes) {
    throw new ArtifactValidationError(`artifact exceeds ${maxBytes} bytes`, "ARTIFACT_TOO_LARGE");
  }
  return canonical;
}

function artifactReference(value, maxBytes = MAX_ARTIFACT_BYTES) {
  const encoded = encodeArtifact(value, maxBytes);
  const hash = crypto.createHash("sha256").update(encoded, "utf8").digest("hex");
  return `${ARTIFACT_PROTOCOL}:${hash}`;
}

function normalizeArtifactReference(reference) {
  if (typeof reference !== "string") {
    throw new ArtifactValidationError("artifact reference must be a string", "BAD_ARTIFACT_REFERENCE");
  }
  const match = ARTIFACT_REFERENCE_PATTERN.exec(reference);
  if (!match) {
    throw new ArtifactValidationError("artifact reference must use versus sha256", "BAD_ARTIFACT_REFERENCE");
  }
  return { reference, hash: match[1] };
}

function normalizeText(value, label, maxLength) {
  if (typeof value !== "string") throw new ArtifactValidationError(`${label} must be text`);
  const normalized = value.normalize("NFC").trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new ArtifactValidationError(`${label} must contain 1 to ${maxLength} visible characters`);
  }
  return normalized;
}

function normalizeTextList(value, label, { min, max, itemMax }) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new ArtifactValidationError(`${label} must contain ${min} to ${max} entries`);
  }
  return value.map((item, index) => normalizeText(item, `${label} ${index + 1}`, itemMax));
}

function normalizeUintString(value, label, maxDigits = 78) {
  const text = String(value);
  if (!/^\d+$/.test(text) || text.length > maxDigits) {
    throw new ArtifactValidationError(`${label} must be an unsigned integer`);
  }
  return BigInt(text).toString();
}

function normalizeMissionManifest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ArtifactValidationError("mission manifest must be an object");
  }
  if (input.kind !== "versus-mission") {
    throw new ArtifactValidationError("mission manifest kind must be versus-mission");
  }
  if (Number(input.version) !== MISSION_MANIFEST_VERSION) {
    throw new ArtifactValidationError("mission manifest version is unsupported");
  }
  if (typeof input.author !== "string" || !isAddress(input.author)) {
    throw new ArtifactValidationError("mission author must be an ethereum address");
  }
  const createdAt = Number(input.createdAt);
  const expiresAt = Number(input.expiresAt);
  if (!Number.isSafeInteger(createdAt) || createdAt < 1) {
    throw new ArtifactValidationError("mission createdAt must be a unix timestamp");
  }
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= createdAt ||
    expiresAt - createdAt > 30 * 24 * 60 * 60
  ) {
    throw new ArtifactValidationError("mission must expire within thirty days of creation");
  }
  return {
    kind: "versus-mission",
    version: MISSION_MANIFEST_VERSION,
    launchId: normalizeUintString(input.launchId, "mission launchId"),
    author: getAddress(input.author).toLowerCase(),
    title: normalizeText(input.title, "mission title", 80),
    objective: normalizeText(input.objective, "mission objective", 800),
    steps: normalizeTextList(input.steps, "mission steps", { min: 1, max: 12, itemMax: 240 }),
    successConditions: normalizeTextList(input.successConditions, "mission success conditions", {
      min: 1,
      max: 8,
      itemMax: 240,
    }),
    evidenceRequirements: normalizeTextList(
      input.evidenceRequirements,
      "mission evidence requirements",
      { min: 1, max: 8, itemMax: 240 }
    ),
    createdAt,
    expiresAt,
    budgetMicros: normalizeUintString(input.budgetMicros ?? "0", "mission budgetMicros", 39),
  };
}

function verifyMissionPostcardArtifact(postcard, value) {
  const manifest = normalizeMissionManifest(value);
  if (postcard.type !== "mission") {
    throw new ArtifactValidationError("a mission manifest may only be attached to a mission postcard");
  }
  if (manifest.launchId !== postcard.launchId) {
    throw new ArtifactValidationError("mission manifest launch does not match its postcard");
  }
  if (manifest.author !== postcard.author) {
    throw new ArtifactValidationError("mission manifest author does not match its postcard");
  }
  if (manifest.budgetMicros !== (postcard.amountMicros || "0")) {
    throw new ArtifactValidationError("mission manifest budget does not match its postcard");
  }
  return manifest;
}

function normalizeOutcomeManifest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ArtifactValidationError("outcome manifest must be an object");
  }
  if (input.kind !== "versus-outcome") {
    throw new ArtifactValidationError("outcome manifest kind must be versus-outcome");
  }
  if (Number(input.version) !== OUTCOME_MANIFEST_VERSION) {
    throw new ArtifactValidationError("outcome manifest version is unsupported");
  }
  if (typeof input.reporter !== "string" || !isAddress(input.reporter)) {
    throw new ArtifactValidationError("outcome reporter must be an ethereum address");
  }
  if (typeof input.missionId !== "string" || !HASH_PATTERN.test(input.missionId)) {
    throw new ArtifactValidationError("outcome missionId must be a postcard hash");
  }
  const status = String(input.status || "");
  if (!OUTCOME_STATUSES.includes(status)) {
    throw new ArtifactValidationError("outcome status is unsupported");
  }
  const completedAt = Number(input.completedAt);
  if (!Number.isSafeInteger(completedAt) || completedAt < 1) {
    throw new ArtifactValidationError("outcome completedAt must be a unix timestamp");
  }
  if (!Array.isArray(input.evidenceReferences) || input.evidenceReferences.length > 16) {
    throw new ArtifactValidationError("outcome evidenceReferences must contain zero to sixteen hashes");
  }
  const evidenceReferences = input.evidenceReferences.map((reference) => {
    normalizeArtifactReference(reference);
    return reference;
  });
  return {
    kind: "versus-outcome",
    version: OUTCOME_MANIFEST_VERSION,
    launchId: normalizeUintString(input.launchId, "outcome launchId"),
    missionId: input.missionId,
    reporter: getAddress(input.reporter).toLowerCase(),
    status,
    summary: normalizeText(input.summary, "outcome summary", 800),
    evidenceReferences,
    completedAt,
  };
}

function verifyOutcomePostcardArtifact(postcard, mission, value) {
  const manifest = normalizeOutcomeManifest(value);
  if (postcard.type !== "outcome") {
    throw new ArtifactValidationError("an outcome manifest may only be attached to an outcome postcard");
  }
  if (!mission || mission.type !== "mission" || postcard.replyTo !== mission.id) {
    throw new ArtifactValidationError("outcome postcard must directly reference its mission");
  }
  if (manifest.launchId !== postcard.launchId || mission.launchId !== postcard.launchId) {
    throw new ArtifactValidationError("outcome manifest launch does not match its postcard");
  }
  if (manifest.missionId !== mission.id) {
    throw new ArtifactValidationError("outcome manifest mission does not match its postcard");
  }
  if (manifest.reporter !== postcard.author) {
    throw new ArtifactValidationError("outcome manifest reporter does not match its postcard");
  }
  return manifest;
}

class ArtifactStore {
  constructor({ directory = null, maxBytes = MAX_ARTIFACT_BYTES } = {}) {
    if (!Number.isInteger(maxBytes) || maxBytes < 256 || maxBytes > MAX_ARTIFACT_BYTES) {
      throw new RangeError(`maxBytes must be between 256 and ${MAX_ARTIFACT_BYTES}`);
    }
    this.directory = directory;
    this.maxBytes = maxBytes;
    this.memory = new Map();
  }

  pathFor(reference) {
    const { hash } = normalizeArtifactReference(reference);
    return this.directory ? path.join(this.directory, `${hash}.json`) : null;
  }

  put(value) {
    const encoded = encodeArtifact(value, this.maxBytes);
    const reference = artifactReference(value, this.maxBytes);
    this.write(reference, encoded);
    return reference;
  }

  import(reference, value) {
    normalizeArtifactReference(reference);
    const encoded = encodeArtifact(value, this.maxBytes);
    const actual = artifactReference(value, this.maxBytes);
    if (actual !== reference) {
      throw new ArtifactValidationError("artifact bytes do not match their reference", "ARTIFACT_HASH_MISMATCH");
    }
    this.write(reference, encoded);
    return reference;
  }

  write(reference, encoded) {
    this.memory.set(reference, encoded);
    const filePath = this.pathFor(reference);
    if (!filePath) return;
    fs.mkdirSync(this.directory, { recursive: true });
    if (fs.existsSync(filePath)) return;
    const temporary = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${encoded}\n`, "utf8");
    fs.renameSync(temporary, filePath);
  }

  has(reference) {
    if (!ARTIFACT_REFERENCE_PATTERN.test(String(reference))) return false;
    if (this.memory.has(reference)) return true;
    const filePath = this.pathFor(reference);
    return Boolean(filePath && fs.existsSync(filePath));
  }

  get(reference) {
    normalizeArtifactReference(reference);
    let encoded = this.memory.get(reference);
    if (!encoded) {
      const filePath = this.pathFor(reference);
      if (!filePath || !fs.existsSync(filePath)) return null;
      encoded = fs.readFileSync(filePath, "utf8").trim();
    }
    let value;
    try {
      value = JSON.parse(encoded);
    } catch (error) {
      throw new ArtifactValidationError(`stored artifact is not json: ${error.message}`, "CORRUPT_ARTIFACT");
    }
    if (artifactReference(value, this.maxBytes) !== reference) {
      throw new ArtifactValidationError("stored artifact hash does not match its filename", "ARTIFACT_HASH_MISMATCH");
    }
    this.memory.set(reference, encodeArtifact(value, this.maxBytes));
    return value;
  }

  get size() {
    const hashes = new Set(
      Array.from(this.memory.keys()).map((reference) => normalizeArtifactReference(reference).hash)
    );
    if (this.directory && fs.existsSync(this.directory)) {
      for (const name of fs.readdirSync(this.directory)) {
        if (/^[0-9a-f]{64}\.json$/.test(name)) hashes.add(name.slice(0, 64));
      }
    }
    return hashes.size;
  }

  entries() {
    const references = new Set(this.memory.keys());
    if (this.directory && fs.existsSync(this.directory)) {
      for (const name of fs.readdirSync(this.directory)) {
        if (/^[0-9a-f]{64}\.json$/.test(name)) references.add(`versus:sha256:${name.slice(0, 64)}`);
      }
    }
    return Array.from(references).sort().map((reference) => ({ reference, value: this.get(reference) }));
  }

  clear() {
    this.memory.clear();
    if (!this.directory || !fs.existsSync(this.directory)) return;
    for (const name of fs.readdirSync(this.directory)) {
      if (/^[0-9a-f]{64}\.json$/.test(name)) fs.unlinkSync(path.join(this.directory, name));
    }
  }
}

module.exports = {
  ARTIFACT_PROTOCOL,
  ARTIFACT_REFERENCE_PATTERN,
  ArtifactStore,
  ArtifactValidationError,
  MAX_ARTIFACT_BYTES,
  MISSION_MANIFEST_VERSION,
  OUTCOME_MANIFEST_VERSION,
  OUTCOME_STATUSES,
  artifactReference,
  canonicalJson,
  encodeArtifact,
  normalizeArtifactReference,
  normalizeMissionManifest,
  normalizeOutcomeManifest,
  verifyOutcomePostcardArtifact,
  verifyMissionPostcardArtifact,
};
