const fs = require("node:fs");
const path = require("node:path");
const { Wallet, hexlify, randomBytes } = require("ethers");

const FX_EPHEMERAL_IDENTITY_SCHEMA = "versus-fx-ephemeral-identity";
const FX_EPHEMERAL_IDENTITY_VERSION = 1;
const DEFAULT_EPHEMERAL_IDENTITY_LIFETIME_SECONDS = 24 * 60 * 60;

class FxEphemeralIdentityError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "FxEphemeralIdentityError";
    this.code = code;
  }
}

function validateRecord(record, now) {
  if (
    !record ||
    record.schema !== FX_EPHEMERAL_IDENTITY_SCHEMA ||
    record.schemaVersion !== FX_EPHEMERAL_IDENTITY_VERSION ||
    !Number.isSafeInteger(record.createdAt) ||
    !Number.isSafeInteger(record.expiresAt) ||
    record.expiresAt <= record.createdAt ||
    !record.keystore ||
    typeof record.keystore !== "object"
  ) {
    throw new FxEphemeralIdentityError(
      "FX ephemeral identity record is malformed",
      "EPHEMERAL_IDENTITY_INVALID"
    );
  }
  if (record.expiresAt < now) {
    throw new FxEphemeralIdentityError(
      "FX ephemeral identity expired; archive the completed run before creating another",
      "EPHEMERAL_IDENTITY_EXPIRED"
    );
  }
  return record;
}

async function loadOrCreateFxEphemeralIdentity({
  filePath,
  password,
  lifetimeSeconds = DEFAULT_EPHEMERAL_IDENTITY_LIFETIME_SECONDS,
  now = () => Math.floor(Date.now() / 1000),
  walletFactory = () => Wallet.createRandom(),
} = {}) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new TypeError("FX ephemeral identity path is required");
  }
  filePath = path.resolve(filePath);
  if (typeof password !== "string" || password.length < 8) {
    throw new TypeError("FX ephemeral identity password must contain at least eight characters");
  }
  lifetimeSeconds = Number(lifetimeSeconds);
  if (
    !Number.isSafeInteger(lifetimeSeconds) ||
    lifetimeSeconds < 60 ||
    lifetimeSeconds > 7 * 24 * 60 * 60
  ) {
    throw new RangeError("FX ephemeral identity lifetime must be between one minute and seven days");
  }
  const currentTime = Number(now());
  if (!Number.isSafeInteger(currentTime) || currentTime < 0) {
    throw new TypeError("FX ephemeral identity clock is invalid");
  }

  if (fs.existsSync(filePath)) {
    const record = validateRecord(
      JSON.parse(fs.readFileSync(filePath, "utf8")),
      currentTime
    );
    const wallet = await Wallet.fromEncryptedJson(
      JSON.stringify(record.keystore),
      password
    );
    return {
      wallet,
      created: false,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      filePath,
    };
  }

  const wallet = walletFactory();
  const createdAt = currentTime;
  const expiresAt = createdAt + lifetimeSeconds;
  const record = {
    schema: FX_EPHEMERAL_IDENTITY_SCHEMA,
    schemaVersion: FX_EPHEMERAL_IDENTITY_VERSION,
    createdAt,
    expiresAt,
    address: wallet.address.toLowerCase(),
    keystore: JSON.parse(await wallet.encrypt(password)),
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${hexlify(randomBytes(6)).slice(2)}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, filePath);
  return {
    wallet,
    created: true,
    createdAt,
    expiresAt,
    filePath,
  };
}

module.exports = {
  DEFAULT_EPHEMERAL_IDENTITY_LIFETIME_SECONDS,
  FX_EPHEMERAL_IDENTITY_SCHEMA,
  FX_EPHEMERAL_IDENTITY_VERSION,
  FxEphemeralIdentityError,
  loadOrCreateFxEphemeralIdentity,
};
