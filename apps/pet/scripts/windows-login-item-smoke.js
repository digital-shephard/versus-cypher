const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { app } = require("electron");
const {
  readWindowsRunValue,
  windowsRunEntryAccepted,
} = require("../src/login-item");

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const NAME = "Versus Cypher";
const targetPath = process.argv[2];

if (process.platform !== "win32") throw new Error("This smoke test requires Windows");
if (!targetPath) throw new Error("Expected the packaged executable path");

function setEnabled(enabled) {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: false,
    enabled,
    name: NAME,
    path: targetPath,
    args: [],
  });
}

function restore(value) {
  if (value == null) {
    setEnabled(false);
    return;
  }
  execFileSync("reg.exe", [
    "add",
    RUN_KEY,
    "/v",
    NAME,
    "/t",
    "REG_SZ",
    "/d",
    value,
    "/f",
  ], { windowsHide: true, stdio: "ignore" });
}

app.whenReady().then(() => {
  const originalValue = readWindowsRunValue(NAME);
  try {
    setEnabled(true);
    const enabledValue = readWindowsRunValue(NAME);
    assert.equal(windowsRunEntryAccepted(true, enabledValue, targetPath), true);

    setEnabled(false);
    const disabledValue = readWindowsRunValue(NAME);
    assert.equal(windowsRunEntryAccepted(false, disabledValue, targetPath), true);

    process.stdout.write(`${JSON.stringify({
      targetPath,
      enabledValue,
      disabledValue,
      electronReadback: app.getLoginItemSettings({ path: targetPath, args: [] }),
      passed: true,
    }, null, 2)}\n`);
  } finally {
    restore(originalValue);
    app.quit();
  }
});
