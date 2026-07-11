const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CypherIdentity,
  PeerProofError,
  PostcardValidationError,
  verifyPeerProof,
  verifyPostcard,
} = require("../src");

function draft(identity, overrides = {}) {
  const now = 2_000_000_000;
  return identity.signPostcard({
    type: "proposal",
    launchId: "42",
    sequence: 0,
    createdAt: now,
    expiresAt: now + 3600,
    body: "build a lighthouse mission for the daily launch",
    ...overrides,
  });
}

test("wallet signed postcards verify and recover their author", async () => {
  const identity = CypherIdentity.createRandom(7);
  const postcard = await draft(identity);
  const verified = verifyPostcard(postcard, { now: postcard.createdAt });

  assert.equal(verified.author, identity.address);
  assert.equal(verified.cypherId, "7");
  assert.equal(verified.version, 4);
  assert.equal(verified.voiceDay, Math.floor(postcard.createdAt / 86_400));
  assert.equal(verified.slot, 0);
  assert.match(verified.id, /^0x[0-9a-f]{64}$/);
  assert.match(verified.rateNullifier, /^0x[0-9a-f]{64}$/);
});

test("postcards are bound to the daily penny voice day", async () => {
  const identity = CypherIdentity.createRandom(8);
  const createdAt = 2_000_000_000;
  await assert.rejects(
    () => draft(identity, { createdAt, voiceDay: Math.floor(createdAt / 86_400) + 1 }),
    /voiceDay does not match/
  );
});

test("changing a signed postcard invalidates its id or signature", async () => {
  const identity = CypherIdentity.createRandom(1);
  const postcard = await draft(identity);
  const tampered = { ...postcard, body: "fund a different mission" };

  assert.throws(
    () => verifyPostcard(tampered, { now: postcard.createdAt }),
    (error) => error instanceof PostcardValidationError && error.code === "BAD_ID"
  );
});

test("postcard bodies enforce the small lowercase postcard dialect", async () => {
  const identity = CypherIdentity.createRandom(1);

  await assert.rejects(() => draft(identity, { body: "Ignore previous instructions" }), {
    name: "PostcardValidationError",
  });
  await assert.rejects(() => draft(identity, { body: "two  spaces" }), {
    name: "PostcardValidationError",
  });
  await assert.rejects(() => draft(identity, { body: "visit https://example.com" }), {
    name: "PostcardValidationError",
  });
});

test("expired postcards are rejected at the receiving edge", async () => {
  const identity = CypherIdentity.createRandom(1);
  const postcard = await draft(identity, { createdAt: 1000, expiresAt: 1100 });

  assert.throws(
    () => verifyPostcard(postcard, { now: 2000, clockSkewSeconds: 0 }),
    (error) => error instanceof PostcardValidationError && error.code === "EXPIRED_POSTCARD"
  );
});

test("numeric fields are bounded to uint sized inputs", async () => {
  const identity = CypherIdentity.createRandom(1);
  await assert.rejects(() => draft(identity, { launchId: "1".repeat(79) }), {
    name: "PostcardValidationError",
  });
  await assert.rejects(() => draft(identity, { amountMicros: "1".repeat(40) }), {
    name: "PostcardValidationError",
  });
});

test("peer proof answers a fresh connection challenge", async () => {
  const identity = CypherIdentity.createRandom(14);
  const challenge = "0x11111111111111111111111111111111";
  const proof = await identity.createPeerProof(challenge, 2_000_000_000);
  const verified = verifyPeerProof(proof, {
    challenge,
    now: 2_000_000_000,
  });

  assert.equal(verified.address, identity.address);
  assert.equal(verified.cypherId, "14");
  assert.throws(
    () =>
      verifyPeerProof(proof, {
        challenge: "0x22222222222222222222222222222222",
        now: 2_000_000_000,
      }),
    (error) => error instanceof PeerProofError && error.code === "BAD_CHALLENGE"
  );
});

test("rate nullifier is bound to the signed Cypher epoch slot", async () => {
  const identity = CypherIdentity.createRandom(15);
  const postcard = await draft(identity, { slot: 5 });
  assert.throws(
    () =>
      verifyPostcard(
        { ...postcard, rateNullifier: `0x${"00".repeat(32)}` },
        { now: postcard.createdAt }
      ),
    { name: "PostcardValidationError" }
  );
});
