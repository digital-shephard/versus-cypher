/** Deterministic frame sequence for the confirmed class graduation ritual. */
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");

const OUT = process.env.SHOT_DIR || path.join(__dirname, "..", "shots", "graduation");
const PREVIEW = process.argv.includes("--preview");
const STUB_ADDR = "0xA11CE00000000000000000000000000000000BEE";
const ACTIVE_BOND = {
  phase: "active",
  agentId: 1,
  cypherId: 15,
  level: 12,
  streak: 34,
  lastCommitDay: Math.floor(Date.now() / 86_400_000),
  vault: 12_340_000,
  runway: 6_500_000,
  tickets: 47,
  totalTickets: 1287,
  classPotMicros: 1_000_040_000,
  classAgents: 1287,
  classId: 1,
  inCurrentClass: true,
  walletAddress: STUB_ADDR,
};

const CEREMONY = {
  version: 1,
  classId: 1,
  nextClassId: 2,
  tokenOrdinal: 0,
  classPotMicros: 1_000_040_000,
  classAgents: 1287,
  graduationFloorMicros: 1_000_000_000,
  detectedAt: Date.now(),
};

const NEXT_STATE = {
  ...ACTIVE_BOND,
  classId: 2,
  classPotMicros: 0,
  classAgents: 0,
  pendingGraduation: CEREMONY,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  app.setPath("userData", path.join(app.getPath("temp"), "versus-graduation-shots"));
  await app.whenReady();
  fs.mkdirSync(OUT, { recursive: true });
  for (const file of fs.readdirSync(OUT)) {
    if (file.endsWith(".png")) fs.rmSync(path.join(OUT, file));
  }

  ipcMain.handle("bond:load", () => ACTIVE_BOND);
  ipcMain.handle("bond:save", () => true);
  ipcMain.handle("service:activitySnapshot", () => ({ version: 1, telemetry: "none", events: [] }));
  ipcMain.handle("wallet:ensure", () => ({ address: STUB_ADDR, network: "base", chainId: 8453 }));
  ipcMain.handle("wallet:getPublic", () => ({ address: STUB_ADDR, network: "base", chainId: 8453 }));
  ipcMain.handle("wallet:copyAddress", () => STUB_ADDR);
  ipcMain.handle("rain:next", () => ({ drop: null, pending: 0, nextAt: null }));
  ipcMain.handle("network:status", () => ({ active: true, peerCount: 1, postcardCount: 0, launchId: "1", neighborhood: [] }));
  ipcMain.handle("network:coalitionView", () => ({ launchId: "1", postcardCount: 0, proposalCount: 0, proposals: [] }));
  ipcMain.handle("agent:nextThought", () => null);
  ipcMain.handle("graduation:acknowledge", (_event, payload) => ({
    ...NEXT_STATE,
    pendingGraduation: undefined,
    lastCelebratedClassId: Number(payload.classId),
  }));
  ipcMain.handle("window:close", () => {});
  ipcMain.handle("window:quit", () => {});

  const win = new BrowserWindow({
    width: 390,
    height: 640,
    show: PREVIEW,
    frame: false,
    transparent: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "src", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      offscreen: !PREVIEW,
    },
  });
  win.webContents.setFrameRate(60);
  await win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  await sleep(700);
  await win.webContents.executeJavaScript(`__pet.setPhase("late-noon"); true`, true);

  win.webContents.send("graduation:available", { ceremony: CEREMONY, state: NEXT_STATE });
  const startDeadline = Date.now() + 2_000;
  while (!(await win.webContents.executeJavaScript("__pet.graduationRunning()", true))) {
    if (Date.now() >= startDeadline) throw new Error("graduation IPC did not start the ritual");
    await sleep(25);
  }
  const frames = PREVIEW ? 0 : 34;
  const intervalMs = 400;
  for (let index = 0; index < frames; index += 1) {
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `t${String(index * intervalMs).padStart(5, "0")}.png`), image.toPNG());
    await sleep(intervalMs);
  }
  const finishDeadline = Date.now() + (PREVIEW ? 20_000 : 3_000);
  while (await win.webContents.executeJavaScript("__pet.graduationRunning()", true)) {
    if (Date.now() >= finishDeadline) throw new Error("graduation IPC ritual did not finish");
    await sleep(25);
  }
  const result = await win.webContents.executeJavaScript(`({
    running: __pet.graduationRunning(),
    classId: __pet.getBond().classId,
    pot: __pet.getBond().classPotMicros,
    celebrated: __pet.getBond().lastCelebratedClassId,
    stage: document.getElementById("graduation-ritual").dataset.stage
  })`, true);
  if (result.running || result.stage !== "idle" || result.classId !== 2 || result.pot !== 0 || result.celebrated !== 1) {
    throw new Error(`graduation ritual did not settle cleanly: ${JSON.stringify(result)}`);
  }
  console.log(JSON.stringify({ ok: true, preview: PREVIEW, frames, intervalMs, output: OUT, result }, null, 2));
  if (!PREVIEW) app.exit(0);
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});

app.on("window-all-closed", () => app.quit());
