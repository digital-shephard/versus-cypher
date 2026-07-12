/** Frame-burst proof that persisted verified pennies drive rain choreography. */
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");

const OUT = process.env.SHOT_DIR || path.join(__dirname, "..", "shots", "ritual");
const STUB_ADDR = "0xA11CE00000000000000000000000000000000BEE";
const ACTIVE_BOND = {
  phase: "active", agentId: 1, cypherId: 15, level: 12, streak: 34,
  lastCommitDay: Math.floor(Date.now() / 86_400_000), vault: 12_340_000,
  classPotMicros: 471_300_000, classAgents: 1287, inCurrentClass: true,
  classId: 1,
  walletAddress: STUB_ADDR,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  app.setPath("userData", path.join(app.getPath("temp"), "versus-pet-shots"));
  await app.whenReady();
  fs.mkdirSync(OUT, { recursive: true });
  const drops = [
    { eventId: "verified-1", type: "commit", agentId: "1", classId: "1", classPotMicros: "471310000" },
    { eventId: "verified-2", type: "rain", agentId: "1", classId: "1", classPotMicros: "471320000" },
    { eventId: "verified-3", type: "rain", agentId: "2", classId: "1", classPotMicros: "471330000" },
    { eventId: "closed-class", type: "rain", agentId: "2", classId: "0", classPotMicros: "10000" },
  ];
  ipcMain.handle("bond:load", () => ACTIVE_BOND);
  ipcMain.handle("bond:save", () => true);
  ipcMain.handle("service:activitySnapshot", () => ({ version: 1, telemetry: "none", events: [] }));
  ipcMain.handle("wallet:ensure", () => ({ address: STUB_ADDR, network: "base", chainId: 8453 }));
  ipcMain.handle("wallet:getPublic", () => ({ address: STUB_ADDR, network: "base", chainId: 8453 }));
  ipcMain.handle("wallet:copyAddress", () => STUB_ADDR);
  ipcMain.handle("wallet:simulateDeposit", () => ({ ok: true }));
  ipcMain.handle("wallet:runOnboardPipeline", () => ACTIVE_BOND);
  ipcMain.handle("rain:next", () => ({
    drop: drops.shift() || null,
    pending: drops.length,
    nextAt: drops.length ? Date.now() + 250 : null,
  }));
  ipcMain.handle("network:status", () => ({ active: true, peerCount: 1, postcardCount: 0, launchId: "1", neighborhood: [] }));
  ipcMain.handle("network:coalitionView", () => ({ launchId: "1", postcardCount: 0, proposalCount: 0, proposals: [] }));
  ipcMain.handle("agent:nextThought", () => null);
  ipcMain.handle("window:close", () => {});
  ipcMain.handle("window:quit", () => {});

  const win = new BrowserWindow({
    width: 390, height: 640, show: false, frame: false, transparent: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "src", "preload.js"),
      contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, offscreen: true,
    },
  });
  win.webContents.setFrameRate(60);
  await win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  await sleep(800);
  await win.webContents.executeJavaScript(`__pet.setPhase("late-noon"); true`, true);
  for (let i = 0; i < 8; i++) {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `t${String(i * 200).padStart(4, "0")}.png`), img.toPNG());
    await sleep(200);
  }
  const rendered = await win.webContents.executeJavaScript("__pet._w.verifiedDropsRendered", true);
  if (rendered !== 3) throw new Error(`expected three verified rendered drops, saw ${rendered}`);
  console.log(JSON.stringify({ ok: true, verifiedDropsRendered: rendered, frames: 8, output: OUT }, null, 2));
  app.exit(0);
}

main().catch((e) => { console.error(e); app.exit(1); });
