const assert = require("node:assert/strict");
const test = require("node:test");
const { availableReferralRewards, parseReferralCode, referralCodeFor } = require("../src/referrals");

test("referral codes round trip and reject malformed or mistyped values", () => {
  const code = referralCodeFor(1042);
  assert.equal(parseReferralCode(code), 1042n);
  assert.equal(parseReferralCode(code.toLowerCase()), 1042n);
  assert.throws(() => parseReferralCode("1042"), /invalid/);
  assert.throws(() => parseReferralCode(`${code.slice(0, -1)}Z`), /checksum/);
  assert.throws(() => referralCodeFor(0), /positive/);
});

test("available referral rewards count only complete fixed payouts", () => {
  assert.equal(availableReferralRewards(990_000, 1_000_000), 0n);
  assert.equal(availableReferralRewards(1_010_000, 1_000_000), 1n);
  assert.equal(availableReferralRewards(12_750_000, 1_000_000), 12n);
});
