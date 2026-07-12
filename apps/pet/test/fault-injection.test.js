const assert = require("node:assert/strict");
const test = require("node:test");
const { FAULTS, FaultInjector, parseFaults } = require("../src/fault-injection");
const { HealthMonitor } = require("../src/health");

test("fault injection accepts only named release scenarios", () => {
  assert.deepEqual([...parseFaults("rpc, brain_malformed,private_key, waku")], ["rpc", "brain_malformed", "waku"]);
  const faults = new FaultInjector("rpc,update");
  assert.equal(faults.enabled("rpc"), true);
  assert.equal(faults.throwIf("brain"), false);
  assert.throws(() => faults.throwIf("rpc"), (error) => error.code === "RPC_UNAVAILABLE");
});

test("every release failure fixture becomes a bounded health issue", () => {
  const faults = new FaultInjector(Object.keys(FAULTS).join(","));
  const monitor = new HealthMonitor();
  for (const name of Object.keys(FAULTS)) {
    try {
      faults.throwIf(name);
    } catch (error) {
      const issue = monitor.report(error, { operation: `fixture_${name}` });
      assert.ok(issue, `${name} should produce a health issue`);
    }
  }
  assert.deepEqual(new Set(monitor.snapshot().issues.map((issue) => issue.code)), new Set([
    "rpc_unavailable",
    "waku_unavailable",
    "store_history_unavailable",
    "insufficient_gas",
    "runway_depleted",
    "brain_unavailable",
    "brain_malformed",
    "transaction_uncertain",
    "database_damaged",
    "update_unavailable",
  ]));
});
