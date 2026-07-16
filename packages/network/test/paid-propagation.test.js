const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  CypherIdentity,
  PaymentProofStore,
  StaticCypherVerifier,
  VersusNode,
  buildSignalBatch,
} = require("../src");

const ARENA = "0x1111111111111111111111111111111111111111";

class MemoryTransport extends EventEmitter {
  constructor() {
    super();
    this.connectionless = true;
    this.handlesPropagation = true;
    this.sent = [];
  }
  async broadcast(postcard, options = {}) { this.sent.push({ postcard, ...options }); }
  async close() {}
  get peerCount() { return 0; }
  peerList() { return []; }
}

async function fixture() {
  const sender = CypherIdentity.createRandom(901);
  const receiver = CypherIdentity.createRandom(902);
  const registry = new StaticCypherVerifier([
    { address: sender.address, cypherId: 901 },
    { address: receiver.address, cypherId: 902 },
  ]);
  const createdAt = Math.floor(Date.now() / 1000);
  const postcard = await sender.signPostcard({
    type: "proposal",
    launchId: "77",
    sequence: 0,
    createdAt,
    expiresAt: createdAt + 3600,
    body: "build a public signal garden",
  });
  const batch = buildSignalBatch({
    postcards: [postcard],
    chainId: 8453,
    arena: ARENA,
    launchId: 77,
    agentId: 901,
    author: sender.address,
  });
  const paymentProof = {
    kind: "versus-signal-settlement",
    version: 1,
    batch,
    transactionHash: `0x${"4".repeat(64)}`,
    blockNumber: "123",
  };
  return { sender, receiver, registry, postcard, paymentProof };
}

test("a strict receiver admits only an exact Base-paid postcard", async (t) => {
  const { receiver, registry, postcard, paymentProof } = await fixture();
  let verified = 0;
  const node = new VersusNode({
    identity: receiver,
    eligibilityVerifier: registry,
    transport: new MemoryTransport(),
    economicVerifier: {
      async verifySignalSettlement(value) {
        verified += 1;
        assert.equal(value.batch.root, paymentProof.batch.root);
        return { verified: true };
      },
    },
  });
  t.after(() => node.close());

  await assert.rejects(() => node.accept(postcard), { code: "MISSING_PAYMENT_PROOF" });
  assert.equal(node.store.size, 0);
  const accepted = await node.accept(postcard, { paymentProof });
  assert.equal(accepted.accepted, true);
  assert.equal(verified, 1);
  assert.equal(node.store.size, 1);
  assert.equal(node.paymentProofs.get(postcard.id).batch.root, paymentProof.batch.root);
});

test("a Base-paid signal requires Cypher ownership but not a separate daily voice", async (t) => {
  const { receiver, postcard, paymentProof } = await fixture();
  const eligibilityChecks = [];
  const node = new VersusNode({
    identity: receiver,
    eligibilityVerifier: {
      async verify(identity) {
        eligibilityChecks.push(identity);
        return {
          ...identity,
          eligible: identity.voiceDay === null,
          reason: identity.voiceDay === null ? null : "daily_voice_not_earned",
        };
      },
    },
    transport: new MemoryTransport(),
    economicVerifier: { async verifySignalSettlement() { return { verified: true }; } },
  });
  t.after(() => node.close());

  const accepted = await node.accept(postcard, { paymentProof });
  assert.equal(accepted.accepted, true);
  assert.equal(eligibilityChecks.length, 1);
  assert.equal(eligibilityChecks[0].address, postcard.author);
  assert.equal(eligibilityChecks[0].cypherId, postcard.cypherId);
  assert.equal(eligibilityChecks[0].voiceDay, null);
});

test("a proof for another signed postcard cannot buy influence for this one", async (t) => {
  const { sender, receiver, registry, postcard, paymentProof } = await fixture();
  const createdAt = postcard.createdAt + 1;
  const other = await sender.signPostcard({
    type: "proposal",
    launchId: "77",
    sequence: 1,
    createdAt,
    expiresAt: createdAt + 3600,
    body: "build a different public signal",
  });
  const node = new VersusNode({
    identity: receiver,
    eligibilityVerifier: registry,
    transport: new MemoryTransport(),
    economicVerifier: { async verifySignalSettlement() { return { verified: true }; } },
  });
  t.after(() => node.close());
  await assert.rejects(() => node.accept(other, { paymentProof }), { code: "WRONG_PAYMENT_PROOF" });
  assert.equal(node.store.size, 0);
});

test("accepted payment proofs survive restart for authenticated history sync", async () => {
  const { postcard, paymentProof } = await fixture();
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "versus-payments-")), "proofs.ndjson");
  const first = new PaymentProofStore({ filePath });
  first.set(postcard.id, paymentProof);
  const restarted = new PaymentProofStore({ filePath });
  assert.equal(restarted.get(postcard.id).batch.root, paymentProof.batch.root);
});

test("a paid postcard can be durably staged before its first network send", async (t) => {
  const { sender, registry, postcard, paymentProof } = await fixture();
  const transport = new MemoryTransport();
  const node = new VersusNode({
    identity: sender,
    eligibilityVerifier: registry,
    transport,
    economicVerifier: { async verifySignalSettlement() { return { verified: true }; } },
  });
  t.after(() => node.close());

  await node.stagePaid(postcard, paymentProof);
  assert.equal(node.store.has(postcard.id), true);
  assert.equal(node.paymentProofs.get(postcard.id).batch.root, paymentProof.batch.root);
  assert.equal(transport.sent.length, 0);

  await node.publishPaid(postcard, paymentProof);
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].postcard.id, postcard.id);
});

test("prepared paid postcards reserve distinct local sequences before acceptance", async (t) => {
  const identity = CypherIdentity.createRandom(903);
  const node = new VersusNode({
    identity,
    eligibilityVerifier: new StaticCypherVerifier([
      { address: identity.address, cypherId: identity.cypherId },
    ]),
    transport: new MemoryTransport(),
  });
  t.after(() => node.close());
  const createdAt = Math.floor(Date.now() / 1000);

  const first = await node.prepare({
    type: "question",
    launchId: "77",
    body: "can another cypher hear this signal",
    createdAt,
  });
  const second = await node.prepare({
    type: "observation",
    launchId: "77",
    body: "another signal follows without equivocation",
    createdAt,
  });

  assert.equal(first.sequence, 0);
  assert.equal(second.sequence, 1);
  assert.notEqual(first.id, second.id);
});

test("restored signal queues can reserve their signed sequences", async (t) => {
  const identity = CypherIdentity.createRandom(904);
  const node = new VersusNode({
    identity,
    eligibilityVerifier: new StaticCypherVerifier([
      { address: identity.address, cypherId: identity.cypherId },
    ]),
    transport: new MemoryTransport(),
  });
  t.after(() => node.close());
  const createdAt = Math.floor(Date.now() / 1000);
  node.reserveLocalSequence(7);

  const postcard = await node.prepare({
    type: "question",
    launchId: "77",
    body: "restored queues keep sequence ownership",
    createdAt,
  });

  assert.equal(postcard.sequence, 8);
});
