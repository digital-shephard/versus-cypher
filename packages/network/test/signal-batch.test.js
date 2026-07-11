const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  CypherIdentity,
  PostcardStore,
  SignalSettlementQueue,
  StaticCypherVerifier,
  VersusNode,
  buildSignalBatch,
  normalizeSignalBatch,
} = require("../src");

const ARENA = "0x1111111111111111111111111111111111111111";

class MemoryTransport extends EventEmitter {
  constructor() {
    super();
    this.connectionless = true;
    this.handlesPropagation = true;
  }
  async broadcast() {}
  async close() {}
  get peerCount() { return 0; }
  peerList() { return []; }
}

async function signed(identity, type, sequence, body, launchId = "77") {
  const createdAt = 2_000_000_000 + sequence;
  return identity.signPostcard({
    type,
    launchId,
    sequence,
    createdAt,
    expiresAt: createdAt + 3600,
    body,
  });
}

test("durable postcards form a deterministic fixed-price signal batch", async () => {
  const identity = CypherIdentity.createRandom(701);
  const postcards = [
    await signed(identity, "proposal", 0, "build a public garden ritual"),
    await signed(identity, "prediction", 1, "ten humans will solve the first clue"),
    await signed(identity, "mission", 2, "publish one public clue each day"),
  ];
  const batch = buildSignalBatch({
    postcards: [postcards[2], postcards[0], postcards[1]],
    chainId: 8453,
    arena: ARENA,
    launchId: 77,
    agentId: 701,
    author: identity.address,
  });

  assert.equal(batch.signalCount, 3);
  assert.equal(batch.inkPennies, 9);
  assert.equal(batch.amountMicros, "90000");
  assert.deepEqual(batch.signals.map((signal) => signal.id), postcards.map((postcard) => postcard.id));
  assert.match(batch.root, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(normalizeSignalBatch(batch), batch);
  assert.throws(() => normalizeSignalBatch({ ...batch, amountMicros: "10000" }));
});

test("signal queue reserves batches across restarts and confirms only the submitted receipt", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "versus-signal-queue-"));
  const filePath = path.join(root, "signals.json");
  const identity = CypherIdentity.createRandom(711);
  const store = new PostcardStore();
  store.add(await signed(identity, "proposal", 0, "build a public radio ritual"));
  store.add(await signed(identity, "endorsement", 1, "endorse the public radio ritual"));
  store.add(await signed(identity, "receipt", 2, "this protocol receipt is not paid ink"));
  const options = {
    store,
    chainId: 8453,
    arena: ARENA,
    agentId: 711,
    author: identity.address,
    filePath,
  };
  const queue = new SignalSettlementQueue(options);
  const record = queue.prepare("77");
  assert.equal(record.batch.signalCount, 2);
  assert.equal(queue.pending("77").length, 0);

  const restarted = new SignalSettlementQueue(options);
  assert.equal(restarted.pending("77").length, 0);
  const transactionHash = `0x${"2".repeat(64)}`;
  restarted.markSubmitted(record.batch.root, transactionHash);
  assert.throws(() =>
    restarted.confirm(record.batch.root, {
      transactionHash: `0x${"3".repeat(64)}`,
      blockNumber: 100,
    })
  );
  restarted.confirm(record.batch.root, { transactionHash, blockNumber: 100 });
  let confirmed = new SignalSettlementQueue(options).list()[0];
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.blockNumber, "100");
  assert.equal(confirmed.transactionHash, transactionHash);
  assert.equal(new SignalSettlementQueue(options).unpublishedConfirmed().length, 1);
  restarted.markPublished(record.batch.root, record.postcards[0].id);
  confirmed = new SignalSettlementQueue(options).list()[0];
  assert.equal(confirmed.publishedIds.length, 1);
  assert.equal(new SignalSettlementQueue(options).unpublishedConfirmed().length, 1);
  restarted.markPublished(record.batch.root, record.postcards[1].id);
  assert.equal(new SignalSettlementQueue(options).unpublishedConfirmed().length, 0);
});

test("failed signal batches release their postcards for a replacement transaction", async () => {
  const identity = CypherIdentity.createRandom(721);
  const store = new PostcardStore();
  store.add(await signed(identity, "proposal", 0, "build a public lighthouse ritual"));
  const queue = new SignalSettlementQueue({
    store,
    chainId: 8453,
    arena: ARENA,
    agentId: 721,
    author: identity.address,
  });
  const first = queue.prepare("77");
  queue.fail(first.batch.root, "transaction reverted");
  assert.equal(queue.pending("77").length, 1);
  const replacement = queue.prepare("77");
  assert.equal(replacement.batch.root, first.batch.root);
  assert.equal(replacement.status, "prepared");
});

test("signal batches reject mixed authors launches and protocol receipts", async () => {
  const first = CypherIdentity.createRandom(731);
  const second = CypherIdentity.createRandom(732);
  const proposal = await signed(first, "proposal", 0, "build the first public ritual");
  const wrongAuthor = await signed(second, "proposal", 0, "build the second public ritual");
  const wrongLaunch = await signed(first, "proposal", 1, "build the third public ritual", "78");
  const receipt = await signed(first, "receipt", 2, "protocol receipts stay outside settlement");
  const common = {
    chainId: 8453,
    arena: ARENA,
    launchId: 77,
    agentId: 731,
    author: first.address,
  };
  assert.throws(() => buildSignalBatch({ ...common, postcards: [proposal, wrongAuthor] }));
  assert.throws(() => buildSignalBatch({ ...common, postcards: [proposal, wrongLaunch] }));
  assert.throws(() => buildSignalBatch({ ...common, postcards: [receipt] }));
});

test("a confirmed batch becomes a hash bound settlement observation", async (t) => {
  const identity = CypherIdentity.createRandom(741);
  const registry = new StaticCypherVerifier([{ address: identity.address, cypherId: 741 }]);
  const node = new VersusNode({
    identity,
    eligibilityVerifier: registry,
    transport: new MemoryTransport(),
  });
  t.after(async () => node.close());
  await node.publish({
    type: "proposal",
    launchId: "77",
    body: "build a public archive ritual",
  });
  const queue = new SignalSettlementQueue({
    store: node.store,
    chainId: 8453,
    arena: ARENA,
    agentId: 741,
    author: identity.address,
  });
  const prepared = queue.prepare("77");
  const transactionHash = `0x${"5".repeat(64)}`;
  queue.markSubmitted(prepared.batch.root, transactionHash);
  const confirmed = queue.confirm(prepared.batch.root, { transactionHash, blockNumber: 456 });
  const announcement = await node.publishSignalSettlement(confirmed);
  const settlement = node.artifactStore.get(announcement.artifact);

  assert.equal(announcement.type, "receipt");
  assert.equal(settlement.batch.root, prepared.batch.root);
  assert.equal(settlement.transactionHash, transactionHash);
  assert.equal(settlement.blockNumber, "456");
  assert.deepEqual(settlement.batch.signals.map((signal) => signal.id), [prepared.batch.signals[0].id]);
});
