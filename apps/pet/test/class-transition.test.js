const assert = require("node:assert/strict");
const test = require("node:test");
const { WRONG_CLASS_SELECTOR, classOverError, isWrongClassError } = require("../src/class-transition");

test("recognizes WrongClass across ethers and nested RPC error shapes", () => {
  assert.equal(isWrongClassError({ revert: { name: "WrongClass" } }), true);
  assert.equal(isWrongClassError({ errorName: "WrongClass" }), true);
  assert.equal(isWrongClassError({ info: { error: { data: `${WRONG_CLASS_SELECTOR}00` } } }), true);
  assert.equal(isWrongClassError(new Error("unrelated failure")), false);
});

test("class-over errors retain stale and newly open class IDs", () => {
  const cause = new Error("transaction reverted");
  const error = classOverError(8, 9, cause);
  assert.equal(error.code, "CLASS_OVER");
  assert.equal(error.classId, "8");
  assert.equal(error.currentClassId, "9");
  assert.match(error.message, /class 8 is over; class 9 is now open/);
  assert.equal(error.cause, cause);
});
