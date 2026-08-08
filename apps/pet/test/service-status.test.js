const assert = require("node:assert/strict");
const test = require("node:test");

const {
  combinedWakuState,
  fxWakuStates,
} = require("../src/service-status");

test("FX Waku keeps the service monitor live when the Cypher mesh is disabled", () => {
  const fxStatus = {
    broker: { transport: { state: "caught_up" } },
    requester: { transport: { state: "ready" } },
    relayer: { transport: { state: "ready" } },
    dealer: { transport: { state: "offline" } },
  };
  assert.deepEqual(fxWakuStates(fxStatus), [
    "caught_up",
    "ready",
    "ready",
    "offline",
  ]);
  assert.equal(combinedWakuState("off", fxStatus), "caught_up");
});

test("combined Waku status reports offline only when no lane is live", () => {
  assert.equal(
    combinedWakuState("offline", {
      requester: { transport: { state: "reconnecting" } },
    }),
    "reconnecting"
  );
  assert.equal(
    combinedWakuState("offline", {
      requester: { transport: { state: "offline" } },
    }),
    "offline"
  );
});
