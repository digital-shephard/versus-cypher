const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { DailyLifecycleScheduler, utcDay } = require("../src/daily-lifecycle");

const DAY = 86_400_000;

function harness(overrides = {}) {
  let now = 200 * DAY + 1234;
  let state = {
    phase: "active",
    agentId: 7,
    runway: 70_000,
    lastCommitDay: 199,
    ...overrides.state,
  };
  let rainCalls = 0;
  let reconcileCalls = 0;
  let thinkCalls = 0;
  const scheduler = new DailyLifecycleScheduler({
    loadState: () => structuredClone(state),
    saveState: (next) => { state = structuredClone(next); },
    reconcile: async () => {
      reconcileCalls += 1;
      if (overrides.reconcile) return overrides.reconcile({ state, setState: (next) => { state = next; } });
      return structuredClone(state);
    },
    rain: async ({ day }) => {
      rainCalls += 1;
      if (overrides.rain) return overrides.rain({ day, state, setState: (next) => { state = next; } });
      state.lastCommitDay = day;
      state.runway -= 10_000;
      return { state: structuredClone(state), hash: "0xrain" };
    },
    think: overrides.think === null ? null : async () => {
      thinkCalls += 1;
      return overrides.think ? overrides.think() : { status: "idle" };
    },
    shouldThink: () => overrides.shouldThink !== false,
    now: () => now,
    checkIntervalMs: 1000,
    retryBaseMs: 100,
    retryMaxMs: 1000,
  });
  return {
    scheduler,
    state: () => structuredClone(state),
    calls: () => ({ rainCalls, reconcileCalls, thinkCalls }),
    advance: (ms) => { now += ms; },
  };
}

describe("independent daily lifecycle", () => {
  it("reconciles rains and thinks once for an otherwise solitary Cypher", async () => {
    const h = harness();
    assert.equal((await h.scheduler.wake("startup")).status, "complete");
    assert.deepEqual(h.calls(), { rainCalls: 1, reconcileCalls: 1, thinkCalls: 1 });
    assert.equal(h.state().dailyLifecycle.rainStatus, "confirmed");
    assert.equal(h.state().dailyLifecycle.thoughtDay, utcDay(200 * DAY + 1234));

    assert.equal((await h.scheduler.wake("timer")).status, "complete");
    assert.deepEqual(h.calls(), { rainCalls: 1, reconcileCalls: 2, thinkCalls: 1 });
  });

  it("rains with the brain disabled and never calls inference", async () => {
    const h = harness({ shouldThink: false });
    const result = await h.scheduler.wake("startup");
    assert.equal(result.thoughtStatus, "disabled");
    assert.deepEqual(h.calls(), { rainCalls: 1, reconcileCalls: 1, thinkCalls: 0 });
  });

  it("uses reconciliation to avoid a duplicate transaction after restart", async () => {
    const day = 200;
    const h = harness({
      reconcile: ({ state }) => ({ ...state, lastCommitDay: day, runway: 60_000 }),
    });
    await h.scheduler.wake("startup");
    assert.deepEqual(h.calls(), { rainCalls: 0, reconcileCalls: 1, thinkCalls: 1 });
  });

  it("persists exponential retry state and succeeds after a temporary failure", async () => {
    let failures = 1;
    const h = harness({
      reconcile: ({ state }) => {
        if (failures-- > 0) throw new Error("rpc unavailable");
        return structuredClone(state);
      },
    });
    const failed = await h.scheduler.wake("startup");
    assert.equal(failed.status, "error");
    assert.equal(failed.error.code, "TEMPORARY_FAILURE");
    assert.equal((await h.scheduler.wake("timer")).status, "deferred");
    h.advance(100);
    assert.equal((await h.scheduler.wake("timer")).status, "complete");
    assert.deepEqual(h.calls(), { rainCalls: 1, reconcileCalls: 2, thinkCalls: 1 });
  });

  it("coalesces concurrent startup and resume wakes", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const h = harness({
      reconcile: async ({ state }) => {
        await gate;
        return structuredClone(state);
      },
    });
    const startup = h.scheduler.wake("startup");
    const resume = h.scheduler.wake("resume");
    assert.equal(startup, resume);
    release();
    await startup;
    assert.deepEqual(h.calls(), { rainCalls: 1, reconcileCalls: 1, thinkCalls: 1 });
  });
});
