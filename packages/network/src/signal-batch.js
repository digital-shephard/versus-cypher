const fs = require("fs");
const path = require("path");
const { getAddress, isAddress, keccak256, toUtf8Bytes } = require("ethers");
const { canonicalJson } = require("./artifact-store");
const { SIGNAL_INK_PENNIES, SIGNAL_TYPES, verifyPostcard } = require("./protocol");

const SIGNAL_BATCH_PROTOCOL = "versus-signal-batch";
const SIGNAL_BATCH_VERSION = 2;
const SIGNAL_SETTLEMENT_KIND = "versus-signal-settlement";
const SIGNAL_SETTLEMENT_VERSION = 1;
const MAX_SIGNAL_BATCH = 100;
const PENNY_MICROS = 10_000n;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;

class SignalBatchError extends Error {
  constructor(message, code = "INVALID_SIGNAL_BATCH") {
    super(message);
    this.name = "SignalBatchError";
    this.code = code;
  }
}

function normalizeUintString(value, label, maxDigits = 78) {
  const text = String(value);
  if (!/^\d+$/.test(text) || text.length > maxDigits) {
    throw new SignalBatchError(`${label} must be an unsigned integer`);
  }
  return BigInt(text).toString();
}

function signalBatchPayload({ chainId, arena, launchId, agentId, author, signals }) {
  if (typeof arena !== "string" || !isAddress(arena)) {
    throw new SignalBatchError("signal Arena address is invalid");
  }
  if (typeof author !== "string" || !isAddress(author)) {
    throw new SignalBatchError("signal author address is invalid");
  }
  if (!Array.isArray(signals) || signals.length < 1 || signals.length > MAX_SIGNAL_BATCH) {
    throw new SignalBatchError(`signal batch must contain 1 to ${MAX_SIGNAL_BATCH} postcards`);
  }
  const normalizedSignals = signals.map((signal) => {
    if (!signal || typeof signal !== "object" || !HASH_PATTERN.test(signal.id)) {
      throw new SignalBatchError("signal batch entries must contain lowercase postcard hashes");
    }
    const price = SIGNAL_INK_PENNIES[signal.type];
    if (!price || Number(signal.inkPennies) !== price) {
      throw new SignalBatchError("signal batch entry has an invalid type or ink price");
    }
    return { id: signal.id, type: signal.type, inkPennies: price };
  });
  if (new Set(normalizedSignals.map((signal) => signal.id)).size !== normalizedSignals.length) {
    throw new SignalBatchError("signal batch postcard IDs must be unique lowercase hashes");
  }
  return {
    protocol: SIGNAL_BATCH_PROTOCOL,
    version: SIGNAL_BATCH_VERSION,
    chainId: normalizeUintString(chainId, "signal chainId", 20),
    arena: getAddress(arena).toLowerCase(),
    launchId: normalizeUintString(launchId, "signal launchId"),
    agentId: normalizeUintString(agentId, "signal agentId"),
    author: getAddress(author).toLowerCase(),
    signals: normalizedSignals,
  };
}

function signalBatchRoot(input) {
  return keccak256(toUtf8Bytes(canonicalJson(signalBatchPayload(input))));
}

function buildSignalBatch({ postcards, chainId, arena, launchId, agentId, author }) {
  if (!Array.isArray(postcards)) throw new SignalBatchError("postcards must be an array");
  const normalizedAuthor = getAddress(author).toLowerCase();
  const normalizedAgentId = normalizeUintString(agentId, "signal agentId");
  const normalizedLaunchId = normalizeUintString(launchId, "signal launchId");
  const ordered = [...postcards].sort(
    (left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id)
  );
  for (const postcard of ordered) {
    if (!SIGNAL_TYPES.includes(postcard.type)) {
      throw new SignalBatchError("signal batch contains a non-durable postcard");
    }
    if (
      postcard.author !== normalizedAuthor ||
      postcard.cypherId !== normalizedAgentId ||
      postcard.launchId !== normalizedLaunchId
    ) {
      throw new SignalBatchError("signal batch postcards do not share author Cypher and launch");
    }
  }
  const payload = signalBatchPayload({
    chainId,
    arena,
    launchId: normalizedLaunchId,
    agentId: normalizedAgentId,
    author: normalizedAuthor,
    signals: ordered.map((postcard) => ({
      id: postcard.id,
      type: postcard.type,
      inkPennies: SIGNAL_INK_PENNIES[postcard.type],
    })),
  });
  const inkPennies = payload.signals.reduce((sum, signal) => sum + signal.inkPennies, 0);
  return {
    ...payload,
    root: signalBatchRoot(payload),
    signalCount: ordered.length,
    inkPennies,
    amountMicros: (BigInt(inkPennies) * PENNY_MICROS).toString(),
  };
}

function normalizeSignalBatch(batch) {
  if (!batch || typeof batch !== "object" || Array.isArray(batch)) {
    throw new SignalBatchError("signal batch must be an object");
  }
  const payload = signalBatchPayload(batch);
  const root = signalBatchRoot(payload);
  if (batch.root !== root) throw new SignalBatchError("signal batch root does not match its postcards");
  if (Number(batch.signalCount) !== payload.signals.length) {
    throw new SignalBatchError("signal batch count does not match its postcards");
  }
  const inkPennies = payload.signals.reduce((sum, signal) => sum + signal.inkPennies, 0);
  if (Number(batch.inkPennies) !== inkPennies) {
    throw new SignalBatchError("signal batch ink total does not match its typed entries");
  }
  const amountMicros = (BigInt(inkPennies) * PENNY_MICROS).toString();
  if (String(batch.amountMicros) !== amountMicros) {
    throw new SignalBatchError("signal batch amount does not match its fixed ink prices");
  }
  return { ...payload, root, signalCount: payload.signals.length, inkPennies, amountMicros };
}

function normalizeSignalSettlement(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new SignalBatchError("signal settlement must be an object");
  }
  if (input.kind !== SIGNAL_SETTLEMENT_KIND || Number(input.version) !== SIGNAL_SETTLEMENT_VERSION) {
    throw new SignalBatchError("signal settlement kind or version is unsupported");
  }
  if (typeof input.transactionHash !== "string" || !HASH_PATTERN.test(input.transactionHash)) {
    throw new SignalBatchError("signal settlement transaction hash is invalid");
  }
  return {
    kind: SIGNAL_SETTLEMENT_KIND,
    version: SIGNAL_SETTLEMENT_VERSION,
    batch: normalizeSignalBatch(input.batch),
    transactionHash: input.transactionHash,
    blockNumber: normalizeUintString(input.blockNumber, "signal blockNumber"),
  };
}

function verifySignalSettlementPostcard(postcard, value) {
  const settlement = normalizeSignalSettlement(value);
  if (postcard.type !== "receipt") {
    throw new SignalBatchError("signal settlement must be attached to a receipt postcard");
  }
  if (
    postcard.author !== settlement.batch.author ||
    postcard.cypherId !== settlement.batch.agentId ||
    postcard.launchId !== settlement.batch.launchId
  ) {
    throw new SignalBatchError("signal settlement does not match its announcing postcard");
  }
  return settlement;
}

class SignalSettlementQueue {
  constructor({ store, chainId, arena, agentId, author, filePath = null }) {
    if (!store) throw new TypeError("signal queue requires a postcard store");
    this.store = store;
    this.chainId = normalizeUintString(chainId, "signal chainId", 20);
    this.arena = getAddress(arena).toLowerCase();
    this.agentId = normalizeUintString(agentId, "signal agentId");
    this.author = getAddress(author).toLowerCase();
    this.filePath = filePath;
    this.batches = new Map();
    this.load();
  }

  load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch (error) {
      throw new SignalBatchError(`signal queue is unreadable: ${error.message}`, "BAD_SIGNAL_QUEUE");
    }
    for (const record of parsed.batches || []) {
      const batch = normalizeSignalBatch(record.batch);
      if (batch.chainId !== this.chainId || batch.arena !== this.arena || batch.agentId !== this.agentId) {
        throw new SignalBatchError("signal queue contains a batch for another deployment", "BAD_SIGNAL_QUEUE");
      }
      const postcards = Array.isArray(record.postcards)
        ? record.postcards.map((postcard) => verifyPostcard(postcard, { temporal: false }))
        : [];
      if (postcards.length && (
        postcards.length !== batch.signals.length ||
        postcards.some((postcard, index) => postcard.id !== batch.signals[index].id)
      )) {
        throw new SignalBatchError("signal queue postcards do not match their paid batch", "BAD_SIGNAL_QUEUE");
      }
      const paidIds = new Set(batch.signals.map((signal) => signal.id));
      const publishedIds = Array.isArray(record.publishedIds)
        ? record.publishedIds.filter((id) => paidIds.has(id))
        : [];
      this.batches.set(batch.root, { ...record, batch, postcards, publishedIds });
    }
  }

  save() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(
      temporary,
      `${JSON.stringify({ version: 1, batches: this.list() }, null, 2)}\n`,
      "utf8"
    );
    fs.renameSync(temporary, this.filePath);
  }

  reservedIds() {
    const ids = new Set();
    for (const record of this.batches.values()) {
      if (record.status === "failed") continue;
      for (const signal of record.batch.signals) ids.add(signal.id);
    }
    return ids;
  }

  pending(launchId, limit = MAX_SIGNAL_BATCH) {
    limit = Number(limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SIGNAL_BATCH) {
      throw new RangeError(`signal batch limit must be between 1 and ${MAX_SIGNAL_BATCH}`);
    }
    const reserved = this.reservedIds();
    return this.store
      .list({ launchId: String(launchId), author: this.author, limit: 100_000 })
      .filter((postcard) => SIGNAL_TYPES.includes(postcard.type) && !reserved.has(postcard.id))
      .slice(0, limit);
  }

  prepare(launchId, limit = MAX_SIGNAL_BATCH) {
    const postcards = this.pending(launchId, limit);
    if (postcards.length < 1) throw new SignalBatchError("there are no unsettled durable signals", "NO_SIGNALS");
    return this.preparePostcards(postcards, launchId);
  }

  preparePostcards(postcards, launchId) {
    if (!Array.isArray(postcards) || postcards.length < 1 || postcards.length > MAX_SIGNAL_BATCH) {
      throw new SignalBatchError(`signal batch must contain 1 to ${MAX_SIGNAL_BATCH} postcards`);
    }
    postcards = postcards.map((postcard) => verifyPostcard(postcard, { temporal: false }));
    const batch = buildSignalBatch({
      postcards,
      chainId: this.chainId,
      arena: this.arena,
      launchId,
      agentId: this.agentId,
      author: this.author,
    });
    const record = {
      batch,
      postcards: batch.signals.map((signal) => ({ ...postcards.find((postcard) => postcard.id === signal.id) })),
      status: "prepared",
      preparedAt: Date.now(),
      transactionHash: null,
      publishedIds: [],
    };
    this.batches.set(batch.root, record);
    this.save();
    return record;
  }

  markSubmitted(root, transactionHash) {
    const record = this.requireRecord(root);
    if (record.status !== "prepared") throw new SignalBatchError("signal batch is not prepared");
    if (typeof transactionHash !== "string" || !HASH_PATTERN.test(transactionHash)) {
      throw new SignalBatchError("signal transaction hash is invalid");
    }
    record.status = "submitted";
    record.transactionHash = transactionHash;
    record.submittedAt = Date.now();
    this.save();
    return record;
  }

  confirm(root, { transactionHash, blockNumber }) {
    const record = this.requireRecord(root);
    if (record.status !== "submitted" || record.transactionHash !== transactionHash) {
      throw new SignalBatchError("signal receipt does not match the submitted transaction");
    }
    record.status = "confirmed";
    record.blockNumber = normalizeUintString(blockNumber, "signal blockNumber");
    record.confirmedAt = Date.now();
    this.save();
    return record;
  }

  fail(root, reason = "transaction failed") {
    const record = this.requireRecord(root);
    if (record.status === "confirmed") throw new SignalBatchError("confirmed signal batch cannot fail");
    record.status = "failed";
    record.failure = String(reason).slice(0, 240);
    record.failedAt = Date.now();
    this.save();
    return record;
  }

  markPublished(root, postcardId) {
    const record = this.requireRecord(root);
    if (record.status !== "confirmed") throw new SignalBatchError("signal batch is not confirmed");
    if (!record.batch.signals.some((signal) => signal.id === postcardId)) {
      throw new SignalBatchError("published postcard is not in the signal batch");
    }
    const ids = new Set(record.publishedIds || []);
    ids.add(postcardId);
    record.publishedIds = Array.from(ids);
    record.publishedAt = Date.now();
    this.save();
    return record;
  }

  requireRecord(root) {
    const record = this.batches.get(root);
    if (!record) throw new SignalBatchError("signal batch is unknown", "UNKNOWN_SIGNAL_BATCH");
    return record;
  }

  list() {
    return Array.from(this.batches.values()).sort((left, right) => left.preparedAt - right.preparedAt);
  }

  submitted() {
    return this.list().filter((record) => record.status === "submitted");
  }

  unpublishedConfirmed() {
    return this.list().filter((record) =>
      record.status === "confirmed" &&
      (record.publishedIds?.length || 0) < record.batch.signalCount
    );
  }
}

module.exports = {
  MAX_SIGNAL_BATCH,
  PENNY_MICROS,
  SIGNAL_BATCH_PROTOCOL,
  SIGNAL_BATCH_VERSION,
  SIGNAL_SETTLEMENT_KIND,
  SIGNAL_SETTLEMENT_VERSION,
  SignalBatchError,
  SignalSettlementQueue,
  buildSignalBatch,
  normalizeSignalBatch,
  normalizeSignalSettlement,
  signalBatchPayload,
  signalBatchRoot,
  verifySignalSettlementPostcard,
};
