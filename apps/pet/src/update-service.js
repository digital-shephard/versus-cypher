const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function cleanError(error) {
  return String(error?.message || error || "Update failed")
    .replace(/https?:\/\/[^\s]+/g, "release server")
    .slice(0, 160);
}

function createUpdateService({ app, autoUpdater, publish, disabled = false }) {
  let timer = null;
  let state = {
    status: disabled || !app.isPackaged ? "disabled" : "idle",
    currentVersion: app.getVersion(),
    availableVersion: null,
    progress: null,
    error: null,
  };

  const emit = () => publish?.({ ...state });
  const setState = (patch) => {
    state = { ...state, ...patch };
    emit();
    return { ...state };
  };

  if (!disabled && app.isPackaged) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.on("checking-for-update", () => setState({ status: "checking", error: null }));
    autoUpdater.on("update-available", (info) => setState({
      status: "available", availableVersion: info.version, progress: null, error: null,
    }));
    autoUpdater.on("update-not-available", () => setState({
      status: "current", availableVersion: null, progress: null, error: null,
    }));
    autoUpdater.on("download-progress", (progress) => setState({
      status: "downloading",
      progress: Math.max(0, Math.min(100, Math.round(progress.percent || 0))),
      error: null,
    }));
    autoUpdater.on("update-downloaded", (info) => setState({
      status: "ready", availableVersion: info.version, progress: 100, error: null,
    }));
    autoUpdater.on("error", (error) => setState({
      status: "error", progress: null, error: cleanError(error),
    }));
  }

  async function check() {
    if (disabled || !app.isPackaged) return setState({ status: "disabled" });
    await autoUpdater.checkForUpdates();
    return { ...state };
  }

  async function download() {
    if (state.status !== "available") throw new Error("No verified update is available");
    setState({ status: "downloading", progress: 0, error: null });
    await autoUpdater.downloadUpdate();
    return { ...state };
  }

  function install() {
    if (state.status !== "ready") throw new Error("Update is not ready to install");
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return { ...state };
  }

  function start() {
    if (disabled || !app.isPackaged || timer) return;
    setTimeout(() => check().catch(() => {}), 15_000);
    timer = setInterval(() => check().catch(() => {}), CHECK_INTERVAL_MS);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { check, download, getState: () => ({ ...state }), install, start, stop };
}

module.exports = { CHECK_INTERVAL_MS, cleanError, createUpdateService };
