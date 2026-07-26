const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { keccak256, toUtf8Bytes } = require("ethers");
const {
  advanceFxCaseState,
  advanceFxState,
  canonicalJson,
  selectSingleDealerRoute,
  verifyFxEnvelope,
} = require("./fx-protocol");

const FX_JOURNAL_VERSION = 1;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;

class FxJournalError extends Error {
  constructor(message, code = "FX_JOURNAL_ERROR") {
    super(message);
    this.name = "FxJournalError";
    this.code = code;
  }
}

function normalizeHash(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (!HASH_PATTERN.test(normalized)) {
    throw new FxJournalError(`${label} must be a 32-byte hash`, "INVALID_SCOPE");
  }
  return normalized;
}

function actionSlot(message) {
  switch (message.type) {
    case "fx_rfq":
      return "trade:open";
    case "fx_accept":
      return "trade:accept";
    case "fx_reserve":
      return "trade:reserve";
    case "fx_lock_source":
      return "lock:source";
    case "fx_lock_destination":
      return "lock:destination";
    case "fx_claim":
    case "fx_refund":
      return `settle-lock:${message.payload.lockMessageId}`;
    case "fx_complete":
      return "trade:complete";
    case "fx_default":
      return `case:default:${message.sender}`;
    case "fx_dispute":
      return `case:dispute:${message.sender}`;
    default:
      return null;
  }
}

function computeFxActionNullifier(message, slot = actionSlot(message)) {
  if (!slot) return null;
  return keccak256(toUtf8Bytes(canonicalJson({
    protocol: message.protocol,
    version: message.version,
    deploymentId: message.deploymentId,
    tradeId: message.tradeId,
    slot,
  })));
}

function parseMessage(row) {
  return row ? JSON.parse(row.message_json) : null;
}

class FxTradeJournal {
  constructor({
    filePath,
    deploymentId,
    now = () => Math.floor(Date.now() / 1000),
    minimumTimeoutDeltaSeconds = 60,
  } = {}) {
    if (typeof filePath !== "string" || !filePath.trim()) {
      throw new TypeError("FX journal requires a file path");
    }
    this.filePath = path.resolve(filePath);
    this.deploymentId = normalizeHash(deploymentId, "deploymentId");
    this.now = now;
    this.minimumTimeoutDeltaSeconds = Number(minimumTimeoutDeltaSeconds);
    if (
      !Number.isSafeInteger(this.minimumTimeoutDeltaSeconds) ||
      this.minimumTimeoutDeltaSeconds < 1
    ) {
      throw new TypeError("minimumTimeoutDeltaSeconds must be a positive integer");
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    try { fs.chmodSync(path.dirname(this.filePath), 0o700); } catch (_) {}
    this.db = new DatabaseSync(this.filePath, { enableForeignKeyConstraints: true });
    try { fs.chmodSync(this.filePath, 0o600); } catch (_) {}
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;"
    );
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fx_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS fx_trades (
        deployment_id TEXT NOT NULL,
        trade_id TEXT NOT NULL,
        settlement_state TEXT NOT NULL,
        case_state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(deployment_id, trade_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS fx_messages (
        id TEXT PRIMARY KEY,
        deployment_id TEXT NOT NULL,
        trade_id TEXT NOT NULL,
        sender TEXT NOT NULL,
        sequence TEXT NOT NULL,
        type TEXT NOT NULL,
        message_json TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        UNIQUE(deployment_id, trade_id, sender, sequence),
        FOREIGN KEY(deployment_id, trade_id)
          REFERENCES fx_trades(deployment_id, trade_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS fx_messages_trade
        ON fx_messages(deployment_id, trade_id, received_at, id);

      CREATE TABLE IF NOT EXISTS fx_sequences (
        deployment_id TEXT NOT NULL,
        trade_id TEXT NOT NULL,
        sender TEXT NOT NULL,
        last_sequence TEXT NOT NULL,
        last_message_id TEXT NOT NULL,
        PRIMARY KEY(deployment_id, trade_id, sender),
        FOREIGN KEY(deployment_id, trade_id)
          REFERENCES fx_trades(deployment_id, trade_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS fx_sequence_reservations (
        deployment_id TEXT NOT NULL,
        trade_id TEXT NOT NULL,
        sender TEXT NOT NULL,
        last_reserved_sequence TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(deployment_id, trade_id, sender)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS fx_actions (
        nullifier TEXT PRIMARY KEY,
        deployment_id TEXT NOT NULL,
        trade_id TEXT NOT NULL,
        slot TEXT NOT NULL,
        message_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(deployment_id, trade_id, slot),
        FOREIGN KEY(message_id) REFERENCES fx_messages(id)
      ) STRICT;
    `);
    const storedVersion = this.db
      .prepare("SELECT value FROM fx_meta WHERE key = 'schema_version'")
      .get()?.value;
    const storedDeployment = this.db
      .prepare("SELECT value FROM fx_meta WHERE key = 'deployment_id'")
      .get()?.value;
    if (storedVersion && Number(storedVersion) !== FX_JOURNAL_VERSION) {
      throw new FxJournalError("FX journal schema version is unsupported", "BAD_JOURNAL");
    }
    if (storedDeployment && storedDeployment !== this.deploymentId) {
      throw new FxJournalError(
        "FX journal belongs to another deployment",
        "DEPLOYMENT_MISMATCH"
      );
    }
    this.db
      .prepare("INSERT OR REPLACE INTO fx_meta(key, value) VALUES(?, ?)")
      .run("schema_version", String(FX_JOURNAL_VERSION));
    this.db
      .prepare("INSERT OR REPLACE INTO fx_meta(key, value) VALUES(?, ?)")
      .run("deployment_id", this.deploymentId);
  }

  reserveSequence(tradeId, sender) {
    tradeId = normalizeHash(tradeId, "tradeId");
    sender = String(sender || "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(sender)) {
      throw new FxJournalError("sender must be an EVM address", "INVALID_SCOPE");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const accepted = this.db.prepare(`
        SELECT last_sequence FROM fx_sequences
        WHERE deployment_id = ? AND trade_id = ? AND sender = ?
      `).get(this.deploymentId, tradeId, sender);
      const reserved = this.db.prepare(`
        SELECT last_reserved_sequence FROM fx_sequence_reservations
        WHERE deployment_id = ? AND trade_id = ? AND sender = ?
      `).get(this.deploymentId, tradeId, sender);
      const next =
        (accepted ? BigInt(accepted.last_sequence) : 0n) >
        (reserved ? BigInt(reserved.last_reserved_sequence) : 0n)
          ? BigInt(accepted.last_sequence) + 1n
          : BigInt(reserved?.last_reserved_sequence || 0) + 1n;
      this.db.prepare(`
        INSERT INTO fx_sequence_reservations(
          deployment_id, trade_id, sender, last_reserved_sequence, updated_at
        ) VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(deployment_id, trade_id, sender) DO UPDATE SET
          last_reserved_sequence = excluded.last_reserved_sequence,
          updated_at = excluded.updated_at
      `).run(this.deploymentId, tradeId, sender, next.toString(), this.now());
      this.db.exec("COMMIT");
      return next.toString();
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.db.close();
  }

  message(id) {
    return parseMessage(
      this.db.prepare("SELECT message_json FROM fx_messages WHERE id = ?").get(id)
    );
  }

  requireMessage(id, type, tradeId) {
    const message = this.message(id);
    if (!message || message.type !== type || message.tradeId !== tradeId) {
      throw new FxJournalError(
        `${type} reference is missing or belongs to another trade`,
        "MISSING_REFERENCE"
      );
    }
    return message;
  }

  findType(tradeId, type) {
    return parseMessage(this.db.prepare(`
      SELECT message_json FROM fx_messages
      WHERE deployment_id = ? AND trade_id = ? AND type = ?
      ORDER BY received_at DESC, id DESC LIMIT 1
    `).get(this.deploymentId, tradeId, type));
  }

  tradeRow(tradeId) {
    return this.db.prepare(`
      SELECT * FROM fx_trades WHERE deployment_id = ? AND trade_id = ?
    `).get(this.deploymentId, tradeId);
  }

  validateLineage(message, currentState) {
    let settlementState = currentState;
    let caseState = this.tradeRow(message.tradeId)?.case_state || "none";
    switch (message.type) {
      case "fx_rfq":
        settlementState = advanceFxState(settlementState, "publish_rfq");
        break;
      case "fx_quote": {
        if (settlementState !== "rfq_open") {
          throw new FxJournalError("quote arrived outside the RFQ window", "INVALID_STATE");
        }
        this.requireMessage(message.payload.rfqId, "fx_rfq", message.tradeId);
        break;
      }
      case "fx_accept": {
        const rfq = this.requireMessage(message.payload.rfqId, "fx_rfq", message.tradeId);
        const quote = this.requireMessage(
          message.payload.quoteId,
          "fx_quote",
          message.tradeId
        );
        const route = selectSingleDealerRoute(
          rfq,
          [{ quote, brokerFeeAtomic: message.payload.brokerFeeAtomic }],
          { now: message.createdAt, policy: rfq.payload.quotePolicy }
        );
        if (
          route.routeId !== message.payload.routeId ||
          route.totalInputAtomic !== message.payload.totalInputAtomic ||
          quote.payload.inputAmountAtomic !== message.payload.dealerInputAmountAtomic ||
          quote.payload.outputAmountAtomic !== message.payload.outputAmountAtomic
        ) {
          throw new FxJournalError(
            "acceptance does not match the locally recomputed route",
            "ROUTE_MISMATCH"
          );
        }
        settlementState = advanceFxState(settlementState, "accept_quote");
        break;
      }
      case "fx_reserve": {
        this.requireMessage(message.payload.acceptId, "fx_accept", message.tradeId);
        this.requireMessage(message.payload.quoteId, "fx_quote", message.tradeId);
        if (settlementState !== "quote_accepted") {
          throw new FxJournalError("reservation arrived outside acceptance", "INVALID_STATE");
        }
        break;
      }
      case "fx_lock_source": {
        const accept = this.requireMessage(
          message.payload.acceptId,
          "fx_accept",
          message.tradeId
        );
        const quote = this.requireMessage(
          accept.payload.quoteId,
          "fx_quote",
          message.tradeId
        );
        const reserve = this.findType(message.tradeId, "fx_reserve");
        if (
          !reserve ||
          message.payload.chainId !== quote.payload.inputChainId ||
          message.payload.token !== quote.payload.inputToken ||
          message.payload.amountAtomic !== accept.payload.totalInputAtomic ||
          message.payload.secretHash !== accept.payload.secretHash ||
          message.payload.refundAddress !== accept.payload.sourceRefundAddress ||
          message.payload.beneficiary !== reserve.payload.dealerSourceClaimAddress
        ) {
          throw new FxJournalError(
            "source lock does not match accepted route",
            "MALFORMED_LOCK"
          );
        }
        settlementState = advanceFxState(settlementState, "confirm_source_lock");
        break;
      }
      case "fx_lock_destination": {
        const accept = this.requireMessage(
          message.payload.acceptId,
          "fx_accept",
          message.tradeId
        );
        const quote = this.requireMessage(
          accept.payload.quoteId,
          "fx_quote",
          message.tradeId
        );
        const reserve = this.findType(message.tradeId, "fx_reserve");
        const sourceLock = this.findType(message.tradeId, "fx_lock_source");
        if (
          !reserve ||
          !sourceLock ||
          message.payload.chainId !== quote.payload.outputChainId ||
          message.payload.token !== quote.payload.outputToken ||
          message.payload.amountAtomic !== accept.payload.outputAmountAtomic ||
          message.payload.secretHash !== accept.payload.secretHash ||
          message.payload.beneficiary !== accept.payload.destinationClaimAddress ||
          message.payload.refundAddress !== reserve.payload.dealerDestinationRefundAddress ||
          sourceLock.payload.timeout <
            message.payload.timeout + this.minimumTimeoutDeltaSeconds
        ) {
          throw new FxJournalError(
            "destination lock does not match route or safe timeout order",
            "MALFORMED_LOCK"
          );
        }
        settlementState = advanceFxState(
          settlementState,
          "confirm_destination_lock"
        );
        break;
      }
      case "fx_claim": {
        const lock = this.message(message.payload.lockMessageId);
        if (
          !lock ||
          !["fx_lock_source", "fx_lock_destination"].includes(lock.type) ||
          lock.tradeId !== message.tradeId ||
          lock.payload.chainId !== message.payload.chainId ||
          lock.payload.secretHash !== message.payload.secretHash ||
          lock.payload.beneficiary !== message.payload.beneficiary
        ) {
          throw new FxJournalError("claim does not match a verified lock", "BAD_EVIDENCE");
        }
        settlementState = advanceFxState(
          settlementState,
          lock.type === "fx_lock_destination"
            ? "confirm_destination_claim"
            : "confirm_source_claim"
        );
        break;
      }
      case "fx_refund": {
        const lock = this.message(message.payload.lockMessageId);
        if (
          !lock ||
          !["fx_lock_source", "fx_lock_destination"].includes(lock.type) ||
          lock.tradeId !== message.tradeId ||
          lock.payload.chainId !== message.payload.chainId ||
          lock.payload.refundAddress !== message.payload.beneficiary ||
          message.createdAt < lock.payload.timeout
        ) {
          throw new FxJournalError(
            "refund does not match an expired verified lock",
            "BAD_EVIDENCE"
          );
        }
        settlementState = advanceFxState(
          settlementState,
          lock.type === "fx_lock_destination"
            ? "confirm_destination_refund"
            : "confirm_source_refund"
        );
        break;
      }
      case "fx_complete":
        if (settlementState !== "complete") {
          throw new FxJournalError(
            "completion cannot precede both verified claims",
            "BAD_EVIDENCE"
          );
        }
        this.requireMessage(message.payload.acceptId, "fx_accept", message.tradeId);
        this.requireMessage(
          message.payload.sourceClaimMessageId,
          "fx_claim",
          message.tradeId
        );
        this.requireMessage(
          message.payload.destinationClaimMessageId,
          "fx_claim",
          message.tradeId
        );
        break;
      case "fx_default":
        this.requireMessage(message.payload.acceptId, "fx_accept", message.tradeId);
        caseState = advanceFxCaseState(caseState, "report_default");
        break;
      case "fx_dispute":
        this.requireMessage(message.payload.defaultId, "fx_default", message.tradeId);
        caseState = advanceFxCaseState(caseState, "open_dispute");
        break;
      default:
        throw new FxJournalError("unsupported FX message type", "UNSUPPORTED_MESSAGE");
    }
    return { settlementState, caseState };
  }

  apply(envelope, { now = this.now(), temporal = false } = {}) {
    const message = verifyFxEnvelope(envelope, { now, temporal });
    if (message.deploymentId !== this.deploymentId) {
      throw new FxJournalError(
        "message belongs to another deployment",
        "DEPLOYMENT_MISMATCH"
      );
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.message(message.id)) {
        this.db.exec("COMMIT");
        return { status: "duplicate", snapshot: this.snapshot(message.tradeId) };
      }

      const sameSequence = this.db.prepare(`
        SELECT id FROM fx_messages
        WHERE deployment_id = ? AND trade_id = ? AND sender = ? AND sequence = ?
      `).get(
        this.deploymentId,
        message.tradeId,
        message.sender,
        message.sequence
      );
      if (sameSequence) {
        throw new FxJournalError(
          "sender equivocated at one trade sequence",
          "SEQUENCE_EQUIVOCATION"
        );
      }
      const sequence = this.db.prepare(`
        SELECT last_sequence FROM fx_sequences
        WHERE deployment_id = ? AND trade_id = ? AND sender = ?
      `).get(this.deploymentId, message.tradeId, message.sender);
      if (sequence && BigInt(message.sequence) <= BigInt(sequence.last_sequence)) {
        throw new FxJournalError("message sequence was already surpassed", "STALE_SEQUENCE");
      }

      let trade = this.tradeRow(message.tradeId);
      if (!trade) {
        if (message.type !== "fx_rfq") {
          throw new FxJournalError("trade must begin with an RFQ", "UNKNOWN_TRADE");
        }
        this.db.prepare(`
          INSERT INTO fx_trades(
            deployment_id, trade_id, settlement_state, case_state, created_at, updated_at
          ) VALUES(?, ?, 'idle', 'none', ?, ?)
        `).run(this.deploymentId, message.tradeId, message.createdAt, now);
        trade = this.tradeRow(message.tradeId);
      }

      const slot = actionSlot(message);
      const nullifier = computeFxActionNullifier(message, slot);
      if (nullifier) {
        const existing = this.db.prepare(`
          SELECT message_id FROM fx_actions
          WHERE deployment_id = ? AND trade_id = ? AND slot = ?
        `).get(this.deploymentId, message.tradeId, slot);
        if (existing) {
          throw new FxJournalError(
            `economic action ${slot} was already reserved`,
            "ACTION_REPLAY"
          );
        }
      }

      const next = this.validateLineage(message, trade.settlement_state);
      this.db.prepare(`
        INSERT INTO fx_messages(
          id, deployment_id, trade_id, sender, sequence, type, message_json, received_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        message.id,
        this.deploymentId,
        message.tradeId,
        message.sender,
        message.sequence,
        message.type,
        JSON.stringify(message),
        now
      );
      this.db.prepare(`
        INSERT INTO fx_sequences(
          deployment_id, trade_id, sender, last_sequence, last_message_id
        ) VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(deployment_id, trade_id, sender) DO UPDATE SET
          last_sequence = excluded.last_sequence,
          last_message_id = excluded.last_message_id
      `).run(
        this.deploymentId,
        message.tradeId,
        message.sender,
        message.sequence,
        message.id
      );
      if (nullifier) {
        this.db.prepare(`
          INSERT INTO fx_actions(
            nullifier, deployment_id, trade_id, slot, message_id, created_at
          ) VALUES(?, ?, ?, ?, ?, ?)
        `).run(
          nullifier,
          this.deploymentId,
          message.tradeId,
          slot,
          message.id,
          now
        );
      }
      this.db.prepare(`
        UPDATE fx_trades
        SET settlement_state = ?, case_state = ?, updated_at = ?
        WHERE deployment_id = ? AND trade_id = ?
      `).run(
        next.settlementState,
        next.caseState,
        now,
        this.deploymentId,
        message.tradeId
      );
      this.db.exec("COMMIT");
      return {
        status: "accepted",
        messageId: message.id,
        actionNullifier: nullifier,
        snapshot: this.snapshot(message.tradeId),
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  snapshot(tradeId) {
    tradeId = normalizeHash(tradeId, "tradeId");
    const trade = this.tradeRow(tradeId);
    if (!trade) return null;
    const messages = this.db.prepare(`
      SELECT id, type, sender, sequence FROM fx_messages
      WHERE deployment_id = ? AND trade_id = ?
      ORDER BY received_at, id
    `).all(this.deploymentId, tradeId).map((row) => ({
      id: row.id,
      type: row.type,
      sender: row.sender,
      sequence: row.sequence,
    }));
    const actions = this.db.prepare(`
      SELECT nullifier, slot, message_id FROM fx_actions
      WHERE deployment_id = ? AND trade_id = ?
      ORDER BY slot, nullifier
    `).all(this.deploymentId, tradeId).map((row) => ({
      nullifier: row.nullifier,
      slot: row.slot,
      messageId: row.message_id,
    }));
    const sequences = this.db.prepare(`
      SELECT sender, last_sequence, last_message_id FROM fx_sequences
      WHERE deployment_id = ? AND trade_id = ?
      ORDER BY sender
    `).all(this.deploymentId, tradeId).map((row) => ({
      sender: row.sender,
      lastSequence: row.last_sequence,
      lastMessageId: row.last_message_id,
    }));
    const stable = {
      version: FX_JOURNAL_VERSION,
      deploymentId: this.deploymentId,
      tradeId,
      settlementState: trade.settlement_state,
      caseState: trade.case_state,
      messages,
      actions,
      sequences,
    };
    return {
      ...stable,
      stateHash: keccak256(toUtf8Bytes(canonicalJson(stable))),
    };
  }
}

module.exports = {
  FX_JOURNAL_VERSION,
  FxJournalError,
  FxTradeJournal,
  actionSlot,
  computeFxActionNullifier,
};
