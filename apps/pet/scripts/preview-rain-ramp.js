/** Thirty-second verified-penny rain ramp for visual review. */
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");

const OUT = process.env.SHOT_DIR || path.join(__dirname, "..", "shots", "rain-ramp");
const PREVIEW = process.argv.includes("--preview");
const RAMP_MS = 30_000;
const STEP_MS = 50;
const LIGHT_INTERVAL_MS = 1_800;
const HEAVY_INTERVAL_MS = 160;
const PENNY_MICROS = 10_000;
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
  classPotMicros: 420_000_000,
  classAgents: 1287,
  classId: 1,
  inCurrentClass: true,
  walletAddress: STUB_ADDR,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const smoothstep = (value) => value * value * (3 - 2 * value);

function pennyInterval(progress) {
  const eased = smoothstep(clamp(progress, 0, 1));
  return LIGHT_INTERVAL_MS * Math.pow(HEAVY_INTERVAL_MS / LIGHT_INTERVAL_MS, eased);
}

async function renderRainState(win, classPotMicros, addPenny) {
  return win.webContents.executeJavaScript(`(() => {
    ${addPenny ? `__pet.verifiedRainDrop("peer", ${JSON.stringify(classPotMicros)});` : ""}
    const active = __pet._w.drops.items.slice(0, __pet._w.drops.n);
    const layerWind = [1.08, 1, 0.92];
    const angles = active.map((drop) => Math.atan((__pet._w.wind + drop.drift) * layerWind[drop.layer]) * 180 / Math.PI);
    return {
      storm: __pet._w.storm,
      targetStorm: __pet._w.targetStorm,
      wind: __pet._w.wind,
      rainRate: __pet._w.rainRate,
      rainPressure: __pet._w.rainPressure,
      activeDrops: __pet._w.drops.n,
      frontDrops: active.filter((drop) => drop.front).length,
      angleSpreadDeg: angles.length ? Math.max(...angles) - Math.min(...angles) : 0,
      queuedDrops: __pet._w.whiteQueue,
      renderedDrops: __pet._w.verifiedDropsRendered,
      microburstsRendered: __pet._w.microburstsRendered,
      coalescedRainPennies: __pet._w.coalescedRainPennies,
      classPotMicros: __pet.getBond().classPotMicros,
    };
  })()`, true);
}

async function main() {
  app.setPath("userData", path.join(app.getPath("temp"), `versus-rain-ramp-${process.pid}`));
  await app.whenReady();

  if (!PREVIEW) {
    fs.mkdirSync(OUT, { recursive: true });
    for (const file of fs.readdirSync(OUT)) {
      if (file.endsWith(".png") || file === "rain-ramp.json") fs.rmSync(path.join(OUT, file));
    }
  }

  let win;
  ipcMain.handle("bond:load", () => ACTIVE_BOND);
  ipcMain.handle("bond:save", () => true);
  ipcMain.handle("service:activitySnapshot", () => ({ version: 1, telemetry: "none", events: [] }));
  ipcMain.handle("wallet:ensure", () => ({ address: STUB_ADDR, network: "base", chainId: 8453 }));
  ipcMain.handle("wallet:getPublic", () => ({ address: STUB_ADDR, network: "base", chainId: 8453 }));
  ipcMain.handle("wallet:copyAddress", () => STUB_ADDR);
  ipcMain.handle("rain:next", () => ({ drop: null, pending: 0, nextAt: null }));
  ipcMain.handle("network:status", () => ({ active: true, peerCount: 3, postcardCount: 0, launchId: "1", neighborhood: [] }));
  ipcMain.handle("network:coalitionView", () => ({ launchId: "1", postcardCount: 0, proposalCount: 0, proposals: [] }));
  ipcMain.handle("agent:nextThought", () => null);
  ipcMain.handle("window:close", () => win?.close());
  ipcMain.handle("window:quit", () => win?.close());

  win = new BrowserWindow({
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
  await win.webContents.executeJavaScript(`
    __pet.setPhase("late-noon");
    __pet.setBond(${JSON.stringify(ACTIVE_BOND)});
    __pet.showClass();
    true;
  `, true);
  await sleep(500);

  const startedAt = Date.now();
  let nextPennyAt = startedAt;
  let nextCaptureAt = 5_000;
  let classPotMicros = ACTIVE_BOND.classPotMicros;
  let pennies = 0;
  const samples = [];

  while (!win.isDestroyed()) {
    const elapsed = Date.now() - startedAt;
    if (elapsed > RAMP_MS) break;
    const progress = clamp(elapsed / RAMP_MS, 0, 1);
    let addPenny = false;
    if (Date.now() >= nextPennyAt) {
      addPenny = true;
      pennies += 1;
      classPotMicros += PENNY_MICROS;
      nextPennyAt = Date.now() + pennyInterval(progress);
    }
    const state = await renderRainState(win, classPotMicros, addPenny);

    if (!PREVIEW && elapsed >= nextCaptureAt) {
      const checkpoint = Math.min(RAMP_MS, nextCaptureAt);
      const image = await win.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, `t${String(checkpoint).padStart(5, "0")}.png`), image.toPNG());
      samples.push({ elapsedMs: checkpoint, progress, pennies, intervalMs: pennyInterval(progress), ...state });
      nextCaptureAt += 5_000;
    }
    await sleep(STEP_MS);
  }

  if (win.isDestroyed()) return;
  let holdPennies = 0;
  const holdUntil = Date.now() + 900;
  let finalState = await renderRainState(win, classPotMicros, false);
  while (Date.now() < holdUntil) {
    classPotMicros += PENNY_MICROS;
    holdPennies += 1;
    finalState = await renderRainState(win, classPotMicros, true);
    await sleep(HEAVY_INTERVAL_MS);
  }
  finalState = await renderRainState(win, classPotMicros, false);

  const result = {
    ok: finalState.storm > 0.85 && finalState.rainPressure > 0.85 &&
      finalState.microburstsRendered > 50 && finalState.angleSpreadDeg <= 12,
    preview: PREVIEW,
    durationMs: RAMP_MS,
    pennies,
    holdPennies,
    lightIntervalMs: LIGHT_INTERVAL_MS,
    heavyIntervalMs: HEAVY_INTERVAL_MS,
    finalState,
  };
  if (!result.ok) throw new Error(`rain ramp did not reach heavy intensity: ${JSON.stringify(result)}`);

  if (!PREVIEW) {
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, "t30000.png"), image.toPNG());
    samples.push({ elapsedMs: RAMP_MS, progress: 1, pennies, intervalMs: HEAVY_INTERVAL_MS, ...finalState });
    const saturationProbe = await win.webContents.executeJavaScript(`(() => {
      const pot = Number(__pet.getBond().classPotMicros || 0);
      for (let index = 0; index < 100; index += 1) __pet.verifiedRainDrop("peer", pot);
      return {
        pendingBursts: __pet._w.goldQueue + __pet._w.whiteQueue,
        coalescedRainPennies: __pet._w.coalescedRainPennies,
        rateSamples: __pet._w.rainTimes.length,
        rainPressure: __pet._w.rainPressure,
      };
    })()`, true);
    if (
      saturationProbe.pendingBursts > 24 || saturationProbe.coalescedRainPennies < 70 ||
      saturationProbe.rateSamples > 20 || saturationProbe.rainPressure !== 1
    ) {
      throw new Error(`max-rain saturation is unbounded: ${JSON.stringify(saturationProbe)}`);
    }
    result.saturationProbe = saturationProbe;
    fs.writeFileSync(path.join(OUT, "rain-ramp.json"), `${JSON.stringify({ ...result, samples }, null, 2)}\n`);
    console.log(JSON.stringify({ ...result, output: OUT }, null, 2));
    app.exit(0);
    return;
  }

  console.log(JSON.stringify({ ...result, status: "holding heavy rain until the preview closes" }, null, 2));
  while (!win.isDestroyed()) {
    classPotMicros += PENNY_MICROS;
    await renderRainState(win, classPotMicros, true);
    await sleep(HEAVY_INTERVAL_MS);
  }
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});

app.on("window-all-closed", () => app.quit());
