/** Static capture proof that the independent retrieval rig centers on every Cypher seat. */
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");

const OUT = process.env.SHOT_DIR || path.join(__dirname, "..", "shots", "graduation-roster");
const STUB_ADDR = "0xA11CE00000000000000000000000000000000BEE";
const BASE_BOND = {
  phase: "active", agentId: 1, cypherId: 0, level: 12, streak: 34,
  classPotMicros: 1_000_000_000, classAgents: 1287, classId: 1,
  tickets: 47, totalTickets: 1287, runway: 6_500_000, walletAddress: STUB_ADDR,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  app.setPath("userData", path.join(app.getPath("temp"), "versus-graduation-roster-shots"));
  await app.whenReady();
  fs.mkdirSync(OUT, { recursive: true });
  for (const file of fs.readdirSync(OUT)) if (file.endsWith(".png")) fs.rmSync(path.join(OUT, file));

  ipcMain.handle("bond:load", () => BASE_BOND);
  ipcMain.handle("bond:save", () => true);
  ipcMain.handle("service:activitySnapshot", () => ({ version: 1, telemetry: "none", events: [] }));
  ipcMain.handle("wallet:ensure", () => ({ address: STUB_ADDR, network: "base", chainId: 8453 }));
  ipcMain.handle("rain:next", () => ({ drop: null, pending: 0, nextAt: null }));
  ipcMain.handle("network:status", () => ({ active: true, peerCount: 1, launchId: "1", neighborhood: [] }));
  ipcMain.handle("network:coalitionView", () => ({ launchId: "1", postcardCount: 0, proposalCount: 0, proposals: [] }));
  ipcMain.handle("agent:nextThought", () => null);
  ipcMain.handle("window:close", () => {});
  ipcMain.handle("window:quit", () => {});

  const win = new BrowserWindow({
    width: 390, height: 640, show: false, frame: false, transparent: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "src", "preload.js"),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true,
    },
  });
  await win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  await win.webContents.insertCSS(`
    #graduation-ritual *, #face-motion { transition: none !important; animation: none !important; }
  `);
  await sleep(500);
  const roster = await win.webContents.executeJavaScript("VERSUS_CYPHERS.CYPHERS.map(({id,name}) => ({id,name}))", true);
  let maxCenterError = 0;
  for (const cypher of roster) {
    const geometry = await win.webContents.executeJavaScript(`(async () => {
      __pet.resetGraduationPreview();
      __pet.setBond(${JSON.stringify({ ...BASE_BOND, cypherId: 0 })});
      __pet.getBond().cypherId = ${Number(cypher.id)};
      __pet.showClass();
      await document.getElementById("face").decode().catch(() => {});
      __pet.setFill(1);
      const target = __pet.previewGraduationCapture();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const ring = document.getElementById("graduation-lifebuoy-back").getBoundingClientRect();
      const cistern = document.getElementById("cistern").getBoundingClientRect();
      return {
        dx: ring.left + ring.width / 2 - (cistern.left + target.x),
        dy: ring.top + ring.height / 2 - (cistern.top + target.y)
      };
    })()`, true);
    maxCenterError = Math.max(maxCenterError, Math.abs(geometry.dx), Math.abs(geometry.dy));
    await sleep(140);
    const image = await win.webContents.capturePage();
    const safeName = cypher.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    fs.writeFileSync(path.join(OUT, `${String(cypher.id).padStart(2, "0")}-${safeName}.png`), image.toPNG());
  }
  if (maxCenterError > 1) throw new Error(`graduation rig center drifted by ${maxCenterError}px`);
  console.log(JSON.stringify({ ok: true, cyphers: roster.length, maxCenterError, output: OUT }, null, 2));
  app.exit(0);
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
