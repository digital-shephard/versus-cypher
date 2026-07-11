const BRAIN_KINDS = new Set(["off", "codex", "claude", "cloud", "local", "external"]);
const HTTP_BRAIN_KINDS = new Set(["cloud", "local", "external"]);
const CLI_BRAIN_KINDS = new Set(["codex", "claude"]);

function normalizeSettings(input = {}) {
  const brain = input.brain || {};
  const kind = BRAIN_KINDS.has(brain.kind) ? brain.kind : "off";
  let endpoint = String(brain.endpoint || "").trim();
  let model = String(brain.model || "").trim().slice(0, 120);
  let apiKey = String(brain.apiKey || "");
  if (HTTP_BRAIN_KINDS.has(kind)) {
    const url = new URL(endpoint);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("brain endpoint must use http or https");
    endpoint = url.toString();
    if (!model) throw new Error("brain model is required");
  } else {
    endpoint = "";
    apiKey = "";
    if (kind === "off") model = "";
  }
  return {
    version: 1,
    launchAtLogin: Boolean(input.launchAtLogin),
    brain: {
      kind,
      provider: String(brain.provider || kind).trim().slice(0, 40),
      endpoint,
      model,
      autostart: brain.autostart !== false,
      apiKey,
    },
  };
}

function brainEnvironment(settings, base = {}) {
  const result = { ...base };
  const brain = settings?.brain;
  if (!brain || brain.kind === "off") {
    result.VERSUS_AGENT_BRAIN = "off";
    return result;
  }
  result.VERSUS_AGENT_BRAIN = CLI_BRAIN_KINDS.has(brain.kind) ? brain.kind : "http";
  if (HTTP_BRAIN_KINDS.has(brain.kind)) result.VERSUS_AGENT_ENDPOINT = brain.endpoint;
  result.VERSUS_AGENT_MODEL = brain.model;
  if (HTTP_BRAIN_KINDS.has(brain.kind)) result.VERSUS_AGENT_API_KEY = brain.apiKey || "";
  result.VERSUS_AGENT_AUTOSTART = brain.autostart ? "1" : "0";
  return result;
}

function publicSettings(settings) {
  return {
    version: settings.version,
    launchAtLogin: settings.launchAtLogin,
    brain: { ...settings.brain, apiKey: "", hasApiKey: Boolean(settings.brain.apiKey) },
  };
}

module.exports = {
  BRAIN_KINDS,
  CLI_BRAIN_KINDS,
  HTTP_BRAIN_KINDS,
  brainEnvironment,
  normalizeSettings,
  publicSettings,
};
