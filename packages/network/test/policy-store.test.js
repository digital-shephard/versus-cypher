const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  CypherIdentity,
  PostcardStore,
  RateLimitError,
  RatePolicy,
  TrustGraph,
} = require("../src");

async function signed(identity, sequence, type = "receipt") {
  return identity.signPostcard({
    type,
    launchId: "9",
    sequence,
    createdAt: 2_000_000_000 + sequence,
    expiresAt: 2_000_003_600 + sequence,
    body: `message number ${sequence}`,
  });
}

test("rate policy limits both chatter and durable signals", async () => {
  const identity = CypherIdentity.createRandom(3);
  const policy = new RatePolicy({
    maxPerMinute: 3,
    maxPerLaunch: 10,
    maxSignalsPerLaunch: 1,
    now: () => 5_000,
  });

  policy.consume(await signed(identity, 0));
  policy.consume(await signed(identity, 1, "proposal"));
  const secondSignal = await signed(identity, 2, "critique");
  assert.throws(
    () => policy.consume(secondSignal),
    (error) => error instanceof RateLimitError && error.code === "SIGNAL_LIMIT"
  );
});

test("trust is local multidimensional and persisted", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-trust-"));
  const filePath = path.join(directory, "trust.json");
  const peer = CypherIdentity.createRandom(4).address;

  const graph = new TrustGraph({ filePath });
  graph.setScore(peer, "taste", 75);
  graph.setScore(peer, "integrity", -20);
  graph.setBlocked(peer, true);

  const restored = new TrustGraph({ filePath });
  assert.equal(restored.score(peer, "taste"), 75);
  assert.equal(restored.score(peer, "integrity"), -20);
  assert.equal(restored.isBlocked(peer), true);
});

test("append only postcard history restores sequence state", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-store-"));
  const filePath = path.join(directory, "postcards.ndjson");
  const identity = CypherIdentity.createRandom(5);
  const postcard = await signed(identity, 4);

  const store = new PostcardStore({ filePath });
  assert.equal(store.add(postcard), true);
  assert.equal(store.add(postcard), false);

  const restored = new PostcardStore({ filePath });
  assert.equal(restored.size, 1);
  assert.equal(restored.nextSequence(identity.address), 5);
  assert.equal(restored.get(postcard.id).body, postcard.body);
});

test("history reload rejects malformed local records without losing valid history", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-store-corrupt-"));
  const filePath = path.join(directory, "postcards.ndjson");
  const identity = CypherIdentity.createRandom(6);
  const postcard = await signed(identity, 0);
  fs.writeFileSync(filePath, `${JSON.stringify(postcard)}\nnot json\n`, "utf8");

  const restored = new PostcardStore({ filePath });
  assert.equal(restored.size, 1);
  assert.equal(restored.loadErrors.length, 1);
  assert.equal(restored.loadErrors[0].line, 2);
});

test("signed Cypher epoch slots cannot be reused even after policy restart", async () => {
  const identity = CypherIdentity.createRandom(7);
  const createdAt = 2_000_000_000;
  const first = await identity.signPostcard({
    type: "observation",
    launchId: "10",
    sequence: 0,
    slot: 4,
    createdAt,
    expiresAt: createdAt + 3600,
    body: "use one deterministic cypher epoch slot",
  });
  const conflicting = await identity.signPostcard({
    type: "observation",
    launchId: "10",
    sequence: 1,
    slot: 4,
    createdAt: createdAt + 1,
    expiresAt: createdAt + 3601,
    body: "try to reuse the deterministic cypher epoch slot",
  });

  const policy = new RatePolicy();
  policy.consume(first);
  assert.throws(() => policy.consume(conflicting), {
    code: "EPOCH_SLOT_REUSED",
  });

  const restoredPolicy = new RatePolicy();
  restoredPolicy.seed([first]);
  assert.throws(() => restoredPolicy.consume(conflicting), {
    code: "EPOCH_SLOT_REUSED",
  });

  const nextEpoch = await identity.signPostcard({
    type: "observation",
    launchId: "10",
    sequence: 2,
    slot: 4,
    createdAt: createdAt + 600,
    expiresAt: createdAt + 4200,
    body: "reuse the slot only after the next epoch begins",
  });
  assert.doesNotThrow(() => restoredPolicy.consume(nextEpoch));
});
