const assert = require("node:assert/strict");
const test = require("node:test");
const { HealthMonitor, classifyFailure } = require("../src/health");

test("failure classification maps raw failures to bounded owner-safe states", () => {
  assert.equal(classifyFailure(Object.assign(new Error("fetch failed"), { code: "NETWORK_ERROR" }), { channel: "base" }), "rpc_unavailable");
  assert.equal(classifyFailure(new Error("invalid decision envelope"), { channel: "brain" }), "brain_malformed");
  assert.equal(classifyFailure(Object.assign(new Error("empty"), { code: "EMPTY_RUNWAY" })), "runway_depleted");
  assert.equal(classifyFailure(new Error("database disk image is malformed")), "database_damaged");
  assert.equal(classifyFailure(Object.assign(new Error("offline"), { code: "WAKU_UNAVAILABLE" })), "waku_unavailable");
  assert.equal(classifyFailure(Object.assign(new Error("history"), { code: "WAKU_STORE_UNAVAILABLE" })), "store_history_unavailable");
  assert.equal(classifyFailure(Object.assign(new Error("gas"), { code: "INSUFFICIENT_GAS" })), "insufficient_gas");
  assert.equal(classifyFailure(Object.assign(new Error("brain"), { code: "BRAIN_UNAVAILABLE" })), "brain_unavailable");
  assert.equal(classifyFailure(Object.assign(new Error("pending"), { code: "TRANSACTION_UNCERTAIN" })), "transaction_uncertain");
  assert.equal(classifyFailure(Object.assign(new Error("update"), { code: "UPDATE_UNAVAILABLE" })), "update_unavailable");
});

test("health monitor exposes fixed recovery copy and never raw errors", () => {
  let now = 100;
  const monitor = new HealthMonitor({ now: () => now });
  monitor.report(new Error("GET https://secret.invalid/?api_key=hunter2 failed"), { channel: "base", operation: "state sync" });
  now = 200;
  monitor.report(new Error("Bearer sk-owner-secret"), { channel: "base", operation: "state sync" });
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.status, "attention");
  assert.equal(snapshot.issues[0].code, "rpc_unavailable");
  assert.equal(snapshot.issues[0].occurrences, 2);
  assert.equal(snapshot.issues[0].firstSeenAt, 100);
  assert.equal(JSON.stringify(snapshot).includes("hunter2"), false);
  assert.equal(JSON.stringify(snapshot).includes("sk-owner"), false);
  assert.equal(monitor.resolveSubsystem("base"), true);
  assert.equal(monitor.snapshot().status, "healthy");
});
