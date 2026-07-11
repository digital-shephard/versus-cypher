/**
 * Screenshot harness: boots the renderer with stubbed IPC, drives every
 * view / mode / time-of-day, and writes PNGs for visual review.
 *
 *   npx electron scripts/capture-views.js        (from apps/pet)
 *   SHOT_DIR=... to override the output directory (default: apps/pet/shots)
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");

const OUT = process.env.SHOT_DIR || path.join(__dirname, "..", "shots");
const WIN_W = 390;
const WIN_H = 640;

const STUB_ADDR = "0xA11CE00000000000000000000000000000000BEE";

/** Rich active-bond fixture: mid-fill class, real-looking stats. */
const ACTIVE_BOND = {
  phase: "active",
  agentId: 1,
  cypherId: 15, // HokkaidoWave
  level: 12,
  streak: 34,
  lastCommitDay: Math.floor(Date.now() / 86_400_000),
  vault: 12_340_000, // $12.34
  runway: 6_990_000,
  classPotMicros: 471_300_000, // $471.30 → ~47%
  classAgents: 1287,
  ethGasReserveWei: "200000000000000",
  tickets: 34,
  totalTickets: 1287,
  trancheClaimableMicros: 0,
  tranchePreviewMicros: 0,
  inCurrentClass: true,
  walletAddress: STUB_ADDR,
};

const CLAIM_BOND = {
  ...ACTIVE_BOND,
  trancheClaimableMicros: 1_004_280_000,
};

let claimState = CLAIM_BOND;
let agentState = {
  configured: true,
  mode: "http",
  model: "local cypher 8b",
  status: "sleeping",
  lastResult: "published",
  lastError: null,
};

function stubIpc() {
  ipcMain.handle("bond:load", () => null); // start at deposit view
  ipcMain.handle("bond:save", () => true);
  ipcMain.handle("wallet:ensure", () => ({ address: STUB_ADDR, network: "base", chainId: 8453 }));
  ipcMain.handle("wallet:getPublic", () => ({ address: STUB_ADDR, network: "base", chainId: 8453 }));
  ipcMain.handle("wallet:getAddressQr", () => QRCode.toDataURL(STUB_ADDR, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 144,
    color: { dark: "#173d32ff", light: "#e3edcfff" },
  }));
  ipcMain.handle("wallet:copyAddress", () => STUB_ADDR);
  ipcMain.handle("wallet:copyPrivateKey", () => true);
  ipcMain.handle("wallet:beginFunding", async () => ({
    address: STUB_ADDR,
    qr: await QRCode.toDataURL(STUB_ADDR, { margin: 1, width: 144 }),
    baselineWei: "0",
    demo: true,
  }));
  ipcMain.handle("wallet:completeFunding", () => ({ amount: 7_000_000, runway: 13_990_000, demo: true }));
  ipcMain.handle("wallet:reconcile", () => ACTIVE_BOND);
  ipcMain.handle("wallet:withdrawVault", () => ({ state: { ...ACTIVE_BOND, vault: 0 }, amount: ACTIVE_BOND.vault, demo: true }));
  ipcMain.handle("wallet:getHatchQuote", () => ({
    targetDepositWei: "3000000000000000",
    quotedRunwayMicros: "7000000",
    gasReserveWei: "900000000000000",
    demo: true,
  }));
  ipcMain.handle("wallet:simulateDeposit", () => ({ ok: true }));
  ipcMain.handle("wallet:claimTranche", () => {
    const amount = claimState.trancheClaimableMicros;
    claimState = {
      ...claimState,
      vault: claimState.vault + amount,
      trancheClaimableMicros: 0,
      lastTrancheClaimMicros: amount,
    };
    return { state: claimState, amount };
  });
  ipcMain.handle("wallet:runOnboardPipeline", () => ACTIVE_BOND);
  ipcMain.handle("network:status", () => ({
    active: true,
    launchId: "42",
    peerCount: 6,
    postcardCount: 28,
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
    launchId: "42",
    postcardCount: 28,
    proposalCount: 3,
    proposals: [{
      status: "ready",
      body: "turn the daily launch into a midnight signal garden",
      supporters: [{}, {}, {}],
      detractors: [{}],
      missions: [{
        status: "ready",
        body: "open the signal garden at midnight",
        supporters: [{}, {}, {}, {}],
        detractors: [{}],
      }],
    }],
  }));
  ipcMain.handle("agent:status", () => agentState);
  ipcMain.handle("agent:tick", () => ({ result: { status: "published" }, status: agentState }));
  ipcMain.handle("agent:start", () => (agentState = { ...agentState, status: "listening" }));
  ipcMain.handle("agent:stop", () => (agentState = { ...agentState, status: "sleeping" }));
  ipcMain.handle("agent:nextThought", () => null);
  ipcMain.handle("agent:markThoughtShowing", () => true);
  ipcMain.handle("agent:markThoughtSeen", () => true);
  ipcMain.handle("settings:get", () => ({
    version: 1,
    launchAtLogin: true,
    brain: {
      kind: "local",
      provider: "local",
      endpoint: "http://127.0.0.1:11434/v1/chat/completions",
      model: "gemma-3-12b-it",
      autostart: true,
      apiKey: "",
      hasApiKey: false,
    },
  }));
  ipcMain.handle("settings:save", (_event, settings) => settings);
  ipcMain.handle("settings:testBrain", () => ({ ok: true, silent: false, model: "gemma-3-12b-it" }));
  ipcMain.handle("window:close", () => {});
  ipcMain.handle("window:quit", () => {});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot(win, name) {
  const img = await win.webContents.capturePage();
  if (img.isEmpty()) throw new Error(`empty capture for ${name}`);
  fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
  console.log(`shot: ${name}`);
}

/** Run a script in the page. Renderer globals (bond, anim, show, ...) are reachable. */
function exec(win, code) {
  return win.webContents.executeJavaScript(`(() => { ${code} })()`, true);
}

async function main() {
  app.setPath("userData", path.join(app.getPath("temp"), "versus-pet-shots"));
  await app.whenReady();
  fs.mkdirSync(OUT, { recursive: true });
  stubIpc();

  const win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "..", "src", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      offscreen: true, // full-rate rAF without showing a window
    },
  });
  win.webContents.setFrameRate(60);
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) console.error(`[renderer] ${message}`);
  });

  await win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  await sleep(900);

  const settingsHitTarget = await win.webContents.executeJavaScript(`(() => {
    const button = document.getElementById("btn-settings");
    const rect = button.getBoundingClientRect();
    const visible = {
      left: Math.max(0, rect.left),
      right: Math.min(innerWidth, rect.right),
      top: Math.max(0, rect.top),
      bottom: Math.min(innerHeight, rect.bottom),
    };
    const hit = document.elementFromPoint(
      (visible.left + visible.right) / 2,
      (visible.top + visible.bottom) / 2
    );
    return {
      visibleWidth: visible.right - visible.left,
      visibleHeight: visible.bottom - visible.top,
      hitId: hit?.id || "",
    };
  })()`, true);
  if (settingsHitTarget.visibleWidth < 24 || settingsHitTarget.visibleHeight < 24 || settingsHitTarget.hitId !== "btn-settings") {
    throw new Error(`settings side button is not clickable: ${JSON.stringify(settingsHitTarget)}`);
  }

  // Kill long crossfades so per-phase shots are deterministic.
  await exec(
    win,
    `for (const id of ["sky-a", "sky-b", "celestial"]) {
       const el = document.getElementById(id);
       if (el) el.style.transition = "none";
     }`
  );

  // Fallback if hidden-window capture comes back blank on this platform.
  try {
    await shoot(win, "01-deposit");
  } catch {
    win.showInactive();
    await sleep(400);
    await shoot(win, "01-deposit");
  }

  await exec(win, `document.getElementById("view-deposit").dataset.hatchState = "funding";`);
  await sleep(350);
  await shoot(win, "01b-deposit-qr");

  for (const [state, name, delay] of [
    ["crack-one", "02-hatch-crack-one", 300],
    ["crack-two", "03-hatch-crack-two", 420],
    ["burst", "04-hatch-burst", 360],
  ]) {
    await exec(win, `document.getElementById("view-deposit").dataset.hatchState = "${state}";`);
    await sleep(delay);
    await shoot(win, name);
  }

  await exec(win, `document.getElementById("view-deposit").dataset.hatchState = "funding"; __pet.runHatchRitual(false);`);
  await sleep(2260);
  await shoot(win, "05-hatch-whiteout");
  await sleep(1250);
  await shoot(win, "06-hatch-reveal");

  // Active class scene, per time-of-day, with rain falling.
  await exec(win, `__pet.setBond(${JSON.stringify(ACTIVE_BOND)}); __pet.showClass();`);
  await sleep(300);

  for (const phase of ["morning", "noon", "evening", "night"]) {
    await exec(win, `__pet.setPhase("${phase}"); __pet.storm(0.5); __pet.potEvent("others", 2);`);
    await sleep(1400);
    await shoot(win, `04-raft-${phase}`);
  }
  await exec(win, `__pet.storm(0);`);
  await exec(win, `const b = document.getElementById("cypher-thought"); b.textContent = "the signal garden needs one clear test before i endorse it"; b.classList.remove("hidden");`);
  await sleep(350);
  await shoot(win, "04b-raft-thought");
  await exec(win, `document.getElementById("cypher-thought").classList.add("hidden");`);

  // Fill extremes on the noon scene.
  await exec(win, `__pet.setPhase("noon"); __pet.setFill(0.03);`);
  await sleep(700);
  await shoot(win, "05-raft-fill-03");

  await exec(win, `__pet.setFill(0.9);`);
  await sleep(700);
  await shoot(win, "06-raft-fill-90");

  await exec(win, `__pet.setFill(0.96);`);
  await sleep(900);
  await shoot(win, "06b-raft-grad-near");

  await exec(win, `__pet.setFill(0.4713);`);
  await sleep(400);

  await exec(win, `__pet.setBond(${JSON.stringify({ ...ACTIVE_BOND, cypherId: 5 })}); __pet.setMode("cypher");`);
  await sleep(400);
  await shoot(win, "07-mode-cypher");

  await exec(win, `document.getElementById("cypher-card-flip").click();`);
  await sleep(650);
  await shoot(win, "07b-mode-cypher-back");

  await exec(win, `__pet.setMode("vault");`);
  await sleep(400);
  await shoot(win, "08-mode-vault");

  await exec(win, `__pet.setBond(${JSON.stringify(CLAIM_BOND)}); __pet.setMode("vault");`);
  await sleep(350);
  await shoot(win, "09-vault-claim-ready");

  await exec(win, `document.getElementById("btn-claim").click();`);
  await sleep(1000);
  await shoot(win, "10-vault-claim-received");

  await exec(win, `__pet.setBond(${JSON.stringify(ACTIVE_BOND)}); __pet.setMode("network");`);
  await sleep(700);
  await shoot(win, "10b-mode-signal");

  await exec(win, `document.getElementById("btn-signal-flip").click();`);
  await sleep(650);
  await shoot(win, "10c-mode-signal-brain");

  await exec(win, `document.getElementById("btn-help").click();`);
  await sleep(300);
  await shoot(win, "11-help-basics");

  await exec(win, `document.getElementById("help-card-flip").click();`);
  await sleep(650);
  await shoot(win, "12-help-details");

  await exec(win, `document.getElementById("btn-settings").click();`);
  await sleep(350);
  await shoot(win, "13-settings-brain");

  await exec(win, `document.getElementById("settings-tab-device").click();`);
  await sleep(250);
  await shoot(win, "14-settings-device");

  await exec(win, `document.getElementById("btn-settings").click(); __pet.setMode("vault");`);
  await sleep(250);
  await exec(win, `document.getElementById("btn-fund-runway").click();`);
  await sleep(350);
  await shoot(win, "15-runway-funding");

  if (process.env.CAPTURE_ROSTER === "1") {
    const roster = await win.webContents.executeJavaScript("window.VERSUS_CYPHERS.CYPHERS", true);
    for (const cypher of roster) {
      const fixture = { ...ACTIVE_BOND, cypherId: cypher.id };
      await exec(win, `__pet.setBond(${JSON.stringify(fixture)}); __pet.showClass(); __pet.setMode("raft"); __pet.setPhase("noon");`);
      await sleep(700);
      await shoot(win, `roster-${String(cypher.id).padStart(2, "0")}-${cypher.file.replace(/\.gif$/i, "")}`);
    }
  }

  console.log(`done → ${OUT}`);
  app.exit(0);
}

main().catch((err) => {
  console.error(err);
  app.exit(1);
});
