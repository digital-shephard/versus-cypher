const assert = require("node:assert/strict");
const test = require("node:test");
const {
  BASE_PUBLIC_RPCS,
  rpcUrlsFromEnv,
  runwaySafeTargetMicros,
  splitDepositWei,
} = require("../src/base-rpc");

test("deposit split keeps thirty percent ETH and assigns seventy percent to runway", () => {
  const plan = splitDepositWei(10_000_000_000_000_000n);
  assert.equal(plan.swapWei, 7_000_000_000_000_000n);
  assert.equal(plan.gasReserveWei, 3_000_000_000_000_000n);
  assert.equal(plan.swapWei + plan.gasReserveWei, plan.depositWei);
});

test("hatch target keeps the slippage-adjusted runway above the contract floor", () => {
  const target = runwaySafeTargetMicros(10_000_000n, { requiredRunwayMicros: 7_000_000n });
  const quotedRunway = (target * 7_000n) / 10_000n;
  const minimumRunway = (quotedRunway * 9_900n) / 10_000n;
  assert.equal(target, 10_101_012n);
  assert.ok(minimumRunway >= 7_000_000n);
});

test("Base RPC pool needs no signup and accepts an explicit operator override", () => {
  assert.deepEqual(rpcUrlsFromEnv({}), [...BASE_PUBLIC_RPCS]);
  assert.deepEqual(rpcUrlsFromEnv({ VERSUS_RPC_URLS: "https://one.test, https://two.test" }), [
    "https://one.test",
    "https://two.test",
  ]);
  assert.deepEqual(rpcUrlsFromEnv({ VERSUS_RPC_URL: "https://private.test" }), [
    "https://private.test",
  ]);
});
