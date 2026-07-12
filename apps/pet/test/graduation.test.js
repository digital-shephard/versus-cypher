const assert = require("node:assert/strict");
const test = require("node:test");
const { acknowledgeGraduation, recordGraduationTransition } = require("../src/graduation");

test("a confirmed class increment creates one durable graduation ceremony", () => {
  const state = { classId: 4, classPotMicros: 1_000_040_000, classAgents: 238 };
  const ceremony = recordGraduationTransition(state, {
    classId: 5,
    graduationFloorMicros: 1_000_000_000,
  }, 1234);
  assert.deepEqual(ceremony, {
    version: 1,
    classId: 4,
    nextClassId: 5,
    tokenOrdinal: 3,
    classPotMicros: 1_000_040_000,
    classAgents: 238,
    graduationFloorMicros: 1_000_000_000,
    detectedAt: 1234,
  });
  assert.equal(recordGraduationTransition(state, { classId: 5 }), ceremony);
});

test("time and same-class reconciliation never invent a graduation", () => {
  const state = { classId: 4, classPotMicros: 1_000_000_000 };
  assert.equal(recordGraduationTransition(state, { classId: 4 }, Date.now() + 86_400_000), null);
  assert.equal(state.pendingGraduation, undefined);
});

test("acknowledgement prevents the same class ceremony from replaying", () => {
  const state = { classId: 1, classPotMicros: 1_000_000_000 };
  recordGraduationTransition(state, { classId: 2, graduationFloorMicros: 1_000_000_000 });
  acknowledgeGraduation(state, 1);
  assert.equal(state.pendingGraduation, undefined);
  assert.equal(state.lastCelebratedClassId, 1);
  assert.equal(recordGraduationTransition(state, { classId: 2 }), null);
  assert.throws(() => acknowledgeGraduation(state, 2), /does not match/);
});
