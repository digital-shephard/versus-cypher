const { execFileSync } = require("node:child_process");
const path = require("node:path");

const WINDOWS_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

function launchAtLoginAccepted(requested, observed = {}) {
  return Boolean(observed.openAtLogin) === Boolean(requested);
}

function parseWindowsRunValue(output) {
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.match(/\sREG_(?:EXPAND_)?SZ\s+(.+)$/i);
    if (match) return match[1].trim();
  }
  return null;
}

function readWindowsRunValue(name, execFileSyncImpl = execFileSync) {
  try {
    const output = execFileSyncImpl("reg.exe", [
      "query",
      WINDOWS_RUN_KEY,
      "/v",
      name,
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    return parseWindowsRunValue(output);
  } catch (error) {
    if (error?.status === 1) return null;
    throw error;
  }
}

function expandWindowsEnvironment(value, environment = process.env) {
  return String(value || "").replace(/%([^%]+)%/g, (match, name) => {
    const key = Object.keys(environment).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return key ? environment[key] : match;
  });
}

function windowsCommandExecutable(command, environment = process.env) {
  const expanded = expandWindowsEnvironment(command, environment).trim();
  if (!expanded) return null;
  if (expanded.startsWith('"')) {
    const closingQuote = expanded.indexOf('"', 1);
    return closingQuote > 1 ? expanded.slice(1, closingQuote) : null;
  }
  return expanded;
}

function windowsRunEntryAccepted(requested, command, executablePath, environment = process.env) {
  if (!requested) return command == null;
  const commandExecutable = windowsCommandExecutable(command, environment);
  if (!commandExecutable) return false;
  return path.win32.normalize(commandExecutable).toLowerCase()
    === path.win32.normalize(executablePath).toLowerCase();
}

module.exports = {
  launchAtLoginAccepted,
  parseWindowsRunValue,
  readWindowsRunValue,
  windowsCommandExecutable,
  windowsRunEntryAccepted,
};
