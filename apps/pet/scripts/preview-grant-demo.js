/**
 * One-minute, local-only grant demo. It exercises the real renderer choreography
 * with deterministic fixtures and never loads the production wallet or network.
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const QRCode = require("qrcode");
const {
  DURATION_MS,
  GRANT_DEMO_BEATS: BEATS,
  validateGrantDemoTimeline,
} = require("./grant-demo-timeline");

if (!validateGrantDemoTimeline()) throw new Error("grant demo timeline must be exactly one minute");

const STUB_ADDRESS = "0xA11CE00000000000000000000000000000000BEE";
const FLOOR_MICROS = 1_000_000_000;
const DEMO_CYPHER_ID = 1; // Ohwail
const HOLD_OPEN = process.argv.includes("--hold");

const ACTIVE_BOND = {
  phase: "active",
  agentId: 4,
  cypherId: DEMO_CYPHER_ID,
  level: 3,
  streak: 3,
  lastCommitDay: Math.floor(Date.now() / 86_400_000),
  nextCommitAt: Math.floor(Date.now() / 1000) + 21 * 60 * 60,
  runway: 6_970_000,
  vault: 0,
  tickets: 3,
  totalTickets: 4,
  classId: 1,
  classPotMicros: 624_830_000,
  classAgents: 4,
  graduationFloorMicros: FLOOR_MICROS,
  inCurrentClass: true,
  walletAddress: STUB_ADDRESS,
};

const CEREMONY = {
  version: 1,
  classId: 1,
  nextClassId: 2,
  tokenOrdinal: 0,
  classPotMicros: 1_000_040_000,
  classAgents: 4,
  graduationFloorMicros: FLOOR_MICROS,
  detectedAt: Date.now(),
};

const NEXT_STATE = {
  ...ACTIVE_BOND,
  classId: 2,
  classPotMicros: 0,
  classAgents: 0,
  pendingGraduation: CEREMONY,
};

let win = null;
let bond = { phase: "awaiting_deposit", walletAddress: STUB_ADDRESS };
let agentState = {
  configured: true,
  mode: "codex",
  model: "owner supplied brain",
  status: "sleeping",
  lastResult: null,
  lastError: null,
};
let thoughtQueue = [];
let rainQueue = [];
let nextActivityId = 1;
const activityEvents = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sleepUntil(startedAt, offsetMs) {
  return sleep(Math.max(0, startedAt + offsetMs - Date.now()));
}

function activitySnapshot() {
  return {
    version: 1,
    telemetry: "none",
    chain: "base",
    waku: "live",
    brain: "local",
    events: activityEvents.slice(-128),
  };
}

function publishActivity({ channel, direction = "local", operation, status = "ok", durationMs = null }) {
  const event = {
    id: nextActivityId++,
    at: Date.now(),
    channel,
    direction,
    operation,
    destination: channel === "waku" ? "versus_mesh" : channel === "base" ? "base" : "local_device",
    status,
    durationMs,
    bytes: null,
  };
  activityEvents.push(event);
  win?.webContents.send("service:activity", event);
}

function registerIpc() {
  ipcMain.handle("service:activitySnapshot", () => activitySnapshot());
  ipcMain.handle("health:snapshot", () => ({ version: 1, status: "healthy", issues: [] }));
  ipcMain.handle("diagnostics:export", () => ({ canceled: true }));
  ipcMain.handle("bond:loadLocal", () => null);
  ipcMain.handle("bond:load", () => bond);
  ipcMain.handle("bond:save", (_event, next) => {
    bond = next;
    return true;
  });
  ipcMain.handle("wallet:ensure", () => ({ address: STUB_ADDRESS, network: "base", chainId: 8453 }));
  ipcMain.handle("wallet:getPublic", () => ({ address: STUB_ADDRESS, network: "base", chainId: 8453 }));
  ipcMain.handle("wallet:getAddressQr", () => QRCode.toDataURL(STUB_ADDRESS, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 144,
    color: { dark: "#173d32ff", light: "#e3edcfff" },
  }));
  ipcMain.handle("wallet:copyAddress", () => STUB_ADDRESS);
  ipcMain.handle("wallet:getHatchQuote", () => ({
    targetDepositWei: "3000000000000000",
    quotedRunwayMicros: "7000000",
    gasReserveWei: "900000000000000",
    demo: true,
  }));
  ipcMain.handle("wallet:getReferralStatus", () => ({ funded: false, rewardPerReferral: 0, availableRewards: 0, demo: true }));
  ipcMain.handle("wallet:setReferralCode", () => ({ skipped: true }));
  ipcMain.handle("wallet:runOnboardPipeline", async () => {
    for (const stage of ["preparing_runway", "swap_confirmed", "hatch_submitted", "joining_class"]) {
      win?.webContents.send("hatch:progress", { stage, at: Date.now() });
      await sleep(1_400);
    }
    await sleep(500);
    bond = { ...ACTIVE_BOND };
    win?.webContents.send("bond:changed", bond);
    win?.webContents.send("hatch:progress", { stage: "ready", at: Date.now() });
    publishActivity({ channel: "base", direction: "in", operation: "hatch_confirmed", durationMs: 1840 });
    return bond;
  });
  ipcMain.handle("rain:next", () => ({
    drop: rainQueue.shift() || null,
    pending: rainQueue.length,
    nextAt: rainQueue.length ? Date.now() + 180 : null,
  }));
  ipcMain.handle("graduation:acknowledge", (_event, { classId }) => {
    bond = {
      ...NEXT_STATE,
      pendingGraduation: undefined,
      lastCelebratedClassId: Number(classId),
    };
    return bond;
  });
  ipcMain.handle("network:status", () => ({
    active: true,
    launchId: String(bond.classId || 1),
    peerCount: 6,
    postcardCount: 18,
    transportStatus: { state: "caught_up" },
    agent: agentState,
    neighborhood: [
      { x: 31, y: 31, radius: 5.5, stance: "support", clusterId: "a" },
      { x: 149, y: 27, radius: 6.2, stance: "support", clusterId: "b" },
      { x: 155, y: 82, radius: 4.7, stance: "dissent", clusterId: "c" },
      { x: 35, y: 88, radius: 5, stance: "neutral", clusterId: "d" },
      { x: 77, y: 16, radius: 4.2, stance: "support", clusterId: "a" },
    ],
  }));
  ipcMain.handle("network:coalitionView", () => ({
    launchId: String(bond.classId || 1),
    postcardCount: 18,
    proposalCount: 1,
    proposals: [{
      status: "ready",
      body: "show the first ownerless launch forming in public",
      supporters: ["1", "2", "4"],
      detractors: [],
      missions: [],
    }],
  }));
  ipcMain.handle("agent:status", () => agentState);
  ipcMain.handle("agent:tick", async () => {
    agentState = { ...agentState, status: "thinking" };
    publishActivity({ channel: "brain", direction: "out", operation: "think", status: "pending" });
    await sleep(1_800);
    thoughtQueue = [{
      id: "grant-demo-thought",
      text: "Four Cyphers are already turning the first class into something real.",
    }];
    agentState = { ...agentState, status: "sleeping", lastResult: "observation recorded" };
    publishActivity({ channel: "brain", direction: "in", operation: "thought_ready", durationMs: 1800 });
    return { result: { status: "observed" }, status: agentState };
  });
  ipcMain.handle("agent:start", () => (agentState = { ...agentState, status: "listening" }));
  ipcMain.handle("agent:stop", () => (agentState = { ...agentState, status: "sleeping" }));
  ipcMain.handle("agent:nextThought", () => thoughtQueue.shift() || null);
  ipcMain.handle("agent:markThoughtShowing", () => true);
  ipcMain.handle("agent:markThoughtSeen", () => true);
  ipcMain.handle("settings:get", () => ({
    version: 1,
    launchAtLogin: false,
    allowReferralFunding: false,
    brain: { kind: "codex", provider: "codex", endpoint: "", model: "owner supplied brain", autostart: false, hasApiKey: false },
  }));
  ipcMain.handle("settings:brainCapabilities", () => ({ codex: { installed: true }, claude: { installed: false } }));
  ipcMain.handle("update:status", () => ({ status: "disabled", currentVersion: "grant-demo" }));
  ipcMain.handle("window:close", () => win?.minimize());
  ipcMain.handle("window:quit", () => app.quit());
}

function queueVerifiedPenny(index) {
  const classPotMicros = ACTIVE_BOND.classPotMicros + (index + 1) * 10_000;
  rainQueue.push({
    eventId: `grant-rain-${index}`,
    type: index % 4 === 0 ? "commit" : "rain",
    agentId: String(index % 5 === 0 ? ACTIVE_BOND.agentId : 20 + index),
    classId: "1",
    classPotMicros: String(classPotMicros),
    pennies: 1,
  });
  win?.webContents.send("rain:available", { pending: rainQueue.length });
  publishActivity({ channel: "waku", direction: "in", operation: "rain_confirmed", durationMs: 42 + index });
}

async function runRainBeat(startedAt) {
  const count = 18;
  for (let index = 0; index < count; index += 1) {
    queueVerifiedPenny(index);
    if (index === 4) await win.webContents.executeJavaScript("__pet.storm(0.35); true", true);
    if (index === 10) await win.webContents.executeJavaScript("__pet.storm(0.82); true", true);
    const progress = (index + 1) / count;
    await sleep(Math.max(180, 720 - progress * 460));
  }
  await sleepUntil(startedAt, BEATS.classOver - 250);
  await win.webContents.executeJavaScript("__pet.storm(0); true", true);
}

async function runTimeline() {
  const startedAt = Date.now();
  console.log("Versus grant demo: 60-second take started.");

  await sleepUntil(startedAt, BEATS.hatch);
  publishActivity({ channel: "base", direction: "out", operation: "funds_found", durationMs: 38 });
  const hatch = win.webContents.executeJavaScript("__pet.runHatchRitual(false)", true);

  await sleepUntil(startedAt, BEATS.rain);
  await hatch;
  await win.webContents.executeJavaScript('__pet.setPhase("late-noon"); __pet.setMode("raft"); true', true);
  const rain = runRainBeat(startedAt);

  await sleepUntil(startedAt, BEATS.classOver);
  await rain;
  publishActivity({ channel: "base", direction: "in", operation: "class_closed", durationMs: 47 });
  win.webContents.send("class:over", { classId: 1, currentClassId: 2, detectedAt: Date.now() });

  await sleepUntil(startedAt, BEATS.graduation);
  publishActivity({ channel: "base", direction: "in", operation: "graduation_confirmed", durationMs: 52 });
  win.webContents.send("graduation:available", { ceremony: CEREMONY, state: NEXT_STATE });

  await sleepUntil(startedAt, BEATS.signal);
  await win.webContents.executeJavaScript(`(() => {
    __pet.setMode("network");
    document.getElementById("btn-signal-flip")?.click();
    return true;
  })()`, true);

  await sleepUntil(startedAt, BEATS.think);
  await win.webContents.executeJavaScript('document.getElementById("btn-brain-think")?.click(); true', true);

  await sleepUntil(startedAt, BEATS.thought);
  await win.webContents.executeJavaScript('__pet.setMode("raft"); true', true);

  await sleepUntil(startedAt, BEATS.service);
  publishActivity({ channel: "system", direction: "local", operation: "telemetry_none", status: "ready" });
  for (const id of [0, 2, 1, 3]) {
    await win.webContents.executeJavaScript(`document.querySelector('[data-screw-id="${id}"]')?.click(); true`, true);
    await sleep(260);
  }

  await sleepUntil(startedAt, BEATS.complete);
  console.log(`Versus grant demo complete: ${DURATION_MS / 1000} seconds.`);
  if (!HOLD_OPEN) app.quit();
}

async function main() {
  app.setPath("userData", path.join(app.getPath("temp"), "versus-grant-demo"));
  await app.whenReady();
  registerIpc();
  publishActivity({ channel: "system", direction: "local", operation: "device_boot", status: "ready" });
  publishActivity({ channel: "base", direction: "in", operation: "state_sync", durationMs: 41 });
  publishActivity({ channel: "waku", direction: "in", operation: "mesh_ready", status: "ready" });

  win = new BrowserWindow({
    width: 390,
    height: 640,
    center: true,
    show: true,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "..", "src", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  await win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  const readyDeadline = Date.now() + 5_000;
  while (!(await win.webContents.executeJavaScript("Boolean(window.__pet)", true))) {
    if (Date.now() >= readyDeadline) throw new Error("grant demo renderer did not become ready");
    await sleep(50);
  }
  await win.webContents.executeJavaScript(`(() => {
    document.getElementById("view-deposit").dataset.hatchState = "funding";
    document.getElementById("hatch-funding").setAttribute("aria-hidden", "false");
    document.getElementById("hatch-referral").setAttribute("aria-hidden", "true");
    document.getElementById("hatch-incubation").setAttribute("aria-hidden", "true");
    return true;
  })()`, true);
  await sleep(900);
  await runTimeline();
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});

app.on("window-all-closed", () => app.quit());
