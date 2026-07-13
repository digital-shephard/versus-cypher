const crypto = require("crypto");

const BACKUP_VERSION = 1;
const SCRYPT_OPTIONS = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function requirePassword(password) {
  if (typeof password !== "string" || password.length < 8 || password.length > 256) {
    throw new RangeError("backup password must contain 8 to 256 characters");
  }
}

function sealPayload(format, payload, password) {
  requirePassword(password);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32, SCRYPT_OPTIONS);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify({ version: BACKUP_VERSION, ...payload }), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    format,
    version: BACKUP_VERSION,
    kdf: "scrypt-n32768-r8-p1",
    cipher: "aes-256-gcm",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: ciphertext.toString("base64"),
  };
}

function openPayload(record, password, format) {
  requirePassword(password);
  if (record?.format !== format || record.version !== BACKUP_VERSION) {
    throw new Error(`unsupported ${format}`);
  }
  try {
    const key = crypto.scryptSync(password, Buffer.from(record.salt, "base64"), 32, SCRYPT_OPTIONS);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"));
    decipher.setAuthTag(Buffer.from(record.tag, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(record.data, "base64")), decipher.final()]);
    const payload = JSON.parse(plaintext.toString("utf8"));
    if (payload.version !== BACKUP_VERSION) throw new Error("invalid payload");
    return payload;
  } catch (_) {
    throw new Error("backup password is wrong or the file is damaged");
  }
}

function createWalletBackup(payload, password) {
  if (!payload?.privateKey || !payload?.address) throw new TypeError("wallet backup requires an address and private key");
  return sealPayload("versus-wallet-backup", payload, password);
}

function openWalletBackup(record, password) {
  const payload = openPayload(record, password, "versus-wallet-backup");
  if (!payload.privateKey || !payload.address) throw new Error("wallet backup password is wrong or the file is damaged");
  return payload;
}

function createCypherArchive(payload, password) {
  if (!payload?.privateKey || !payload?.address || !payload?.networkState) {
    throw new TypeError("Cypher archive requires wallet identity and network state");
  }
  return sealPayload("versus-cypher-archive", payload, password);
}

function openCypherArchive(record, password) {
  const payload = openPayload(record, password, "versus-cypher-archive");
  if (!payload.privateKey || !payload.address || !payload.networkState) {
    throw new Error("backup password is wrong or the file is damaged");
  }
  return payload;
}

function openVersusBackup(record, password) {
  if (record?.format === "versus-wallet-backup") {
    return { format: record.format, payload: openWalletBackup(record, password) };
  }
  if (record?.format === "versus-cypher-archive") {
    return { format: record.format, payload: openCypherArchive(record, password) };
  }
  throw new Error("unsupported Versus backup");
}

module.exports = {
  BACKUP_VERSION,
  createCypherArchive,
  createWalletBackup,
  openCypherArchive,
  openVersusBackup,
  openWalletBackup,
  openPayload,
  sealPayload,
};
