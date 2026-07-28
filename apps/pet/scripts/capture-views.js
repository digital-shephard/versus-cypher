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
const WIN_W = 454;
const WIN_H = 640;
const PREVIEW_FX_TAPE = process.argv.includes("--preview-fx-tape");
const PREVIEW_FX_REQUESTER = process.argv.includes("--preview-fx-requester");
const CAPTURE_FX_REQUESTER = process.argv.includes("--capture-fx-requester");
const CAPTURE_RUNTIME = path.join(
  path.parse(__dirname).root,
  "tmp",
  "versus-pet-capture",
  String(process.pid)
);

const STUB_ADDR = "0xA11CE00000000000000000000000000000000BEE";
let harnessWindow = null;

/** Rich active-bond fixture: mid-fill class, real-looking stats. */
const ACTIVE_BOND = {
  phase: "active",
  agentId: 1,
  cypherId: 15, // HokkaidoWave
  level: 12,
  streak: 34,
  lastCommitDay: Math.floor(Date.now() / 86_400_000),
  nextCommitAt: Math.floor(Date.now() / 1000) + 19 * 60 * 60 + 42 * 60,
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
let networkLaunchId = "42";
const FX_CAPTURE_TRADE_ID = `0x${"ab".repeat(32)}`;
let fxCaptureSnapshot = {
  version: 2,
  enabled: true,
  environment: "public-testnet",
  productionFunds: false,
  brokerConfigured: true,
  settlementConfigured: true,
  policy: {
    armed: false,
    minimumTradeUsd: 1,
    maximumTradeUsd: 50,
    maximumExposureUsd: 1_000,
    maximumRequesterExposureUsd: 100,
    maximumAssetExposureUsd: 500,
    maximumGasUsd: 5,
    maximumOverheadBps: 100,
    minimumSpreadBps: 25,
    inventoryPremiumBps: 0,
    quoteLifetimeSeconds: 30,
    reservationSeconds: 90,
  },
  chains: [
    {
      chainId: "84532",
      chainKey: "base-sepolia",
      chain: "BASE SEPOLIA",
      nativeAsset: "ETH",
      nativeDecimals: 18,
      minimumGasUsd: 1,
      enabled: true,
      rpcUrl: "",
      address: STUB_ADDR,
      dealerAddress: STUB_ADDR,
      requesterAddress: "0xB0B000000000000000000000000000000000CAFE",
      dealerBalanceAtomic: "1000000000000000",
      requesterBalanceAtomic: "1000000000000000",
      dealerGasReady: true,
      requesterGasReady: true,
      gasReady: true,
    },
    {
      chainId: "421614",
      chainKey: "arbitrum-sepolia",
      chain: "ARBITRUM SEPOLIA",
      nativeAsset: "ETH",
      nativeDecimals: 18,
      minimumGasUsd: 1,
      enabled: true,
      rpcUrl: "",
      address: STUB_ADDR,
      dealerAddress: STUB_ADDR,
      requesterAddress: "0xB0B000000000000000000000000000000000CAFE",
      dealerBalanceAtomic: "1000000000000000",
      requesterBalanceAtomic: "1000000000000000",
      dealerGasReady: true,
      requesterGasReady: true,
      gasReady: true,
    },
  ],
  positions: [
    {
      id: "base-sepolia-usdc",
      chainId: "84532",
      chainKey: "base-sepolia",
      chain: "BASE SEPOLIA",
      asset: "USDC",
      decimals: 6,
      assetAddress: "0xcba3d9354dd4c30bb6961abb4473a6340486e01b",
      enabled: true,
      usable: true,
      address: STUB_ADDR,
      availableAtomic: "0",
      reservedAtomic: "0",
      activeLocks: 0,
    },
    {
      id: "arbitrum-sepolia-usdc",
      chainId: "421614",
      chainKey: "arbitrum-sepolia",
      chain: "ARBITRUM SEPOLIA",
      asset: "USDC",
      decimals: 6,
      assetAddress: "0xcba3d9354dd4c30bb6961abb4473a6340486e01b",
      enabled: true,
      usable: true,
      address: STUB_ADDR,
      availableAtomic: "0",
      reservedAtomic: "0",
      activeLocks: 0,
    },
  ],
  trades: [],
  observations: [],
};

function fxCaptureTrade(state = "quoted") {
  const now = new Date().toISOString();
  const trade = {
    tradeId: FX_CAPTURE_TRADE_ID,
    role: "requester",
    state,
    sourcePositionId: "base-sepolia-usdc",
    destinationPositionId: "arbitrum-sepolia-usdc",
    source: {
      chainId: "84532",
      chain: "BASE SEPOLIA",
      asset: "USDC",
      decimals: 6,
      token: "0xcba3d9354dd4c30bb6961abb4473a6340486e01b",
    },
    destination: {
      chainId: "421614",
      chain: "ARBITRUM SEPOLIA",
      asset: "USDC",
      decimals: 6,
      token: "0xcba3d9354dd4c30bb6961abb4473a6340486e01b",
      address: "0x1234567890abcdef1234567890abcdef12345678",
      addressShort: "0x1234\u20265678",
    },
    outputAmountAtomic: "10000000",
    outputAmountDisplay: "10.0 USDC",
    inputAmountDisplay: "10.035 USDC",
    route: {
      dealer: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      spreadBps: 25,
      brokerFeeAtomic: "10000",
      estimatedCompletionSeconds: 24,
      expiresAt: Math.floor(Date.now() / 1000) + 30,
      totalInputAtomic: "10035000",
    },
    timeline: [
      { state: "quoted", at: now },
    ],
    createdAt: now,
    updatedAt: now,
    endpointPaymentAuthorized: false,
    endpointPaymentSubmitted: false,
  };
  if (state !== "quoted") {
    trade.funding = {
      address: STUB_ADDR,
      addressShort: "0xA11C\u20260BEE",
      chainId: "84532",
      token: trade.source.token,
      amountAtomic: "10035000",
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    };
    trade.timeline.push(
      { state: "accepted", at: now },
      { state: "awaiting_source_funds", at: now },
    );
  }
  if (state === "funds_ready") {
    trade.timeline.push(
      { state: "source_lock_confirmed", at: now },
      { state: "destination_lock_confirmed", at: now },
      { state: "funds_ready", at: now },
    );
  }
  return trade;
}

const HEALTH_FIXTURE = {
  version: 1,
  status: "attention",
  issues: [
    {
      code: "rpc_unavailable",
      subsystem: "base",
      severity: "error",
      title: "Base is unreachable",
      detail: "Chain activity is paused while public RPC service is unavailable.",
      action: "Keep Versus open and use Refresh when the connection returns.",
      firstSeenAt: Date.now() - 4000,
      lastSeenAt: Date.now(),
      occurrences: 2,
    },
    {
      code: "store_history_unavailable",
      subsystem: "waku",
      severity: "warning",
      title: "Recent Signal history is delayed",
      detail: "Live messages may work while older Waku Store history is unavailable.",
      action: "Leave Versus open. Bounded history recovery will retry automatically.",
      firstSeenAt: Date.now() - 3000,
      lastSeenAt: Date.now(),
      occurrences: 1,
    },
  ],
};

function stubIpc() {
  const activityNow = Date.now();
  ipcMain.handle("service:activitySnapshot", () => ({
    version: 1,
    telemetry: "none",
    chain: "local_sim",
    waku: "off",
    brain: "local",
    events: [
      { id: 1, at: activityNow - 3200, channel: "system", direction: "local", operation: "device_boot", destination: "local_device", status: "ready", durationMs: null, bytes: null },
      { id: 2, at: activityNow - 2900, channel: "local", direction: "local", operation: "chain_simulator", destination: "local_device", status: "ready", durationMs: null, bytes: null },
      { id: 3, at: activityNow - 2300, channel: "waku", direction: "local", operation: "mesh_config", destination: "versus_mesh", status: "off", durationMs: null, bytes: null },
      { id: 4, at: activityNow - 1800, channel: "brain", direction: "local", operation: "brain_config", destination: "local_model", status: "ready", durationMs: null, bytes: null },
      { id: 5, at: activityNow - 900, channel: "local", direction: "out", operation: "state_read", destination: "local_device", status: "pending", durationMs: null, bytes: null },
      { id: 6, at: activityNow - 868, channel: "local", direction: "in", operation: "state_read", destination: "local_device", status: "ok", durationMs: 32, bytes: 284 },
    ],
  }));
  ipcMain.handle("health:snapshot", () => HEALTH_FIXTURE);
  ipcMain.handle("diagnostics:export", () => ({ canceled: false }));
  ipcMain.handle("bond:loadLocal", () => null);
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
  ipcMain.handle("fx:addressQr", (_event, { address }) => QRCode.toDataURL(address, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 144,
    color: { dark: "#173d32ff", light: "#e3edcfff" },
  }));
  ipcMain.handle("fx:copyAddress", (_event, { address }) => address);
  ipcMain.handle("fx:snapshot", () => structuredClone(fxCaptureSnapshot));
  ipcMain.handle("fx:setEnabled", (_event, { enabled }) => {
    fxCaptureSnapshot.enabled = enabled === true;
    return structuredClone(fxCaptureSnapshot);
  });
  ipcMain.handle("fx:setPolicy", (_event, { patch }) => {
    fxCaptureSnapshot.policy = { ...fxCaptureSnapshot.policy, ...patch };
    return structuredClone(fxCaptureSnapshot);
  });
  ipcMain.handle("fx:setPositionEnabled", (_event, { id, enabled }) => {
    const position = fxCaptureSnapshot.positions.find((entry) => entry.id === id);
    if (position) position.enabled = enabled === true;
    return structuredClone(fxCaptureSnapshot);
  });
  ipcMain.handle("fx:setChainSettings", (_event, { chainId, patch }) => {
    const chain = fxCaptureSnapshot.chains.find(
      (entry) => entry.chainId === String(chainId)
    );
    if (chain) Object.assign(chain, patch);
    return structuredClone(fxCaptureSnapshot);
  });
  ipcMain.handle("fx:withdrawPosition", (_event, input) => ({
    ...structuredClone(fxCaptureSnapshot),
    inventoryTransfer: {
      ...input,
      transactionHash: `0x${"77".repeat(32)}`,
    },
  }));
  ipcMain.handle("fx:requestQuote", () => {
    const trade = fxCaptureTrade("quoted");
    fxCaptureSnapshot.trades = [trade];
    return structuredClone(trade);
  });
  ipcMain.handle("fx:acceptQuote", async () => {
    const trade = fxCaptureTrade("awaiting_source_funds");
    fxCaptureSnapshot.trades = [trade];
    return structuredClone(trade);
  });
  ipcMain.handle("fx:checkFunding", () => {
    const trade = fxCaptureTrade("funds_ready");
    fxCaptureSnapshot.trades = [trade];
    return structuredClone(trade);
  });
  ipcMain.handle("fx:cancel", () => {
    const trade = fxCaptureTrade("cancelled");
    trade.timeline.push({
      state: "cancelled",
      at: new Date().toISOString(),
    });
    trade.cancellation = {
      reason: "owner_cancelled",
    };
    fxCaptureSnapshot.trades = [trade];
    return structuredClone(trade);
  });
  ipcMain.handle("fx:refund", () => structuredClone(fxCaptureSnapshot.trades[0]));
  ipcMain.handle("fx:reconcile", () => structuredClone(fxCaptureSnapshot.trades[0]));
  ipcMain.handle("fx:trade", () => structuredClone(fxCaptureSnapshot.trades[0] || null));
  ipcMain.handle("fx:exportEvidence", () => null);
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
  ipcMain.handle("wallet:getReferralStatus", () => ({ funded: true, rewardPerReferral: 1_000_000, availableRewards: 12, demo: true }));
  ipcMain.handle("wallet:setReferralCode", (_event, { code }) => code
    ? { code: String(code).toUpperCase(), referrerAgentId: 1042, rewardPerReferral: 1_000_000, availableRewards: 12 }
    : { skipped: true });
  ipcMain.handle("wallet:getReferralCode", () => "VRS-1-3C");
  ipcMain.handle("wallet:copyReferralCode", () => "VRS-1-3C");
  ipcMain.handle("wallet:fundReferralPool", () => ({ amount: 1_000_000, demo: true }));
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
  ipcMain.handle("wallet:runOnboardPipeline", async () => {
    await sleep(2400);
    return ACTIVE_BOND;
  });
  ipcMain.handle("rain:next", () => ({ drop: null, pending: 0, nextAt: null }));
  ipcMain.handle("network:status", () => ({
    active: true,
    launchId: networkLaunchId,
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
    launchId: networkLaunchId,
    postcardCount: 28,
    proposalCount: 3,
    currentReferralDrive: {
      proposalId: `0x${"3".repeat(64)}`,
      launchId: networkLaunchId,
      createdAt: Date.now(),
      approvedAt: Date.now(),
      body: "turn the daily launch into a midnight signal garden",
      fundingGoalMicros: "25000000",
      supporters: 3,
      detractors: 1,
      referralCode: "VRS-1-3C",
    },
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
    allowReferralFunding: false,
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
  ipcMain.handle("settings:brainCapabilities", () => ({
    codex: { installed: true },
    claude: { installed: true },
  }));
  ipcMain.handle("update:status", () => ({
    status: "disabled", currentVersion: "0.1.0", availableVersion: null, progress: null, error: null,
  }));
  ipcMain.handle("settings:save", (_event, settings) => settings);
  ipcMain.handle("settings:testBrain", () => ({ ok: true, silent: false, model: "gemma-3-12b-it" }));
  ipcMain.handle("window:close", () => harnessWindow?.close());
  ipcMain.handle("window:quit", () => app.quit());
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
  fs.mkdirSync(CAPTURE_RUNTIME, { recursive: true });
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch(
    "disk-cache-dir",
    path.join(CAPTURE_RUNTIME, "cache")
  );
  app.setPath("userData", path.join(CAPTURE_RUNTIME, "profile"));
  app.setPath("cache", path.join(CAPTURE_RUNTIME, "cache"));
  await app.whenReady();
  fs.mkdirSync(OUT, { recursive: true });
  stubIpc();

  const win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    show: PREVIEW_FX_TAPE || PREVIEW_FX_REQUESTER,
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
      offscreen: !(PREVIEW_FX_TAPE || PREVIEW_FX_REQUESTER), // full-rate rAF without showing a window
    },
  });
  harnessWindow = win;
  win.webContents.setFrameRate(60);
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) console.error(`[renderer] ${message}`);
  });

  await win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  await sleep(900);

  if (PREVIEW_FX_REQUESTER || CAPTURE_FX_REQUESTER) {
    await exec(win, `
      __pet.setBond(${JSON.stringify(ACTIVE_BOND)});
      __pet.showClass();
      __pet.setSurface("fx");
      document.getElementById("fx-open-swap").click();
      document.getElementById("fx-swap-amount").value = "10";
      document.getElementById("fx-swap-recipient").value = "0x1234567890abcdef1234567890abcdef12345678";
      document.getElementById("fx-swap-recipient").dispatchEvent(new Event("blur"));
    `);
    await sleep(650);
    if (PREVIEW_FX_REQUESTER) return;
    await shoot(win, "10f-fx-requester-entry");
    await exec(win, `document.getElementById("fx-get-quotes").click();`);
    await sleep(300);
    await shoot(win, "10f-fx-requester-quote");
    await exec(win, `document.getElementById("fx-requester-back").click();`);
    await sleep(180);
    await shoot(win, "10f-fx-requester-return");
    await exec(win, `document.getElementById("fx-get-quotes").click();`);
    await sleep(300);
    await exec(win, `document.getElementById("fx-accept-quote").click();`);
    await sleep(750);
    await shoot(win, "10f-fx-requester-funding");
    await exec(win, `document.getElementById("fx-check-funding").click();`);
    await sleep(450);
    await shoot(win, "10f-fx-requester-settled");
    console.log(`done \u2192 ${OUT}`);
    app.exit(0);
    return;
  }

  if (PREVIEW_FX_TAPE) {
    await exec(win, `
      __pet.setBond(${JSON.stringify(ACTIVE_BOND)});
      __pet.showClass();
      __pet.setFxDemo(true);
      __pet.setSurface("fx");
      __pet.setFxMode("tape");
      __pet.playFxTapeDemo(850);
    `);
    const replay = setInterval(() => {
      if (win.isDestroyed()) return;
      exec(win, `__pet.playFxTapeDemo(850);`).catch(() => {});
    }, 5_600);
    win.once("closed", () => clearInterval(replay));
    return;
  }

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

  const windowControlTargets = await win.webContents.executeJavaScript(`(() => {
    return ["btn-hide", "btn-quit"].map((id) => {
      const button = document.getElementById(id);
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return { id, left: rect.left, top: rect.top, width: rect.width, height: rect.height, hitId: hit?.id || "" };
    });
  })()`, true);
  if (windowControlTargets.some((target) => target.width < 24 || target.height < 24 || target.hitId !== target.id)) {
    throw new Error(`window controls are not clickable: ${JSON.stringify(windowControlTargets)}`);
  }

  if (process.env.CAPTURE_SERVICE_ONLY === "1") {
    await exec(win, `__pet.setBond(${JSON.stringify(ACTIVE_BOND)}); __pet.showClass(); __pet.setMode("raft"); __pet.setPhase("noon");`);
    await sleep(700);
    await shoot(win, "service-01-assembled");

    const holeAlignment = await win.webContents.executeJavaScript(`(() => {
      return [0, 1, 2, 3].map((id) => {
        const screwRect = document.querySelector(\`[data-screw-id="\${id}"]\`).getBoundingClientRect();
        const holeRect = document.querySelector(\`[data-screw-hole-id="\${id}"]\`).getBoundingClientRect();
        const socketRect = document.querySelector(\`[data-screw-socket-id="\${id}"]\`).getBoundingClientRect();
        return {
          id,
          dx: Math.abs((screwRect.left + screwRect.width / 2) - (holeRect.left + holeRect.width / 2)),
          dy: Math.abs((screwRect.top + screwRect.height / 2) - (holeRect.top + holeRect.height / 2)),
          socketDx: Math.abs((screwRect.left + screwRect.width / 2) - (socketRect.left + socketRect.width / 2)),
          socketDy: Math.abs((screwRect.top + screwRect.height / 2) - (socketRect.top + socketRect.height / 2)),
        };
      });
    })()`, true);
    if (holeAlignment.some(({ dx, dy, socketDx, socketDy }) => dx > 1 || dy > 1 || socketDx > 1 || socketDy > 1)) {
      throw new Error(`CSS screw holes are misaligned before opening: ${JSON.stringify(holeAlignment)}`);
    }

    // Every fastener is independently reversible before the chassis opens.
    await exec(win, `document.querySelector('[data-screw-id="1"]').click();`);
    await sleep(700);
    const oneRemoved = await win.webContents.executeJavaScript(`(() => ({
      stage: document.getElementById("shell").dataset.serviceStage,
      installed: document.querySelectorAll("[data-screw-id].is-visible").length,
      loose: document.querySelectorAll("[data-loose-screw-id].is-visible").length,
      returnEnabled: !document.querySelector('[data-loose-screw-id="1"]').disabled,
    }))()`, true);
    if (oneRemoved.stage !== "closed" || oneRemoved.installed !== 3 || oneRemoved.loose !== 1 || !oneRemoved.returnEnabled) {
      throw new Error(`one removed screw could not be independently returned: ${JSON.stringify(oneRemoved)}`);
    }
    await exec(win, `document.querySelector('[data-loose-screw-id="1"]').click();`);
    await sleep(1100);

    await exec(win, `
      document.querySelector('[data-screw-id="3"]').click();
      document.querySelector('[data-screw-id="0"]').click();
    `);
    await sleep(700);
    const twoRemoved = await win.webContents.executeJavaScript(`(() => ({
      stage: document.getElementById("shell").dataset.serviceStage,
      installed: document.querySelectorAll("[data-screw-id].is-visible").length,
      loose: document.querySelectorAll("[data-loose-screw-id].is-visible").length,
      returnOrderEnabled: [0, 3].every((id) => !document.querySelector('[data-loose-screw-id="' + id + '"]').disabled),
    }))()`, true);
    if (twoRemoved.stage !== "closed" || twoRemoved.installed !== 2 || twoRemoved.loose !== 2 || !twoRemoved.returnOrderEnabled) {
      throw new Error(`multiple removed screws could not be independently returned: ${JSON.stringify(twoRemoved)}`);
    }
    await exec(win, `
      document.querySelector('[data-loose-screw-id="0"]').click();
      document.querySelector('[data-loose-screw-id="3"]').click();
    `);
    await sleep(1100);
    const partialReassembled = await win.webContents.executeJavaScript(`(() => ({
      stage: document.getElementById("shell").dataset.serviceStage,
      installed: document.querySelectorAll("[data-screw-id].is-visible").length,
      loose: document.querySelectorAll("[data-loose-screw-id].is-visible").length,
    }))()`, true);
    if (partialReassembled.stage !== "closed" || partialReassembled.installed !== 4 || partialReassembled.loose !== 0) {
      throw new Error(`partial screw reversal did not restore the device: ${JSON.stringify(partialReassembled)}`);
    }

    await exec(win, `document.querySelectorAll("[data-screw-id]").forEach((button) => button.click());`);
    await sleep(2100);
    const opened = await win.webContents.executeJavaScript(`(() => ({
      stage: document.getElementById("shell").dataset.serviceStage,
      installed: document.querySelectorAll("[data-screw-id].is-visible").length,
      loose: document.querySelectorAll("[data-loose-screw-id].is-visible").length,
    }))()`, true);
    if (opened.stage !== "open" || opened.installed !== 0 || opened.loose !== 4) {
      throw new Error(`service chassis did not open cleanly: ${JSON.stringify(opened)}`);
    }
    const separatedLayers = await win.webContents.executeJavaScript(`(() => {
      return [0, 1, 2, 3].map((id) => {
        const screw = document.querySelector(\`[data-screw-id="\${id}"]\`);
        const hole = document.querySelector(\`[data-screw-hole-id="\${id}"]\`);
        const socket = document.querySelector(\`[data-screw-socket-id="\${id}"]\`);
        screw.classList.add("is-targeting");
        const screwRect = screw.getBoundingClientRect();
        const holeRect = hole.getBoundingClientRect();
        const socketRect = socket.getBoundingClientRect();
        screw.classList.remove("is-targeting");
        return {
          id,
          socketDx: Math.abs((screwRect.left + screwRect.width / 2) - (socketRect.left + socketRect.width / 2)),
          socketDy: Math.abs((screwRect.top + screwRect.height / 2) - (socketRect.top + socketRect.height / 2)),
          holeTravel: (holeRect.top + holeRect.height / 2) - (socketRect.top + socketRect.height / 2),
        };
      });
    })()`, true);
    if (separatedLayers.some(({ socketDx, socketDy, holeTravel }) => socketDx > 1 || socketDy > 1 || holeTravel < 500)) {
      throw new Error(`faceplate holes did not separate from chassis sockets: ${JSON.stringify(separatedLayers)}`);
    }
    await shoot(win, "service-02-open");

    await exec(win, `document.getElementById("faceplate-layer").click();`);
    await sleep(900);
    const returned = await win.webContents.executeJavaScript(`document.getElementById("shell").dataset.serviceStage`, true);
    if (returned !== "awaiting-screws") throw new Error(`faceplate did not return before screws: ${returned}`);
    await shoot(win, "service-03-faceplate-returned");

    await exec(win, `document.getElementById("faceplate-layer").click();`);
    await sleep(900);
    const reopened = await win.webContents.executeJavaScript(`document.getElementById("shell").dataset.serviceStage`, true);
    if (reopened !== "open") throw new Error(`loose faceplate did not lower again: ${reopened}`);
    await shoot(win, "service-03b-reopened");

    await exec(win, `document.getElementById("faceplate-layer").click();`);
    await sleep(900);
    const readyToScrew = await win.webContents.executeJavaScript(`document.getElementById("shell").dataset.serviceStage`, true);
    if (readyToScrew !== "awaiting-screws") throw new Error(`faceplate did not return after second opening: ${readyToScrew}`);

    await exec(win, `document.querySelectorAll("[data-loose-screw-id]").forEach((button) => button.click());`);
    await sleep(1500);
    const reassembled = await win.webContents.executeJavaScript(`(() => ({
      stage: document.getElementById("shell").dataset.serviceStage,
      installed: document.querySelectorAll("[data-screw-id].is-visible").length,
      loose: document.querySelectorAll("[data-loose-screw-id].is-visible").length,
    }))()`, true);
    if (reassembled.stage !== "closed" || reassembled.installed !== 4 || reassembled.loose !== 0) {
      throw new Error(`service chassis did not reassemble cleanly: ${JSON.stringify(reassembled)}`);
    }
    await shoot(win, "service-04-reassembled");
    console.log(`done -> ${OUT}`);
    app.exit(0);
    return;
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

  await exec(win, `document.getElementById("view-deposit").dataset.hatchState = "funding"; refreshHatchQuote();`);
  await sleep(350);
  await shoot(win, "01b-deposit-qr");

  await exec(win, `document.getElementById("view-deposit").dataset.hatchState = "referral";`);
  await sleep(350);
  await shoot(win, "01c-deposit-referral");

  await exec(win, `setHatchState("lifting");`);
  await sleep(450);
  await shoot(win, "01d-hatch-lifting");

  await exec(win, `setHatchState("incubating");`);
  await sleep(600);
  await shoot(win, "02-hatch-incubating");

  await exec(win, `document.getElementById("view-deposit").dataset.hatchState = "funding"; __pet.runHatchRitual(false);`);
  await sleep(900);
  await shoot(win, "03-hatch-waiting");
  await sleep(1800);
  await shoot(win, "05-hatch-whiteout");
  await sleep(1200);
  await shoot(win, "06-hatch-reveal");

  // Active class scene, per time-of-day, with rain falling.
  await exec(win, `__pet.setBond(${JSON.stringify(ACTIVE_BOND)}); __pet.showClass();`);
  await sleep(300);

  for (const phase of ["morning", "noon", "evening", "night"]) {
    await exec(win, `
      __pet.setPhase("${phase}");
      __pet.storm(0.5);
      const pot = Number(__pet.getBond().classPotMicros || 0);
      __pet.verifiedRainDrop("peer", pot + 10000);
      __pet.verifiedRainDrop("peer", pot + 20000);
    `);
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

  networkLaunchId = "43";
  await exec(win, `return refreshNetworkScreen();`);
  await sleep(150);
  const signalClassLabel = await win.webContents.executeJavaScript(
    `document.getElementById("signal-launch")?.textContent`,
    true,
  );
  if (signalClassLabel !== "CLASS 43") {
    throw new Error(`Signal class did not follow rollover: ${signalClassLabel}`);
  }
  await shoot(win, "10bb-mode-signal-class-rollover");

  await exec(win, `document.getElementById("btn-signal-flip").click();`);
  await sleep(650);
  await shoot(win, "10c-mode-signal-brain");

  await exec(win, `__pet.setSurface("cypher"); __pet.setFxMode("desk"); document.getElementById("btn-fx-wheel").click();`);
  await sleep(450);
  const fxSurface = await win.webContents.executeJavaScript(`document.getElementById("shell").dataset.surface`, true);
  if (fxSurface !== "fx") throw new Error(`FX wheel did not open the FX surface: ${fxSurface}`);
  await shoot(win, "10d-fx-desk");

  for (const mode of ["stock", "tape", "risk"]) {
    await exec(win, `document.getElementById("btn-mode").click();`);
    await sleep(250);
    const visibleMode = await win.webContents.executeJavaScript(`document.getElementById("shell").dataset.fxMode`, true);
    if (visibleMode !== mode) throw new Error(`MODE did not advance FX tab to ${mode}: ${visibleMode}`);
    await shoot(win, `10d-fx-${mode}`);
  }

  // Sample dealer rows so the populated layouts stay reviewable while the FX backend is unbuilt.
  await exec(win, `__pet.setFxDemo(true);`);
  await exec(win, `__pet.setFxMode("desk");`);
  await sleep(800);
  await shoot(win, "10e-fx-desk-open");
  for (const mode of ["stock", "tape", "risk"]) {
    await exec(win, `__pet.setFxMode("${mode}");`);
    await sleep(250);
    await shoot(win, `10e-fx-${mode}-populated`);
  }
  await exec(win, `__pet.setFxMode("tape"); __pet.playFxTapeDemo(700);`);
  await sleep(140);
  await shoot(win, "10e-fx-tape-feed-empty");
  await sleep(520);
  await shoot(win, "10e-fx-tape-feed-first");
  await sleep(760);
  await shoot(win, "10e-fx-tape-feed-second");
  await exec(win, `__pet.setFxMode("stock"); document.getElementById("fx-add-position").click();`);
  await sleep(250);
  await shoot(win, "10e-fx-supported-assets");
  await exec(win, `document.querySelector('#fx-add-position-sheet [data-fx-sheet-close]').click();`);
  await exec(win, `document.querySelector('[data-position-id="base-sepolia-usdc"] .fx-act-fill').click();`);
  await sleep(400);
  await shoot(win, "10e-fx-deposit-sheet");
  await exec(win, `document.querySelector('#fx-deposit-sheet [data-fx-sheet-close]').click(); document.querySelector('[data-position-id="base-sepolia-usdc"] .fx-bay-acts .fx-act:nth-child(2)').click();`);
  await sleep(250);
  await shoot(win, "10e-fx-withdraw-sheet");
  await exec(win, `document.querySelector('#fx-withdraw-sheet [data-fx-sheet-close]').click(); __pet.setFxDemo(false); __pet.setFxMode("desk");`);
  await sleep(200);

  await exec(win, `document.getElementById("btn-fx-wheel").click();`);
  await sleep(250);
  const cypherSurface = await win.webContents.executeJavaScript(`document.getElementById("shell").dataset.surface`, true);
  if (cypherSurface !== "cypher") throw new Error(`FX wheel did not return to the Cypher surface: ${cypherSurface}`);
  await exec(win, `__pet.setMode("network");`);
  await sleep(200);
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

  await exec(win, `document.getElementById("settings-tab-health").click();`);
  await sleep(250);
  const healthLayout = await win.webContents.executeJavaScript(`(() => {
    const panel = document.getElementById("settings-health-panel");
    const screen = document.getElementById("settings-screen");
    const panelRect = panel.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const clipped = [...panel.querySelectorAll("strong,small,p,button")].filter((node) =>
      node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1
    ).map((node) => node.id || node.className || node.tagName);
    return {
      inside: panelRect.left >= screenRect.left && panelRect.right <= screenRect.right && panelRect.bottom <= screenRect.bottom,
      clipped,
      issueCount: panel.querySelectorAll(".health-issue").length,
    };
  })()`, true);
  if (!healthLayout.inside || healthLayout.clipped.length || healthLayout.issueCount !== 2) {
    throw new Error(`health layout failed: ${JSON.stringify(healthLayout)}`);
  }
  await shoot(win, "14b-settings-health");

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
