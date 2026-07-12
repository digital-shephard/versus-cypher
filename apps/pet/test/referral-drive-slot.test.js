const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ReferralDriveSlot, referralDriveThought } = require("../src/referral-drive-slot");

const id = (digit) => `0x${digit.repeat(64)}`;
const drive = (proposalId, createdAt, body, fundingGoalMicros) => ({
  id: proposalId,
  status: "ready",
  createdAt,
  body,
  fundingGoalMicros,
  supporters: [{}, {}],
  detractors: [],
});

test("the referral drive slot stores only the latest approved proposal", () => {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "versus-drive-")), "drive.json");
  const slot = new ReferralDriveSlot({ filePath, now: () => 5000 });
  const first = slot.sync(drive(id("1"), 100, "first invite push", "10000000"), {
    referralCode: "VRS-7-DC",
    launchId: "4",
  });
  assert.equal(first.changed, true);
  assert.equal(first.current.proposalId, id("1"));

  const second = slot.sync(drive(id("2"), 200, "replacement invite push", "25000000"), {
    referralCode: "VRS-7-DC",
    launchId: "4",
  });
  assert.equal(second.changed, true);
  assert.equal(second.current.proposalId, id("2"));
  assert.equal(new ReferralDriveSlot({ filePath }).current().proposalId, id("2"));
  assert.equal(fs.readFileSync(filePath, "utf8").includes(id("1")), false);
});

test("the owner bubble is deterministic and contains the local referral code", () => {
  const text = referralDriveThought({
    body: "bring new builders into the signal garden",
    fundingGoalMicros: "25000000",
    referralCode: "VRS-7-DC",
  });
  assert.match(text, /Target \$25/);
  assert.match(text, /VRS-7-DC/);
  assert.ok(text.length <= 180);
});

test("temporary same-launch gaps retain the drive while a launch rollover clears it", () => {
  const slot = new ReferralDriveSlot({ now: () => 5000 });
  slot.sync(drive(id("3"), 300, "sticky approved drive", "5000000"), {
    referralCode: "VRS-7-DC",
    launchId: "4",
  });
  assert.equal(slot.sync(null, { referralCode: "VRS-7-DC", launchId: "4" }).current.proposalId, id("3"));
  const rollover = slot.sync(null, { referralCode: "VRS-7-DC", launchId: "5" });
  assert.equal(rollover.changed, true);
  assert.equal(rollover.current, null);
});
