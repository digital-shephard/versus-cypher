const fs = require("fs");
const path = require("path");
const { verifyPostcard } = require("./protocol");

class PostcardStoreError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "PostcardStoreError";
    this.code = code;
  }
}

class PostcardStore {
  constructor({ filePath = null } = {}) {
    this.filePath = filePath;
    this.byId = new Map();
    this.highestSequence = new Map();
    this.sequenceIds = new Map();
    this.loadErrors = [];
    this.load();
  }

  load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    const lines = fs.readFileSync(this.filePath, "utf8").split(/\r?\n/).filter(Boolean);
    for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
      try {
        const postcard = verifyPostcard(JSON.parse(lines[lineNumber]), { temporal: false });
        this.index(postcard);
      } catch (error) {
        this.loadErrors.push({ line: lineNumber + 1, message: error.message });
      }
    }
  }

  index(postcard) {
    const author = postcard.author.toLowerCase();
    const sequenceKey = `${author}:${postcard.sequence}`;
    const existing = this.sequenceIds.get(sequenceKey);
    if (existing && existing !== postcard.id) {
      throw new PostcardStoreError(
        "author signed conflicting postcards with the same sequence",
        "SEQUENCE_EQUIVOCATION"
      );
    }
    this.byId.set(postcard.id, postcard);
    this.sequenceIds.set(sequenceKey, postcard.id);
    const current = this.highestSequence.get(author);
    if (current === undefined || postcard.sequence > current) {
      this.highestSequence.set(author, postcard.sequence);
    }
  }

  has(id) {
    return this.byId.has(id);
  }

  get(id) {
    return this.byId.get(id) || null;
  }

  idForSequence(author, sequence) {
    return this.sequenceIds.get(`${author.toLowerCase()}:${sequence}`) || null;
  }

  add(postcard) {
    if (this.has(postcard.id)) return false;
    this.index(postcard);
    if (this.filePath) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, `${JSON.stringify(postcard)}\n`, "utf8");
    }
    return true;
  }

  nextSequence(author) {
    return (this.highestSequence.get(author.toLowerCase()) ?? -1) + 1;
  }

  list({ launchId = null, author = null, type = null, limit = 100 } = {}) {
    let values = Array.from(this.byId.values());
    if (launchId !== null) values = values.filter((item) => item.launchId === String(launchId));
    if (author !== null) {
      const normalized = author.toLowerCase();
      values = values.filter((item) => item.author === normalized);
    }
    if (type !== null) values = values.filter((item) => item.type === type);
    values.sort((a, b) => a.createdAt - b.createdAt || a.sequence - b.sequence);
    return values.slice(-limit);
  }

  listWorkingSetCandidates({ launchId, recentLimit = 48, durablePerType = 8 } = {}) {
    const selected = new Map();
    for (const postcard of this.list({ launchId, limit: recentLimit })) selected.set(postcard.id, postcard);
    for (const type of ["proposal", "mission", "outcome", "receipt"]) {
      for (const postcard of this.list({ launchId, type, limit: durablePerType })) selected.set(postcard.id, postcard);
    }
    return Array.from(selected.values()).sort(
      (left, right) => left.createdAt - right.createdAt || left.sequence - right.sequence
    );
  }

  ids({ limit = 128 } = {}) {
    limit = Math.max(1, Math.min(256, Number(limit) || 128));
    return this.list({ limit }).map((postcard) => postcard.id);
  }

  get size() {
    return this.byId.size;
  }
}

module.exports = { PostcardStore, PostcardStoreError };
