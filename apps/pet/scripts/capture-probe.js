/** Debug probe: sample water canvas pixels + palette state at night. */
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

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
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  await win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  await sleep(800);
  await win.webContents.executeJavaScript(
    `__pet.setBond(${JSON.stringify(ACTIVE_BOND)}); __pet.showClass(); __pet.setPhase("night"); true`, true);
  await sleep(2600);
  const report = await win.webContents.executeJavaScript(
    `(() => {
      const W = __pet._w;
      const back = document.getElementById("weather");
      const bctx = back.getContext("2d");
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const sy = __pet._surfaceYAt(12);
      const px = (c, x, y) => Array.from(c.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data);
      const front = document.getElementById("weather-front");
      const fx = front.getContext("2d");
      return JSON.stringify({
        phase: document.getElementById("shell").getAttribute("data-phase"),
        palT: W.palT, css: W.css, isNight: W.isNight,
        fill: W.fill, w: W.w, h: W.h, surfYat12: sy,
        band: px(bctx, 12, sy + 3),
        body: px(bctx, 12, sy + 24),
        deepPx: px(bctx, 12, W.h - 8),
        aboveSurf: px(bctx, 12, sy - 6),
        frontBand: px(fx, 12, sy + 3),
      });
    })()`, true);
  console.log(report);
  app.exit(0);
}

main().catch((e) => { console.error(e); app.exit(1); });
