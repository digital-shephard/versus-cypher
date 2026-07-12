const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { cleanError, createUpdateService } = require("../src/update-service");

function fixture({ packaged = true, enabled = true } = {}) {
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => {
    updater.emit("checking-for-update");
    updater.emit("update-available", { version: "0.1.1" });
  };
  updater.downloadUpdate = async () => {
    updater.emit("download-progress", { percent: 51.2 });
    updater.emit("update-downloaded", { version: "0.1.1" });
  };
  updater.quitAndInstall = () => {};
  const states = [];
  const service = createUpdateService({
    app: { isPackaged: packaged, getVersion: () => "0.1.0" },
    autoUpdater: updater,
    disabled: !enabled,
    publish: (state) => states.push(state),
  });
  return { service, states, updater };
}

test("development builds never contact the release provider", async () => {
  const { service } = fixture({ packaged: false });
  assert.equal((await service.check()).status, "disabled");
});

test("packaged builds remain fail-closed unless signed updates are enabled", async () => {
  const { service } = fixture({ enabled: false });
  assert.equal((await service.check()).status, "disabled");
});

test("update checks and downloads remain separate owner actions", async () => {
  const { service, states } = fixture();
  await service.check();
  assert.equal(service.getState().status, "available");
  assert.equal(service.getState().availableVersion, "0.1.1");
  await service.download();
  assert.equal(service.getState().status, "ready");
  assert.equal(service.getState().progress, 100);
  assert.ok(states.some((state) => state.status === "downloading" && state.progress === 51));
});

test("release errors do not expose provider URLs", () => {
  assert.equal(cleanError(new Error("GET https://example.invalid/private-token failed")), "GET release server failed");
});
