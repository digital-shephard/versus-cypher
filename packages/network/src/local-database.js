const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { getAddress, isAddress } = require("ethers");
const { verifyPostcard } = require("./protocol");
const { PostcardStoreError } = require("./store");

const SCHEMA_VERSION = 1;
const DEFAULT_RETENTION = Object.freeze({
  maxAgeMs: 30 * 86_400_000,
  maxRows: 20_000,
  maxBytes: 100 * 1024 * 1024,
});
const MEMORY_STATUSES = new Set(["active", "disputed", "superseded", "expired", "pinned"]);
const DURABLE_TYPES = new Set(["proposal", "mission", "outcome", "receipt"]);

function normalizeAddress(address) {
  if (typeof address !== "string" || !isAddress(address)) throw new TypeError("address must be an ethereum address");
  return getAddress(address).toLowerCase();
}

function boundedString(value, name, max, { empty = false } = {}) {
  const text = String(value ?? "").trim();
  if ((!empty && !text) || text.length > max) throw new RangeError(`${name} must contain ${empty ? "0" : "1"} to ${max} characters`);
  return text;
}

function stringArray(value, name, { min = 0, max = 128 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new RangeError(`${name} must contain ${min} to ${max} values`);
  }
  return Array.from(new Set(value.map((item) => boundedString(item, `${name} value`, 200))));
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

class CypherLocalDatabase {
  constructor({ filePath, now = () => Date.now(), retention = {} } = {}) {
    if (typeof filePath !== "string" || !filePath.trim()) throw new TypeError("local database requires a file path");
    this.filePath = path.resolve(filePath);
    this.now = now;
    this.retention = { ...DEFAULT_RETENTION, ...retention };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.db = new DatabaseSync(this.filePath, { enableForeignKeyConstraints: true });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS postcards (
        id TEXT PRIMARY KEY,
        launch_id TEXT NOT NULL,
        author TEXT NOT NULL,
        cypher_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        reply_to TEXT,
        artifact TEXT,
        postcard_json TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
        durable INTEGER NOT NULL DEFAULT 0 CHECK (durable IN (0, 1)),
        UNIQUE(author, sequence)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS postcards_launch_created ON postcards(launch_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS postcards_author_created ON postcards(author, created_at DESC);
      CREATE INDEX IF NOT EXISTS postcards_type_created ON postcards(type, created_at DESC);

      CREATE TABLE IF NOT EXISTS peer_profiles (
        address TEXT PRIMARY KEY,
        cypher_id TEXT,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        last_interaction INTEGER NOT NULL,
        accepted_count INTEGER NOT NULL DEFAULT 0,
        explicit_pin INTEGER NOT NULL DEFAULT 0 CHECK (explicit_pin IN (0, 1)),
        muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0, 1)),
        blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1)),
        affinity INTEGER NOT NULL DEFAULT 0 CHECK (affinity BETWEEN -100 AND 100),
        affinity_reasons_json TEXT NOT NULL DEFAULT '[]',
        interaction_counts_json TEXT NOT NULL DEFAULT '{}',
        cluster_id TEXT,
        provenance_json TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS peer_profiles_attention ON peer_profiles(explicit_pin DESC, affinity DESC, last_seen DESC);

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        statement TEXT NOT NULL,
        sources_json TEXT NOT NULL,
        confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
        confidence_reasons_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        replaces_id TEXT,
        contradictions_json TEXT NOT NULL DEFAULT '[]',
        untrusted_sources INTEGER NOT NULL DEFAULT 1 CHECK (untrusted_sources IN (0, 1)),
        pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
        created_at INTEGER NOT NULL,
        reviewed_at INTEGER NOT NULL,
        expires_at INTEGER
      ) STRICT;
      CREATE INDEX IF NOT EXISTS memories_subject ON memories(subject_type, subject_id, status, confidence DESC);
      CREATE INDEX IF NOT EXISTS memories_context ON memories(pinned DESC, status, confidence DESC, reviewed_at DESC);
    `);
    this.db.prepare("INSERT OR REPLACE INTO local_meta(key, value) VALUES('schema_version', ?)").run(String(SCHEMA_VERSION));
  }

  close() {
    this.db.close();
  }

  getMeta(key) {
    const row = this.db.prepare("SELECT value FROM local_meta WHERE key = ?").get(String(key));
    return row?.value ?? null;
  }

  setMeta(key, value) {
    this.db.prepare("INSERT OR REPLACE INTO local_meta(key, value) VALUES(?, ?)").run(String(key), String(value));
  }

  has(id) {
    return Boolean(this.db.prepare("SELECT 1 AS present FROM postcards WHERE id = ?").get(String(id)));
  }

  get(id) {
    const row = this.db.prepare("SELECT postcard_json FROM postcards WHERE id = ?").get(String(id));
    return row ? JSON.parse(row.postcard_json) : null;
  }

  idForSequence(author, sequence) {
    const row = this.db.prepare("SELECT id FROM postcards WHERE author = ? AND sequence = ?").get(
      normalizeAddress(author), Number(sequence)
    );
    return row?.id || null;
  }

  add(postcard, { receivedAt = this.now(), pinned = false, durable = null } = {}) {
    const verified = verifyPostcard(postcard, { temporal: false });
    if (this.has(verified.id)) return false;
    const author = normalizeAddress(verified.author);
    const conflicting = this.idForSequence(author, verified.sequence);
    if (conflicting && conflicting !== verified.id) {
      throw new PostcardStoreError(
        "author signed conflicting postcards with the same sequence",
        "SEQUENCE_EQUIVOCATION"
      );
    }
    const isDurable = durable === null ? DURABLE_TYPES.has(verified.type) : Boolean(durable);
    try {
      this.db.prepare(`
        INSERT INTO postcards(
          id, launch_id, author, cypher_id, sequence, type, created_at, expires_at,
          reply_to, artifact, postcard_json, received_at, pinned, durable
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        verified.id,
        verified.launchId,
        author,
        String(verified.cypherId),
        verified.sequence,
        verified.type,
        verified.createdAt,
        verified.expiresAt,
        verified.replyTo || null,
        verified.artifact || null,
        JSON.stringify(verified),
        Number(receivedAt),
        pinned ? 1 : 0,
        isDurable ? 1 : 0
      );
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed: postcards.author, postcards.sequence")) {
        throw new PostcardStoreError(
          "author signed conflicting postcards with the same sequence",
          "SEQUENCE_EQUIVOCATION"
        );
      }
      throw error;
    }
    this.observePeer(verified, Number(receivedAt));
    return true;
  }

  nextSequence(author) {
    const row = this.db.prepare("SELECT MAX(sequence) AS highest FROM postcards WHERE author = ?").get(normalizeAddress(author));
    return row?.highest == null ? 0 : Number(row.highest) + 1;
  }

  list({ launchId = null, author = null, type = null, limit = 100 } = {}) {
    limit = Math.max(1, Math.min(100_000, Number(limit) || 100));
    const clauses = [];
    const values = [];
    if (launchId !== null) { clauses.push("launch_id = ?"); values.push(String(launchId)); }
    if (author !== null) { clauses.push("author = ?"); values.push(normalizeAddress(author)); }
    if (type !== null) { clauses.push("type = ?"); values.push(String(type)); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`
      SELECT postcard_json FROM (
        SELECT postcard_json, created_at, sequence FROM postcards ${where}
        ORDER BY created_at DESC, sequence DESC LIMIT ?
      ) ORDER BY created_at ASC, sequence ASC
    `).all(...values, limit);
    return rows.map((row) => JSON.parse(row.postcard_json));
  }

  listWorkingSetCandidates({ launchId, recentLimit = 48, durablePerType = 8 } = {}) {
    const selected = new Map();
    for (const postcard of this.list({ launchId, limit: recentLimit })) selected.set(postcard.id, postcard);
    for (const type of DURABLE_TYPES) {
      for (const postcard of this.list({ launchId, type, limit: durablePerType })) selected.set(postcard.id, postcard);
    }
    return Array.from(selected.values()).sort(
      (left, right) => left.createdAt - right.createdAt || left.sequence - right.sequence
    );
  }

  ids({ limit = 128 } = {}) {
    return this.list({ limit: Math.max(1, Math.min(256, Number(limit) || 128)) }).map((postcard) => postcard.id);
  }

  get size() {
    return Number(this.db.prepare("SELECT COUNT(*) AS count FROM postcards").get().count);
  }

  importLegacyNdjson(filePath) {
    const result = { imported: 0, duplicates: 0, errors: [] };
    if (!filePath || !fs.existsSync(filePath)) return result;
    if (this.getMeta("legacy_postcards_imported_at")) return { ...result, skipped: true };
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 0; index < lines.length; index += 1) {
        try {
          if (this.add(JSON.parse(lines[index]))) result.imported += 1;
          else result.duplicates += 1;
        } catch (error) {
          result.errors.push({ line: index + 1, message: error.message });
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.setMeta("legacy_postcards_imported_at", this.now());
    return result;
  }

  observePeer(postcard, at = this.now()) {
    const address = normalizeAddress(postcard.author);
    const current = this.peerProfile(address);
    const counts = { ...(current?.interactionCounts || {}) };
    counts[postcard.type] = Number(counts[postcard.type] || 0) + 1;
    if (!current) {
      this.db.prepare(`
        INSERT INTO peer_profiles(
          address, cypher_id, first_seen, last_seen, last_interaction, accepted_count,
          interaction_counts_json, provenance_json, updated_at
        ) VALUES(?, ?, ?, ?, ?, 1, ?, ?, ?)
      `).run(address, String(postcard.cypherId), at, at, at, JSON.stringify(counts), JSON.stringify([postcard.id]), at);
      return;
    }
    const provenance = Array.from(new Set([...current.provenance, postcard.id])).slice(-256);
    this.db.prepare(`
      UPDATE peer_profiles SET cypher_id = ?, last_seen = ?, last_interaction = ?,
        accepted_count = accepted_count + 1, interaction_counts_json = ?, provenance_json = ?, updated_at = ?
      WHERE address = ?
    `).run(String(postcard.cypherId), at, at, JSON.stringify(counts), JSON.stringify(provenance), at, address);
  }

  peerProfile(address) {
    address = normalizeAddress(address);
    const row = this.db.prepare("SELECT * FROM peer_profiles WHERE address = ?").get(address);
    if (!row) return null;
    return {
      address: row.address,
      cypherId: row.cypher_id,
      firstSeen: Number(row.first_seen),
      lastSeen: Number(row.last_seen),
      lastInteraction: Number(row.last_interaction),
      acceptedCount: Number(row.accepted_count),
      explicitPin: Boolean(row.explicit_pin),
      muted: Boolean(row.muted),
      blocked: Boolean(row.blocked),
      affinity: Number(row.affinity),
      affinityReasons: parseJson(row.affinity_reasons_json, []),
      interactionCounts: parseJson(row.interaction_counts_json, {}),
      clusterId: row.cluster_id,
      provenance: parseJson(row.provenance_json, []),
      updatedAt: Number(row.updated_at),
    };
  }

  setPeerPreference(address, { explicitPin, muted, blocked } = {}) {
    address = normalizeAddress(address);
    const profile = this.peerProfile(address);
    if (!profile) throw new Error("peer profile is unknown");
    const next = {
      explicitPin: explicitPin === undefined ? profile.explicitPin : Boolean(explicitPin),
      muted: muted === undefined ? profile.muted : Boolean(muted),
      blocked: blocked === undefined ? profile.blocked : Boolean(blocked),
    };
    this.db.prepare(`
      UPDATE peer_profiles SET explicit_pin = ?, muted = ?, blocked = ?, updated_at = ? WHERE address = ?
    `).run(next.explicitPin ? 1 : 0, next.muted ? 1 : 0, next.blocked ? 1 : 0, this.now(), address);
    return this.peerProfile(address);
  }

  setPeerAffinity(address, affinity, { reasons = [], provenance = [] } = {}) {
    address = normalizeAddress(address);
    affinity = Number(affinity);
    if (!Number.isInteger(affinity) || affinity < -100 || affinity > 100) {
      throw new RangeError("peer affinity must be an integer between -100 and 100");
    }
    const profile = this.peerProfile(address);
    if (!profile) throw new Error("peer profile is unknown");
    reasons = stringArray(reasons, "affinity reasons", { max: 16 });
    provenance = stringArray(provenance, "affinity provenance", { max: 256 });
    this.db.prepare(`
      UPDATE peer_profiles SET affinity = ?, affinity_reasons_json = ?, provenance_json = ?, updated_at = ?
      WHERE address = ?
    `).run(affinity, JSON.stringify(reasons), JSON.stringify(provenance), this.now(), address);
    return this.peerProfile(address);
  }

  listPeers({ limit = 100, includeBlocked = true } = {}) {
    limit = Math.max(1, Math.min(10_000, Number(limit) || 100));
    const rows = this.db.prepare(`
      SELECT address FROM peer_profiles ${includeBlocked ? "" : "WHERE blocked = 0"}
      ORDER BY explicit_pin DESC, affinity DESC, last_seen DESC LIMIT ?
    `).all(limit);
    return rows.map((row) => this.peerProfile(row.address));
  }

  memoryId(memory) {
    const canonical = JSON.stringify({
      kind: memory.kind,
      subjectType: memory.subjectType,
      subjectId: memory.subjectId,
      statement: memory.statement,
      sources: [...memory.sources].sort(),
    });
    return `mem:${crypto.createHash("sha256").update(canonical).digest("hex")}`;
  }

  putMemory(input) {
    const now = this.now();
    const memory = {
      kind: boundedString(input.kind, "memory kind", 40),
      subjectType: boundedString(input.subjectType, "memory subject type", 40),
      subjectId: boundedString(input.subjectId, "memory subject", 200),
      statement: boundedString(input.statement, "memory statement", 500),
      sources: stringArray(input.sources, "memory sources", { min: 1, max: 128 }),
      confidence: Number(input.confidence),
      confidenceReasons: stringArray(input.confidenceReasons || [], "confidence reasons", { max: 16 }),
      status: String(input.status || "active"),
      replacesId: input.replacesId ? boundedString(input.replacesId, "replacement memory", 200) : null,
      contradictions: stringArray(input.contradictions || [], "memory contradictions", { max: 64 }),
      untrustedSources: input.untrustedSources !== false,
      pinned: Boolean(input.pinned),
      createdAt: Number(input.createdAt || now),
      reviewedAt: Number(input.reviewedAt || now),
      expiresAt: input.expiresAt == null ? null : Number(input.expiresAt),
    };
    if (!Number.isInteger(memory.confidence) || memory.confidence < 0 || memory.confidence > 100) {
      throw new RangeError("memory confidence must be an integer between 0 and 100");
    }
    if (!MEMORY_STATUSES.has(memory.status)) throw new RangeError("memory status is invalid");
    const id = input.id ? boundedString(input.id, "memory id", 200) : this.memoryId(memory);
    if (memory.replacesId) {
      this.db.prepare("UPDATE memories SET status = 'superseded', reviewed_at = ? WHERE id = ?").run(now, memory.replacesId);
    }
    this.db.prepare(`
      INSERT INTO memories(
        id, kind, subject_type, subject_id, statement, sources_json, confidence,
        confidence_reasons_json, status, replaces_id, contradictions_json,
        untrusted_sources, pinned, created_at, reviewed_at, expires_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        statement = excluded.statement, sources_json = excluded.sources_json,
        confidence = excluded.confidence, confidence_reasons_json = excluded.confidence_reasons_json,
        status = excluded.status, replaces_id = excluded.replaces_id,
        contradictions_json = excluded.contradictions_json, untrusted_sources = excluded.untrusted_sources,
        pinned = excluded.pinned, reviewed_at = excluded.reviewed_at, expires_at = excluded.expires_at
    `).run(
      id, memory.kind, memory.subjectType, memory.subjectId, memory.statement,
      JSON.stringify(memory.sources), memory.confidence, JSON.stringify(memory.confidenceReasons),
      memory.status, memory.replacesId, JSON.stringify(memory.contradictions),
      memory.untrustedSources ? 1 : 0, memory.pinned ? 1 : 0,
      memory.createdAt, memory.reviewedAt, memory.expiresAt
    );
    return this.getMemory(id);
  }

  getMemory(id) {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(String(id));
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      statement: row.statement,
      sources: parseJson(row.sources_json, []),
      confidence: Number(row.confidence),
      confidenceReasons: parseJson(row.confidence_reasons_json, []),
      status: row.status,
      replacesId: row.replaces_id,
      contradictions: parseJson(row.contradictions_json, []),
      untrustedSources: Boolean(row.untrusted_sources),
      pinned: Boolean(row.pinned),
      createdAt: Number(row.created_at),
      reviewedAt: Number(row.reviewed_at),
      expiresAt: row.expires_at == null ? null : Number(row.expires_at),
    };
  }

  listMemories({ subjectType = null, subjectId = null, statuses = ["active", "pinned"], limit = 100 } = {}) {
    limit = Math.max(1, Math.min(5000, Number(limit) || 100));
    statuses = stringArray(statuses, "memory statuses", { min: 1, max: MEMORY_STATUSES.size });
    for (const status of statuses) if (!MEMORY_STATUSES.has(status)) throw new RangeError("memory status is invalid");
    const clauses = [`status IN (${statuses.map(() => "?").join(",")})`];
    const values = [...statuses];
    if (subjectType !== null) { clauses.push("subject_type = ?"); values.push(String(subjectType)); }
    if (subjectId !== null) { clauses.push("subject_id = ?"); values.push(String(subjectId)); }
    const rows = this.db.prepare(`
      SELECT id FROM memories WHERE ${clauses.join(" AND ")}
      ORDER BY pinned DESC, confidence DESC, reviewed_at DESC LIMIT ?
    `).all(...values, limit);
    return rows.map((row) => this.getMemory(row.id));
  }

  expireMemories(now = this.now()) {
    return Number(this.db.prepare(`
      UPDATE memories SET status = 'expired', reviewed_at = ?
      WHERE pinned = 0 AND status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?
    `).run(now, now).changes);
  }

  exportArchive() {
    const postcards = this.db.prepare("SELECT postcard_json, received_at, pinned, durable FROM postcards ORDER BY created_at, sequence").all();
    const peers = this.listPeers({ limit: 10_000, includeBlocked: true });
    const memories = this.listMemories({
      statuses: Array.from(MEMORY_STATUSES),
      limit: 5000,
    });
    return {
      format: "versus-local-memory",
      version: SCHEMA_VERSION,
      exportedAt: this.now(),
      postcards: postcards.map((row) => ({
        postcard: JSON.parse(row.postcard_json),
        receivedAt: Number(row.received_at),
        pinned: Boolean(row.pinned),
        durable: Boolean(row.durable),
      })),
      peers,
      memories,
    };
  }

  importArchive(archive, { replace = false } = {}) {
    if (archive?.format !== "versus-local-memory" || archive.version !== SCHEMA_VERSION) {
      throw new Error("unsupported Versus local-memory archive");
    }
    if (!Array.isArray(archive.postcards) || !Array.isArray(archive.peers) || !Array.isArray(archive.memories)) {
      throw new Error("Versus local-memory archive is incomplete");
    }
    const result = { postcards: 0, duplicatePostcards: 0, peers: 0, memories: 0 };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (replace) this.db.exec("DELETE FROM memories; DELETE FROM peer_profiles; DELETE FROM postcards;");
      for (const entry of archive.postcards) {
        if (this.add(entry.postcard, {
          receivedAt: Number(entry.receivedAt || this.now()),
          pinned: Boolean(entry.pinned),
          durable: Boolean(entry.durable),
        })) result.postcards += 1;
        else result.duplicatePostcards += 1;
      }
      for (const peer of archive.peers) {
        const address = normalizeAddress(peer.address);
        const current = this.peerProfile(address);
        if (!current) {
          const at = Number(peer.updatedAt || this.now());
          this.db.prepare(`
            INSERT INTO peer_profiles(
              address, cypher_id, first_seen, last_seen, last_interaction, accepted_count,
              explicit_pin, muted, blocked, affinity, affinity_reasons_json,
              interaction_counts_json, cluster_id, provenance_json, updated_at
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            address, peer.cypherId == null ? null : String(peer.cypherId),
            Number(peer.firstSeen || at), Number(peer.lastSeen || at), Number(peer.lastInteraction || at),
            Number(peer.acceptedCount || 0), peer.explicitPin ? 1 : 0, peer.muted ? 1 : 0,
            peer.blocked ? 1 : 0, Number(peer.affinity || 0),
            JSON.stringify(stringArray(peer.affinityReasons || [], "affinity reasons", { max: 16 })),
            JSON.stringify(peer.interactionCounts || {}), peer.clusterId || null,
            JSON.stringify(stringArray(peer.provenance || [], "peer provenance", { max: 256 })), at
          );
        } else {
          this.setPeerPreference(address, {
            explicitPin: Boolean(peer.explicitPin),
            muted: Boolean(peer.muted),
            blocked: Boolean(peer.blocked),
          });
          this.setPeerAffinity(address, Number(peer.affinity || 0), {
            reasons: peer.affinityReasons || [],
            provenance: peer.provenance || current.provenance,
          });
        }
        result.peers += 1;
      }
      for (const memory of archive.memories) {
        this.putMemory(memory);
        result.memories += 1;
      }
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  prune({ now = this.now(), ...overrides } = {}) {
    const policy = { ...this.retention, ...overrides };
    const cutoff = now - policy.maxAgeMs;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const aged = this.db.prepare(`
        DELETE FROM postcards WHERE pinned = 0 AND durable = 0 AND received_at < ?
      `).run(cutoff).changes;
      const count = Number(this.db.prepare("SELECT COUNT(*) AS count FROM postcards").get().count);
      const excess = Math.max(0, count - policy.maxRows);
      let counted = 0;
      if (excess > 0) {
        counted = this.db.prepare(`
          DELETE FROM postcards WHERE id IN (
            SELECT id FROM postcards WHERE pinned = 0 AND durable = 0
            ORDER BY received_at ASC LIMIT ?
          )
        `).run(excess).changes;
      }
      let logicalBytes = Number(this.db.prepare("SELECT COALESCE(SUM(length(postcard_json)), 0) AS bytes FROM postcards").get().bytes);
      let sized = 0;
      while (logicalBytes > policy.maxBytes) {
        const removed = this.db.prepare(`
          DELETE FROM postcards WHERE id IN (
            SELECT id FROM postcards WHERE pinned = 0 AND durable = 0
            ORDER BY received_at ASC LIMIT 256
          )
        `).run().changes;
        if (!removed) break;
        sized += Number(removed);
        logicalBytes = Number(this.db.prepare("SELECT COALESCE(SUM(length(postcard_json)), 0) AS bytes FROM postcards").get().bytes);
      }
      this.db.exec("COMMIT");
      return { aged: Number(aged), counted: Number(counted), sized, remaining: this.size, logicalBytes };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  stats() {
    const postcard = this.db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(length(postcard_json)), 0) AS bytes,
        COALESCE(SUM(pinned), 0) AS pinned, COALESCE(SUM(durable), 0) AS durable
      FROM postcards
    `).get();
    const fileBytes = fs.existsSync(this.filePath) ? fs.statSync(this.filePath).size : 0;
    const walPath = `${this.filePath}-wal`;
    const shmPath = `${this.filePath}-shm`;
    const walBytes = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
    const shmBytes = fs.existsSync(shmPath) ? fs.statSync(shmPath).size : 0;
    const integrity = this.integrityCheck();
    return {
      schemaVersion: SCHEMA_VERSION,
      postcards: Number(postcard.count),
      postcardBytes: Number(postcard.bytes),
      pinnedPostcards: Number(postcard.pinned),
      durablePostcards: Number(postcard.durable),
      peers: Number(this.db.prepare("SELECT COUNT(*) AS count FROM peer_profiles").get().count),
      memories: Number(this.db.prepare("SELECT COUNT(*) AS count FROM memories").get().count),
      fileBytes,
      walBytes,
      shmBytes,
      totalFileBytes: fileBytes + walBytes + shmBytes,
      integrity: integrity.ok ? "ok" : "failed",
    };
  }

  integrityCheck() {
    try {
      const rows = this.db.prepare("PRAGMA quick_check").all();
      const results = rows.flatMap((row) => Object.values(row)).map(String);
      return { ok: results.length > 0 && results.every((value) => value.toLowerCase() === "ok"), results: results.slice(0, 8) };
    } catch (_) {
      return { ok: false, results: ["failed"] };
    }
  }
}

module.exports = {
  CypherLocalDatabase,
  DEFAULT_RETENTION,
  DURABLE_TYPES,
  MEMORY_STATUSES,
  SCHEMA_VERSION,
};
