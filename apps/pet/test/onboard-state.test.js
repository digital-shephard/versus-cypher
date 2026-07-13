const assert = require("node:assert/strict");
const test = require("node:test");
const { activateConfirmedHatch, isInterruptedHatch } = require("../src/onboard-state");

test("confirmed hatch identity is durable before the first daily penny", () => {
  const state = {
    phase: "minting",
    pendingReferralCode: "VRS-1-A",
    pendingReferrerAgentId: 7,
  };
  activateConfirmedHatch(state, {
    agentId: 42n,
    cypherId: 9n,
    runway: 7_693_951n,
    swapHash: `0x${"1".repeat(64)}`,
    hatchHash: `0x${"2".repeat(64)}`,
    blockNumber: 123,
    referrerAgentId: 7n,
  }, "0x0000000000000000000000000000000000000042", 1_000);

  assert.equal(state.phase, "active");
  assert.equal(state.agentId, 42);
  assert.equal(state.cypherId, 9);
  assert.equal(state.runway, 7_693_951);
  assert.equal(state.level, 0);
  assert.equal(state.tickets, 0);
  assert.equal(state.nextCommitAt, 1);
  assert.equal(state.referredBy, 7);
  assert.equal(state.pendingReferralCode, undefined);
  assert.equal(state.pendingReferrerAgentId, undefined);
});

test("only pre-identity chain phases qualify for hatch recovery", () => {
  assert.equal(isInterruptedHatch({ phase: "swapping" }), true);
  assert.equal(isInterruptedHatch({ phase: "minting" }), true);
  assert.equal(isInterruptedHatch({ phase: "minting", agentId: 1 }), false);
  assert.equal(isInterruptedHatch({ phase: "awaiting_deposit" }), false);
});
