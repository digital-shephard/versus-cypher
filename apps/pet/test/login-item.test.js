const assert = require("node:assert/strict");
const test = require("node:test");

const { launchAtLoginAccepted } = require("../src/login-item");

test("Windows accepts an enabled Run entry without StartupApproved metadata", () => {
  assert.equal(launchAtLoginAccepted("win32", true, {
    openAtLogin: true,
    executableWillLaunchAtLogin: true,
    launchItems: [{ enabled: false }],
  }), true);
});

test("Windows rejects a disabled or missing launch entry when enabling", () => {
  assert.equal(launchAtLoginAccepted("win32", true, {
    openAtLogin: true,
    executableWillLaunchAtLogin: false,
  }), false);
  assert.equal(launchAtLoginAccepted("win32", true, {
    openAtLogin: false,
    executableWillLaunchAtLogin: false,
  }), false);
});

test("Windows disable only requires the matching Run entry to be absent", () => {
  assert.equal(launchAtLoginAccepted("win32", false, {
    openAtLogin: false,
    executableWillLaunchAtLogin: true,
  }), true);
});

test("macOS follows the registered login item state", () => {
  assert.equal(launchAtLoginAccepted("darwin", true, { openAtLogin: true }), true);
  assert.equal(launchAtLoginAccepted("darwin", false, { openAtLogin: false }), true);
});
