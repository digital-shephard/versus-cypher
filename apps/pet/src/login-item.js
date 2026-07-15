function launchAtLoginAccepted(requested, observed = {}) {
  const enabled = Boolean(requested);
  return Boolean(observed.openAtLogin) === enabled;
}

module.exports = { launchAtLoginAccepted };
