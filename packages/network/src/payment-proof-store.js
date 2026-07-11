const fs = require("fs");
const path = require("path");
const { normalizeSignalSettlement } = require("./signal-batch");

class PaymentProofStore {
  constructor({ filePath = null } = {}) {
    this.filePath = filePath;
    this.proofs = new Map();
    this.load();
  }

  load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    const lines = fs.readFileSync(this.filePath, "utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (!/^0x[0-9a-f]{64}$/.test(record.postcardId)) continue;
        this.proofs.set(record.postcardId, normalizeSignalSettlement(record.settlement));
      } catch (_) {}
    }
  }

  set(postcardId, settlement) {
    settlement = normalizeSignalSettlement(settlement);
    this.proofs.set(postcardId, settlement);
    if (this.filePath) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, `${JSON.stringify({ postcardId, settlement })}\n`, "utf8");
    }
    return settlement;
  }

  get(postcardId) {
    return this.proofs.get(postcardId) || null;
  }

  has(postcardId) {
    return this.proofs.has(postcardId);
  }

  entries() {
    return Array.from(this.proofs, ([postcardId, settlement]) => ({ postcardId, settlement }));
  }

  import(records = []) {
    if (!Array.isArray(records)) throw new TypeError("payment proof archive must be an array");
    let imported = 0;
    for (const record of records) {
      if (!record || !/^0x[0-9a-f]{64}$/.test(String(record.postcardId))) {
        throw new TypeError("payment proof archive contains an invalid postcard ID");
      }
      if (this.has(record.postcardId)) continue;
      this.set(record.postcardId, record.settlement);
      imported += 1;
    }
    return imported;
  }

  clear() {
    this.proofs.clear();
    if (this.filePath) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, "", "utf8");
    }
  }
}

module.exports = { PaymentProofStore };
