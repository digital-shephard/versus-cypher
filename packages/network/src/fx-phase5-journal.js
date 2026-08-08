const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { keccak256 } = require("ethers");

const ACTION_STATES = new Set([
  "signed",
  "uncertain",
  "confirmed",
  "reverted",
]);
const ACTION_SLOTS = new Set([
  "source_approval",
  "source_fund",
  "destination_approval",
  "destination_fund",
  "destination_claim",
  "source_claim",
  "destination_refund",
  "source_refund",
]);

class FxPhase5JournalError extends Error {
  constructor(message, code = "FX_PHASE5_JOURNAL_ERROR") {
    super(message);
    this.name = "FxPhase5JournalError";
    this.code = code;
  }
}

function hash(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new FxPhase5JournalError(`${label} must be bytes32`);
  }
  return normalized;
}

function rawTransaction(value) {
  const normalized = String(value || "").toLowerCase();
  if (!/^0x[0-9a-f]+$/.test(normalized) || normalized.length % 2 !== 0) {
    throw new FxPhase5JournalError("raw transaction is invalid");
  }
  return normalized;
}

function actionSlot(value) {
  if (!ACTION_SLOTS.has(value)) {
    throw new FxPhase5JournalError("action slot is unsupported");
  }
  return value;
}

function parseJson(value) {
  return value ? JSON.parse(value) : null;
}

function journalKey(secret) {
  if (Buffer.isBuffer(secret) || secret instanceof Uint8Array) {
    const key = Buffer.from(secret);
    if (key.length !== 32) {
      throw new FxPhase5JournalError("journal encryption key must be 32 bytes");
    }
    return key;
  }
  if (typeof secret !== "string" || secret.length < 12) {
    throw new FxPhase5JournalError(
      "journal encryption secret must contain at least 12 characters"
    );
  }
  return crypto.scryptSync(
    Buffer.from(secret, "utf8"),
    Buffer.from("versus-fx-phase5-journal-v1", "utf8"),
    32,
    { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
  );
}

function actionAad({ tradeId, slot, chainId, transactionHash }) {
  return Buffer.from(
    `${tradeId}:${slot}:${String(chainId)}:${transactionHash}`,
    "utf8"
  );
}

function encryptRawTransaction(value, identity, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(actionAad(identity));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(value, "utf8")),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

function decryptRawTransaction(value, identity, key) {
  try {
    const [version, iv, authTag, ciphertext, extra] = String(value).split(".");
    if (version !== "v1" || extra !== undefined) {
      throw new Error("unsupported envelope");
    }
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(iv, "base64")
    );
    decipher.setAAD(actionAad(identity));
    decipher.setAuthTag(Buffer.from(authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    return rawTransaction(plaintext);
  } catch {
    throw new FxPhase5JournalError(
      "signed transaction envelope cannot be authenticated",
      "CORRUPT_ACTION"
    );
  }
}

class FxPhase5Journal {
  constructor({
    filePath,
    encryptionSecret,
    now = () => Math.floor(Date.now() / 1000),
  }) {
    if (typeof filePath !== "string" || !filePath.trim()) {
      throw new TypeError("Phase 5 journal requires filePath");
    }
    this.filePath = path.resolve(filePath);
    this.encryptionKey = journalKey(encryptionSecret);
    this.now = now;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    try { fs.chmodSync(path.dirname(this.filePath), 0o700); } catch {}
    let database;
    try {
      database = new DatabaseSync(this.filePath, {
        enableForeignKeyConstraints: true,
      });
      try { fs.chmodSync(this.filePath, 0o600); } catch {}
      database.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;"
      );
      database.exec(`
      CREATE TABLE IF NOT EXISTS fx_phase5_trades (
        trade_id TEXT PRIMARY KEY,
        route_id TEXT NOT NULL,
        route_json TEXT NOT NULL,
        recovery_file TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        owner_approved INTEGER NOT NULL DEFAULT 0 CHECK(owner_approved IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS fx_phase5_actions (
        trade_id TEXT NOT NULL,
        slot TEXT NOT NULL,
        chain_id TEXT NOT NULL,
        state TEXT NOT NULL,
        transaction_hash TEXT NOT NULL,
        raw_transaction TEXT NOT NULL,
        receipt_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(trade_id, slot),
        FOREIGN KEY(trade_id) REFERENCES fx_phase5_trades(trade_id)
      ) STRICT;
    `);
    } catch (error) {
      try { database?.close(); } catch {}
      throw error;
    }
    this.db = database;
  }

  close() {
    this.db.close();
  }

  prepareTrade({ tradeId, route, recoveryFile, secretHash }) {
    tradeId = hash(tradeId, "tradeId");
    const routeId = hash(route?.routeId, "route.routeId");
    secretHash = hash(secretHash, "secretHash");
    if (typeof recoveryFile !== "string" || !recoveryFile.trim()) {
      throw new FxPhase5JournalError("recoveryFile is required");
    }
    const existing = this.trade(tradeId);
    if (existing) {
      if (
        existing.routeId !== routeId ||
        existing.secretHash !== secretHash ||
        existing.recoveryFile !== path.resolve(recoveryFile)
      ) {
        throw new FxPhase5JournalError(
          "trade identity conflicts with its durable record",
          "TRADE_CONFLICT"
        );
      }
      return existing;
    }
    const now = this.now();
    this.db.prepare(`
      INSERT INTO fx_phase5_trades(
        trade_id, route_id, route_json, recovery_file, secret_hash,
        owner_approved, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      tradeId,
      routeId,
      JSON.stringify(route),
      path.resolve(recoveryFile),
      secretHash,
      now,
      now
    );
    return this.trade(tradeId);
  }

  trade(tradeId) {
    tradeId = hash(tradeId, "tradeId");
    const row = this.db
      .prepare("SELECT * FROM fx_phase5_trades WHERE trade_id = ?")
      .get(tradeId);
    if (!row) return null;
    const actions = this.db
      .prepare(`
        SELECT * FROM fx_phase5_actions
        WHERE trade_id = ?
        ORDER BY created_at, slot
      `)
      .all(tradeId)
      .map((action) => this.#actionFromRow(action));
    return {
      tradeId: row.trade_id,
      routeId: row.route_id,
      route: JSON.parse(row.route_json),
      recoveryFile: row.recovery_file,
      secretHash: row.secret_hash,
      ownerApproved: row.owner_approved === 1,
      state: this.deriveState(actions, row.owner_approved === 1),
      actions,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  approveFromOwnerUi(tradeId, confirmed) {
    const trade = this.trade(tradeId);
    if (!trade) {
      throw new FxPhase5JournalError("trade does not exist", "UNKNOWN_TRADE");
    }
    if (confirmed !== true) {
      throw new FxPhase5JournalError(
        "explicit owner approval is required",
        "OWNER_REQUIRED"
      );
    }
    this.db.prepare(`
      UPDATE fx_phase5_trades
      SET owner_approved = 1, updated_at = ?
      WHERE trade_id = ?
    `).run(this.now(), trade.tradeId);
    return this.trade(trade.tradeId);
  }

  requireOwnerApproved(tradeId) {
    const trade = this.trade(tradeId);
    if (!trade?.ownerApproved) {
      throw new FxPhase5JournalError(
        "trade requires explicit owner approval",
        "OWNER_REQUIRED"
      );
    }
    return trade;
  }

  action(tradeId, slot) {
    tradeId = hash(tradeId, "tradeId");
    slot = actionSlot(slot);
    const row = this.db.prepare(`
      SELECT * FROM fx_phase5_actions WHERE trade_id = ? AND slot = ?
    `).get(tradeId, slot);
    if (!row) return null;
    return this.#actionFromRow(row);
  }

  recordSignedAction({
    tradeId,
    slot,
    chainId,
    transactionHash,
    rawTransaction: serialized,
  }) {
    const trade = this.requireOwnerApproved(tradeId);
    slot = actionSlot(slot);
    const normalizedRaw = rawTransaction(serialized);
    const computedHash = keccak256(normalizedRaw).toLowerCase();
    transactionHash = hash(transactionHash, "transactionHash");
    if (transactionHash !== computedHash) {
      throw new FxPhase5JournalError(
        "transaction hash does not match signed bytes",
        "BAD_TRANSACTION_HASH"
      );
    }
    const existing = this.action(trade.tradeId, slot);
    if (existing) {
      if (
        existing.transactionHash !== transactionHash ||
        existing.rawTransaction !== normalizedRaw ||
        existing.chainId !== String(BigInt(chainId))
      ) {
        throw new FxPhase5JournalError(
          "action slot already contains different signed bytes",
          "ACTION_CONFLICT"
        );
      }
      return existing;
    }
    const now = this.now();
    const encryptedRaw = encryptRawTransaction(
      normalizedRaw,
      {
        tradeId: trade.tradeId,
        slot,
        chainId: String(BigInt(chainId)),
        transactionHash,
      },
      this.encryptionKey
    );
    this.db.prepare(`
      INSERT INTO fx_phase5_actions(
        trade_id, slot, chain_id, state, transaction_hash, raw_transaction,
        created_at, updated_at
      ) VALUES(?, ?, ?, 'signed', ?, ?, ?, ?)
    `).run(
      trade.tradeId,
      slot,
      String(BigInt(chainId)),
      transactionHash,
      encryptedRaw,
      now,
      now
    );
    return this.action(trade.tradeId, slot);
  }

  markAction(tradeId, slot, state, receipt = null) {
    if (!ACTION_STATES.has(state) || state === "signed") {
      throw new FxPhase5JournalError("action terminal state is unsupported");
    }
    const existing = this.action(tradeId, slot);
    if (!existing) {
      throw new FxPhase5JournalError("signed action does not exist", "UNKNOWN_ACTION");
    }
    if (["confirmed", "reverted"].includes(existing.state)) {
      if (existing.state === state) return existing;
      throw new FxPhase5JournalError(
        "terminal action state is immutable",
        "ACTION_TERMINAL"
      );
    }
    if (receipt?.hash && hash(receipt.hash, "receipt.hash") !== existing.transactionHash) {
      throw new FxPhase5JournalError("receipt belongs to another transaction");
    }
    this.db.prepare(`
      UPDATE fx_phase5_actions
      SET state = ?, receipt_json = ?, updated_at = ?
      WHERE trade_id = ? AND slot = ?
    `).run(
      state,
      receipt ? JSON.stringify(receipt) : null,
      this.now(),
      existing.tradeId,
      existing.slot
    );
    this.db.prepare(`
      UPDATE fx_phase5_trades SET updated_at = ? WHERE trade_id = ?
    `).run(this.now(), existing.tradeId);
    return this.action(existing.tradeId, existing.slot);
  }

  deriveState(actions, ownerApproved) {
    const confirmed = new Set(
      actions.filter((action) => action.state === "confirmed").map((action) => action.slot)
    );
    if (confirmed.has("source_claim")) return "completed";
    if (confirmed.has("source_refund")) return "refunded";
    if (confirmed.has("destination_refund")) return "destination_refunded";
    if (confirmed.has("destination_claim")) return "destination_claimed";
    if (confirmed.has("destination_fund")) return "destination_funded";
    if (confirmed.has("source_fund")) return "source_funded";
    return ownerApproved ? "owner_approved" : "prepared";
  }

  #actionFromRow(row) {
    const identity = {
      tradeId: row.trade_id,
      slot: row.slot,
      chainId: row.chain_id,
      transactionHash: row.transaction_hash,
    };
    return {
      ...identity,
      state: row.state,
      transactionHash: row.transaction_hash,
      rawTransaction: decryptRawTransaction(
        row.raw_transaction,
        identity,
        this.encryptionKey
      ),
      receipt: parseJson(row.receipt_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

module.exports = {
  ACTION_SLOTS,
  FxPhase5Journal,
  FxPhase5JournalError,
};
