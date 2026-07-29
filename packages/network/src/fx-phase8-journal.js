const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { keccak256, toUtf8Bytes } = require("ethers");
const { canonicalJson } = require("./fx-protocol");
const {
  normalizePhase8Policy,
} = require("./fx-phase8-policy");

const ACTIVE_STATES = new Set([
  "destination_pending",
  "source_firm",
  "destination_locked",
  "destination_claimed",
]);
const TERMINAL_STATES = new Set([
  "completed",
  "source_refunded",
  "destination_refunded",
  "dealer_no_show",
  "cancelled",
]);
const ALL_STATES = new Set([...ACTIVE_STATES, ...TERMINAL_STATES]);
const SCHEMA_VERSION = 1;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const ZERO_HASH = `0x${"00".repeat(32)}`;

class FxPhase8JournalError extends Error {
  constructor(message, code = "FX_PHASE8_JOURNAL_ERROR") {
    super(message);
    this.name = "FxPhase8JournalError";
    this.code = code;
  }
}

function hash(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (!HASH_PATTERN.test(normalized)) {
    throw new FxPhase8JournalError(`${label} must be bytes32`);
  }
  return normalized;
}

function unsigned(value, label, { allowZero = true } = {}) {
  const text = String(value);
  if (!/^\d+$/.test(text) || text.length > 78) {
    throw new FxPhase8JournalError(`${label} must be an unsigned integer`);
  }
  const normalized = BigInt(text).toString();
  if (!allowZero && normalized === "0") {
    throw new FxPhase8JournalError(`${label} must be greater than zero`);
  }
  return normalized;
}

function packageIdentity(verified) {
  const core = {
    deploymentId: verified.rfq.deploymentId,
    tradeId: verified.rfq.tradeId,
    rfqId: verified.rfq.id,
    quoteId: verified.quote.id,
    acceptId: verified.accept.id,
    reserveId: verified.reserve.id,
    sourceLockMessageId: verified.sourceLock.id,
    sourceLockId: verified.expectedSourceLockId,
    destinationLockId: verified.expectedDestinationLockId,
  };
  return keccak256(toUtf8Bytes(canonicalJson(core)));
}

function packageIdentityV2(input) {
  return keccak256(toUtf8Bytes(canonicalJson({
    deploymentId: input.rfq.deploymentId,
    tradeId: input.rfq.tradeId,
    rfqId: input.rfq.id,
    quoteId: input.quote.id,
    acceptId: input.accept.id,
    reserveId: input.reserve.id,
    sourceLockId: input.expectedSourceLockId,
    destinationLockId: input.expectedDestinationLockId,
  })));
}

function rowToTrade(row) {
  if (!row) return null;
  return {
    deploymentId: row.deployment_id,
    tradeId: row.trade_id,
    packageId: row.package_id,
    requester: row.requester,
    dealer: row.dealer,
    assetKey: row.asset_key,
    inputAmountAtomic: row.input_amount_atomic,
    exposureValueMicros: row.exposure_value_micros,
    sourceLockId: row.source_lock_id,
    sourceTransactionHash: row.source_transaction_hash,
    destinationLockId: row.destination_lock_id,
    destinationTransactionHash: row.destination_transaction_hash,
    sourceRefundTimestamp: row.source_refund_timestamp,
    destinationRefundTimestamp: row.destination_refund_timestamp,
    dealerDeadline: row.dealer_deadline,
    state: row.state,
    package: JSON.parse(row.package_json),
    economics: JSON.parse(row.economics_json),
    terminalEvidenceId: row.terminal_evidence_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class FxPhase8ExposureJournal {
  constructor({
    filePath,
    deploymentId,
    policy = {},
    now = () => Math.floor(Date.now() / 1000),
  } = {}) {
    if (typeof filePath !== "string" || !filePath.trim()) {
      throw new TypeError("Phase 8 exposure journal requires filePath");
    }
    this.filePath = path.resolve(filePath);
    this.deploymentId = hash(deploymentId, "deploymentId");
    this.policy = normalizePhase8Policy(policy);
    this.now = now;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    try { fs.chmodSync(path.dirname(this.filePath), 0o700); } catch {}
    this.db = new DatabaseSync(this.filePath, {
      enableForeignKeyConstraints: true,
    });
    try { fs.chmodSync(this.filePath, 0o600); } catch {}
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;"
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fx_phase8_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS fx_phase8_exposure (
        deployment_id TEXT NOT NULL,
        trade_id TEXT NOT NULL,
        package_id TEXT NOT NULL UNIQUE,
        requester TEXT NOT NULL,
        dealer TEXT NOT NULL,
        asset_key TEXT NOT NULL,
        input_amount_atomic TEXT NOT NULL,
        exposure_value_micros TEXT NOT NULL,
        source_lock_id TEXT NOT NULL,
        source_transaction_hash TEXT NOT NULL,
        destination_lock_id TEXT NOT NULL,
        destination_transaction_hash TEXT,
        source_refund_timestamp INTEGER NOT NULL,
        destination_refund_timestamp INTEGER NOT NULL,
        dealer_deadline INTEGER NOT NULL,
        state TEXT NOT NULL,
        package_json TEXT NOT NULL,
        economics_json TEXT NOT NULL,
        terminal_evidence_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(deployment_id, trade_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS fx_phase8_outcomes (
        evidence_id TEXT PRIMARY KEY,
        deployment_id TEXT NOT NULL,
        trade_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        outcome TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        recorded_at INTEGER NOT NULL,
        FOREIGN KEY(deployment_id, trade_id)
          REFERENCES fx_phase8_exposure(deployment_id, trade_id)
      ) STRICT;
    `);
    this.assertMetadata();
  }

  assertMetadata() {
    const version = this.db
      .prepare("SELECT value FROM fx_phase8_meta WHERE key = 'schema_version'")
      .get()?.value;
    const deployment = this.db
      .prepare("SELECT value FROM fx_phase8_meta WHERE key = 'deployment_id'")
      .get()?.value;
    if (version && Number(version) !== SCHEMA_VERSION) {
      throw new FxPhase8JournalError(
        "Phase 8 journal schema is unsupported",
        "BAD_JOURNAL"
      );
    }
    if (deployment && deployment !== this.deploymentId) {
      throw new FxPhase8JournalError(
        "Phase 8 journal belongs to another deployment",
        "DEPLOYMENT_MISMATCH"
      );
    }
    this.db
      .prepare("INSERT OR REPLACE INTO fx_phase8_meta(key, value) VALUES(?, ?)")
      .run("schema_version", String(SCHEMA_VERSION));
    this.db
      .prepare("INSERT OR REPLACE INTO fx_phase8_meta(key, value) VALUES(?, ?)")
      .run("deployment_id", this.deploymentId);
  }

  close() {
    this.db.close();
  }

  trade(tradeId) {
    return rowToTrade(this.db.prepare(`
      SELECT * FROM fx_phase8_exposure
      WHERE deployment_id = ? AND trade_id = ?
    `).get(this.deploymentId, hash(tradeId, "tradeId")));
  }

  activeTrades() {
    return this.db.prepare(`
      SELECT * FROM fx_phase8_exposure
      WHERE deployment_id = ?
        AND state IN (
          'destination_pending',
          'source_firm',
          'destination_locked',
          'destination_claimed'
        )
      ORDER BY created_at, trade_id
    `).all(this.deploymentId).map(rowToTrade);
  }

  exposureSummary() {
    const trades = this.activeTrades();
    const sum = (entries) => entries
      .reduce((total, trade) => total + BigInt(trade.exposureValueMicros), 0n)
      .toString();
    const byRequester = {};
    const byAsset = {};
    for (const trade of trades) {
      byRequester[trade.requester] ||= { count: 0, exposureValueMicros: "0" };
      byRequester[trade.requester].count += 1;
      byRequester[trade.requester].exposureValueMicros = (
        BigInt(byRequester[trade.requester].exposureValueMicros) +
        BigInt(trade.exposureValueMicros)
      ).toString();
      byAsset[trade.assetKey] ||= { count: 0, exposureValueMicros: "0" };
      byAsset[trade.assetKey].count += 1;
      byAsset[trade.assetKey].exposureValueMicros = (
        BigInt(byAsset[trade.assetKey].exposureValueMicros) +
        BigInt(trade.exposureValueMicros)
      ).toString();
    }
    return {
      count: trades.length,
      exposureValueMicros: sum(trades),
      byRequester,
      byAsset,
    };
  }

  assertCapacity(verified) {
    const summary = this.exposureSummary();
    const requester = verified.rfq.sender;
    const assetKey =
      `${verified.route.outputChainId}:${verified.route.outputToken}`;
    const amount = BigInt(verified.exposureValueMicros);
    const requesterExposure = summary.byRequester[requester] || {
      count: 0,
      exposureValueMicros: "0",
    };
    const assetExposure = summary.byAsset[assetKey] || {
      count: 0,
      exposureValueMicros: "0",
    };
    const failures = [];
    if (summary.count + 1 > this.policy.maximumActiveLocksGlobal) {
      failures.push("global_lock_count");
    }
    if (
      requesterExposure.count + 1 >
      this.policy.maximumActiveLocksPerRequester
    ) {
      failures.push("requester_lock_count");
    }
    if (assetExposure.count + 1 > this.policy.maximumActiveLocksPerAsset) {
      failures.push("asset_lock_count");
    }
    if (
      BigInt(summary.exposureValueMicros) + amount >
      BigInt(this.policy.maximumActiveValueMicrosGlobal)
    ) {
      failures.push("global_input_value");
    }
    if (
      BigInt(requesterExposure.exposureValueMicros) + amount >
      BigInt(this.policy.maximumActiveValueMicrosPerRequester)
    ) {
      failures.push("requester_input_value");
    }
    if (
      BigInt(assetExposure.exposureValueMicros) + amount >
      BigInt(this.policy.maximumActiveValueMicrosPerAsset)
    ) {
      failures.push("asset_input_value");
    }
    if (failures.length) {
      throw new FxPhase8JournalError(
        `dealer exposure policy rejected: ${failures.join(",")}`,
        "EXPOSURE_LIMIT"
      );
    }
  }

  admitSource(verified) {
    if (verified.rfq.deploymentId !== this.deploymentId) {
      throw new FxPhase8JournalError(
        "source package belongs to another deployment",
        "DEPLOYMENT_MISMATCH"
      );
    }
    const tradeId = hash(verified.rfq.tradeId, "tradeId");
    const packageId = packageIdentity(verified);
    const existing = this.trade(tradeId);
    if (existing) {
      if (existing.packageId !== packageId) {
        throw new FxPhase8JournalError(
          "trade conflicts with its durable source package",
          "TRADE_CONFLICT"
        );
      }
      return existing;
    }
    const assetKey =
      `${verified.route.outputChainId}:${verified.route.outputToken}`;
    const now = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const raced = this.trade(tradeId);
      if (raced) {
        if (raced.packageId !== packageId) {
          throw new FxPhase8JournalError(
            "trade conflicts with its durable source package",
            "TRADE_CONFLICT"
          );
        }
        this.db.exec("COMMIT");
        return raced;
      }
      this.assertCapacity(verified);
      this.db.prepare(`
        INSERT INTO fx_phase8_exposure(
          deployment_id, trade_id, package_id, requester, dealer, asset_key,
          input_amount_atomic, exposure_value_micros, source_lock_id,
          source_transaction_hash,
          destination_lock_id, source_refund_timestamp,
          destination_refund_timestamp, dealer_deadline, state, package_json,
          economics_json, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'source_firm', ?, ?, ?, ?)
      `).run(
        this.deploymentId,
        tradeId,
        packageId,
        verified.rfq.sender,
        verified.quote.sender,
        assetKey,
        unsigned(verified.route.totalInputAtomic, "input amount", {
          allowZero: false,
        }),
        unsigned(verified.exposureValueMicros, "exposure value micros", {
          allowZero: false,
        }),
        verified.expectedSourceLockId,
        verified.sourceLock.payload.transactionHash,
        verified.expectedDestinationLockId,
        verified.sourceLock.payload.timeout,
        verified.destinationRefundTimestamp,
        verified.reserve.payload.reservationDeadline,
        JSON.stringify({
          rfq: verified.rfq,
          quote: verified.quote,
          accept: verified.accept,
          reserve: verified.reserve,
          sourceLock: verified.sourceLock,
          chain: verified.chain,
        }),
        JSON.stringify(verified.economics),
        now,
        now
      );
      this.db.exec("COMMIT");
      return this.trade(tradeId);
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  reserveDestinationV2({
    rfq,
    quote,
    accept,
    reserve,
    expectedSourceLockId,
    expectedDestinationLockId,
    destinationRefundTimestamp,
    exposureValueMicros,
    economics = {},
  }) {
    if (
      rfq?.version !== 2 ||
      quote?.version !== 2 ||
      accept?.version !== 2 ||
      reserve?.version !== 2
    ) {
      throw new FxPhase8JournalError(
        "V2 exposure requires a complete version-two package",
        "BAD_PACKAGE"
      );
    }
    if (rfq.deploymentId !== this.deploymentId) {
      throw new FxPhase8JournalError(
        "destination package belongs to another deployment",
        "DEPLOYMENT_MISMATCH"
      );
    }
    const tradeId = hash(rfq.tradeId, "tradeId");
    const sourceLockId = hash(expectedSourceLockId, "source lock id");
    const destinationLockId = hash(
      expectedDestinationLockId,
      "destination lock id"
    );
    const packageId = packageIdentityV2({
      rfq,
      quote,
      accept,
      reserve,
      expectedSourceLockId: sourceLockId,
      expectedDestinationLockId: destinationLockId,
    });
    const existing = this.trade(tradeId);
    if (existing) {
      if (existing.packageId !== packageId) {
        throw new FxPhase8JournalError(
          "trade conflicts with its durable destination package",
          "TRADE_CONFLICT"
        );
      }
      return existing;
    }
    const verified = {
      rfq,
      route: {
        outputChainId: quote.payload.outputChainId,
        outputToken: quote.payload.outputToken,
      },
      exposureValueMicros: unsigned(
        exposureValueMicros,
        "exposure value micros",
        { allowZero: false }
      ),
    };
    const now = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const raced = this.trade(tradeId);
      if (raced) {
        if (raced.packageId !== packageId) {
          throw new FxPhase8JournalError(
            "trade conflicts with its durable destination package",
            "TRADE_CONFLICT"
          );
        }
        this.db.exec("COMMIT");
        return raced;
      }
      this.assertCapacity(verified);
      this.db.prepare(`
        INSERT INTO fx_phase8_exposure(
          deployment_id, trade_id, package_id, requester, dealer, asset_key,
          input_amount_atomic, exposure_value_micros, source_lock_id,
          source_transaction_hash, destination_lock_id,
          destination_transaction_hash, source_refund_timestamp,
          destination_refund_timestamp, dealer_deadline, state, package_json,
          economics_json, created_at, updated_at
        ) VALUES(
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'destination_pending',
          ?, ?, ?, ?
        )
      `).run(
        this.deploymentId,
        tradeId,
        packageId,
        rfq.sender,
        quote.sender,
        `${quote.payload.outputChainId}:${quote.payload.outputToken}`,
        unsigned(quote.payload.inputAmountAtomic, "input amount", {
          allowZero: false,
        }),
        verified.exposureValueMicros,
        sourceLockId,
        ZERO_HASH,
        destinationLockId,
        ZERO_HASH,
        Number(destinationRefundTimestamp) -
          this.policy.minimumTimeoutDeltaSeconds,
        Number(destinationRefundTimestamp),
        reserve.payload.reservationDeadline,
        JSON.stringify({ rfq, quote, accept, reserve }),
        JSON.stringify(economics),
        now,
        now
      );
      this.db.exec("COMMIT");
      return this.trade(tradeId);
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  markDestinationLockedV2(tradeId, destinationLock) {
    const trade = this.trade(tradeId);
    if (!trade) {
      throw new FxPhase8JournalError("trade is not admitted", "UNKNOWN_TRADE");
    }
    if (
      destinationLock?.version !== 2 ||
      destinationLock?.type !== "fx_lock_destination" ||
      destinationLock.payload.transactionHash === ZERO_HASH ||
      destinationLock.payload.timeout !== trade.destinationRefundTimestamp
    ) {
      throw new FxPhase8JournalError(
        "destination lock does not match the V2 reservation",
        "LOCK_MISMATCH"
      );
    }
    if (trade.state === "destination_locked") {
      if (
        trade.destinationTransactionHash !==
        destinationLock.payload.transactionHash
      ) {
        throw new FxPhase8JournalError(
          "destination lock conflicts with its durable transaction",
          "TRADE_CONFLICT"
        );
      }
      return trade;
    }
    if (trade.state !== "destination_pending") {
      throw new FxPhase8JournalError(
        "destination lock cannot advance this trade",
        "INVALID_STATE"
      );
    }
    this.db.prepare(`
      UPDATE fx_phase8_exposure
      SET state = 'destination_locked', destination_transaction_hash = ?,
          package_json = ?, updated_at = ?
      WHERE deployment_id = ? AND trade_id = ?
    `).run(
      destinationLock.payload.transactionHash,
      JSON.stringify({
        ...trade.package,
        destinationLock,
      }),
      this.now(),
      this.deploymentId,
      trade.tradeId
    );
    return this.trade(trade.tradeId);
  }

  attachSourceLockV2(tradeId, sourceLock) {
    const trade = this.trade(tradeId);
    if (!trade || trade.state !== "destination_locked") {
      throw new FxPhase8JournalError(
        "source lock has no active V2 destination exposure",
        "UNKNOWN_TRADE"
      );
    }
    if (
      sourceLock?.version !== 2 ||
      sourceLock?.type !== "fx_lock_source" ||
      Number(sourceLock.payload.timeout) +
        this.policy.minimumTimeoutDeltaSeconds >
        trade.destinationRefundTimestamp
    ) {
      throw new FxPhase8JournalError(
        "source lock violates the V2 timeout order",
        "LOCK_MISMATCH"
      );
    }
    if (trade.sourceTransactionHash !== ZERO_HASH) {
      if (trade.sourceTransactionHash !== sourceLock.payload.transactionHash) {
        throw new FxPhase8JournalError(
          "source lock conflicts with its durable transaction",
          "TRADE_CONFLICT"
        );
      }
      return trade;
    }
    this.db.prepare(`
      UPDATE fx_phase8_exposure
      SET source_transaction_hash = ?, source_refund_timestamp = ?,
          package_json = ?, updated_at = ?
      WHERE deployment_id = ? AND trade_id = ?
    `).run(
      sourceLock.payload.transactionHash,
      sourceLock.payload.timeout,
      JSON.stringify({
        ...trade.package,
        sourceLock,
      }),
      this.now(),
      this.deploymentId,
      trade.tradeId
    );
    return this.trade(trade.tradeId);
  }

  markDestinationLocked(tradeId, {
    lockId,
    transactionHash,
    timeout,
  }) {
    const trade = this.trade(tradeId);
    if (!trade) {
      throw new FxPhase8JournalError("trade is not admitted", "UNKNOWN_TRADE");
    }
    lockId = hash(lockId, "destination lock id");
    transactionHash = hash(transactionHash, "destination transaction hash");
    if (
      lockId !== trade.destinationLockId ||
      Number(timeout) !== trade.destinationRefundTimestamp
    ) {
      throw new FxPhase8JournalError(
        "destination lock does not match the durable plan",
        "LOCK_MISMATCH"
      );
    }
    if (trade.state === "destination_locked") {
      if (trade.destinationTransactionHash !== transactionHash) {
        throw new FxPhase8JournalError(
          "destination lock conflicts with its durable transaction",
          "TRADE_CONFLICT"
        );
      }
      return trade;
    }
    if (trade.state !== "source_firm") {
      throw new FxPhase8JournalError(
        "destination lock cannot advance this trade",
        "INVALID_STATE"
      );
    }
    this.db.prepare(`
      UPDATE fx_phase8_exposure
      SET state = 'destination_locked', destination_transaction_hash = ?,
          updated_at = ?
      WHERE deployment_id = ? AND trade_id = ?
    `).run(transactionHash, this.now(), this.deploymentId, trade.tradeId);
    return this.trade(trade.tradeId);
  }

  markDestinationClaimed(tradeId) {
    return this.transition(tradeId, ["destination_locked"], "destination_claimed");
  }

  markTerminal(tradeId, state, evidenceId = null) {
    if (!TERMINAL_STATES.has(state)) {
      throw new FxPhase8JournalError("terminal state is unsupported");
    }
    if (evidenceId !== null) evidenceId = hash(evidenceId, "evidenceId");
    const trade = this.trade(tradeId);
    if (!trade) {
      throw new FxPhase8JournalError("trade is not admitted", "UNKNOWN_TRADE");
    }
    if (TERMINAL_STATES.has(trade.state)) {
      if (
        trade.state !== state ||
        (evidenceId && trade.terminalEvidenceId !== evidenceId)
      ) {
        throw new FxPhase8JournalError(
          "terminal trade state is immutable",
          "TRADE_TERMINAL"
        );
      }
      return trade;
    }
    this.db.prepare(`
      UPDATE fx_phase8_exposure
      SET state = ?, terminal_evidence_id = ?, updated_at = ?
      WHERE deployment_id = ? AND trade_id = ?
    `).run(
      state,
      evidenceId,
      this.now(),
      this.deploymentId,
      trade.tradeId
    );
    return this.trade(trade.tradeId);
  }

  transition(tradeId, allowedFrom, nextState) {
    if (!ALL_STATES.has(nextState)) {
      throw new FxPhase8JournalError("trade state is unsupported");
    }
    const trade = this.trade(tradeId);
    if (!trade) {
      throw new FxPhase8JournalError("trade is not admitted", "UNKNOWN_TRADE");
    }
    if (trade.state === nextState) return trade;
    if (!allowedFrom.includes(trade.state)) {
      throw new FxPhase8JournalError(
        `cannot advance ${trade.state} to ${nextState}`,
        "INVALID_STATE"
      );
    }
    this.db.prepare(`
      UPDATE fx_phase8_exposure
      SET state = ?, updated_at = ?
      WHERE deployment_id = ? AND trade_id = ?
    `).run(nextState, this.now(), this.deploymentId, trade.tradeId);
    return this.trade(trade.tradeId);
  }

  recordVerifiedOutcome({ evidenceId, tradeId, subject, outcome, evidence }) {
    evidenceId = hash(evidenceId, "evidenceId");
    const trade = this.trade(tradeId);
    if (!trade) {
      throw new FxPhase8JournalError("trade is not admitted", "UNKNOWN_TRADE");
    }
    if (!["dealer_no_show", "requester_abandoned", "completed"].includes(outcome)) {
      throw new FxPhase8JournalError("outcome is unsupported");
    }
    const existing = this.db.prepare(`
      SELECT * FROM fx_phase8_outcomes WHERE evidence_id = ?
    `).get(evidenceId);
    if (existing) {
      if (
        existing.trade_id !== trade.tradeId ||
        existing.subject !== subject ||
        existing.outcome !== outcome
      ) {
        throw new FxPhase8JournalError(
          "evidence id conflicts with its recorded outcome",
          "EVIDENCE_CONFLICT"
        );
      }
      return existing;
    }
    this.db.prepare(`
      INSERT INTO fx_phase8_outcomes(
        evidence_id, deployment_id, trade_id, subject, outcome,
        evidence_json, recorded_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?)
    `).run(
      evidenceId,
      this.deploymentId,
      trade.tradeId,
      String(subject).toLowerCase(),
      outcome,
      JSON.stringify(evidence),
      this.now()
    );
    return this.db.prepare(`
      SELECT * FROM fx_phase8_outcomes WHERE evidence_id = ?
    `).get(evidenceId);
  }

  reputation(subject) {
    const normalized = String(subject || "").toLowerCase();
    const rows = this.db.prepare(`
      SELECT outcome, recorded_at
      FROM fx_phase8_outcomes
      WHERE deployment_id = ? AND subject = ?
    `).all(this.deploymentId, normalized);
    const counts = {};
    const weights = {};
    const now = this.now();
    for (const row of rows) {
      counts[row.outcome] = (counts[row.outcome] || 0) + 1;
      const age = Math.max(0, now - Number(row.recorded_at));
      const weight = 0.5 ** (age / this.policy.reputationHalfLifeSeconds);
      weights[row.outcome] = (weights[row.outcome] || 0) + weight;
    }
    const rounded = (value) => Number((value || 0).toFixed(6));
    return {
      subject: normalized,
      completed: counts.completed || 0,
      dealerNoShows: counts.dealer_no_show || 0,
      requesterAbandonments: counts.requester_abandoned || 0,
      completedWeight: rounded(weights.completed),
      dealerNoShowWeight: rounded(weights.dealer_no_show),
      requesterAbandonmentWeight: rounded(weights.requester_abandoned),
      decayHalfLifeSeconds: this.policy.reputationHalfLifeSeconds,
      authority: "local_verified_evidence_only",
    };
  }
}

module.exports = {
  ACTIVE_STATES,
  FxPhase8ExposureJournal,
  FxPhase8JournalError,
  TERMINAL_STATES,
  packageIdentity,
};
