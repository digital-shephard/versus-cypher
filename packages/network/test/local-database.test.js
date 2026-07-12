const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { CypherIdentity, CypherLocalDatabase } = require("../src");

function tempDatabase() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "versus-local-db-"));
  return { root, filePath: path.join(root, "cypher.sqlite") };
}

async function postcard(identity, { sequence, type = "observation", body = "watch the current launch carefully", createdAt = 1000 }) {
  return identity.signPostcard({
    launchId: "1",
    sequence,
    type,
    body,
    createdAt,
    expiresAt: createdAt + 3600,
  });
}

test("indexed local history persists queries sequences and peer observations", async () => {
  const { filePath } = tempDatabase();
  const identity = CypherIdentity.createRandom(11);
  const first = await postcard(identity, { sequence: 0, createdAt: 1000 });
  const second = await postcard(identity, { sequence: 1, type: "proposal", body: "build a public signal garden", createdAt: 1001 });
  let db = new CypherLocalDatabase({ filePath, now: () => 2000 });
  assert.equal(db.add(first), true);
  assert.equal(db.add(first), false);
  assert.equal(db.add(second), true);
  assert.equal(db.nextSequence(identity.address), 2);
  assert.equal(db.idForSequence(identity.address, 1), second.id);
  assert.deepEqual(db.list({ author: identity.address }).map((item) => item.id), [first.id, second.id]);
  assert.equal(db.peerProfile(identity.address).acceptedCount, 2);
  assert.deepEqual(db.peerProfile(identity.address).interactionCounts, { observation: 1, proposal: 1 });
  assert.equal(db.stats().durablePostcards, 1);
  assert.deepEqual(db.integrityCheck(), { ok: true, results: ["ok"] });
  assert.equal(db.stats().integrity, "ok");
  db.close();

  db = new CypherLocalDatabase({ filePath });
  assert.equal(db.size, 2);
  assert.equal(db.get(second.id).body, "build a public signal garden");
  db.close();
});

test("a damaged SQLite file fails closed instead of being replaced", () => {
  const { filePath } = tempDatabase();
  fs.writeFileSync(filePath, "this is not a sqlite database", "utf8");
  assert.throws(() => new CypherLocalDatabase({ filePath }), /database|disk image|file is not/i);
  assert.equal(fs.readFileSync(filePath, "utf8"), "this is not a sqlite database");
});

test("legacy NDJSON import preserves valid records and reports malformed lines", async () => {
  const { root, filePath } = tempDatabase();
  const identity = CypherIdentity.createRandom(12);
  const first = await postcard(identity, { sequence: 0 });
  const legacy = path.join(root, "postcards.ndjson");
  fs.writeFileSync(legacy, `${JSON.stringify(first)}\nnot-json\n`, "utf8");
  const db = new CypherLocalDatabase({ filePath });
  const result = db.importLegacyNdjson(legacy);
  assert.equal(result.imported, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(db.has(first.id), true);
  assert.equal(db.importLegacyNdjson(legacy).skipped, true);
  db.close();
});

test("bounded pruning removes old chatter but preserves pinned and durable records", async () => {
  const { filePath } = tempDatabase();
  const identity = CypherIdentity.createRandom(13);
  const db = new CypherLocalDatabase({ filePath, now: () => 10_000 });
  for (let sequence = 0; sequence < 6; sequence += 1) {
    const type = sequence === 4 ? "proposal" : "observation";
    const item = await postcard(identity, { sequence, type, createdAt: 1000 + sequence });
    db.add(item, { receivedAt: 1000 + sequence, pinned: sequence === 5 });
  }
  const result = db.prune({ now: 10_000, maxAgeMs: 1000, maxRows: 2, maxBytes: 1_000_000 });
  assert.equal(result.remaining, 2);
  const retained = db.list({ limit: 10 });
  assert.deepEqual(retained.map((item) => item.sequence), [4, 5]);
  db.close();
});

test("peer pins and explainable affinity remain private local state", async () => {
  const { filePath } = tempDatabase();
  const identity = CypherIdentity.createRandom(14);
  const item = await postcard(identity, { sequence: 0 });
  const db = new CypherLocalDatabase({ filePath });
  db.add(item);
  db.setPeerPreference(identity.address, { explicitPin: true });
  const profile = db.setPeerAffinity(identity.address, 35, {
    reasons: ["two useful predictions"],
    provenance: [item.id],
  });
  assert.equal(profile.explicitPin, true);
  assert.equal(profile.affinity, 35);
  assert.deepEqual(profile.affinityReasons, ["two useful predictions"]);
  assert.equal(db.listPeers()[0].address, identity.address.toLowerCase());
  db.close();
});

test("durable memories require provenance and supersede earlier conclusions", async () => {
  const { filePath } = tempDatabase();
  const db = new CypherLocalDatabase({ filePath, now: () => 5000 });
  assert.throws(() => db.putMemory({
    kind: "peer_outcome",
    subjectType: "peer",
    subjectId: "peer-a",
    statement: "this peer usually verifies its claims",
    sources: [],
    confidence: 60,
  }), /memory sources/);

  const first = db.putMemory({
    kind: "peer_outcome",
    subjectType: "peer",
    subjectId: "peer-a",
    statement: "this peer usually verifies its claims",
    sources: ["postcard-one", "postcard-two"],
    confidence: 60,
    confidenceReasons: ["two independent outcomes"],
    untrustedSources: true,
  });
  const replacement = db.putMemory({
    kind: "peer_outcome",
    subjectType: "peer",
    subjectId: "peer-a",
    statement: "recent outcomes make this peer uncertain",
    sources: ["postcard-three"],
    confidence: 75,
    replacesId: first.id,
    contradictions: [first.id],
  });
  assert.equal(db.getMemory(first.id).status, "superseded");
  assert.equal(db.getMemory(replacement.id).untrustedSources, true);
  assert.deepEqual(db.listMemories().map((memory) => memory.id), [replacement.id]);
  db.close();
});

test("stale unpinned memories expire while pinned owner memory remains", () => {
  const { filePath } = tempDatabase();
  const db = new CypherLocalDatabase({ filePath, now: () => 9000 });
  const stale = db.putMemory({
    kind: "peer_outcome",
    subjectType: "peer",
    subjectId: "peer-stale",
    statement: "this old conclusion needs another observation",
    sources: ["postcard-old"],
    confidence: 40,
    expiresAt: 8999,
  });
  const pinned = db.putMemory({
    kind: "owner_note",
    subjectType: "peer",
    subjectId: "peer-pinned",
    statement: "the owner wants this note retained",
    sources: ["owner-note"],
    confidence: 100,
    pinned: true,
    expiresAt: 8999,
  });
  assert.equal(db.expireMemories(), 1);
  assert.equal(db.getMemory(stale.id).status, "expired");
  assert.equal(db.getMemory(pinned.id).status, "active");
  assert.equal(db.getMemory(pinned.id).pinned, true);
  db.close();
});

test("a local-memory archive restores postcards relationships and memories", async () => {
  const sourcePath = tempDatabase().filePath;
  const targetPath = tempDatabase().filePath;
  const identity = CypherIdentity.createRandom(15);
  const item = await postcard(identity, { sequence: 0, type: "proposal", body: "make a durable signal garden" });
  const source = new CypherLocalDatabase({ filePath: sourcePath, now: () => 6000 });
  source.add(item, { pinned: true });
  source.setPeerPreference(identity.address, { explicitPin: true });
  source.setPeerAffinity(identity.address, 42, { reasons: ["useful proposal"], provenance: [item.id] });
  source.putMemory({
    kind: "proposal_theme",
    subjectType: "proposal",
    subjectId: item.id,
    statement: "the signal garden is a durable local theme",
    sources: [item.id],
    confidence: 80,
  });
  const archive = source.exportArchive();
  source.close();

  const target = new CypherLocalDatabase({ filePath: targetPath });
  const result = target.importArchive(archive);
  assert.deepEqual(result, { postcards: 1, duplicatePostcards: 0, peers: 1, memories: 1 });
  assert.equal(target.get(item.id).body, item.body);
  assert.equal(target.peerProfile(identity.address).explicitPin, true);
  assert.equal(target.peerProfile(identity.address).affinity, 42);
  assert.equal(target.listMemories()[0].sources[0], item.id);
  target.close();
});
