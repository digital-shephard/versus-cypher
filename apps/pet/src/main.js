const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, clipboard, safeStorage, dialog, powerMonitor } = require("electron");
const path = require("path");
const fs = require("fs");
const { Wallet } = require("ethers");
const QRCode = require("qrcode");
const { chooseRandomCypher } = require("./random");
const { normalizeRainPennies, applyConfirmedRain } = require("./rain");
const { availableReferralRewards, parseReferralCode, referralCodeFor } = require("./referrals");
const { loadChainConfig, createChainRainService } = require("./chain");
const { createPetNetworkService } = require("./network");
const { createAgentBrain, detectAgentAdapters, loadAgentBrainConfig } = require("./brain");
const { brainEnvironment, normalizeSettings, publicSettings } = require("./settings");
const {
  createCypherArchive,
  createWalletBackup,
  openCypherArchive,
  openWalletBackup,
} = require("./wallet-backup");
const {
  DAY_SECONDS,
  DailyLifecycleScheduler,
  commitIsDue,
  nextCadenceStreak,
  nextCommitAtFor,
} = require("./daily-lifecycle");
const { ServiceActivityBus } = require("./activity-bus");
const { createUpdateService } = require("./update-service");
const { createDiagnosticsReport } = require("./diagnostics");
const { FaultInjector } = require("./fault-injection");
const { HealthMonitor } = require("./health");
const { OperationJournal } = require("./operation-journal");
const { RainInbox } = require("./rain-inbox");
const { acknowledgeGraduation, recordGraduationTransition } = require("./graduation");
const { quarantineDatabaseFiles } = require("./local-recovery");
const {
  createTrustedIpcRegistrar,
  hardenRendererWindow,
  trustedFileUrl,
} = require("./electron-security");
const buildMetadata = require("../package.json");

function configureStableIdentity() {
  app.setName("Versus Cypher");
  app.setAppUserModelId("network.versus.cypher");
}

configureStableIdentity();

const { autoUpdater } = require("electron-updater");

function applyPackagedWalkthroughProfile() {
  if (!app.isPackaged) return false;
  const marker = path.join(process.resourcesPath, "versus-walkthrough-profile.json");
  if (!fs.existsSync(marker)) return false;
  const config = JSON.parse(fs.readFileSync(marker, "utf8"));
  if (config?.version !== 1 || !path.isAbsolute(config.userDataPath)) {
    throw new Error("Versus walkthrough profile marker is invalid");
  }
  const allowedEnvironment = new Set([
    "VERSUS_RPC_URL",
    "VERSUS_DEPLOYMENT",
    "VERSUS_P2P_TRANSPORT",
    "VERSUS_AGENT_AUTOSTART",
    "VERSUS_AGENT_TIMEOUT_MS",
    "VERSUS_WALKTHROUGH_EVIDENCE_DIR",
    "VERSUS_WALKTHROUGH_DEVICE_SCALE",
    "VERSUS_FAULTS",
  ]);
  for (const [key, value] of Object.entries(config.environment || {})) {
    if (!allowedEnvironment.has(key) || typeof value !== "string" || !value.trim()) {
      throw new Error(`Versus walkthrough environment entry ${key} is invalid`);
    }
    process.env[key] = value.trim();
  }
  if (process.env.VERSUS_DEPLOYMENT && !path.isAbsolute(process.env.VERSUS_DEPLOYMENT)) {
    throw new Error("Versus walkthrough deployment path must be absolute");
  }
  if (process.env.VERSUS_WALKTHROUGH_EVIDENCE_DIR && !path.isAbsolute(process.env.VERSUS_WALKTHROUGH_EVIDENCE_DIR)) {
    throw new Error("Versus walkthrough evidence path must be absolute");
  }
  if (process.env.VERSUS_WALKTHROUGH_DEVICE_SCALE) {
    const scale = Number(process.env.VERSUS_WALKTHROUGH_DEVICE_SCALE);
    if (![1, 1.25, 1.5].includes(scale)) throw new Error("Versus walkthrough device scale is invalid");
    app.commandLine.appendSwitch("force-device-scale-factor", String(scale));
  }
  app.setPath("userData", path.resolve(config.userDataPath));
  app.setName("Versus Walkthrough");
  app.setAppUserModelId("fun.versus.pet.walkthrough");
  return true;
}

const WALKTHROUGH_PROFILE = applyPackagedWalkthroughProfile();

const STATE_PATH = path.join(app.getPath("userData"), "bond.json");
const WALLET_PATH = path.join(app.getPath("userData"), "wallet.json");
const SETTINGS_PATH = path.join(app.getPath("userData"), "settings.json");
const OPERATION_JOURNAL_PATH = path.join(app.getPath("userData"), "economic-operations.json");
const NETWORK_DATA_DIR = path.join(app.getPath("userData"), "network");
const RAIN_INBOX_PATH = path.join(app.getPath("userData"), "verified-rain.json");
const RENDERER_PATH = path.join(__dirname, "..", "renderer", "index.html");
const TRUSTED_RENDERER_URL = trustedFileUrl(RENDERER_PATH);
const registerIpcHandle = createTrustedIpcRegistrar(ipcMain, TRUSTED_RENDERER_URL);
const WIN_W = 390;
const WIN_H = 640;

/** Local demo stand-in for the roughly $10 funded hatch. */
const DEMO_DEPOSIT_WEI = "3000000000000000";

let mainWindow = null;
let tray = null;
let pollTimer = null;
let stateSyncTimer = null;
let rainLock = Promise.resolve();
let dailyRainInFlight = null;
let dailyLifecycleScheduler = null;
let signalSettlementLock = Promise.resolve();
let chainRainService = null;
let chainConfigError = null;
let networkService = null;
let networkStart = null;
let networkUnavailableReason = null;
let updateService = null;
const activityBus = new ServiceActivityBus({ limit: 128 });
const activityStates = new Map();
const healthMonitor = new HealthMonitor();
const faultInjector = new FaultInjector((!app.isPackaged || WALKTHROUGH_PROFILE) ? process.env.VERSUS_FAULTS : "");
const operationJournal = new OperationJournal({ filePath: OPERATION_JOURNAL_PATH });
const rainInbox = new RainInbox({ filePath: RAIN_INBOX_PATH });

function publishHealth(snapshot = healthMonitor.snapshot()) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send("health:changed", snapshot);
}

healthMonitor.on("changed", publishHealth);

function resolveOperationHealth(event = {}) {
  const channel = String(event.channel || "");
  const operation = String(event.operation || "");
  if (channel === "base" && operation === "state_sync") healthMonitor.resolve("rpc_unavailable");
  if (channel === "waku" && operation === "mesh_start") healthMonitor.resolve("waku_unavailable");
  if (channel === "brain") {
    healthMonitor.resolve("brain_unavailable");
    healthMonitor.resolve("brain_malformed");
  }
  if (operation === "update_check") healthMonitor.resolve("update_unavailable");
}

function recordActivityState(key, event) {
  const state = `${event.channel}:${event.operation}:${event.status}:${event.destination || ""}`;
  if (activityStates.get(key) === state) return null;
  activityStates.set(key, state);
  return activityBus.record(event);
}

async function observeActivity(event, task) {
  const finish = activityBus.begin(event);
  try {
    const result = await task();
    finish("ok");
    resolveOperationHealth(event);
    return result;
  } catch (error) {
    finish("error");
    healthMonitor.report(error, event);
    throw error;
  }
}

try {
  chainRainService = createChainRainService(loadChainConfig());
} catch (err) {
  chainConfigError = err;
  console.error("Versus chain configuration error:", err.message);
}

activityBus.record({ channel: "system", operation: "device_boot", destination: "local_device", status: "ready" });
activityBus.record(chainConfigError
  ? { channel: "base", operation: "chain_config", destination: "base", status: "error" }
  : chainRainService
    ? { channel: "base", operation: "chain_config", destination: "base", status: "ready" }
    : { channel: "local", operation: "chain_simulator", destination: "local_device", status: "ready" });

activityBus.on("event", (event) => {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send("service:activity", event);
});

function serviceActivitySnapshot() {
  const settings = loadSettings();
  let transport = null;
  try { transport = networkService?.status?.().transportStatus || null; } catch (_) {}
  return {
    version: 1,
    telemetry: "none",
    chain: chainConfigError ? "error" : chainRainService ? "base" : "local_sim",
    waku: transport?.state || (networkUnavailableReason ? "off" : "not_configured"),
    brain: settings.brain.kind === "off" ? "off" : settings.brain.kind,
    health: healthMonitor.snapshot(),
    events: activityBus.snapshot(),
  };
}

function refreshHealthSnapshot() {
  const state = loadState() || {};
  if (operationJournal.damaged) {
    healthMonitor.report(Object.assign(new Error("Economic operation journal is damaged"), { code: "DATABASE_DAMAGED" }), {
      channel: "disk", operation: "operation_journal",
    });
  }
  if (operationJournal.pending().length) {
    healthMonitor.report(Object.assign(new Error("Transaction confirmation is uncertain"), { code: "TRANSACTION_UNCERTAIN" }), {
      channel: "base", operation: "operation_recovery",
    });
  } else {
    healthMonitor.resolve("transaction_uncertain");
  }
  if (state.phase === "active") {
    if (Number(state.runway || 0) < 10_000) {
      healthMonitor.report(Object.assign(new Error("Cypher runway is empty"), { code: "EMPTY_RUNWAY" }), {
        operation: "runway_check",
      });
    } else {
      healthMonitor.resolve("runway_depleted");
    }
    if (/^\d+$/.test(String(state.ethGasReserveWei || "")) && BigInt(state.ethGasReserveWei || 0) === 0n) {
      healthMonitor.report(Object.assign(new Error("Not enough ETH remains for gas"), { code: "INSUFFICIENT_GAS" }), {
        operation: "gas_check",
      });
    } else {
      healthMonitor.resolve("insufficient_gas");
    }
  }
  try {
    const status = networkService?.status?.();
    const transportState = String(status?.transportStatus?.state || "").toLowerCase();
    if (["offline", "error"].includes(transportState)) {
      healthMonitor.report(Object.assign(new Error("Waku relay is unavailable"), { code: "WAKU_UNAVAILABLE" }), {
        channel: "waku", operation: "mesh_state",
      });
    }
    if (transportState === "degraded_store") {
      healthMonitor.report(Object.assign(new Error("Waku Store history is unavailable"), { code: "WAKU_STORE_UNAVAILABLE" }), {
        channel: "waku", operation: "store_sync", store: true,
      });
    }
    if (status?.localDatabase?.integrity === "failed") {
      healthMonitor.report(Object.assign(new Error("Local database integrity check failed"), { code: "DATABASE_DAMAGED" }), {
        channel: "disk", operation: "database_check",
      });
    }
  } catch (error) {
    healthMonitor.report(error, { channel: "disk", operation: "database_check" });
  }
  return healthMonitor.snapshot();
}

async function exportDiagnostics() {
  await reconcileOperationJournal();
  const service = serviceActivitySnapshot();
  let network = {};
  try { network = networkService?.status?.() || {}; } catch (error) {
    healthMonitor.report(error, { channel: "disk", operation: "database_check" });
  }
  const report = createDiagnosticsReport({
    generatedAt: Date.now(),
    application: {
      version: app.getVersion(),
      packaged: app.isPackaged,
      platform: process.platform,
      architecture: process.arch,
    },
    service,
    health: refreshHealthSnapshot(),
    state: loadState() || {},
    network,
    update: updateService?.getState?.() || {},
    operations: operationJournal.summary(),
    activity: service.events,
  });
  const stamp = new Date().toISOString().slice(0, 10);
  const selected = await dialog.showSaveDialog(mainWindow, {
    title: "Export Versus diagnostics",
    defaultPath: backupDefaultPath(`versus-cypher-diagnostics-${stamp}.txt`),
    filters: [{ name: "Versus diagnostics", extensions: ["txt"] }],
  });
  if (selected.canceled || !selected.filePath) return { canceled: true };
  fs.writeFileSync(selected.filePath, report, { encoding: "utf8", mode: 0o600 });
  activityBus.record({ channel: "disk", operation: "diagnostics_export", destination: "owner_file", status: "ok" });
  return { canceled: false };
}

async function runJournaledOperation({ key, kind, agentId = null }, task) {
  operationJournal.begin(key, kind, { agentId });
  const onSubmitted = async (transactionHash) => operationJournal.submitted(key, transactionHash);
  try {
    const result = await task(onSubmitted);
    operationJournal.complete(key, {
      transactionHash: result?.hash || operationJournal.current(key)?.transactionHash || null,
      blockNumber: result?.blockNumber ?? null,
    });
    if (operationJournal.pending().length === 0) healthMonitor.resolve("transaction_uncertain");
    return result;
  } catch (error) {
    const current = operationJournal.current(key);
    if (current?.status === "submitted" || error?.code === "TRANSACTION_UNCERTAIN") {
      operationJournal.uncertain(key);
      healthMonitor.report(Object.assign(new Error("Transaction confirmation is uncertain"), { code: "TRANSACTION_UNCERTAIN" }), {
        channel: "base", operation: kind,
      });
    } else {
      operationJournal.fail(key, "preflight_failed");
    }
    throw error;
  }
}

async function reconcileOperationJournal() {
  if (!chainRainService) return operationJournal.summary();
  for (const record of operationJournal.pending()) {
    if (!record.transactionHash) {
      operationJournal.uncertain(record.key);
      healthMonitor.report(Object.assign(new Error("Transaction confirmation is uncertain"), { code: "TRANSACTION_UNCERTAIN" }), {
        channel: "base", operation: record.kind,
      });
      continue;
    }
    try {
      const result = await chainRainService.transactionStatus(record.transactionHash);
      if (result.status === "pending") {
        operationJournal.uncertain(record.key);
        healthMonitor.report(Object.assign(new Error("Transaction confirmation is uncertain"), { code: "TRANSACTION_UNCERTAIN" }), {
          channel: "base", operation: record.kind,
        });
      } else if (result.status === "failed") {
        operationJournal.fail(record.key, "transaction_reverted");
      } else {
        operationJournal.complete(record.key, result);
        await reconcileChainState();
      }
    } catch (error) {
      operationJournal.uncertain(record.key);
      healthMonitor.report(Object.assign(new Error("Transaction confirmation is uncertain"), { code: "TRANSACTION_UNCERTAIN" }), {
        channel: "base", operation: record.kind,
      });
    }
  }
  if (operationJournal.pending().length === 0) healthMonitor.resolve("transaction_uncertain");
  return operationJournal.summary();
}

function loadJson(file, fallback = null) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {}
  return fallback;
}

function saveJson(file, data) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch (_) {}
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch (_) {}
}

function backupDefaultPath(fileName) {
  const directory = WALKTHROUGH_PROFILE && process.env.VERSUS_WALKTHROUGH_EVIDENCE_DIR
    ? process.env.VERSUS_WALKTHROUGH_EVIDENCE_DIR
    : app.getPath("documents");
  return path.join(directory, fileName);
}

function walkthroughNetworkStateFixture() {
  if (!WALKTHROUGH_PROFILE || !process.env.VERSUS_WALKTHROUGH_EVIDENCE_DIR) return null;
  const file = path.join(process.env.VERSUS_WALKTHROUGH_EVIDENCE_DIR, "network-state-fixture.json");
  const fixture = loadJson(file, null);
  return fixture && new Set(["offline", "reconnecting", "caught_up", "degraded_store"]).has(fixture.state)
    ? fixture
    : null;
}

function applyWalkthroughNetworkStateFixture(status) {
  const fixture = walkthroughNetworkStateFixture();
  if (!fixture) return status;
  const active = fixture.state !== "offline";
  return {
    ...status,
    active,
    reason: active ? status.reason : "walkthrough_offline_fixture",
    transportStatus: {
      ...(status.transportStatus || {}),
      transport: "waku",
      state: fixture.state,
      changedAt: fixture.updatedAt,
      error: fixture.state === "degraded_store" ? "walkthrough Store recovery unavailable" : null,
      historySync: fixture.state === "caught_up"
        ? { received: Number(status.postcardCount || 0), completedAt: fixture.updatedAt }
        : status.historySync || null,
    },
  };
}

function applyLaunchAtLogin(openAtLogin) {
  const options = {
    openAtLogin: Boolean(openAtLogin),
    openAsHidden: false,
    ...(process.platform === "win32" ? {
      enabled: Boolean(openAtLogin),
      name: WALKTHROUGH_PROFILE ? "Versus Walkthrough" : "Versus",
    } : {}),
  };
  const identity = process.platform === "win32"
    ? { path: process.execPath, args: [] }
    : {};
  if (process.platform === "win32") {
    const legacyNames = WALKTHROUGH_PROFILE
      ? ["fun.versus.pet.walkthrough", "fun.versus.pet"]
      : ["fun.versus.pet"];
    for (const name of legacyNames) {
      if (name === options.name) continue;
      app.setLoginItemSettings({ openAtLogin: false, enabled: false, name, ...identity });
    }
  }
  app.setLoginItemSettings({ ...options, ...identity });
  const observed = app.getLoginItemSettings(identity);
  const matchingItems = process.platform === "win32"
    ? (observed.launchItems || []).filter((item) => path.resolve(item.path) === path.resolve(process.execPath))
    : [];
  const accepted = process.platform === "win32"
    ? options.openAtLogin
      ? Boolean(observed.executableWillLaunchAtLogin && matchingItems.some((item) => item.enabled))
      : !observed.executableWillLaunchAtLogin && !matchingItems.some((item) => item.enabled)
    : Boolean(observed.openAtLogin) === options.openAtLogin;
  if (WALKTHROUGH_PROFILE && process.env.VERSUS_WALKTHROUGH_EVIDENCE_DIR) {
    fs.appendFileSync(path.join(process.env.VERSUS_WALKTHROUGH_EVIDENCE_DIR, "login-item-events.jsonl"), `${JSON.stringify({
      at: Date.now(),
      requested: options.openAtLogin,
      accepted,
      openAtLogin: Boolean(observed.openAtLogin),
      executableWillLaunchAtLogin: Boolean(observed.executableWillLaunchAtLogin),
      launchItems: matchingItems.map((item) => ({
        name: item.name,
        path: item.path,
        args: item.args,
        scope: item.scope,
        enabled: item.enabled,
      })),
    })}\n`);
  }
  if (!accepted) {
    throw new Error("Windows did not accept the launch-on-login setting");
  }
  return observed;
}

function loadState() {
  return loadJson(STATE_PATH, null);
}

function saveState(state) {
  saveJson(STATE_PATH, state);
}

function loadWallet() {
  const stored = loadJson(WALLET_PATH, null);
  if (!stored) return null;
  if (stored.encryptedPrivateKey) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("OS wallet encryption is unavailable");
    return {
      ...stored,
      privateKey: safeStorage.decryptString(Buffer.from(stored.encryptedPrivateKey, "base64")),
    };
  }
  return stored;
}

function saveWallet(wallet) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("OS wallet encryption is unavailable");
  const { privateKey, ...publicWallet } = wallet;
  saveJson(WALLET_PATH, {
    ...publicWallet,
    keyProtection: "electron-safe-storage-v1",
    encryptedPrivateKey: safeStorage.encryptString(privateKey).toString("base64"),
  });
}

function ensureWallet() {
  let w = loadWallet();
  if (w?.address && w?.privateKey) {
    if (!w.encryptedPrivateKey) saveWallet(w);
    return w;
  }
  const wallet = Wallet.createRandom();
  w = {
    address: wallet.address,
    privateKey: wallet.privateKey,
    createdAt: new Date().toISOString(),
    network: "base",
    chainId: 8453,
  };
  saveWallet(w);
  return w;
}

function loadSettings() {
  const stored = loadJson(SETTINGS_PATH, null);
  if (stored) {
    let apiKey = "";
    if (stored.encryptedApiKey) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("OS credential encryption is unavailable");
      apiKey = safeStorage.decryptString(Buffer.from(stored.encryptedApiKey, "base64"));
    }
    return normalizeSettings({ ...stored, brain: { ...(stored.brain || {}), apiKey } });
  }
  const envConfig = loadAgentBrainConfig(process.env);
  return normalizeSettings({
    launchAtLogin: false,
    brain: envConfig ? {
      kind: new Set(["codex", "claude"]).has(envConfig.mode)
        ? envConfig.mode
        : /^https?:\/\/(?:127\.0\.0\.1|localhost)/i.test(envConfig.endpoint) ? "local" : "cloud",
      provider: "environment",
      endpoint: envConfig.endpoint || "",
      model: envConfig.model,
      apiKey: envConfig.apiKey,
      autostart: envConfig.autostart,
    } : { kind: "off" },
  });
}

function saveSettings(input) {
  const previous = loadSettings();
  const submittedKey = input.brain && Object.hasOwn(input.brain, "apiKey") ? input.brain.apiKey : undefined;
  const resolvedApiKey = submittedKey === "" && input.brain?.hasApiKey ? previous.brain.apiKey : submittedKey;
  const merged = normalizeSettings({
    ...previous,
    ...input,
    brain: {
      ...previous.brain,
      ...(input.brain || {}),
      apiKey: resolvedApiKey === undefined ? previous.brain.apiKey : resolvedApiKey,
    },
  });
  if (merged.brain.apiKey && !safeStorage.isEncryptionAvailable()) throw new Error("OS credential encryption is unavailable");
  const { apiKey, ...brain } = merged.brain;
  saveJson(SETTINGS_PATH, {
    version: merged.version,
    launchAtLogin: merged.launchAtLogin,
    allowReferralFunding: merged.allowReferralFunding,
    brain,
    encryptedApiKey: apiKey ? safeStorage.encryptString(apiKey).toString("base64") : null,
  });
  applyLaunchAtLogin(merged.launchAtLogin);
  return merged;
}

function applyChainState(state, chain) {
  recordGraduationTransition(state, chain);
  state.walletAddress = chain.address;
  state.walletOwner = chain.owner;
  state.cypherId = Number(chain.cypherId);
  state.level = Number(chain.level);
  state.streak = Number(chain.streak);
  state.lastCommitDay = Number(chain.lastCommitDay);
  state.nextCommitAt = Number(chain.nextCommitAt);
  state.vault = Number(chain.vault);
  state.runway = Number(chain.runway);
  state.ethGasReserveWei = chain.ethBalance.toString();
  state.walletUsdcMicros = Number(chain.usdcBalance);
  state.tickets = Number(chain.tickets);
  state.totalTickets = Number(chain.totalTickets);
  state.trancheClaimableMicros = Number(chain.claimable);
  state.tranchePreviewMicros = Number(chain.tranchePreview);
  state.tranchePotMicros = Number(chain.tranchePot);
  state.classId = Number(chain.classId);
  state.classPotMicros = Number(chain.classPotMicros);
  state.classAgents = Number(chain.classAgents);
  state.graduationFloorMicros = Number(chain.graduationFloorMicros || 1_000_000_000);
  state.referralRewardMicros = Number(chain.referralRewardMicros || 0);
  state.referralRewardsAvailable = Number(chain.referralRewardsAvailable || 0);
  state.referredBy = Number(chain.referredBy || 0);
  state.referralFundedToday = Boolean(chain.referralFundedToday);
  state.genesis = Boolean(chain.genesis);
  state.chainSyncedAt = Date.now();
  return state;
}

async function reconcileChainState() {
  const state = loadState() || {};
  if (!chainRainService || state.phase !== "active" || !state.agentId) return state;
  return observeActivity({ channel: "base", operation: "state_sync", destination: "base_rpc" }, async () => {
    faultInjector.throwIf("rpc");
    const wallet = ensureWallet();
    const chain = await chainRainService.readState({ address: wallet.address, agentId: state.agentId });
    state.ownershipLost = chain.owner.toLowerCase() !== wallet.address.toLowerCase();
    const pendingBefore = Number(state.pendingGraduation?.classId || 0);
    applyChainState(state, chain);
    saveState(state);
    if (
      Number(state.pendingGraduation?.classId || 0) > pendingBefore &&
      mainWindow && !mainWindow.isDestroyed()
    ) {
      mainWindow.webContents.send("graduation:available", {
        ceremony: state.pendingGraduation,
        state: structuredClone(state),
      });
    }
    return state;
  });
}

function startStateSync() {
  if (stateSyncTimer) clearInterval(stateSyncTimer);
  stateSyncTimer = setInterval(() => {
    reconcileChainState().catch((error) => console.error("Versus chain reconciliation error:", error.message));
  }, 60_000);
  stateSyncTimer.unref?.();
}

async function ensureNetworkService({ suppressAutostart = false } = {}) {
  if (networkService) return networkService;
  if (networkStart) return networkStart;
  const state = loadState();
  if (state?.phase !== "active" || !state.agentId) return null;

  networkStart = (async () => {
    const wallet = ensureWallet();
    let service;
    try {
      faultInjector.throwIf("database");
      service = await createPetNetworkService({
        privateKey: wallet.privateKey,
        agentId: state.agentId,
        dataDir: NETWORK_DATA_DIR,
        beforeAgentTick: ensureDailyRainForAgent,
        onAgentAction: (action, service) => handleAgentAction(action, service),
        agentContextProvider: () => {
          const current = loadState() || {};
          return {
            runwayMicros: Number(current.runway || 0),
            runwayPennies: Math.floor(Number(current.runway || 0) / 10_000),
            gasReserveWei: String(current.ethGasReserveWei || "0"),
            tickets: Number(current.tickets || 0),
            rainedToday: Number(current.lastCommitDay) === Math.floor(Date.now() / 86_400_000),
            referralPool: {
              rewardMicros: Number(current.referralRewardMicros || 0),
              availableRewards: Number(current.referralRewardsAvailable || 0),
            },
            permissions: {
              referralFunding:
                loadSettings().allowReferralFunding === true &&
                !current.referralFundedToday &&
                Number(current.runway || 0) >= 10_000,
            },
          };
        },
        env: {
          ...brainEnvironment(loadSettings(), process.env),
          ...(suppressAutostart ? { VERSUS_AGENT_AUTOSTART: "0" } : {}),
        },
      });
      service.node.on("postcard", () => activityBus.record({
        channel: "waku", direction: "in", operation: "postcard_receive", destination: "versus_mesh", status: "ok",
      }));
      service.node.on("peerReady", () => activityBus.record({
        channel: "waku", direction: "in", operation: "peer_ready", destination: "versus_mesh", status: "ready",
      }));
      service.node.on("peerDisconnect", () => activityBus.record({
        channel: "waku", direction: "in", operation: "peer_disconnect", destination: "versus_mesh", status: "wait",
      }));
      service.node.on("rejected", () => activityBus.record({
        channel: "waku", direction: "in", operation: "postcard_reject", destination: "versus_mesh", status: "error",
      }));
      service.node.transport?.on?.("published", () => activityBus.record({
        channel: "waku", direction: "out", operation: "lightpush_publish", destination: "versus_mesh", status: "ok",
      }));
      service.node.transport?.on?.("historySynced", () => activityBus.record({
        channel: "waku", direction: "in", operation: "store_sync", destination: "versus_mesh", status: "ok",
      }));
      service.node.transport?.on?.("rainBatch", (batch, metadata = {}) => {
        const accepted = rainInbox.acceptBatch(batch);
        activityBus.record({
          channel: "waku",
          direction: "in",
          operation: "verified_rain",
          destination: "local_device",
          status: accepted.acceptedPennies ? "ok" : "idle",
        });
        if (accepted.acceptedPennies && mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
          mainWindow.webContents.send("rain:available", {
            pennies: accepted.acceptedPennies,
            pending: accepted.pending,
            history: Boolean(metadata.history),
          });
        }
      });
      service.node.transport?.on?.("rainRejected", (error) => {
        activityBus.record({
          channel: "waku", direction: "in", operation: "rain_reject", destination: "versus_mesh", status: "error",
        });
        console.error("Versus verified rain rejected:", error.message);
      });
      service.node.transport?.on?.("state", (transportStatus = {}) => {
        const state = String(transportStatus.state || "wait").toLowerCase();
        recordActivityState("waku-state", {
          channel: "waku",
          direction: "local",
          operation: "mesh_state",
          destination: "versus_mesh",
          status: state === "ready" || state === "live" || state === "caught_up"
            ? "ready"
            : state === "offline" ? "off" : state === "error" ? "error" : "wait",
        });
        if (["ready", "live", "caught_up"].includes(state)) healthMonitor.resolve("waku_unavailable");
        if (state === "degraded_store") {
          healthMonitor.report(Object.assign(new Error("Waku Store history is unavailable"), { code: "WAKU_STORE_UNAVAILABLE" }), {
            channel: "waku", operation: "store_sync", store: true,
          });
        } else if (state === "caught_up") {
          healthMonitor.resolve("store_history_unavailable");
        }
        if (["offline", "error"].includes(state)) {
          healthMonitor.report(Object.assign(new Error("Waku relay is unavailable"), { code: "WAKU_UNAVAILABLE" }), {
            channel: "waku", operation: "mesh_state",
          });
        }
      });
      service.agentRuntime?.on?.("thought", () => activityBus.record({
        channel: "brain", direction: "in", operation: "private_thought", destination: "local_device", status: "ok",
      }));
      service.agentRuntime?.on?.("action", () => activityBus.record({
        channel: "brain", direction: "in", operation: "public_action", destination: "versus_mesh", status: "ok",
      }));
      service.agentRuntime?.on?.("idle", () => activityBus.record({
        channel: "brain", direction: "in", operation: "silent_tick", destination: "local_device", status: "idle",
      }));
      service.agentRuntime?.on?.("brainError", (error) => {
        activityBus.record({
          channel: "brain", direction: "in", operation: "inference", destination: "owner_brain", status: "error",
        });
        healthMonitor.report(error || new Error("Brain inference failed"), { channel: "brain", operation: "inference" });
      });
    } catch (error) {
      if (error?.code === "CYPHER_REGISTRY_NOT_CONFIGURED") {
        networkUnavailableReason = "base_cypher_registry_not_configured";
        recordActivityState("waku-config", {
          channel: "waku",
          operation: "mesh_config",
          destination: "versus_mesh",
          status: "off",
        });
        return null;
      }
      healthMonitor.report(error, {
        channel: error?.code === "DATABASE_DAMAGED" || /sqlite|database/i.test(String(error?.message || "")) ? "disk" : "waku",
        operation: "mesh_start",
      });
      throw error;
    }
    const finishNetworkStart = activityBus.begin({
      channel: "waku",
      operation: "mesh_start",
      destination: "versus_mesh",
    });
    try {
      faultInjector.throwIf("waku");
      await service.start();
      try {
        faultInjector.throwIf("store");
      } catch (error) {
        healthMonitor.report(error, { channel: "waku", operation: "store_sync", store: true });
        activityBus.record({ channel: "waku", direction: "in", operation: "store_sync", destination: "versus_mesh", status: "wait" });
      }
      await reconcileSubmittedSignalBatches(service);
      finishNetworkStart("ok");
    } catch (error) {
      finishNetworkStart("error");
      healthMonitor.report(error, { channel: "waku", operation: "mesh_start" });
      await service.close().catch(() => {});
      throw error;
    }
    networkUnavailableReason = null;
    networkService = service;
    return service;
  })();

  try {
    return await networkStart;
  } finally {
    networkStart = null;
  }
}

async function handleAgentAction(action, service) {
  if (action?.type !== "fund_referrals") {
    return queueSignalSettlement(service, action.launchId, 100, [action]);
  }
  const settings = loadSettings();
  if (!settings.allowReferralFunding) throw new Error("referral funding is disabled by the owner");
  const state = loadState() || {};
  if (state.phase !== "active" || !state.agentId) throw new Error("no active Cypher");
  if (Number(state.runway || 0) < 10_000) throw new Error("Cypher runway is empty");
  const day = Math.floor(Date.now() / 86_400_000);
  if (state.referralFundedToday && Number(state.referralFundedDay) === day) {
    throw new Error("the Cypher already funded referrals today");
  }

  if (chainRainService) {
    const wallet = ensureWallet();
    await runJournaledOperation(
      {
        key: `referral-fund:${state.agentId}:${day}`,
        kind: "referral_fund",
        agentId: state.agentId,
        proposalId: action.proposalId,
      },
      (onSubmitted) => chainRainService.fundReferralPoolFromRunway({
        privateKey: wallet.privateKey,
        agentId: state.agentId,
        proposalId: action.proposalId,
        onSubmitted,
      })
    );
    await reconcileChainState();
  } else {
    state.runway = Number(state.runway) - 10_000;
    const rewardMicros = BigInt(state.referralRewardMicros || 1_000_000);
    const completeRewards = BigInt(Math.max(0, Math.floor(Number(state.referralRewardsAvailable || 0))));
    const priorBalance = BigInt(state.referralPoolBalanceMicros || 0) || completeRewards * rewardMicros;
    state.referralPoolBalanceMicros = Number(priorBalance + 10_000n);
    state.referralRewardsAvailable = Number(
      availableReferralRewards(state.referralPoolBalanceMicros, rewardMicros)
    );
    state.referralFundedToday = true;
    saveState(state);
  }
  const updated = loadState() || state;
  updated.referralFundedToday = true;
  updated.referralFundedDay = day;
  updated.lastReferralProposalId = action.proposalId;
  saveState(updated);
  return { status: "funded", proposalId: action.proposalId, amountMicros: 10_000 };
}

async function performDailyRainForAgent() {
  if (chainConfigError) throw chainConfigError;
  faultInjector.throwIf("gas");
  faultInjector.throwIf("runway");
  let state = await reconcileChainState();
  state ||= loadState() || {};
  if (state.phase !== "active" || !state.agentId) {
    const error = new Error("no active Cypher");
    error.code = "NO_ACTIVE_CYPHER";
    throw error;
  }
  if (state.ownershipLost) {
    const error = new Error("Cypher ownership no longer belongs to this wallet");
    error.code = "OWNERSHIP_LOST";
    throw error;
  }
  const now = Date.now();
  const day = Math.floor(now / 86_400_000);
  const dueAt = nextCommitAtFor(state, now);
  if (!commitIsDue(state, now)) return { status: "not_due", day, nextCommitAt: dueAt, state };
  if (Number(state.runway || 0) < 10_000) {
    const error = new Error("Cypher runway is empty");
    error.code = "EMPTY_RUNWAY";
    throw error;
  }

  let hash = null;
  if (chainRainService) {
    const wallet = ensureWallet();
    const receipt = await chainRainService.commitDaily({
      privateKey: wallet.privateKey,
      agentId: state.agentId,
    });
    hash = receipt.hash;
    state = await reconcileChainState();
    if (commitIsDue(state, Date.now())) throw new Error("daily rain receipt did not reconcile onchain");
  } else {
    const committedAt = Math.floor(Date.now() / 1000);
    state.runway = Number(state.runway) - 10_000;
    state.lastCommitDay = day;
    state.level = Number(state.level || 0) + 1;
    state.streak = nextCadenceStreak(dueAt, state.streak, committedAt);
    state.nextCommitAt = committedAt + DAY_SECONDS;
    state.tickets = Number(state.tickets || 0) + 1;
    state.totalTickets = Number(state.totalTickets || 0) + 1;
    state.classPotMicros = Number(state.classPotMicros || 0) + 10_000;
  }

  state.lastRainTxHash = hash;
  state.rainPenniesToday = 1;
  state.todayRainDay = day;
  state.lifetimeRainPennies = Number(state.lifetimeRainPennies || 0) + 1;
  state.lastRainAt = Date.now();
  saveState(state);
  return { status: "rained", day, hash, state };
}

function ensureDailyRainForAgent() {
  if (dailyRainInFlight) return dailyRainInFlight;
  dailyRainInFlight = performDailyRainForAgent().finally(() => {
    dailyRainInFlight = null;
  });
  return dailyRainInFlight;
}

function startDailyLifecycle() {
  if (dailyLifecycleScheduler) return dailyLifecycleScheduler;
  dailyLifecycleScheduler = new DailyLifecycleScheduler({
    loadState,
    saveState,
    reconcile: reconcileChainState,
    rain: ensureDailyRainForAgent,
    shouldThink: () => {
      const settings = loadSettings();
      return settings.brain.kind !== "off" && settings.brain.autostart;
    },
    think: async () => {
      const service = await ensureNetworkService();
      const state = loadState() || {};
      const lastCommitAt = Math.max(0, nextCommitAtFor(state) - DAY_SECONDS);
      return service ? service.runDailyAgentTick(`commit:${lastCommitAt}`) : { status: "brain_off" };
    },
  });
  dailyLifecycleScheduler.on("errorState", ({ error, nextRetryAt }) => {
    console.error(`Versus daily lifecycle ${error.code}: ${error.message}; retry after ${new Date(nextRetryAt).toISOString()}`);
    healthMonitor.report(Object.assign(new Error(error.message), { code: error.code }), {
      channel: "base", operation: "daily_lifecycle",
    });
  });
  dailyLifecycleScheduler.on("fatal", (error) => {
    console.error("Versus daily lifecycle fatal error:", error.message);
  });
  dailyLifecycleScheduler.start({ immediate: true });
  return dailyLifecycleScheduler;
}

function queueSignalSettlement(service, launchId = null, limit = 100, postcards = null) {
  const operation = signalSettlementLock.then(() => settlePreparedSignals(service, launchId, limit, postcards));
  signalSettlementLock = operation.catch(() => {});
  return operation;
}

async function settlePreparedSignals(service, launchId = null, limit = 100, postcards = null) {
  if (chainConfigError) throw chainConfigError;
  if (!chainRainService) throw new Error("Base chain service is not configured");
  launchId = String(launchId || service.status().launchId || "0");
  const record = postcards?.length
    ? service.prepareSignalPostcards(postcards, launchId)
    : service.prepareSignalBatch(launchId, limit);
  let submittedHash = null;
  try {
    const wallet = ensureWallet();
    const receipt = await chainRainService.settleSignalBatchFromRunway({
      privateKey: wallet.privateKey,
      agentId: service.node.identity.cypherId,
      batch: record.batch,
      onSubmitted: async (hash) => {
        submittedHash = hash;
        service.markSignalBatchSubmitted(record.batch.root, hash);
      },
    });
    const confirmed = service.confirmSignalBatch(record.batch.root, {
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
    });
    const state = loadState() || {};
    state.runway = Math.max(0, Number(state.runway || 0) - Number(receipt.amount));
    state.tickets = Number(state.tickets || 0) + Number(record.batch.inkPennies);
    state.totalTickets = Number(state.totalTickets || 0) + Number(record.batch.inkPennies);
    state.classPotMicros = Number(state.classPotMicros || 0) + Number(receipt.amount);
    saveState(state);
    try {
      const published = await service.publishPaidBatch(confirmed);
      return { record: confirmed, published, deliveryPending: false };
    } catch (error) {
      console.error("Versus paid postcard delivery pending:", error.message);
      return {
        record: confirmed,
        published: [],
        deliveryPending: true,
        deliveryError: error.message,
      };
    }
  } catch (error) {
    if (!submittedHash || error?.receipt?.status === 0) service.failSignalBatch(record.batch.root, error.message);
    throw error;
  }
}

async function reconcileSubmittedSignalBatches(service) {
  if (!chainRainService || typeof chainRainService.reconcileSignalBatch !== "function") return [];
  const outcomes = [];
  for (const record of service.submittedSignalBatches()) {
    try {
      const result = await chainRainService.reconcileSignalBatch({
        agentId: service.node.identity.cypherId,
        batch: record.batch,
        transactionHash: record.transactionHash,
      });
      if (result.status === "pending") {
        outcomes.push({ root: record.batch.root, status: "pending" });
        continue;
      }
      if (result.status === "failed") {
        service.failSignalBatch(record.batch.root, "submitted transaction reverted");
        outcomes.push({ root: record.batch.root, status: "failed" });
        continue;
      }
      const confirmed = service.confirmSignalBatch(record.batch.root, {
        transactionHash: result.transactionHash,
        blockNumber: result.blockNumber,
      });
      try {
        await service.publishPaidBatch(confirmed);
      } catch (error) {
        console.error("Versus reconciled paid postcard publication error:", error.message);
      }
      outcomes.push({ root: record.batch.root, status: "confirmed" });
    } catch (error) {
      console.error("Versus signal reconciliation error:", error.message);
      outcomes.push({ root: record.batch.root, status: "uncertain", error: error.message });
    }
  }
  for (const record of service.unpublishedSignalBatches()) {
    try {
      await service.publishPaidBatch(record);
      outcomes.push({ root: record.batch.root, status: "published" });
    } catch (error) {
      console.error("Versus paid postcard recovery error:", error.message);
      outcomes.push({ root: record.batch.root, status: "publish_failed", error: error.message });
    }
  }
  return outcomes;
}

function createWindow() {
  const display = screen.getPrimaryDisplay().workArea;
  const x = WALKTHROUGH_PROFILE ? display.x + 24 : display.x + display.width - WIN_W - 24;
  const y = WALKTHROUGH_PROFILE ? display.y + 80 : display.y + display.height - WIN_H - 24;

  mainWindow = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x,
    y,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    title: WALKTHROUGH_PROFILE ? "Versus Walkthrough" : "Versus Cypher",
    icon: path.join(__dirname, "..", "assets", "brand", process.platform === "win32" ? "v_gem.ico" : "v_gem.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
    },
  });

  hardenRendererWindow(mainWindow, TRUSTED_RENDERER_URL);

  mainWindow.setAlwaysOnTop(true, "floating");
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });
  let transparentSurfaceRefreshReason = null;
  let transparentSurfaceRefreshing = false;
  let transparentRefreshTimer = null;

  const cancelTransparentSurfaceRefresh = () => {
    if (transparentRefreshTimer) clearTimeout(transparentRefreshTimer);
    transparentRefreshTimer = null;
  };

  const pulseTransparentSurface = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    const bounds = mainWindow.getBounds();
    mainWindow.setBounds({ ...bounds, width: bounds.width + 1 }, false);
    mainWindow.setBounds(bounds, false);
    mainWindow.webContents.invalidate();
  };

  const refreshFocusedTransparentSurface = () => {
    if (transparentSurfaceRefreshReason !== "focus" || transparentSurfaceRefreshing || transparentRefreshTimer) return;
    transparentSurfaceRefreshReason = null;
    mainWindow.webContents.invalidate();
    transparentRefreshTimer = setTimeout(() => {
      transparentRefreshTimer = null;
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
      transparentSurfaceRefreshing = true;
      pulseTransparentSurface();
      mainWindow.hide();
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.invalidate();
      setTimeout(() => {
        transparentSurfaceRefreshing = false;
      }, 0);
    }, 120);
  };

  const refreshRestoredTransparentSurface = () => {
    cancelTransparentSurfaceRefresh();
    transparentSurfaceRefreshReason = null;
    transparentSurfaceRefreshing = true;
    mainWindow.hide();
    transparentRefreshTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) {
        transparentRefreshTimer = null;
        transparentSurfaceRefreshing = false;
        return;
      }
      const bounds = mainWindow.getBounds();
      mainWindow.setBounds({ ...bounds, width: bounds.width + 1 }, false);
      mainWindow.setBounds(bounds, false);
      mainWindow.show();
      mainWindow.focus();
      mainWindow.setOpacity(1);
      mainWindow.webContents.invalidate();
      transparentRefreshTimer = null;
      setTimeout(() => {
        transparentSurfaceRefreshing = false;
      }, 0);
    }, 120);
  };

  mainWindow.on("minimize", () => {
    cancelTransparentSurfaceRefresh();
    transparentSurfaceRefreshReason = "restore";
    mainWindow.setOpacity(0);
  });
  mainWindow.on("blur", () => {
    if (!transparentSurfaceRefreshing && transparentSurfaceRefreshReason !== "restore" && !mainWindow.isMinimized()) {
      transparentSurfaceRefreshReason = "focus";
    }
  });
  mainWindow.on("restore", refreshRestoredTransparentSurface);
  mainWindow.on("focus", () => {
    if (transparentSurfaceRefreshReason === "restore") refreshRestoredTransparentSurface();
    else refreshFocusedTransparentSurface();
  });
  mainWindow.loadFile(RENDERER_PATH);
  mainWindow.on("closed", () => {
    mainWindow = null;
    stopPoll();
  });
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, "..", "assets", "brand", "v_gem.png")).resize({ width: 32, height: 32 });
  tray = new Tray(img);
  tray.setToolTip("Versus Cypher");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Show",
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          } else createWindow();
        },
      },
      { label: "Hide", click: () => mainWindow?.hide() },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ])
  );
  tray.on("click", () => {
    if (!mainWindow) return createWindow();
    if (mainWindow.isVisible()) mainWindow.hide();
    else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startDepositPoll() {
  stopPoll();
  pollTimer = setInterval(() => {
    const state = loadState();
    if (!state || state.phase !== "awaiting_deposit") return;
    // Live Base balance check plugs in here later.
    // Demo path uses wallet:simulateDeposit.
  }, 4000);
}

app.whenReady().then(() => {
  const settings = loadSettings();
  activityBus.record({
    channel: "brain",
    operation: "brain_config",
    destination: settings.brain.kind === "local" ? "local_model" : settings.brain.kind === "off" ? "local_device" : "owner_endpoint",
    status: settings.brain.kind === "off" ? "off" : "ready",
  });
  if (!process.env.VERSUS_DEPLOYMENT) {
    recordActivityState("waku-config", {
      channel: "waku",
      operation: "mesh_config",
      destination: "versus_mesh",
      status: "off",
    });
  }
  applyLaunchAtLogin(settings.launchAtLogin);
  createWindow();
  createTray();
  updateService = createUpdateService({
    app,
    autoUpdater,
    disabled:
      WALKTHROUGH_PROFILE ||
      process.env.VERSUS_DISABLE_UPDATES === "1" ||
      buildMetadata.versusSignedUpdates !== true,
    publish: (status) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("update:status", status);
      activityBus.record({
        channel: "system",
        operation: "update_check",
        destination: "github_releases",
        status: status.status === "error" ? "error" : status.status,
      });
      if (status.status === "error") {
        healthMonitor.report(Object.assign(new Error("Update provider is unavailable"), { code: "UPDATE_UNAVAILABLE" }), {
          channel: "update", operation: "update_check",
        });
      } else if (["current", "available", "ready"].includes(status.status)) {
        healthMonitor.resolve("update_unavailable");
      }
    },
  });
  updateService.start();
  reconcileChainState()
    .catch((error) => console.error("Versus initial chain reconciliation error:", error.message))
    .finally(async () => {
      await reconcileOperationJournal().catch((error) => console.error("Versus operation reconciliation error:", error.message));
      await ensureNetworkService().catch((error) => console.error("Versus network start error:", error.message));
      startDailyLifecycle();
    });
  startStateSync();
  powerMonitor.on("resume", () => {
    dailyLifecycleScheduler?.wake("resume", { ignoreBackoff: true }).catch((error) => {
      console.error("Versus resume lifecycle error:", error.message);
    });
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopPoll();
  // Frameless pet: closing the only window should quit (tray can relaunch).
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (stateSyncTimer) clearInterval(stateSyncTimer);
  dailyLifecycleScheduler?.stop();
  networkService?.close().catch(() => {});
  updateService?.stop();
});

registerIpcHandle("bond:load", async () => {
  dailyLifecycleScheduler?.wake("foreground").catch((error) => {
    console.error("Versus foreground lifecycle error:", error.message);
  });
  try { return await reconcileChainState(); } catch (error) {
    console.error("Versus foreground chain reconciliation error:", error.message);
    return loadState();
  }
});
registerIpcHandle("service:activitySnapshot", () => serviceActivitySnapshot());
registerIpcHandle("health:snapshot", async () => {
  await reconcileOperationJournal();
  return refreshHealthSnapshot();
});
registerIpcHandle("diagnostics:export", () => exportDiagnostics());
registerIpcHandle("bond:save", (_e, state) => {
  saveState(state);
  return true;
});
registerIpcHandle("graduation:acknowledge", (_e, payload) => {
  const state = loadState() || {};
  acknowledgeGraduation(state, payload?.classId);
  saveState(state);
  return state;
});

registerIpcHandle("wallet:ensure", () => {
  const w = ensureWallet();
  return { address: w.address, network: w.network, chainId: w.chainId };
});

registerIpcHandle("wallet:getPublic", () => {
  const w = loadWallet();
  if (!w) return null;
  return { address: w.address, network: w.network, chainId: w.chainId };
});

registerIpcHandle("wallet:getAddressQr", async () => {
  const w = ensureWallet();
  return QRCode.toDataURL(w.address, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 144,
    color: {
      dark: "#173d32ff",
      light: "#e3edcfff",
    },
  });
});

registerIpcHandle("rain:next", () => rainInbox.next());

registerIpcHandle("wallet:copyAddress", () => {
  const w = ensureWallet();
  clipboard.writeText(w.address);
  return w.address;
});

registerIpcHandle("wallet:copyPrivateKey", () => {
  const wallet = ensureWallet();
  clipboard.writeText(wallet.privateKey);
  return true;
});

registerIpcHandle("wallet:createBackup", async (_e, { password } = {}) => {
  const wallet = ensureWallet();
  const backup = createWalletBackup({
    address: wallet.address,
    privateKey: wallet.privateKey,
    createdAt: wallet.createdAt,
    network: wallet.network,
    chainId: wallet.chainId,
    bond: loadState(),
  }, password);
  const selected = await dialog.showSaveDialog(mainWindow, {
    title: "Back up Versus Cypher",
    defaultPath: backupDefaultPath(`versus-cypher-${wallet.address.slice(2, 8)}.versus-backup.json`),
    filters: [{ name: "Versus encrypted backup", extensions: ["json"] }],
  });
  if (selected.canceled || !selected.filePath) return { canceled: true };
  fs.writeFileSync(selected.filePath, `${JSON.stringify(backup, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return { canceled: false, filePath: selected.filePath };
});

registerIpcHandle("wallet:restoreBackup", async (_e, { password } = {}) => {
  const selected = await dialog.showOpenDialog(mainWindow, {
    title: "Restore Versus Cypher",
    defaultPath: backupDefaultPath(""),
    properties: ["openFile"],
    filters: [{ name: "Versus encrypted backup", extensions: ["json"] }],
  });
  if (selected.canceled || !selected.filePaths[0]) return { canceled: true };
  const payload = openWalletBackup(JSON.parse(fs.readFileSync(selected.filePaths[0], "utf8")), password);
  const recovered = new Wallet(payload.privateKey);
  if (recovered.address.toLowerCase() !== payload.address.toLowerCase()) throw new Error("backup wallet address does not match its private key");
  await networkService?.close().catch(() => {});
  networkService = null;
  saveWallet({
    address: recovered.address,
    privateKey: recovered.privateKey,
    createdAt: payload.createdAt || new Date().toISOString(),
    network: payload.network || "base",
    chainId: Number(payload.chainId || 8453),
  });
  if (payload.bond) saveState(payload.bond);
  const state = await reconcileChainState();
  await ensureNetworkService();
  return { canceled: false, address: recovered.address, state };
});

registerIpcHandle("cypher:createArchive", async (_e, { password } = {}) => {
  const wallet = ensureWallet();
  const service = await ensureNetworkService();
  if (!service) throw new Error("hatch a Cypher before creating its full archive");
  const archive = createCypherArchive({
    address: wallet.address,
    privateKey: wallet.privateKey,
    createdAt: wallet.createdAt,
    network: wallet.network,
    chainId: wallet.chainId,
    bond: loadState(),
    networkState: service.exportLocalArchive(),
    operationJournal: operationJournal.exportArchive(),
    verifiedRain: rainInbox.exportArchive(),
  }, password);
  const selected = await dialog.showSaveDialog(mainWindow, {
    title: "Back up Versus Cypher and memories",
    defaultPath: backupDefaultPath(`versus-cypher-full-${wallet.address.slice(2, 8)}.versus-archive.json`),
    filters: [{ name: "Versus encrypted Cypher archive", extensions: ["json"] }],
  });
  if (selected.canceled || !selected.filePath) return { canceled: true };
  fs.writeFileSync(selected.filePath, `${JSON.stringify(archive, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return {
    canceled: false,
    filePath: selected.filePath,
    stats: archive.networkState?.localMemory?.postcards?.length == null
      ? service.localDatabase.stats()
      : {
          postcards: archive.networkState.localMemory.postcards.length,
          peers: archive.networkState.localMemory.peers.length,
          memories: archive.networkState.localMemory.memories.length,
        },
  };
});

registerIpcHandle("cypher:restoreArchive", async (_e, { password } = {}) => {
  const selected = await dialog.showOpenDialog(mainWindow, {
    title: "Restore Versus Cypher and memories",
    defaultPath: backupDefaultPath(""),
    properties: ["openFile"],
    filters: [{ name: "Versus encrypted Cypher archive", extensions: ["json"] }],
  });
  if (selected.canceled || !selected.filePaths[0]) return { canceled: true };
  const payload = openCypherArchive(JSON.parse(fs.readFileSync(selected.filePaths[0], "utf8")), password);
  const recovered = new Wallet(payload.privateKey);
  if (recovered.address.toLowerCase() !== payload.address.toLowerCase()) {
    throw new Error("Cypher archive address does not match its private key");
  }
  if (!payload.bond?.agentId) throw new Error("Cypher archive has no registered agent state");
  if (operationJournal.damaged && !payload.operationJournal) {
    throw new Error("This older archive cannot recover the damaged economic operation journal");
  }

  dailyLifecycleScheduler?.stop();
  await networkService?.close().catch(() => {});
  networkService = null;
  networkStart = null;
  quarantineDatabaseFiles(NETWORK_DATA_DIR);
  saveWallet({
    address: recovered.address,
    privateKey: recovered.privateKey,
    createdAt: payload.createdAt || new Date().toISOString(),
    network: payload.network || "base",
    chainId: Number(payload.chainId || 8453),
  });
  saveState(payload.bond);
  if (payload.operationJournal) operationJournal.importArchive(payload.operationJournal);
  if (payload.verifiedRain) rainInbox.importArchive(payload.verifiedRain);

  const service = await ensureNetworkService({ suppressAutostart: true });
  if (!service) throw new Error("restored Cypher could not start its local network service");
  const imported = service.importLocalArchive(payload.networkState, { replace: true });
  if (loadSettings().brain.autostart && service.agentRuntime) await service.startAgent();
  const state = await reconcileChainState();
  dailyLifecycleScheduler?.start({ immediate: true });
  return { canceled: false, address: recovered.address, imported, state };
});

registerIpcHandle("settings:get", () => publicSettings(loadSettings()));
registerIpcHandle("settings:brainCapabilities", () => detectAgentAdapters());
registerIpcHandle("update:status", () => updateService?.getState() || {
  status: "disabled", currentVersion: app.getVersion(), availableVersion: null, progress: null, error: null,
});
registerIpcHandle("update:check", () => observeActivity({
  channel: "update", operation: "update_check", destination: "github_releases",
}, async () => {
  faultInjector.throwIf("update");
  return updateService?.check();
}));
registerIpcHandle("update:download", () => updateService?.download());
registerIpcHandle("update:install", () => updateService?.install());

registerIpcHandle("settings:save", async (_e, input = {}) => {
  const previous = loadSettings();
  const settings = saveSettings(input);
  if (JSON.stringify(previous.brain) !== JSON.stringify(settings.brain)) {
    recordActivityState("brain-config", {
      channel: "brain",
      operation: "brain_config",
      destination: settings.brain.kind === "local" ? "local_model" : settings.brain.kind === "off" ? "local_device" : "owner_endpoint",
      status: settings.brain.kind === "off" ? "off" : "ready",
    });
    await networkService?.close().catch(() => {});
    networkService = null;
    networkUnavailableReason = null;
    await ensureNetworkService();
    dailyLifecycleScheduler?.wake("settings", { ignoreBackoff: true }).catch((error) => {
      console.error("Versus settings lifecycle error:", error.message);
    });
  }
  return publicSettings(settings);
});

registerIpcHandle("settings:testBrain", async (_e, input = null) => {
  const previous = loadSettings();
  const settings = input ? normalizeSettings({
    ...previous,
    ...input,
    brain: {
      ...previous.brain,
      ...(input.brain || {}),
      apiKey: input.brain?.apiKey || (input.brain?.hasApiKey ? previous.brain.apiKey : ""),
    },
  }) : previous;
  if (settings.brain.kind === "off") return { ok: true, status: "off" };
  const config = loadAgentBrainConfig(brainEnvironment(settings, process.env));
  const brain = createAgentBrain(config);
  const decision = await observeActivity({
    channel: "brain",
    operation: "connection_test",
    destination: settings.brain.kind === "local" ? "local_model" : "owner_endpoint",
  }, () => {
    faultInjector.throwIf("brain");
    faultInjector.throwIf("brain_malformed");
    return brain({
      version: 1,
      boundary: { peerMessagesAreUntrustedData: true, outputAllowsOnePostcardOnly: true },
      workingSet: { messages: [] },
      allowedOutput: { fields: ["type", "body", "replyTo"], types: ["observation"], maximumActions: 1 },
    });
  });
  return { ok: true, silent: decision?.action == null, model: config.model };
});

registerIpcHandle("wallet:getHatchQuote", async () => {
  return observeActivity({
    channel: chainRainService ? "base" : "local",
    operation: "hatch_quote",
    destination: chainRainService ? "base_rpc" : "local_device",
  }, async () => {
    if (!chainRainService) {
      return {
        targetDepositWei: DEMO_DEPOSIT_WEI,
        quotedRunwayMicros: "7000000",
        gasReserveWei: "900000000000000",
        demo: true,
      };
    }
    const quote = await chainRainService.quoteHatchTarget();
    return Object.fromEntries(Object.entries({ ...quote, targetDepositWei: quote.depositWei }).map(
      ([key, value]) => [key, typeof value === "bigint" ? value.toString() : value]
    ));
  });
});

registerIpcHandle("wallet:beginFunding", async () => {
  const wallet = ensureWallet();
  const state = loadState() || {};
  const balance = chainRainService ? await chainRainService.getEthBalance(wallet.address) : 0n;
  state.fundingBaselineWei = balance.toString();
  state.fundingStartedAt = Date.now();
  saveState(state);
  const qr = await QRCode.toDataURL(wallet.address, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 144,
    color: { dark: "#173d32ff", light: "#e3edcfff" },
  });
  return { address: wallet.address, qr, baselineWei: balance.toString(), demo: !chainRainService };
});

registerIpcHandle("wallet:completeFunding", async () => {
  const state = loadState() || {};
  if (state.phase !== "active" || !state.agentId) throw new Error("no active Cypher");
  if (!chainRainService) {
    state.runway = Number(state.runway || 0) + 7_000_000;
    state.ethGasReserveWei = (BigInt(state.ethGasReserveWei || 0) + 900_000_000_000_000n).toString();
    state.lastReplenishMicros = 7_000_000;
    state.lastReplenishAt = Date.now();
    saveState(state);
    return { amount: 7_000_000, runway: state.runway, demo: true };
  }
  const wallet = ensureWallet();
  const balance = await chainRainService.getEthBalance(wallet.address);
  const baseline = BigInt(state.fundingBaselineWei || 0);
  const depositWei = balance - baseline;
  if (depositWei <= 0n) throw new Error("new funding deposit has not arrived yet");
  const result = await chainRainService.replenishWithEth({
    privateKey: wallet.privateKey,
    agentId: state.agentId,
    depositWei,
  });
  state.lastReplenishMicros = Number(result.amount);
  state.lastReplenishAt = Date.now();
  state.lastReplenishTxHash = result.replenishHash;
  delete state.fundingBaselineWei;
  saveState(state);
  await reconcileChainState();
  return { ...result, amount: result.amount.toString(), runway: result.runway.toString(), demo: false };
});

registerIpcHandle("wallet:reconcile", () => reconcileChainState());

registerIpcHandle("network:status", async () => {
  const service = await ensureNetworkService();
  if (!service) {
    return applyWalkthroughNetworkStateFixture({
      active: false,
      reason: networkUnavailableReason || "cypher_not_hatched",
    });
  }
  return applyWalkthroughNetworkStateFixture(service.status());
});

registerIpcHandle("agent:status", async () => {
  const service = await ensureNetworkService();
  return service
    ? service.agentStatus()
    : { configured: false, mode: "off", status: "off", lastResult: null, lastError: null };
});

registerIpcHandle("agent:tick", async () => {
  const service = await ensureNetworkService();
  if (!service) throw new Error("hatch a Cypher before waking its brain");
  return observeActivity({ channel: "brain", operation: "agent_tick", destination: "owner_brain" }, () => service.runAgentTick());
});

registerIpcHandle("agent:start", async () => {
  const service = await ensureNetworkService();
  if (!service) throw new Error("hatch a Cypher before waking its brain");
  return service.startAgent();
});

registerIpcHandle("agent:stop", async () => {
  const service = await ensureNetworkService();
  return service ? service.stopAgent() : { configured: false, mode: "off", status: "off" };
});

registerIpcHandle("agent:nextThought", async () => {
  return networkService ? networkService.nextThought() : null;
});

registerIpcHandle("agent:markThoughtShowing", async (_e, { id } = {}) => {
  return networkService ? networkService.markThoughtShowing(id) : null;
});

registerIpcHandle("agent:markThoughtSeen", async (_e, { id } = {}) => {
  return networkService ? networkService.markThoughtSeen(id) : null;
});

registerIpcHandle("network:connect", async (_e, { peerUrl } = {}) => {
  const service = await ensureNetworkService();
  if (!service) throw new Error("hatch a Cypher before joining the network");
  return observeActivity({ channel: "waku", operation: "peer_connect", destination: "versus_mesh" }, () => service.connect(peerUrl));
});

registerIpcHandle("network:publish", async (_e, postcard = {}) => {
  const service = await ensureNetworkService();
  if (!service) throw new Error("hatch a Cypher before publishing postcards");
  return observeActivity({ channel: "waku", operation: "postcard_publish", destination: "versus_mesh" }, async () => {
    const prepared = await service.prepare(postcard);
    await queueSignalSettlement(service, prepared.launchId, 100, [prepared]);
    return prepared;
  });
});

registerIpcHandle("network:publishMission", async (_e, input = {}) => {
  const service = await ensureNetworkService();
  if (!service) throw new Error("hatch a Cypher before publishing a mission");
  const prepared = await service.prepareMission(input);
  await queueSignalSettlement(service, prepared.launchId, 100, [prepared]);
  return prepared;
});

registerIpcHandle("network:publishOutcome", async (_e, input = {}) => {
  const service = await ensureNetworkService();
  if (!service) throw new Error("hatch a Cypher before publishing an outcome");
  const prepared = await service.prepareOutcome(input);
  await queueSignalSettlement(service, prepared.launchId, 100, [prepared]);
  return prepared;
});

registerIpcHandle("network:list", async (_e, query = {}) => {
  const service = await ensureNetworkService();
  return service ? service.list(query) : [];
});

registerIpcHandle("network:coalitionView", async (_e, { launchId } = {}) => {
  const service = await ensureNetworkService();
  if (!service) return { launchId: String(launchId || "0"), proposals: [] };
  return service.coalitionView(launchId);
});

registerIpcHandle("network:clusterView", async () => {
  const service = await ensureNetworkService();
  return service ? service.clusterView() : [];
});

registerIpcHandle("network:getArtifact", async (_e, { reference } = {}) => {
  const service = await ensureNetworkService();
  return service ? service.getArtifact(reference) : null;
});

registerIpcHandle("network:assessOutcome", async (_e, input = {}) => {
  const service = await ensureNetworkService();
  if (!service) throw new Error("hatch a Cypher before assessing an outcome");
  return service.assessOutcome(input);
});

registerIpcHandle("network:listOutcomeAssessments", async () => {
  const service = await ensureNetworkService();
  return service ? service.listOutcomeAssessments() : [];
});

registerIpcHandle("network:listSignalBatches", async () => {
  const service = await ensureNetworkService();
  return service ? service.listSignalBatches() : [];
});

registerIpcHandle("network:settleSignalBatch", async (_e, { launchId, limit } = {}) => {
  const service = await ensureNetworkService();
  if (!service) throw new Error("hatch a Cypher before settling durable signals");
  return queueSignalSettlement(service, launchId, limit);
});

registerIpcHandle("network:sponsorMission", async (_e, { missionId, amount, deadline } = {}) => {
  const service = await ensureNetworkService();
  if (!service) throw new Error("hatch a Cypher before sponsoring a mission");
  if (chainConfigError) throw chainConfigError;
  if (!chainRainService) throw new Error("Base chain service is not configured");
  const mission = service.missionForSponsorship(missionId);
  const wallet = ensureWallet();
  const receipt = await runJournaledOperation({
    key: `mission:sponsor:${mission.missionId}`,
    kind: "mission_sponsor",
    agentId: service.node.identity.cypherId,
  }, (onSubmitted) => chainRainService.sponsorMission({
    privateKey: wallet.privateKey,
    missionId: mission.missionId,
    launchId: mission.launchId,
    sponsorAgentId: service.node.identity.cypherId,
    recipientAgentId: mission.recipientAgentId,
    amount,
    deadline,
    onSubmitted,
  }));
  let announcement = null;
  try {
    announcement = await service.publishMissionSponsorship({
      kind: "versus-mission-sponsorship",
      version: 1,
      chainId: receipt.chainId,
      escrow: receipt.escrow,
      escrowId: receipt.escrowId,
      missionId: receipt.missionId,
      launchId: receipt.launchId,
      sponsorAgentId: receipt.sponsorAgentId,
      recipientAgentId: receipt.recipientAgentId,
      sponsor: receipt.sponsor,
      amountMicros: receipt.amount,
      deadline: receipt.deadline,
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
    });
  } catch (error) {
    console.error("Versus mission sponsorship announcement error:", error.message);
  }
  return { receipt, announcement };
});

registerIpcHandle("network:releaseMission", async (_e, { escrowId } = {}) => {
  if (chainConfigError) throw chainConfigError;
  if (!chainRainService) throw new Error("Base chain service is not configured");
  return runJournaledOperation({ key: `mission:release:${escrowId}`, kind: "mission_release" },
    (onSubmitted) => chainRainService.releaseMission({ privateKey: ensureWallet().privateKey, escrowId, onSubmitted }));
});

registerIpcHandle("network:refundMission", async (_e, { escrowId } = {}) => {
  if (chainConfigError) throw chainConfigError;
  if (!chainRainService) throw new Error("Base chain service is not configured");
  return runJournaledOperation({ key: `mission:refund:${escrowId}`, kind: "mission_refund" },
    (onSubmitted) => chainRainService.refundMission({ privateKey: ensureWallet().privateKey, escrowId, onSubmitted }));
});

registerIpcHandle("network:getMissionEscrow", async (_e, { escrowId } = {}) => {
  if (chainConfigError) throw chainConfigError;
  if (!chainRainService) throw new Error("Base chain service is not configured");
  return chainRainService.getMissionEscrow(escrowId);
});

registerIpcHandle("network:verifyEconomicProof", async (_e, { reference } = {}) => {
  const service = await ensureNetworkService();
  if (!service) throw new Error("hatch a Cypher before verifying economic proof");
  const result = await service.verifyEconomicProof(reference);
  return {
    verified: result.verified,
    kind: result.kind,
    escrowState: result.escrowState ?? null,
    reputation: result.reputation ?? null,
    transactionHash: result.receipt.hash,
    blockNumber: result.receipt.blockNumber,
  };
});

registerIpcHandle("network:setBlocked", async (_e, { address, blocked } = {}) => {
  const service = await ensureNetworkService();
  if (!service) throw new Error("hatch a Cypher before changing network trust");
  return service.setBlocked(address, blocked);
});

registerIpcHandle("network:setTrustScore", async (_e, { address, dimension, score } = {}) => {
  const service = await ensureNetworkService();
  if (!service) throw new Error("hatch a Cypher before changing network trust");
  return service.setTrustScore(address, dimension, score);
});

registerIpcHandle("network:listPeerRelationships", async (_e, query = {}) => {
  const service = await ensureNetworkService();
  return service ? service.listPeerRelationships(query) : [];
});

registerIpcHandle("network:setPeerPreference", async (_e, { address, preference } = {}) => {
  const service = await ensureNetworkService();
  if (!service) throw new Error("hatch a Cypher before changing peer preferences");
  return service.setPeerPreference(address, preference);
});

registerIpcHandle("network:setPeerAffinity", async (_e, { address, affinity, evidence } = {}) => {
  const service = await ensureNetworkService();
  if (!service) throw new Error("hatch a Cypher before changing peer affinity");
  return service.setPeerAffinity(address, affinity, evidence);
});

registerIpcHandle("network:listMemories", async (_e, query = {}) => {
  const service = await ensureNetworkService();
  return service ? service.listMemories(query) : [];
});

registerIpcHandle("network:putMemory", async (_e, memory = {}) => {
  const service = await ensureNetworkService();
  if (!service) throw new Error("hatch a Cypher before storing local memory");
  return service.putMemory(memory);
});

registerIpcHandle("wallet:simulateDeposit", async () => {
  return observeActivity({
    channel: chainRainService ? "base" : "local",
    operation: "deposit_check",
    destination: chainRainService ? "base_rpc" : "local_device",
  }, async () => {
    faultInjector.throwIf("rpc");
    const state = loadState() || {};
    delete state.cypherId;
    if (chainRainService) {
      const wallet = ensureWallet();
      const quote = await chainRainService.quoteHatchTarget();
      const balance = await chainRainService.getEthBalance(wallet.address);
      if (balance < quote.depositWei) {
        throw new Error("deposit has not reached the Cypher wallet yet");
      }
      state.depositWei = balance.toString();
      state.hatchQuote = Object.fromEntries(Object.entries(quote).map(
        ([key, value]) => [key, typeof value === "bigint" ? value.toString() : value]
      ));
      state.demoDeposit = false;
    } else {
      state.depositWei = DEMO_DEPOSIT_WEI;
      state.demoDeposit = true;
    }
    state.phase = "swapping";
    state.depositAt = Date.now();
    saveState(state);
    return { ok: true, depositWei: state.depositWei, demo: state.demoDeposit };
  });
});

registerIpcHandle("wallet:getReferralStatus", async () => {
  const state = loadState() || {};
  if (!chainRainService) {
    if (state.phase !== "active") {
      state.phase = "awaiting_referral";
      saveState(state);
    }
    return { funded: true, rewardPerReferral: 1_000_000, availableRewards: 12, demo: true };
  }
  const status = await chainRainService.referralStatus();
  if (status.funded && state.phase !== "active") {
    state.phase = "awaiting_referral";
    saveState(state);
  }
  return {
    funded: status.funded,
    rewardPerReferral: Number(status.rewardPerReferral),
    availableRewards: Number(status.availableRewards),
    demo: false,
  };
});

registerIpcHandle("wallet:setReferralCode", async (_e, { code } = {}) => {
  const state = loadState() || {};
  if (!code) {
    delete state.pendingReferralCode;
    delete state.pendingReferrerAgentId;
    if (state.phase === "awaiting_referral") state.phase = "swapping";
    saveState(state);
    return { skipped: true };
  }
  const wallet = ensureWallet();
  let result;
  if (chainRainService) {
    result = await chainRainService.validateReferralCode({ code, hatchOwner: wallet.address });
  } else {
    const referrerAgentId = parseReferralCode(code);
    result = {
      code: referralCodeFor(referrerAgentId),
      referrerAgentId,
      referrerCypherId: 0n,
      rewardPerReferral: 1_000_000n,
      availableRewards: 12n,
    };
  }
  state.pendingReferralCode = result.code;
  state.pendingReferrerAgentId = Number(result.referrerAgentId);
  state.phase = "swapping";
  saveState(state);
  return Object.fromEntries(Object.entries(result).map(([key, value]) => [
    key,
    typeof value === "bigint" ? Number(value) : value,
  ]));
});

registerIpcHandle("wallet:getReferralCode", () => {
  const state = loadState() || {};
  if (state.phase !== "active" || !state.agentId) return null;
  return referralCodeFor(state.agentId);
});

registerIpcHandle("wallet:copyReferralCode", () => {
  const state = loadState() || {};
  if (state.phase !== "active" || !state.agentId) throw new Error("no active Cypher");
  const code = referralCodeFor(state.agentId);
  clipboard.writeText(code);
  return code;
});

registerIpcHandle("wallet:fundReferralPool", async (_e, { amountMicros } = {}) => {
  const state = loadState() || {};
  if (state.phase !== "active" || !state.agentId) throw new Error("no active Cypher");
  amountMicros = BigInt(amountMicros || 0);
  if (amountMicros <= 0n) throw new Error("referral funding must be positive");
  const proposalId = `0x${"0".repeat(64)}`;
  if (!chainRainService) {
    if (BigInt(state.walletUsdcMicros || 0) < amountMicros) throw new Error("wallet USDC is too low");
    state.walletUsdcMicros = Number(BigInt(state.walletUsdcMicros || 0) - amountMicros);
    state.referralPoolBalanceMicros = Number(BigInt(state.referralPoolBalanceMicros || 0) + amountMicros);
    state.referralRewardsAvailable = Number(
      availableReferralRewards(state.referralPoolBalanceMicros, state.referralRewardMicros || 1_000_000)
    );
    saveState(state);
    return { amount: Number(amountMicros), demo: true };
  }
  const wallet = ensureWallet();
  const operationId = Date.now();
  const result = await runJournaledOperation(
    {
      key: `referral-manual:${state.agentId}:${operationId}`,
      kind: "referral_manual_fund",
      agentId: state.agentId,
      amountMicros: amountMicros.toString(),
    },
    (onSubmitted) => chainRainService.fundReferralPool({
      privateKey: wallet.privateKey,
      sponsorAgentId: state.agentId,
      proposalId,
      amount: amountMicros,
      onSubmitted,
    })
  );
  await reconcileChainState();
  return { amount: Number(amountMicros), hash: result.hash, demo: false };
});

registerIpcHandle("wallet:claimTranche", async () => {
  const state = loadState() || {};
  if (chainRainService) {
    if (state.phase !== "active" || !state.agentId) throw new Error("no active Cypher");
    const wallet = ensureWallet();
    const result = await runJournaledOperation({ key: `claim:${state.agentId}`, kind: "tranche_claim", agentId: state.agentId },
      (onSubmitted) => chainRainService.claimTranche({ privateKey: wallet.privateKey, agentId: state.agentId, onSubmitted }));
    const synced = await reconcileChainState();
    return { state: synced, amount: Number(result.amount), hash: result.hash, demo: false };
  }
  const amount = Number(state.trancheClaimableMicros || 0);
  if (amount <= 0) return { state, amount: 0 };
  state.vault = Number(state.vault || 0) + amount;
  state.trancheClaimableMicros = 0;
  state.lastTrancheClaimMicros = amount;
  state.lastTrancheClaimAt = Date.now();
  saveState(state);
  return { state, amount };
});

registerIpcHandle("wallet:withdrawVault", async (_e, { amount } = {}) => {
  const state = loadState() || {};
  if (state.phase !== "active" || !state.agentId) throw new Error("no active Cypher");
  if (!chainRainService) {
    const withdrawal = amount == null ? Number(state.vault || 0) : Math.min(Number(amount), Number(state.vault || 0));
    state.vault = Number(state.vault || 0) - withdrawal;
    state.walletUsdcMicros = Number(state.walletUsdcMicros || 0) + withdrawal;
    saveState(state);
    return { state, amount: withdrawal, demo: true };
  }
  const wallet = ensureWallet();
  const result = await chainRainService.withdrawVault({ privateKey: wallet.privateKey, agentId: state.agentId, amount });
  const synced = await reconcileChainState();
  return { state: synced, amount: Number(result.amount), hash: result.hash, demo: false };
});

registerIpcHandle("wallet:rainFromRunway", (_e, { pennies } = {}) => {
  const operation = rainLock.then(() => observeActivity({
    channel: chainRainService ? "base" : "local",
    operation: "rain_commit",
    destination: chainRainService ? "arena_contract" : "local_device",
  }, async () => {
    faultInjector.throwIf("transaction");
    faultInjector.throwIf("gas");
    faultInjector.throwIf("runway");
    const state = loadState() || {};
    if (state.phase !== "active" || !state.agentId) throw new Error("no active Cypher");
    pennies = normalizeRainPennies(pennies);
    if (chainConfigError) throw chainConfigError;
    let result;
    if (chainRainService) {
      const wallet = ensureWallet();
      const chain = await runJournaledOperation({ key: `rain:${state.agentId}`, kind: "rain", agentId: state.agentId },
        (onSubmitted) => chainRainService.rainFromRunway({
          privateKey: wallet.privateKey,
          agentId: state.agentId,
          pennies,
          onSubmitted,
        }));
      const day = Math.floor(Date.now() / 86_400_000);
      if (Number(state.todayRainDay) !== day) state.rainPenniesToday = 0;
      state.vault = Number(chain.vault);
      state.runway = Number(chain.runway);
      state.level = Number(chain.level);
      state.streak = Number(chain.streak);
      state.lastCommitDay = Number(chain.lastCommitDay);
      state.tickets = Number(chain.tickets);
      state.totalTickets = Number(chain.totalTickets);
      state.classPotMicros = Number(chain.classPotMicros);
      state.classAgents = Number(chain.classAgents);
      state.rainPenniesToday = Number(state.rainPenniesToday || 0) + Number(pennies);
      state.todayRainDay = day;
      state.lifetimeRainPennies = Number(state.lifetimeRainPennies || 0) + Number(pennies);
      state.lastRainAt = Date.now();
      state.lastRainPennies = Number(pennies);
      state.lastRainTxHash = chain.hash;
      result = { state, pennies: Number(pennies), amount: Number(pennies) * 10_000, hash: chain.hash };
    } else {
      await sleep(520);
      result = applyConfirmedRain(state, pennies);
    }
    saveState(state);
    return result;
  }));
  rainLock = operation.catch(() => {});
  return operation;
});

registerIpcHandle("wallet:runOnboardPipeline", async (_e, { cypherCount = 29 } = {}) => observeActivity({
  channel: chainRainService ? "base" : "local",
  operation: "cypher_hatch",
  destination: chainRainService ? "arena_contract" : "local_device",
}, async () => {
  const w = ensureWallet();
  const state = loadState() || {};
  const referrerAgentId = BigInt(state.pendingReferrerAgentId || 0);
  let cypherId = Number.isInteger(state.cypherId) ? state.cypherId : null;
  if (!chainRainService && cypherId === null) cypherId = chooseRandomCypher(cypherCount);

  state.phase = "swapping";
  if (cypherId !== null) state.cypherId = cypherId;
  saveState(state);
  if (chainRainService && !state.demoDeposit) {
    const result = await chainRainService.hatchWithEth({
      privateKey: w.privateKey,
      depositWei: state.depositWei,
      referrerAgentId,
      onPhase: async (phase, details) => {
        state.phase = phase;
        state.hatchQuote = Object.fromEntries(Object.entries(details).map(
          ([key, value]) => [key, typeof value === "bigint" ? value.toString() : value]
        ));
        saveState(state);
      },
    });
    cypherId = Number(result.cypherId);
    await chainRainService.commitDaily({ privateKey: w.privateKey, agentId: result.agentId });
    state.phase = "active";
    state.agentId = Number(result.agentId);
    state.runway = Number(result.runway) - 10_000;
    state.usdcMicros = Number(result.runway);
    state.ethGasReserveWei = state.hatchQuote.gasReserveWei;
    state.swapTxHash = result.swapHash;
    state.hatchTxHash = result.hatchHash;
    state.referredBy = Number(referrerAgentId);
  } else {
    await sleep(900);

    state.phase = "minting";
    state.usdcMicros = 7_000_000;
    state.ethGasReserveWei = "900000000000000";
    saveState(state);
    await sleep(900);
    state.agentId = state.agentId || 1;
    state.runway = 6_990_000;
    state.referredBy = Number(referrerAgentId);
  }

  state.phase = "active";
  state.cypherId = cypherId;
  state.level = 1;
  state.streak = 1;
  state.lastCommitDay = Math.floor(Date.now() / 86_400_000);
  state.nextCommitAt = Math.floor(Date.now() / 1000) + DAY_SECONDS;
  state.vault = 0;
  state.tickets = 1;
  state.totalTickets = 1;
  state.trancheClaimableMicros = 0;
  state.tranchePreviewMicros = 0;
  state.classPotMicros = 10_000; // first penny in the open class
  state.rainPenniesToday = 1;
  state.todayRainDay = Math.floor(Date.now() / 86_400_000);
  state.lifetimeRainPennies = 1;
  state.classAgents = 1;
  state.inCurrentClass = true;
  state.walletAddress = w.address;
  state.onboardedAt = Date.now();
  delete state.pendingReferralCode;
  delete state.pendingReferrerAgentId;
  saveState(state);

  ensureNetworkService().catch((error) => {
    console.error("Versus network start error:", error.message);
  });
  dailyLifecycleScheduler?.wake("hatch", { ignoreBackoff: true }).catch((error) => {
    console.error("Versus hatch lifecycle error:", error.message);
  });

  return state;
}));

registerIpcHandle("window:close", () => {
  mainWindow?.minimize();
});
registerIpcHandle("window:quit", () => app.quit());

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
