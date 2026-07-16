/** Development-only hatch preview. Uses one public read-only quote and never spends. */
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const QRCode = require("qrcode");
const { fetchNodeHatchQuote, hatchQuoteEndpointsFromEnv } = require("../src/base-rpc");

const BASE_DEPLOYMENT = require(path.join(__dirname, "..", "..", "..", "versus", "deployments", "base.json"));

const STUB_ADDRESS = "0xA11CE00000000000000000000000000000000BEE";
const ACTIVE_BOND = {
  phase: "active",
  agentId: 44,
  cypherId: 15,
  level: 1,
  streak: 1,
  lastCommitDay: Math.floor(Date.now() / 86_400_000),
  nextCommitAt: Math.floor(Date.now() / 1000) + 86_400,
  runway: 6_990_000,
  vault: 0,
  tickets: 1,
  totalTickets: 1_304,
  classId: 1,
  classPotMicros: 471_300_000,
  classAgents: 1_304,
  graduationFloorMicros: 1_000_000_000,
  inCurrentClass: true,
  walletAddress: STUB_ADDRESS,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let bond = { phase: "awaiting_deposit", walletAddress: STUB_ADDRESS };
let win = null;
let liveQuotePromise = null;

function handle(channel, task) {
  ipcMain.handle(channel, task);
}

function getLivePreviewQuote() {
  if (!liveQuotePromise) {
    const startedAt = Date.now();
    liveQuotePromise = fetchNodeHatchQuote({
      endpoints: hatchQuoteEndpointsFromEnv(process.env),
      trustedSigners: BASE_DEPLOYMENT.rainAttestors,
      chainId: BASE_DEPLOYMENT.chainId,
      arena: BASE_DEPLOYMENT.contracts.arena,
    }).then((quote) => {
      const previewQuoteMs = Date.now() - startedAt;
      console.log(`Live signed hatch quote: ${(previewQuoteMs / 1000).toFixed(2)}s via ${new URL(quote.sourceEndpoint).hostname}`);
      return {
        ...quote,
        targetDepositWei: quote.depositWei,
        previewQuoteMs,
      };
    });
  }
  return liveQuotePromise;
}

function installPreviewIpc() {
  handle("bond:loadLocal", () => bond);
  handle("bond:load", () => bond);
  handle("bond:save", (_event, next) => {
    bond = next;
    return true;
  });
  handle("service:activitySnapshot", () => ({ version: 1, telemetry: "none", events: [] }));
  handle("health:snapshot", () => ({ version: 1, status: "ok", issues: [] }));
  handle("wallet:ensure", () => ({ address: STUB_ADDRESS, network: "base", chainId: 8453 }));
  handle("wallet:getPublic", () => ({ address: STUB_ADDRESS, network: "base", chainId: 8453 }));
  handle("wallet:getAddressQr", () => QRCode.toDataURL(STUB_ADDRESS, { margin: 1, width: 144 }));
  handle("wallet:copyAddress", () => STUB_ADDRESS);
  handle("wallet:getHatchQuote", async () => Object.fromEntries(
    Object.entries(await getLivePreviewQuote()).map(([key, value]) => [
      key,
      typeof value === "bigint" ? value.toString() : value,
    ])
  ));
  handle("wallet:simulateDeposit", async () => {
    console.log("Simulating Base funding check...");
    await sleep(3_400);
    console.log("Preview funding confirmed.");
    return { ok: true, demo: true, simulatedCheckMs: 3_400 };
  });
  handle("wallet:getReferralStatus", () => ({ funded: false, rewardPerReferral: 0, availableRewards: 0, demo: true }));
  handle("wallet:setReferralCode", () => ({ skipped: true }));
  handle("wallet:runOnboardPipeline", async () => {
    for (const stage of ["preparing_runway", "swap_confirmed", "hatch_submitted", "joining_class"]) {
      win?.webContents.send("hatch:progress", { stage, at: Date.now() });
      await sleep(1450);
    }
    bond = { ...ACTIVE_BOND };
    win?.webContents.send("bond:changed", bond);
    win?.webContents.send("hatch:progress", { stage: "ready", at: Date.now() });
    return bond;
  });
  handle("rain:next", () => ({ drop: null, pending: 0, nextAt: null }));
  handle("network:status", () => ({ active: false, peerCount: 0, postcardCount: 0, launchId: "1", neighborhood: [] }));
  handle("network:coalitionView", () => ({ launchId: "1", postcardCount: 0, proposalCount: 0, proposals: [] }));
  handle("agent:nextThought", () => null);
  handle("settings:get", () => ({
    version: 1,
    launchAtLogin: false,
    allowReferralFunding: false,
    brain: { kind: "off", provider: "off", endpoint: "", model: "", autostart: false, hasApiKey: false },
  }));
  handle("settings:brainCapabilities", () => ({ codex: { installed: false }, claude: { installed: false } }));
  handle("update:status", () => ({ status: "disabled", currentVersion: "preview" }));
  handle("window:close", () => win?.minimize());
  handle("window:quit", () => app.quit());
}

async function main() {
  app.setPath("userData", path.join(app.getPath("temp"), "versus-hatch-preview"));
  await app.whenReady();
  installPreviewIpc();
  win = new BrowserWindow({
    width: 390,
    height: 640,
    frame: false,
    transparent: true,
    resizable: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "..", "src", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  await win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  await sleep(500);
  await win.webContents.executeJavaScript(`(async () => {
    setHatchState("funding");
    ensureDepositQr();
    const quote = await window.versus.getHatchQuote();
    await refreshHatchQuote();
    const status = document.getElementById("deposit-status");
    status.textContent = "LIVE NODE QUOTE: " + (Number(quote.previewQuoteMs) / 1000).toFixed(2) + "S | CLICK I SENT IT";
    status.classList.remove("hidden");
    return true;
  })()`, true);
  const autoCloseMs = Number(process.env.VERSUS_HATCH_PREVIEW_AUTO_CLOSE_MS || 0);
  if (Number.isFinite(autoCloseMs) && autoCloseMs > 0) {
    setTimeout(() => app.quit(), autoCloseMs).unref?.();
  }
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
