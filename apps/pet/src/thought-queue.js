const fs = require("fs");
const path = require("path");

const MAX_THOUGHT_CHARS = 180;
const URL_PATTERN = /(?:https?:\/\/|www\.)/i;
const ADDRESS_PATTERN = /0x[a-f0-9]{40}/i;

function normalizeThought(text) {
  if (typeof text !== "string") throw new TypeError("thought must be text");
  const value = text.replace(/\s+/g, " ").trim();
  if (!value || value.length > MAX_THOUGHT_CHARS) {
    throw new RangeError(`thought must contain 1-${MAX_THOUGHT_CHARS} characters`);
  }
  if (URL_PATTERN.test(value) || ADDRESS_PATTERN.test(value)) {
    throw new TypeError("thoughts cannot display links or wallet addresses");
  }
  return value;
}

class ThoughtQueue {
  constructor({ filePath = null, now = () => Date.now(), maxItems = 100 } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.maxItems = maxItems;
    this.items = this.load();
  }

  load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return (parsed.items || []).map((item) => ({
        ...item,
        state: item.state === "seen" ? "seen" : "new",
      })).slice(-this.maxItems);
    } catch (_) {
      return [];
    }
  }

  save() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, items: this.items }, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, this.filePath);
  }

  enqueue(text, meta = {}) {
    const item = {
      id: `${this.now()}-${Math.random().toString(36).slice(2, 9)}`,
      text: normalizeThought(text),
      state: "new",
      createdAt: this.now(),
      launchId: meta.launchId == null ? null : String(meta.launchId),
      actionType: meta.actionType || null,
    };
    this.items.push(item);
    this.items = this.items.slice(-this.maxItems);
    this.save();
    return { ...item };
  }

  next() {
    const item = this.items.find((candidate) => candidate.state === "new");
    return item ? { ...item } : null;
  }

  markShowing(id) {
    return this.setState(id, "showing");
  }

  markSeen(id) {
    return this.setState(id, "seen");
  }

  setState(id, state) {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) return null;
    item.state = state;
    if (state === "seen") item.seenAt = this.now();
    this.save();
    return { ...item };
  }

  unseenCount() {
    return this.items.filter((item) => item.state !== "seen").length;
  }
}

module.exports = { MAX_THOUGHT_CHARS, ThoughtQueue, normalizeThought };
