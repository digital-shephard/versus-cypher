const test = require("node:test");
const assert = require("node:assert/strict");
const { ServiceActivityBus } = require("../src/activity-bus");

test("service activity exposes only a bounded public schema", () => {
  const bus = new ServiceActivityBus({ limit: 16, now: () => 1234 });
  const event = bus.record({
    channel: "base",
    direction: "out",
    operation: "eth_call ownerOf",
    destination: "public base rpc",
    status: "pending",
    privateKey: "0xsecret",
    authorization: "Bearer secret",
    payload: { password: "secret" },
  });

  assert.deepEqual(Object.keys(event), [
    "id", "at", "channel", "direction", "operation", "destination", "status", "durationMs", "bytes",
  ]);
  assert.equal(event.operation, "eth_call_ownerof");
  assert.equal(event.destination, "public_base_rpc");
  assert.equal(JSON.stringify(event).includes("secret"), false);
});

test("service activity spans record pending and terminal timing", () => {
  let now = 100;
  const bus = new ServiceActivityBus({ limit: 16, now: () => now });
  const finish = bus.begin({ channel: "waku", operation: "peer_search", destination: "versus_mesh" });
  now = 284;
  finish("wait");
  finish("ok");

  const events = bus.snapshot();
  assert.equal(events.length, 2);
  assert.equal(events[0].status, "pending");
  assert.equal(events[1].status, "wait");
  assert.equal(events[1].durationMs, 184);
});

test("service activity keeps only the configured recent window", () => {
  const bus = new ServiceActivityBus({ limit: 16 });
  for (let index = 0; index < 20; index += 1) {
    bus.record({ channel: "local", operation: `event_${index}` });
  }
  assert.equal(bus.snapshot().length, 16);
  assert.equal(bus.snapshot()[0].operation, "event_4");
});

test("service activity rejects credential shaped labels before renderer exposure", () => {
  const bus = new ServiceActivityBus({ limit: 16 });
  const privateKey = bus.record({ operation: `0x${"a".repeat(64)}`, destination: "base" });
  const apiKey = bus.record({ operation: "request", destination: "Bearer sk-owner-secret" });
  const url = bus.record({ operation: "request", destination: "https://user:password@example.com/private?key=secret" });

  assert.equal(privateKey.operation, "redacted");
  assert.equal(apiKey.destination, "redacted");
  assert.equal(url.destination, "redacted");
});
