const fs = require("node:fs");
const path = require("node:path");

const ACTIVE_STATUSES = new Set(["prepared", "submitted", "uncertain"]);
const HASH_PATTERN = /^0x[a-f0-9]{64}$/i;

function cleanToken(value, name, maximum = 96) {
  const text = String(value || "").trim();
  if (!text || text.length > maximum || !/^[a-z0-9._:-]+$/i.test(text)) throw new RangeError(`${name} is invalid`);
  return text;
}

class OperationJournal {
  constructor({ filePath, now = () => Date.now() } = {}) {
    if (typeof filePath !== "string" || !filePath.trim()) throw new TypeError("operation journal requires a file path");
    this.filePath = path.resolve(filePath);
    this.now = now;
    this.damaged = false;
    this.records = this.load();
  }

  load() {
    if (!fs.existsSync(this.filePath)) return [];
    try {
      const value = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (value?.version !== 1 || !Array.isArray(value.records)) throw new Error("operation journal format is invalid");
      return value.records.filter((record) => record && typeof record.key === "string").slice(-256);
    } catch (_) {
      this.damaged = true;
      return [];
    }
  }

  save() {
    if (this.damaged) {
      const error = new Error("Economic operation journal is damaged");
      error.code = "DATABASE_DAMAGED";
      throw error;
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, records: this.records.slice(-256) }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }

  current(key) {
    key = cleanToken(key, "operation key");
    return [...this.records].reverse().find((record) => record.key === key) || null;
  }

  begin(key, kind, metadata = {}) {
    if (this.damaged) {
      const error = new Error("Economic operation journal is damaged");
      error.code = "DATABASE_DAMAGED";
      throw error;
    }
    key = cleanToken(key, "operation key");
    kind = cleanToken(kind, "operation kind", 40);
    const existing = this.current(key);
    if (existing && ACTIVE_STATUSES.has(existing.status)) {
      const error = new Error("A previous transaction is still uncertain and will not be repeated");
      error.code = "TRANSACTION_UNCERTAIN";
      error.operation = { ...existing };
      throw error;
    }
    const record = {
      id: `${this.now()}-${this.records.length + 1}`,
      key,
      kind,
      status: "prepared",
      preparedAt: this.now(),
      updatedAt: this.now(),
      transactionHash: null,
      blockNumber: null,
      agentId: Number.isSafeInteger(Number(metadata.agentId)) ? Number(metadata.agentId) : null,
    };
    this.records.push(record);
    this.save();
    return { ...record };
  }

  update(key, patch) {
    const record = this.current(key);
    if (!record) throw new Error("operation journal record is missing");
    Object.assign(record, patch, { updatedAt: this.now() });
    this.save();
    return { ...record };
  }

  submitted(key, transactionHash) {
    if (!HASH_PATTERN.test(String(transactionHash || ""))) throw new RangeError("operation transaction hash is invalid");
    return this.update(key, { status: "submitted", transactionHash: String(transactionHash).toLowerCase() });
  }

  uncertain(key) {
    return this.update(key, { status: "uncertain" });
  }

  complete(key, { transactionHash = null, blockNumber = null } = {}) {
    if (transactionHash !== null && !HASH_PATTERN.test(String(transactionHash))) throw new RangeError("operation transaction hash is invalid");
    return this.update(key, {
      status: "complete",
      transactionHash: transactionHash ? String(transactionHash).toLowerCase() : this.current(key)?.transactionHash || null,
      blockNumber: Number.isSafeInteger(Number(blockNumber)) ? Number(blockNumber) : null,
      completedAt: this.now(),
    });
  }

  fail(key, reasonCode = "failed") {
    return this.update(key, { status: "failed", reasonCode: cleanToken(reasonCode, "operation failure", 40), failedAt: this.now() });
  }

  pending() {
    return this.records.filter((record) => ACTIVE_STATUSES.has(record.status)).map((record) => ({ ...record }));
  }

  exportArchive() {
    if (this.damaged) {
      const error = new Error("Economic operation journal is damaged");
      error.code = "DATABASE_DAMAGED";
      throw error;
    }
    return {
      format: "versus-economic-operations",
      version: 1,
      records: this.records.map((record) => ({ ...record })),
    };
  }

  importArchive(archive) {
    if (archive?.format !== "versus-economic-operations" || archive.version !== 1 || !Array.isArray(archive.records)) {
      throw new Error("Cypher archive economic journal is invalid");
    }
    const records = archive.records.slice(-256);
    for (const record of records) {
      cleanToken(record?.key, "operation key");
      cleanToken(record?.kind, "operation kind", 40);
      if (!["prepared", "submitted", "uncertain", "complete", "failed"].includes(record.status)) {
        throw new Error("Cypher archive economic journal status is invalid");
      }
      if (record.transactionHash !== null && record.transactionHash !== undefined && !HASH_PATTERN.test(String(record.transactionHash))) {
        throw new Error("Cypher archive economic journal hash is invalid");
      }
    }
    if (this.damaged && fs.existsSync(this.filePath)) {
      fs.renameSync(this.filePath, `${this.filePath}.damaged-${this.now()}`);
    }
    this.damaged = false;
    this.records = records.map((record) => ({ ...record }));
    this.save();
    return this.summary();
  }

  summary() {
    const counts = {};
    for (const record of this.records) counts[record.status] = Number(counts[record.status] || 0) + 1;
    return { version: 1, damaged: this.damaged, pending: this.pending().length, counts };
  }
}

module.exports = { ACTIVE_STATUSES, OperationJournal };
