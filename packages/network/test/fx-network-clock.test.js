const assert = require("node:assert/strict");
const test = require("node:test");
const {
  calibrateFxNetworkClock,
  createFxNetworkNow,
} = require("../src");

function clockFetch(timestamps) {
  let index = 0;
  return async () => ({
    ok: true,
    async json() {
      return {
        result: { timestamp: `0x${timestamps[index++].toString(16)}` },
      };
    },
  });
}

test("FX network clock uses two agreeing EVM observations", async () => {
  const clock = await calibrateFxNetworkClock({
    rpcUrls: ["https://rpc-a.invalid", "https://rpc-b.invalid"],
    localNowMs: 1_799_999_000_000,
    fetchImpl: clockFetch([1_800_000_005, 1_800_000_007]),
  });
  assert.equal(clock.timestamp, 1_800_000_007);
  assert.equal(clock.offsetSeconds, 1_007);
  assert.equal(clock.sources.length, 2);
  const now = createFxNetworkNow(clock, {
    localNowMs: () => 1_799_999_010_000,
  });
  assert.equal(now(), 1_800_000_017);
});

test("FX network clock fails closed without two sources", async () => {
  await assert.rejects(
    () => calibrateFxNetworkClock({
      rpcUrls: ["https://rpc-a.invalid"],
      fetchImpl: clockFetch([1_800_000_000]),
    }),
    /at least two/
  );
});

test("FX network clock fails closed when sources disagree", async () => {
  await assert.rejects(
    () => calibrateFxNetworkClock({
      rpcUrls: ["https://rpc-a.invalid", "https://rpc-b.invalid"],
      localNowMs: 1_800_000_000_000,
      fetchImpl: clockFetch([1_800_000_000, 1_800_000_031]),
    }),
    /disagree/
  );
});
