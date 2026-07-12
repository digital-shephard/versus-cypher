const fs = require("fs");
const path = require("path");

const MAX_SEEN_EVENTS = 100_000;

class RainInbox {
  constructor({ filePath, now = () => Date.now() }) {
    this.filePath = path.resolve(filePath);
    this.now = now;
    this.state = this.load();
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      return { version: 1, events: [], seen: [], nextDropAt: 0, spacingMs: 1_000 };
    }
    const value = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    if (value.version !== 1 || !Array.isArray(value.events) || !Array.isArray(value.seen)) {
      throw new Error("verified rain inbox is invalid");
    }
    return value;
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }

  pending() {
    return this.state.events.reduce((sum, event) => sum + event.remaining, 0);
  }

  acceptBatch(batch) {
    const seen = new Set(this.state.seen);
    let acceptedEvents = 0;
    let acceptedPennies = 0;
    for (const event of batch.events || []) {
      if (seen.has(event.eventId)) continue;
      seen.add(event.eventId);
      this.state.events.push({
        eventId: event.eventId,
        type: event.type,
        agentId: String(event.agentId),
        classId: String(event.classId),
        classTotalMicros: String(event.classTotalMicros),
        transactionHash: event.transactionHash,
        logIndex: event.logIndex,
        pennies: event.pennies,
        remaining: event.pennies,
        receivedAt: this.now(),
      });
      acceptedEvents += 1;
      acceptedPennies += event.pennies;
    }
    if (!acceptedEvents) return { acceptedEvents: 0, acceptedPennies: 0, pending: this.pending() };
    this.state.seen = Array.from(seen).slice(-MAX_SEEN_EVENTS);
    const pending = this.pending();
    this.state.spacingMs = Math.max(120, Math.min(60_000, Math.floor(batch.distributionWindowMs / pending)));
    if (!this.state.nextDropAt || this.state.nextDropAt < this.now()) this.state.nextDropAt = this.now();
    this.save();
    return { acceptedEvents, acceptedPennies, pending };
  }

  next() {
    const now = this.now();
    const pending = this.pending();
    if (!pending) return { drop: null, pending: 0, nextAt: null };
    if (now < this.state.nextDropAt) return { drop: null, pending, nextAt: this.state.nextDropAt };
    const event = this.state.events.find((candidate) => candidate.remaining > 0);
    event.remaining -= 1;
    const classPotMicros = (BigInt(event.classTotalMicros) - BigInt(event.remaining) * 10_000n).toString();
    const drop = {
      eventId: event.eventId,
      type: event.type,
      agentId: event.agentId,
      classId: event.classId,
      transactionHash: event.transactionHash,
      classPotMicros,
    };
    this.state.events = this.state.events.filter((candidate) => candidate.remaining > 0);
    this.state.nextDropAt = this.state.events.length ? now + this.state.spacingMs : 0;
    this.save();
    return { drop, pending: pending - 1, nextAt: this.state.nextDropAt || null };
  }

  status() {
    return { pending: this.pending(), nextAt: this.state.nextDropAt || null, seen: this.state.seen.length };
  }

  exportArchive() {
    return structuredClone(this.state);
  }

  importArchive(value) {
    if (value?.version !== 1 || !Array.isArray(value.events) || !Array.isArray(value.seen)) {
      throw new Error("verified rain archive is invalid");
    }
    this.state = structuredClone(value);
    this.save();
    return this.status();
  }
}

module.exports = { MAX_SEEN_EVENTS, RainInbox };
