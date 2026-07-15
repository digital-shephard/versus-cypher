const assert = require("node:assert/strict");
const test = require("node:test");

const {
  launchAtLoginAccepted,
  parseWindowsRunValue,
  readWindowsRunValue,
  windowsCommandExecutable,
  windowsRunEntryAccepted,
} = require("../src/login-item");

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

test("Windows reads the executable from the named Run entry", () => {
  const output = [
    "",
    "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
    "    Versus Cypher    REG_SZ    \"C:\\Users\\Test\\Versus Cypher.exe\"",
    "",
  ].join("\r\n");
  assert.equal(parseWindowsRunValue(output), '"C:\\Users\\Test\\Versus Cypher.exe"');
  assert.equal(windowsCommandExecutable(parseWindowsRunValue(output)), "C:\\Users\\Test\\Versus Cypher.exe");
});

test("Windows registry verification accepts the installed executable despite broken Electron readback", () => {
  const executable = "C:\\Users\\Test\\Programs\\Versus Cypher\\Versus Cypher.exe";
  assert.equal(windowsRunEntryAccepted(true, `"${executable}"`, executable), true);
  assert.equal(windowsRunEntryAccepted(false, null, executable), true);
  assert.equal(windowsRunEntryAccepted(true, '"C:\\Other\\Versus Cypher.exe"', executable), false);
  assert.equal(windowsRunEntryAccepted(false, `"${executable}"`, executable), false);
});

test("Windows registry lookup treats a missing named value as disabled", () => {
  const missing = Object.assign(new Error("missing"), { status: 1 });
  assert.equal(readWindowsRunValue("Versus Cypher", () => { throw missing; }), null);
});
