const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const WebSocket = require("ws");
const {
  readWindowsRunValue,
  windowsRunEntryAccepted,
} = require("../src/login-item");

const targetPath = process.argv[2];
const port = Number(process.argv[3] || 9327);
const settingsPath = path.join(process.env.APPDATA, "Versus Cypher", "settings.json");

if (process.platform !== "win32") throw new Error("This smoke test requires Windows");
if (!targetPath || !fs.existsSync(targetPath)) throw new Error("Expected the installed executable path");

async function waitForTarget() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const target = targets.find((candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl);
      if (target) return target;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Installed app did not expose its local test target");
}

function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 0;
  socket.on("message", (message) => {
    const payload = JSON.parse(message.toString());
    const request = pending.get(payload.id);
    if (!request) return;
    pending.delete(payload.id);
    if (payload.error) request.reject(new Error(payload.error.message));
    else request.resolve(payload.result);
  });
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("open", () => resolve({
      close: () => socket.close(),
      send(method, params = {}) {
        const id = ++nextId;
        return new Promise((requestResolve, requestReject) => {
          pending.set(id, { resolve: requestResolve, reject: requestReject });
          socket.send(JSON.stringify({ id, method, params }));
        });
      },
    }));
  });
}

async function setThroughUi(client, enabled) {
  const expression = `
    (async () => {
      const settings = document.querySelector("#btn-settings");
      if (settings?.getAttribute("aria-pressed") !== "true") settings?.click();
      document.querySelector("#settings-tab-device")?.click();
      const checkbox = document.querySelector("#setting-launch-login");
      if (!checkbox) throw new Error("Launch-on-login checkbox is missing");
      if (checkbox.checked !== ${JSON.stringify(enabled)}) checkbox.click();
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const status = document.querySelector("#settings-status")?.textContent?.trim();
        if (status === "SAVED" || status?.startsWith("Error:")) {
          return { checked: checkbox.checked, status };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return { checked: checkbox.checked, status: document.querySelector("#settings-status")?.textContent?.trim() };
    })()
  `;
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  return result.result.value;
}

async function waitForUiReady(client, expected) {
  const expression = `
    (async () => {
      const bootDeadline = Date.now() + 15000;
      while (Date.now() < bootDeadline && (document.readyState !== "complete" || !window.versus?.getSettings)) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      const settings = document.querySelector("#btn-settings");
      if (settings?.getAttribute("aria-pressed") !== "true") settings?.click();
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const checkbox = document.querySelector("#setting-launch-login");
        const status = document.querySelector("#settings-status")?.textContent?.trim();
        if (status === "LOCAL CONTROL" && checkbox?.checked === ${JSON.stringify(expected)}) return { ready: true };
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return {
        ready: false,
        documentReadyState: document.readyState,
        hasPreloadApi: Boolean(window.versus?.getSettings),
        settingsPressed: settings?.getAttribute("aria-pressed"),
        status: document.querySelector("#settings-status")?.textContent?.trim(),
        checked: document.querySelector("#setting-launch-login")?.checked,
        ipcSettings: await window.versus?.getSettings?.(),
      };
    })()
  `;
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  assert.equal(result.result.value?.ready, true, `Settings UI did not become ready: ${JSON.stringify(result.result.value)}`);
}

function verify(enabled, uiResult) {
  const stored = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const runValue = readWindowsRunValue("Versus Cypher");
  assert.equal(uiResult.checked, enabled);
  assert.equal(
    uiResult.status === "SAVED",
    true,
    `Unexpected settings status: ${JSON.stringify(uiResult)}`,
  );
  assert.equal(stored.launchAtLogin, enabled);
  assert.equal(windowsRunEntryAccepted(enabled, runValue, targetPath), true);
  return { enabled, uiResult, stored: stored.launchAtLogin, runValue };
}

(async () => {
  const child = spawn(targetPath, [`--remote-debugging-port=${port}`], {
    detached: false,
    stdio: "ignore",
    windowsHide: false,
  });
  let client;
  try {
    const target = await waitForTarget();
    client = await connect(target.webSocketDebuggerUrl);
    const initial = Boolean(JSON.parse(fs.readFileSync(settingsPath, "utf8")).launchAtLogin);
    await waitForUiReady(client, initial);
    assert.equal(windowsRunEntryAccepted(initial, readWindowsRunValue("Versus Cypher"), targetPath), true);
    const sequence = initial ? [false, true, false, true] : [true, false, true];
    const results = [];
    for (const enabled of sequence) {
      results.push(verify(enabled, await setThroughUi(client, enabled)));
    }
    process.stdout.write(`${JSON.stringify({ passed: true, targetPath, results }, null, 2)}\n`);
    await client.send("Browser.close").catch(() => {});
  } finally {
    client?.close();
    if (!child.killed) child.kill();
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
