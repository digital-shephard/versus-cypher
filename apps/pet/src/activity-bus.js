const { EventEmitter } = require("events");

const CHANNELS = new Set(["system", "local", "base", "waku", "brain", "disk"]);
const DIRECTIONS = new Set(["local", "out", "in"]);
const STATUSES = new Set(["pending", "ok", "ready", "idle", "off", "wait", "error"]);

function boundedToken(value, fallback, maximum = 32) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maximum);
  return normalized || fallback;
}

function safeLabel(value, fallback, maximum) {
  const raw = String(value || "").trim();
  if (/bearer\s|sk-[a-z0-9_-]+|0x[a-f0-9]{64}|private[ _-]?key|api[ _-]?key|mnemonic|password|secret/i.test(raw)) {
    return "redacted";
  }
  if (/^[a-z]+:\/\//i.test(raw)) {
    try { return boundedToken(new URL(raw).hostname, fallback, maximum); } catch (_) { return "redacted"; }
  }
  return boundedToken(raw, fallback, maximum);
}

function boundedNumber(value, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.min(Math.round(number), maximum);
}

class ServiceActivityBus extends EventEmitter {
  constructor({ limit = 128, now = () => Date.now() } = {}) {
    super();
    if (!Number.isInteger(limit) || limit < 16 || limit > 1024) {
      throw new RangeError("activity limit must be between 16 and 1024");
    }
    this.limit = limit;
    this.now = now;
    this.nextId = 1;
    this.events = [];
  }

  record(input = {}) {
    const channel = boundedToken(input.channel, "system", 12);
    const direction = boundedToken(input.direction, "local", 8);
    const status = boundedToken(input.status, "ok", 10);
    const event = Object.freeze({
      id: this.nextId++,
      at: boundedNumber(input.at ?? this.now(), Number.MAX_SAFE_INTEGER) ?? this.now(),
      channel: CHANNELS.has(channel) ? channel : "system",
      direction: DIRECTIONS.has(direction) ? direction : "local",
      operation: safeLabel(input.operation, "activity", 34),
      destination: safeLabel(input.destination, "device", 34),
      status: STATUSES.has(status) ? status : "error",
      durationMs: boundedNumber(input.durationMs, 3_600_000),
      bytes: boundedNumber(input.bytes, 100_000_000),
    });
    this.events.push(event);
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit);
    this.emit("event", event);
    return event;
  }

  begin(input = {}) {
    const startedAt = this.now();
    const base = {
      channel: input.channel,
      operation: input.operation,
      destination: input.destination,
    };
    this.record({ ...base, direction: input.direction || "out", status: "pending", at: startedAt });
    let ended = false;
    return (status = "ok", output = {}) => {
      if (ended) return null;
      ended = true;
      return this.record({
        ...base,
        direction: output.direction || "in",
        status,
        at: this.now(),
        durationMs: this.now() - startedAt,
        bytes: output.bytes,
      });
    };
  }

  snapshot() {
    return this.events.map((event) => ({ ...event }));
  }
}

module.exports = { ServiceActivityBus };
