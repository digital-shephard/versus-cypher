const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { RainInbox } = require("../src/rain-inbox");

function temporaryFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "versus-rain-")), "rain.json");
}

function batch(events, distributionWindowMs = 1_000) {
  return { distributionWindowMs, events };
}

test("verified pennies persist and drain exactly once across restart", () => {
  let now = 1_000;
  const filePath = temporaryFile();
  let inbox = new RainInbox({ filePath, now: () => now });
  const event = { eventId: "event-1", type: "rain", agentId: "7", classId: "1", classTotalMicros: "30000", transactionHash: `0x${"ab".repeat(32)}`, logIndex: 0, pennies: 3 };
  assert.deepEqual(inbox.acceptBatch(batch([event])), { acceptedEvents: 1, acceptedPennies: 3, pending: 3 });
  assert.equal(inbox.acceptBatch(batch([event])).acceptedPennies, 0);
  assert.equal(inbox.next().drop.classPotMicros, "10000");
  inbox = new RainInbox({ filePath, now: () => now });
  assert.equal(inbox.status().pending, 2);
  now += 500;
  assert.equal(inbox.next().drop.classPotMicros, "20000");
  now += 500;
  assert.equal(inbox.next().drop.classPotMicros, "30000");
  assert.equal(inbox.next().drop, null);
});

test("independent node attestations for one event do not duplicate drops", () => {
  const inbox = new RainInbox({ filePath: temporaryFile(), now: () => 5_000 });
  const event = { eventId: "shared-chain-event", type: "commit", agentId: "9", classId: "1", classTotalMicros: "10000", transactionHash: `0x${"cd".repeat(32)}`, logIndex: 2, pennies: 1 };
  assert.equal(inbox.acceptBatch(batch([event])).acceptedPennies, 1);
  assert.equal(inbox.acceptBatch(batch([event])).acceptedPennies, 0);
  assert.equal(inbox.status().pending, 1);
});

test("full Cypher archives preserve pending and seen rain", () => {
  const source = new RainInbox({ filePath: temporaryFile(), now: () => 5_000 });
  const event = { eventId: "archive-event", type: "signal", agentId: "4", classId: "1", classTotalMicros: "20000", transactionHash: `0x${"ef".repeat(32)}`, logIndex: 1, pennies: 2 };
  source.acceptBatch(batch([event]));
  source.next();
  const restored = new RainInbox({ filePath: temporaryFile(), now: () => 6_000 });
  assert.deepEqual(restored.importArchive(source.exportArchive()), { pending: 1, nextAt: 5_500, seen: 1 });
  assert.equal(restored.acceptBatch(batch([event])).acceptedPennies, 0);
});
