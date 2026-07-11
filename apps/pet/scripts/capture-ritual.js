/** Frame-burst capture of the single-penny ritual + hop choreography. */
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");

const OUT = process.env.SHOT_DIR || path.join(__dirname, "..", "shots", "ritual");
const STUB_ADDR = "0xA11CE00000000000000000000000000000000BEE";
const ACTIVE_BOND = {
  phase: "active", agentId: 1, cypherId: 15, level: 12, streak: 34,
  lastCommitDay: Math.floor(Date.now() / 86_400_000), vault: 12_340_000,
  classPotMicros: 471_300_000, classAgents: 1287, inCurrentClass: true,
  walletAddress: STUB_ADDR,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  app.setPath("userData", path.join(app.getPath("temp"), "versus-pet-shots"));
  await app.whenReady();
  fs.mkdirSync(OUT, { recursive: true });
  ipcMain.handle("bond:load", () => null);
  ipcMain.handle("bond:save", () => true);
  ipcMain.handle("wallet:ensure", () => ({ address: STUB_ADDR, network: "base", chainId: 8453 }));
  ipcMain.handle("wallet:getPublic", () => ({ address: STUB_ADDR, network: "base", chainId: 8453 }));
  ipcMain.handle("wallet:copyAddress", () => STUB_ADDR);
  ipcMain.handle("wallet:simulateDeposit", () => ({ ok: true }));
  ipcMain.handle("wallet:runOnboardPipeline", () => ACTIVE_BOND);
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
  await win.webContents.executeJavaScript(
    `__pet.setBond(${JSON.stringify(ACTIVE_BOND)}); __pet.showClass(); __pet.setPhase("late-noon"); true`, true);
  await sleep(2200);

  await win.webContents.executeJavaScript(`__pet.potEvent("self", 1); true`, true);
  for (let i = 0; i < 8; i++) {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `t${String(i * 200).padStart(4, "0")}.png`), img.toPNG());
    await sleep(200);
  }
  console.log(`done → ${OUT}`);
  app.exit(0);
}

main().catch((e) => { console.error(e); app.exit(1); });
