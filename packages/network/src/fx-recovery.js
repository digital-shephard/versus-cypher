const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { keccak256 } = require("ethers");

const FX_RECOVERY_VERSION = 1;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const KDF = Object.freeze({ name: "scrypt", N: 16384, r: 8, p: 1 });

class FxRecoveryError extends Error {
  constructor(message, code = "FX_RECOVERY_ERROR") {
    super(message);
    this.name = "FxRecoveryError";
    this.code = code;
  }
}

function hash(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (!HASH_PATTERN.test(normalized)) {
    throw new FxRecoveryError(`${label} must be a 32-byte hash`, "INVALID_PACKET");
  }
  return normalized;
}

function passwordBytes(password) {
  if (typeof password !== "string" || password.length < 12) {
    throw new FxRecoveryError(
      "recovery password must contain at least 12 characters",
      "WEAK_PASSWORD"
    );
  }
  return Buffer.from(password, "utf8");
}

function deriveKey(password, salt, kdf = KDF) {
  if (
    kdf?.name !== "scrypt" ||
    kdf.N !== KDF.N ||
    kdf.r !== KDF.r ||
    kdf.p !== KDF.p
  ) {
    throw new FxRecoveryError("recovery KDF parameters are unsupported", "INVALID_PACKET");
  }
  return crypto.scryptSync(passwordBytes(password), salt, 32, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: 64 * 1024 * 1024,
  });
}

function atomicWrite(filePath, value) {
  const absolute = path.resolve(filePath);
  const directory = path.dirname(absolute);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch (_) {}
  const temporary = `${absolute}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, absolute);
  try {
    const directoryDescriptor = fs.openSync(directory, "r");
    try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
  } catch (_) {}
  return absolute;
}

function validatePacket(packet) {
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) {
    throw new FxRecoveryError("recovery packet must be an object", "INVALID_PACKET");
  }
  const required = [
    "version",
    "deploymentId",
    "tradeId",
    "secretHash",
    "createdAt",
    "kdf",
    "salt",
    "iv",
    "authTag",
    "ciphertext",
  ];
  if (
    Object.keys(packet).some((key) => ![...required, "metadata"].includes(key)) ||
    required.some((key) => !(key in packet)) ||
    packet.version !== FX_RECOVERY_VERSION
  ) {
    throw new FxRecoveryError("recovery packet fields are invalid", "INVALID_PACKET");
  }
  hash(packet.deploymentId, "deploymentId");
  hash(packet.tradeId, "tradeId");
  hash(packet.secretHash, "secretHash");
  if (!Number.isSafeInteger(packet.createdAt) || packet.createdAt < 1) {
    throw new FxRecoveryError("recovery packet timestamp is invalid", "INVALID_PACKET");
  }
  for (const [field, bytes] of [["salt", 16], ["iv", 12], ["authTag", 16]]) {
    const value = Buffer.from(String(packet[field]), "base64");
    if (value.length !== bytes) {
      throw new FxRecoveryError(`${field} is invalid`, "INVALID_PACKET");
    }
  }
  const ciphertext = Buffer.from(String(packet.ciphertext), "base64");
  if (ciphertext.length < 16 || ciphertext.length > 4096) {
    throw new FxRecoveryError("ciphertext is invalid", "INVALID_PACKET");
  }
  deriveKey("validation-only-password", Buffer.from(packet.salt, "base64"), packet.kdf);
  return packet;
}

function createFxRecoveryPacket({
  filePath,
  password,
  deploymentId,
  tradeId,
  createdAt = Math.floor(Date.now() / 1000),
  secret = crypto.randomBytes(32),
  metadata = {},
} = {}) {
  const secretBytes = Buffer.from(secret);
  if (secretBytes.length !== 32) {
    throw new FxRecoveryError("FX secret must contain exactly 32 bytes", "INVALID_SECRET");
  }
  const normalizedDeployment = hash(deploymentId, "deploymentId");
  const normalizedTrade = hash(tradeId, "tradeId");
  const secretHash = keccak256(secretBytes);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(password, salt);
  const plaintext = Buffer.from(JSON.stringify({
    version: FX_RECOVERY_VERSION,
    deploymentId: normalizedDeployment,
    tradeId: normalizedTrade,
    secret: secretBytes.toString("base64"),
  }));
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${normalizedDeployment}:${normalizedTrade}:${secretHash}`));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const packet = {
    version: FX_RECOVERY_VERSION,
    deploymentId: normalizedDeployment,
    tradeId: normalizedTrade,
    secretHash,
    createdAt,
    kdf: KDF,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    metadata: { ...metadata },
  };
  atomicWrite(filePath, packet);
  return {
    filePath: path.resolve(filePath),
    packet,
    secret: secretBytes,
    secretHash,
  };
}

function restoreFxRecoveryPacket({ filePath, password, deploymentId, tradeId } = {}) {
  let packet;
  try {
    packet = JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
  } catch (error) {
    throw new FxRecoveryError(
      `recovery packet cannot be read: ${error.message}`,
      "CORRUPT_PACKET"
    );
  }
  try {
    validatePacket(packet);
    const expectedDeployment = deploymentId
      ? hash(deploymentId, "deploymentId")
      : packet.deploymentId;
    const expectedTrade = tradeId ? hash(tradeId, "tradeId") : packet.tradeId;
    if (
      packet.deploymentId !== expectedDeployment ||
      packet.tradeId !== expectedTrade
    ) {
      throw new FxRecoveryError(
        "recovery packet belongs to another trade",
        "SCOPE_MISMATCH"
      );
    }
    const salt = Buffer.from(packet.salt, "base64");
    const iv = Buffer.from(packet.iv, "base64");
    const key = deriveKey(password, salt, packet.kdf);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(
      Buffer.from(`${packet.deploymentId}:${packet.tradeId}:${packet.secretHash}`)
    );
    decipher.setAuthTag(Buffer.from(packet.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(packet.ciphertext, "base64")),
      decipher.final(),
    ]);
    const restored = JSON.parse(plaintext.toString("utf8"));
    const secret = Buffer.from(restored.secret, "base64");
    if (
      restored.version !== FX_RECOVERY_VERSION ||
      restored.deploymentId !== packet.deploymentId ||
      restored.tradeId !== packet.tradeId ||
      secret.length !== 32 ||
      keccak256(secret) !== packet.secretHash
    ) {
      throw new FxRecoveryError("recovery packet plaintext is invalid", "CORRUPT_PACKET");
    }
    return { packet, secret, secretHash: packet.secretHash };
  } catch (error) {
    if (error instanceof FxRecoveryError) throw error;
    throw new FxRecoveryError(
      "recovery packet authentication failed",
      "CORRUPT_PACKET"
    );
  }
}

module.exports = {
  FX_RECOVERY_VERSION,
  FxRecoveryError,
  createFxRecoveryPacket,
  restoreFxRecoveryPacket,
  validatePacket,
};
