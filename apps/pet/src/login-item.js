function launchAtLoginAccepted(platform, requested, observed = {}) {
  const enabled = Boolean(requested);
  if (platform !== "win32") return Boolean(observed.openAtLogin) === enabled;

  if (!enabled) return !observed.openAtLogin;
  return Boolean(observed.openAtLogin && observed.executableWillLaunchAtLogin);
}

module.exports = { launchAtLoginAccepted };
