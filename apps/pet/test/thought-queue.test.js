const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ThoughtQueue, normalizeThought } = require("../src/thought-queue");

test("thoughts survive restart until they have been fully shown", () => {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "versus-thoughts-")), "thoughts.json");
  const queue = new ThoughtQueue({ filePath, now: () => 1000 });
  const thought = queue.enqueue("the proposal feels useful but needs one clear test");
  queue.markShowing(thought.id);

  const restarted = new ThoughtQueue({ filePath, now: () => 2000 });
  assert.equal(restarted.next().id, thought.id);
  restarted.markSeen(thought.id);
  assert.equal(new ThoughtQueue({ filePath }).next(), null);
});

test("thought bubbles reject links wallet addresses and oversized prose", () => {
  assert.throws(() => normalizeThought("visit https://example.com"), /links/);
  assert.throws(() => normalizeThought(`send to 0x${"1".repeat(40)}`), /addresses/);
  assert.throws(() => normalizeThought("x".repeat(181)), RangeError);
});

test("single-slot notices replace stale unseen bubbles instead of stacking", () => {
  const queue = new ThoughtQueue({ now: (() => { let now = 0; return () => ++now; })() });
  queue.enqueue("the first referral drive is ready", { slotKey: "referral-drive" });
  const latest = queue.enqueue("a newer referral drive replaced it", { slotKey: "referral-drive" });
  assert.equal(queue.items.length, 1);
  assert.equal(queue.next().id, latest.id);
  assert.equal(queue.next().text, "a newer referral drive replaced it");
  assert.equal(queue.clearSlot("referral-drive"), 1);
  assert.equal(queue.next(), null);
});
