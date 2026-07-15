const assert = require("node:assert/strict");
const test = require("node:test");

const { launchAtLoginAccepted } = require("../src/login-item");

test("Windows accepts an enabled Run entry without StartupApproved metadata", () => {
  assert.equal(launchAtLoginAccepted(true, {
    openAtLogin: true,
    executableWillLaunchAtLogin: false,
    launchItems: [{ enabled: false }],
  }), true);
});

test("Windows rejects a missing matching Run entry when enabling", () => {
  assert.equal(launchAtLoginAccepted(true, {
    openAtLogin: false,
    executableWillLaunchAtLogin: false,
  }), false);
});

test("Windows disable requires the matching Run entry to be absent", () => {
  assert.equal(launchAtLoginAccepted(false, {
    openAtLogin: false,
    executableWillLaunchAtLogin: true,
  }), true);
});

test("macOS follows the registered login item state", () => {
  assert.equal(launchAtLoginAccepted(true, { openAtLogin: true }), true);
  assert.equal(launchAtLoginAccepted(false, { openAtLogin: false }), true);
});
