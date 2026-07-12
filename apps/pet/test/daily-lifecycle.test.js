const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  DailyLifecycleScheduler,
  nextCadenceStreak,
  nextCommitAtFor,
  utcDay,
} = require("../src/daily-lifecycle");

const DAY = 86_400_000;

function harness(overrides = {}) {
  let now = overrides.now ?? 200 * DAY + 1234;
  let state = {
    phase: "active",
    agentId: 7,
    runway: 70_000,
    lastCommitDay: 199,
    nextCommitAt: Math.floor(now / 1000) - 1,
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
      if (overrides.rain) {
        return overrides.rain({
          day,
          state,
          setState: (next) => { state = next; },
          advance: (ms) => { now += ms; },
        });
      }
      state.lastCommitDay = day;
      state.nextCommitAt = Math.floor(now / 1000) + 86_400;
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
    setTimeoutImpl: overrides.setTimeoutImpl,
    clearTimeoutImpl: overrides.clearTimeoutImpl,
  });
  return {
    scheduler,
    state: () => structuredClone(state),
    calls: () => ({ rainCalls, reconcileCalls, thinkCalls }),
    advance: (ms) => { now += ms; },
  };
}

describe("independent daily lifecycle", () => {
  it("matches the contract streak rule for rolling cadence windows", () => {
    assert.equal(nextCadenceStreak(100_000, 8, 100_001), 9);
    assert.equal(nextCadenceStreak(100_000, 8, 186_399), 9);
    assert.equal(nextCadenceStreak(100_000, 8, 186_400), 1);
  });

  it("migrates an existing local bond from its last confirmed rain timestamp", () => {
    assert.equal(nextCommitAtFor({ lastRainAt: 1_000_000 }), 87_400);
    assert.equal(nextCommitAtFor({ lastCommitDay: 199 }), 200 * 86_400);
  });

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
      reconcile: ({ state }) => ({
        ...state,
        lastCommitDay: day,
        nextCommitAt: state.nextCommitAt + 86_401,
        runway: 60_000,
      }),
    });
    await h.scheduler.wake("startup");
    assert.deepEqual(h.calls(), { rainCalls: 0, reconcileCalls: 1, thinkCalls: 1 });
  });

  it("waits past UTC midnight until this Cypher's own 24-hour due time", async () => {
    let scheduledDelay = null;
    const h = harness({
      state: {
        lastCommitDay: 199,
        nextCommitAt: Math.floor((200 * DAY + 1234) / 1000) + 3600,
      },
      setTimeoutImpl: (_callback, delay) => {
        scheduledDelay = delay;
        return { unref() {} };
      },
      clearTimeoutImpl: () => {},
    });
    const result = await h.scheduler.wake("startup");
    assert.equal(result.status, "waiting");
    assert.deepEqual(h.calls(), { rainCalls: 0, reconcileCalls: 1, thinkCalls: 0 });
    assert.ok(scheduledDelay >= 3_599_000 && scheduledDelay <= 3_600_000);
  });

  it("uses the confirmed receipt day when a due transaction crosses UTC midnight", async () => {
    const start = 201 * DAY - 500;
    const h = harness({
      now: start,
      state: { lastCommitDay: 199, nextCommitAt: Math.floor(start / 1000) - 1 },
      rain: ({ state, setState, advance }) => {
        advance(1000);
        setState({
          ...state,
          lastCommitDay: 201,
          nextCommitAt: Math.floor((start + 1000) / 1000) + 86_400,
        });
        return { state: h.state(), hash: "0xmidnight" };
      },
    });
    const result = await h.scheduler.wake("due");
    assert.equal(result.status, "complete");
    assert.equal(result.day, 201);
    assert.deepEqual(h.calls(), { rainCalls: 1, reconcileCalls: 1, thinkCalls: 1 });
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
