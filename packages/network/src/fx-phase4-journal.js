const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const STATES = new Set([
  "prepared",
  "owner_approved",
  "signed",
  "confirmed",
  "reverted",
  "uncertain",
]);

class FxPhase4JournalError extends Error {
  constructor(message, code = "FX_PHASE4_JOURNAL_ERROR") {
    super(message);
    this.name = "FxPhase4JournalError";
    this.code = code;
  }
}

function normalizeHash(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new FxPhase4JournalError(`${label} must be bytes32`);
  }
  return normalized;
}

class FxPhase4Journal {
  constructor({ filePath, now = () => Math.floor(Date.now() / 1000) }) {
    this.filePath = path.resolve(filePath);
    this.now = now;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    try { fs.chmodSync(path.dirname(this.filePath), 0o700); } catch {}
    this.db = new DatabaseSync(this.filePath, { enableForeignKeyConstraints: true });
    try { fs.chmodSync(this.filePath, 0o600); } catch {}
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fx_phase4_intents (
        intent_id TEXT PRIMARY KEY,
        route_json TEXT NOT NULL,
        cost_json TEXT NOT NULL,
        state TEXT NOT NULL,
        approval_source TEXT,
        transaction_hash TEXT,
        raw_transaction TEXT,
        receipt_block INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `);
  }

  close() {
    this.db.close();
  }

  get(intentId) {
    intentId = normalizeHash(intentId, "intentId");
    const row = this.db
      .prepare("SELECT * FROM fx_phase4_intents WHERE intent_id = ?")
      .get(intentId);
    if (!row) return null;
    return {
      intentId: row.intent_id,
      route: JSON.parse(row.route_json),
      cost: JSON.parse(row.cost_json),
      state: row.state,
      approvalSource: row.approval_source,
      transactionHash: row.transaction_hash,
      rawTransaction: row.raw_transaction,
      receiptBlock: row.receipt_block,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  prepare({ intentId, route, cost }) {
    intentId = normalizeHash(intentId, "intentId");
    const existing = this.get(intentId);
    if (existing) return existing;
    const now = this.now();
    this.db.prepare(`
      INSERT INTO fx_phase4_intents(
        intent_id, route_json, cost_json, state, created_at, updated_at
      ) VALUES(?, ?, ?, 'prepared', ?, ?)
    `).run(
      intentId,
      JSON.stringify(route, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value
      ),
      JSON.stringify(cost),
      now,
      now
    );
    return this.get(intentId);
  }

  approve(intentId, source) {
    if (source !== "owner_ui") {
      throw new FxPhase4JournalError(
        "only the owner UI may approve an FX intent",
        "OWNER_REQUIRED"
      );
    }
    const intent = this.get(intentId);
    if (!intent || intent.state !== "prepared") {
      throw new FxPhase4JournalError("intent is not awaiting approval", "BAD_STATE");
    }
    this.db.prepare(`
      UPDATE fx_phase4_intents
      SET state = 'owner_approved', approval_source = ?, updated_at = ?
      WHERE intent_id = ?
    `).run(source, this.now(), intent.intentId);
    return this.get(intent.intentId);
  }

  requireExecutable(intentId) {
    const intent = this.get(intentId);
    if (!intent || intent.state !== "owner_approved") {
      throw new FxPhase4JournalError(
        "intent requires one explicit owner approval",
        "OWNER_REQUIRED"
      );
    }
    return intent;
  }

  requireRecoverable(intentId) {
    const intent = this.get(intentId);
    if (
      !intent ||
      !["signed", "uncertain"].includes(intent.state) ||
      !intent.transactionHash ||
      !intent.rawTransaction
    ) {
      throw new FxPhase4JournalError(
        "intent has no exact signed transaction to recover",
        "BAD_STATE"
      );
    }
    return intent;
  }

  recordSignedTransaction(intentId, transactionHash, rawTransaction) {
    const intent = this.requireExecutable(intentId);
    transactionHash = normalizeHash(transactionHash, "transactionHash");
    if (typeof rawTransaction !== "string" || !/^0x[0-9a-f]+$/i.test(rawTransaction)) {
      throw new FxPhase4JournalError("rawTransaction is invalid");
    }
    this.db.prepare(`
      UPDATE fx_phase4_intents
      SET state = 'signed', transaction_hash = ?, raw_transaction = ?, updated_at = ?
      WHERE intent_id = ?
    `).run(transactionHash, rawTransaction, this.now(), intent.intentId);
    return this.get(intent.intentId);
  }

  markConfirmed(intentId, transactionHash, blockNumber) {
    return this.#terminal(intentId, "confirmed", transactionHash, blockNumber);
  }

  markReverted(intentId, transactionHash) {
    return this.#terminal(intentId, "reverted", transactionHash, null);
  }

  markUncertain(intentId, transactionHash) {
    return this.#terminal(intentId, "uncertain", transactionHash, null);
  }

  #terminal(intentId, state, transactionHash, blockNumber) {
    if (!STATES.has(state)) throw new FxPhase4JournalError("unknown state");
    const intent = this.get(intentId);
    if (!intent) throw new FxPhase4JournalError("intent does not exist", "BAD_STATE");
    if (["confirmed", "reverted"].includes(intent.state)) {
      if (intent.state === state) return intent;
      throw new FxPhase4JournalError(
        "terminal FX intent state is immutable",
        "BAD_STATE"
      );
    }
    if (!["signed", "uncertain"].includes(intent.state)) {
      throw new FxPhase4JournalError(
        "intent has not reached a signed transaction",
        "BAD_STATE"
      );
    }
    transactionHash = normalizeHash(transactionHash, "transactionHash");
    this.db.prepare(`
      UPDATE fx_phase4_intents
      SET state = ?, transaction_hash = ?, receipt_block = ?, updated_at = ?
      WHERE intent_id = ?
    `).run(state, transactionHash, blockNumber, this.now(), intent.intentId);
    return this.get(intent.intentId);
  }
}

module.exports = {
  FxPhase4Journal,
  FxPhase4JournalError,
};
