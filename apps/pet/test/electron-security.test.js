const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const {
  createTrustedIpcRegistrar,
  hardenRendererWindow,
  isTrustedIpcEvent,
  sameTrustedDocument,
  trustedFileUrl,
} = require("../src/electron-security");

const TRUSTED_URL = trustedFileUrl(path.join(__dirname, "..", "renderer", "index.html"));

function trustedEvent(url = TRUSTED_URL) {
  const frame = { url };
  frame.top = frame;
  return { senderFrame: frame };
}

test("trusted renderer identity accepts only the top-level local document", () => {
  assert.equal(sameTrustedDocument(`${TRUSTED_URL}#settings`, TRUSTED_URL), true);
  assert.equal(sameTrustedDocument("https://example.com/", TRUSTED_URL), false);
  assert.equal(isTrustedIpcEvent(trustedEvent(), TRUSTED_URL), true);

  const child = { url: TRUSTED_URL, top: {} };
  assert.equal(isTrustedIpcEvent({ senderFrame: child }, TRUSTED_URL), false);
  assert.equal(isTrustedIpcEvent(trustedEvent("file:///tmp/index.html"), TRUSTED_URL), false);
});

test("trusted IPC registrar rejects foreign frames before invoking a handler", async () => {
  let registered;
  const ipcMain = { handle: (channel, handler) => { registered = { channel, handler }; } };
  const register = createTrustedIpcRegistrar(ipcMain, TRUSTED_URL);
  register("wallet:test", (_event, value) => value + 1);

  assert.equal(registered.channel, "wallet:test");
  assert.equal(await registered.handler(trustedEvent(), 4), 5);
  assert.throws(
    () => registered.handler(trustedEvent("https://example.com/"), 4),
    (error) => error.code === "UNTRUSTED_RENDERER"
  );
});

test("window hardening denies popups permissions webviews and foreign navigation", () => {
  const listeners = new Map();
  let openHandler;
  let permissionCheck;
  let permissionRequest;
  const window = {
    webContents: {
      setWindowOpenHandler: (handler) => { openHandler = handler; },
      on: (event, handler) => listeners.set(event, handler),
      session: {
        setPermissionCheckHandler: (handler) => { permissionCheck = handler; },
        setPermissionRequestHandler: (handler) => { permissionRequest = handler; },
      },
    },
  };
  hardenRendererWindow(window, TRUSTED_URL);

  assert.deepEqual(openHandler(), { action: "deny" });
  assert.equal(permissionCheck(), false);
  let permissionResult = null;
  permissionRequest(null, "camera", (allowed) => { permissionResult = allowed; });
  assert.equal(permissionResult, false);

  let prevented = false;
  listeners.get("will-navigate")({ preventDefault: () => { prevented = true; } }, "https://example.com/");
  assert.equal(prevented, true);
  prevented = false;
  listeners.get("will-navigate")({ preventDefault: () => { prevented = true; } }, TRUSTED_URL);
  assert.equal(prevented, false);
  listeners.get("will-attach-webview")({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
});
