const $ = (id) => document.getElementById(id);

const SERVICE_SCREW_COUNT = 4;
const removedServiceScrews = new Set();
let serviceStage = "closed";
let serviceTimer = null;
let serviceActivity = [];
let serviceActivityStatus = { chain: "local_sim", waku: "not_configured", brain: "off", telemetry: "none" };

function serviceStatusLabel(kind, value) {
  const labels = {
    chain: { local_sim: "SIM", base: "BASE", error: "ERR" },
    waku: { not_configured: "OFF", off: "OFF", offline: "OFF", reconnecting: "WAIT", caught_up: "LIVE", live: "LIVE", ready: "LIVE" },
    brain: { off: "OFF", local: "LOCAL", cloud: "CLOUD", external: "HOOK" },
  };
  return labels[kind]?.[String(value || "").toLowerCase()] || String(value || "--").slice(0, 5).toUpperCase();
}

function formatServiceTime(at) {
  const date = new Date(Number(at) || Date.now());
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
}

function renderServiceMonitor() {
  $("service-chain-status").textContent = serviceStatusLabel("chain", serviceActivityStatus.chain);
  $("service-waku-status").textContent = serviceStatusLabel("waku", serviceActivityStatus.waku);
  $("service-brain-status").textContent = serviceStatusLabel("brain", serviceActivityStatus.brain);
  $("service-event-count").textContent = `LOG ${String(serviceActivity.length).padStart(3, "0")}`;
  const terminal = $("service-terminal");
  terminal.replaceChildren();
  for (const activity of serviceActivity.slice(-14)) {
    const row = document.createElement("div");
    row.className = "service-terminal-line";
    row.dataset.status = activity.status;
    const direction = activity.status === "error" ? "!" : activity.direction === "out" ? ">" : activity.direction === "in" ? "<" : ".";
    const result = activity.status === "pending"
      ? "..."
      : `${String(activity.status || "ok").toUpperCase()}${activity.durationMs == null ? "" : ` ${activity.durationMs}ms`}`;
    for (const [tag, className, text] of [
      ["time", "", formatServiceTime(activity.at)],
      ["span", "service-direction", direction],
      ["span", "service-channel", String(activity.channel || "system").toUpperCase()],
      ["span", "service-operation", String(activity.operation || "activity").toUpperCase()],
      ["span", "service-result", result],
    ]) {
      const part = document.createElement(tag);
      if (className) part.className = className;
      part.textContent = text;
      row.appendChild(part);
    }
    terminal.appendChild(row);
  }
}

async function wireServiceMonitor() {
  const updateClock = () => { $("service-monitor-clock").textContent = formatServiceTime(Date.now()); };
  updateClock();
  window.setInterval(updateClock, 1000);
  try {
    const snapshot = await window.versus?.getServiceActivity?.();
    if (snapshot) {
      serviceActivityStatus = snapshot;
      serviceActivity = Array.isArray(snapshot.events) ? snapshot.events.slice(-128) : [];
      renderServiceMonitor();
    }
  } catch (_) {
    renderServiceMonitor();
  }
  window.versus?.onServiceActivity?.((activity) => {
    serviceActivity.push(activity);
    if (serviceActivity.length > 128) serviceActivity.splice(0, serviceActivity.length - 128);
    renderServiceMonitor();
  });
}

function setServiceStage(stage) {
  serviceStage = stage;
  $("shell").dataset.serviceStage = stage;
  document.querySelectorAll("[data-loose-screw-id]").forEach((button) => {
    button.disabled = stage !== "awaiting-screws";
  });
}

function scheduleServiceStep(callback, delay) {
  if (serviceTimer) window.clearTimeout(serviceTimer);
  serviceTimer = window.setTimeout(() => {
    serviceTimer = null;
    callback();
  }, delay);
}

function openServiceChassis() {
  if (serviceStage !== "closed" || removedServiceScrews.size !== SERVICE_SCREW_COUNT) return;
  setServiceStage("powerdown");
  scheduleServiceStep(() => {
    setServiceStage("opening");
    scheduleServiceStep(() => setServiceStage("open"), 840);
  }, 420);
}

function closeServiceChassis() {
  if (serviceStage !== "open") return;
  setServiceStage("closing");
  scheduleServiceStep(() => setServiceStage("awaiting-screws"), 840);
}

function reopenServiceChassis() {
  if (serviceStage !== "awaiting-screws" || removedServiceScrews.size !== SERVICE_SCREW_COUNT) return;
  setServiceStage("opening");
  scheduleServiceStep(() => setServiceStage("open"), 840);
}

function loosenServiceScrew(button) {
  if (serviceStage !== "closed" || button.classList.contains("is-loosening")) return;
  const id = Number(button.dataset.screwId);
  if (!Number.isInteger(id) || removedServiceScrews.has(id)) return;
  button.classList.add("is-loosening");
  button.disabled = true;
  window.setTimeout(() => {
    button.classList.remove("is-visible", "is-loosening");
    const loose = document.querySelector(`[data-loose-screw-id="${id}"]`);
    loose.classList.add("is-visible", "is-landed");
    loose.disabled = serviceStage !== "awaiting-screws";
    removedServiceScrews.add(id);
    if (removedServiceScrews.size === SERVICE_SCREW_COUNT) openServiceChassis();
  }, 620);
}

function reinstallServiceScrew(loose) {
  if (serviceStage !== "awaiting-screws" || loose.classList.contains("is-returning")) return;
  const id = Number(loose.dataset.looseScrewId);
  const installed = document.querySelector(`[data-screw-id="${id}"]`);
  if (!installed || !removedServiceScrews.has(id)) return;
  const from = loose.getBoundingClientRect();
  installed.classList.add("is-targeting");
  const to = installed.getBoundingClientRect();
  installed.classList.remove("is-targeting");
  loose.style.setProperty("--return-x", `${to.left + to.width / 2 - (from.left + from.width / 2)}px`);
  loose.style.setProperty("--return-y", `${to.top + to.height / 2 - (from.top + from.height / 2)}px`);
  loose.classList.remove("is-landed");
  loose.classList.add("is-returning");
  loose.disabled = true;
  window.setTimeout(() => {
    loose.classList.remove("is-visible", "is-returning");
    loose.style.removeProperty("--return-x");
    loose.style.removeProperty("--return-y");
    installed.disabled = false;
    installed.classList.add("is-visible", "is-tightening");
    removedServiceScrews.delete(id);
    window.setTimeout(() => installed.classList.remove("is-tightening"), 460);
    if (removedServiceScrews.size === 0) {
      scheduleServiceStep(() => setServiceStage("closed"), 480);
    }
  }, 520);
}

function wireServiceChassis() {
  setServiceStage("closed");
  document.querySelectorAll("[data-screw-id]").forEach((button) => {
    button.addEventListener("click", () => loosenServiceScrew(button));
  });
  document.querySelectorAll("[data-loose-screw-id]").forEach((button) => {
    button.addEventListener("click", () => reinstallServiceScrew(button));
  });
  $("faceplate-layer").addEventListener("click", (event) => {
    if (serviceStage !== "open" && serviceStage !== "awaiting-screws") return;
    event.preventDefault();
    event.stopPropagation();
    if (serviceStage === "open") closeServiceChassis();
    else reopenServiceChassis();
  }, true);
}

// Wire window chrome first so boot errors never trap the user.
function wireChrome() {
  const hide = $("btn-hide");
  const quit = $("btn-quit");
  const help = $("btn-help");
  const settings = $("btn-settings");
  if (hide) hide.onclick = () => window.versus?.hide?.();
  if (quit) quit.onclick = () => window.versus?.quit?.();
  if (help) help.onclick = () => setHelpOpen(!helpOpen);
  if (settings) settings.onclick = () => setSettingsOpen(!settingsOpen);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (settingsOpen) setSettingsOpen(false);
      else if (helpOpen) setHelpOpen(false);
      else window.versus?.hide?.();
    }
    if (e.key === "q" && (e.ctrlKey || e.metaKey)) window.versus?.quit?.();
  });
}
wireChrome();
wireServiceChassis();
wireServiceMonitor();

const roster = window.VERSUS_CYPHERS || {
  CYPHERS: [{ id: 0, name: "Calfire", file: "Calfire.gif" }],
  cypherSrc: (file) => `../assets/cyphers/${file}`,
  cypherOf: () => ({ id: 0, name: "Calfire", file: "Calfire.gif" }),
  layoutOf: () => null,
};
const { CYPHERS, cypherSrc, cypherOf, layoutOf } = roster;
const profileCatalog = window.VERSUS_CYPHER_PROFILES || {
  MAXIMA: {},
  profileOf: () => null,
};

const FLOOR_USDC = 1000;
const FLOOR_MICROS = FLOOR_USDC * 1e6;
const POLL_MS = 8000;
const SCENE_TICK_MS = 60_000;
const OCEAN_BACKGROUNDS = {
  morning: "../assets/tamagotchi/ocean-morning.png",
  noon: "../assets/tamagotchi/ocean-noon.png",
  "late-noon": "../assets/tamagotchi/ocean-late-noon.png",
  evening: "../assets/tamagotchi/ocean-evening.png",
  night: "../assets/tamagotchi/ocean-night.png",
};

const TWO_PI = Math.PI * 2;
const RAFT_H = 174; // raft box height in px
const SUBMERGE = 27; // px of log below the waterline

let bond = null;
let wallet = null;
const MODES = ["raft", "cypher", "vault", "network"];
let activeMode = "raft";
let modeLock = false;
let staticRaf = 0;
let sceneTimer = null;
let activeSkyLayer = "sky-a";
let currentScenePhase = "";
let forcedPhase = null; // test/debug override
let skyFadeTimer = null;
let saveDirty = false;
let claimNoticeShown = false;
let claimLock = false;
let cypherFlipped = false;
let helpOpen = false;
let helpFlipped = false;
let settingsOpen = false;
let settingsTab = "brain";
let currentSettings = null;
let fundingOpen = false;
let signalFlipped = false;
let networkSnapshot = null;
let networkRefreshLock = false;
const RAIN_BATCH_MAX = 25;
let queuedRainPennies = 0;
let inFlightRainPennies = 0;
let rainFlushTimer = null;
let lastRainTapAt = 0;
const rainTapIntervals = [];

/* ------------------------------------------------------------------
   Palettes — 5 roles per phase: surface, mid, deep, specular, foam
   (each rgba), plus waveAmp. Sampled to harmonize with the sky art.
   ------------------------------------------------------------------ */
const PHASE_PAL = {
  morning: { c: [[127, 212, 193, 0.85], [63, 158, 155, 0.92], [22, 80, 94, 0.98], [255, 232, 201, 1], [234, 255, 244, 0.7]], amp: 1.0 },
  noon: { c: [[111, 219, 232, 0.85], [30, 154, 181, 0.92], [10, 74, 99, 0.98], [242, 254, 255, 1], [240, 255, 255, 0.75]], amp: 1.0 },
  "late-noon": { c: [[108, 196, 169, 0.85], [46, 143, 132, 0.92], [20, 82, 87, 0.98], [255, 217, 138, 1], [255, 244, 214, 0.7]], amp: 0.9 },
  evening: { c: [[92, 84, 144, 0.88], [56, 49, 107, 0.94], [21, 17, 52, 0.98], [255, 156, 102, 1], [255, 205, 178, 0.55]], amp: 0.75 },
  night: { c: [[44, 90, 102, 0.88], [18, 56, 68, 0.94], [4, 20, 29, 0.98], [191, 233, 214, 1], [200, 235, 222, 0.45]], amp: 0.6 },
};

function flattenPal(def) {
  const f = new Float32Array(21);
  for (let r = 0; r < 5; r++) for (let k = 0; k < 4; k++) f[r * 4 + k] = def.c[r][k];
  f[20] = def.amp;
  return f;
}
const PAL_FLAT = {};
for (const p of Object.keys(PHASE_PAL)) PAL_FLAT[p] = flattenPal(PHASE_PAL[p]);

/* ------------------------------------------------------------------
   Pools — fixed arrays, swap-with-last kill, zero alloc in the loop.
   ------------------------------------------------------------------ */
function pool(max, make) {
  const items = new Array(max);
  for (let i = 0; i < max; i++) items[i] = make();
  return { items, n: 0, max };
}
function poolKill(p, i) {
  const t = p.items[i];
  p.items[i] = p.items[p.n - 1];
  p.items[--p.n] = t;
}
function poolTake(p) {
  return p.n < p.max ? p.items[p.n++] : null;
}

let rngState = 0x9e3779b9;
function rnd() {
  rngState ^= rngState << 13;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  return (rngState >>> 0) / 4294967296;
}

/* rain depth layers: [lenMin,lenMax, spdMin,spdMax, width, alpha, windMul, rate/s@storm1] */
const RAIN_LAYERS = [
  { len0: 4, len1: 6, spd0: 90, spd1: 120, w: 1, a: 0.28, wind: 0.6, rate: 18 },
  { len0: 7, len1: 10, spd0: 150, spd1: 190, w: 1, a: 0.45, wind: 1, rate: 12 },
  { len0: 12, len1: 16, spd0: 230, spd1: 280, w: 1.7, a: 0.8, wind: 1, rate: 7 },
];

const W = {
  w: 0, h: 0,
  fill: 0, targetFill: 0, raftFill: 0,
  storm: 0, targetStorm: 0, stormOffAt: 0,
  wind: 0, isNight: false, gradNear: false,
  causticBoost: 0,
  palFrom: new Float32Array(21), palTo: new Float32Array(21), pal: new Float32Array(21),
  palT: 1, paletteDirty: true,
  css: { surface: "", mid: "", deep: "", spec: "", foam: "" },
  bodyGrad: null, glowGrad: null, gradTop: -1,
  surfY: null,
  hash: new Float32Array(32),
  drops: pool(32, () => ({ x: 0, y: 0, vy: 0, len: 0, layer: 0, gold: false, white: false })),
  ripples: pool(12, () => ({ x: 0, t: 0, dur: 900, amp: 1, gold: false })),
  splashes: pool(24, () => ({ x: 0, y: 0, vx: 0, vy: 0, t: 0, life: 380 })),
  sparkles: pool(20, () => ({ x: 0, y: 0, t: 0, dur: 1200, size: 1 })),
  bubbles: pool(8, () => ({ x: 0, y: 0, r: 1, vy: 14, seed: 0 })),
  motes: pool(4, () => ({ x: 0, t: 0, dur: 4000 })),
  birds: pool(3, () => ({ x: 0, y: 0, vx: 0, active: false })),
  fish: { active: false, t: 0, x0: 0, dir: 1 },
  star: { active: false, t: 0, x0: 0, y0: 0 },
  accFar: 0, accMid: 0, accNear: 0,
  goldQueue: 0, whiteQueue: 0, nextCoinAt: 0,
  nextBubbleAt: 0, nextSparkleAt: 0, nextAmbientAt: 0, nextMoteAt: 0,
  nextIdleAt: 0, lastStarAt: -1e9, lastPotEventAt: -1e9,
  lastFoamAt: 0, frameToggle: false,
  lastT: 0, rafId: 0, running: false,
};
for (let i = 0; i < 32; i++) W.hash[i] = Math.random();

/* raft physics: two damped springs (heave in px, roll in deg) */
const PH = {
  heave: { p: 0, v: 0, k: 11.9, c: 2.62, t: 0 }, // 0.55 Hz, ~27% overshoot
  roll: { p: 0, v: 0, k: 6.3, c: 1.51, t: 0 }, // 0.40 Hz, lively but clamped
  faceRoll: 0, nudge: 0,
};

function stepSpring(s, h) {
  s.v += (s.k * (s.t - s.p) - s.c * s.v) * h;
  s.p += s.v * h;
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

/* ------------------------------------------------------------------
   Formatting + small helpers
   ------------------------------------------------------------------ */
function showBootError(err) {
  const el = $("boot-error");
  if (!el) return;
  el.classList.remove("hidden");
  el.textContent = `Boot failed: ${err?.message || err}`;
  show("view-deposit");
}

function formatCompact(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return k >= 10 ? `${Math.round(k)}K` : `${k.toFixed(1).replace(/\.0$/, "")}K`;
  }
  if (n < 1_000_000_000) {
    const m = n / 1_000_000;
    return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1).replace(/\.0$/, "")}M`;
  }
  const b = n / 1_000_000_000;
  return b >= 10 ? `${Math.round(b)}B` : `${b.toFixed(1).replace(/\.0$/, "")}B`;
}

function formatUsdcDollars(micros) {
  return `$${(Number(micros) / 1e6).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatTicketWeight(tickets, totalTickets) {
  if (!totalTickets || !tickets) return "0%";
  const percent = (tickets / totalTickets) * 100;
  if (percent >= 1) return `${percent.toFixed(2)}%`;
  if (percent >= 0.01) return `${percent.toFixed(3)}%`;
  return `${percent.toFixed(4)}%`;
}

function formatClassPot(micros) {
  const dollars = Number(micros) / 1e6;
  if (dollars >= FLOOR_USDC) return `$${FLOOR_USDC.toLocaleString()}`;
  return `$${dollars.toFixed(2)}`;
}

function shortAddr(a) {
  if (!a) return "";
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}

function setCypherFace(id) {
  const c = cypherOf(id);
  const img = $("face");
  if (img) {
    img.src = cypherSrc(c.file);
    img.alt = c.name;
    applyRaftSpriteLayout(img, layoutOf(c.file));
  }
}

function applyRaftSpriteLayout(img, layout) {
  if (!layout) {
    img.style.width = "150px";
    img.style.height = "150px";
    img.style.transform = "none";
    return;
  }

  const box = 150;
  const targetWidth = 140;
  const targetHeight = 130;
  const targetBaseline = 139.5;
  const [canvasWidth, canvasHeight] = layout.canvas;
  const [left, top, right, bottom] = layout.bounds;
  const visibleWidth = Math.max(1, right - left);
  const visibleHeight = Math.max(1, bottom - top);
  const rawZoom = Math.min(targetWidth / visibleWidth, targetHeight / visibleHeight) * (layout.zoom || 1);
  const zoom = Math.round(rawZoom * 64) / 64;
  const visibleCenterX = (left + right) / 2;
  const translateX = Math.round(box / 2 + (layout.x || 0) - zoom * visibleCenterX);
  const translateY = Math.round(targetBaseline + (layout.y || 0) - zoom * layout.baseline);

  img.style.width = `${canvasWidth}px`;
  img.style.height = `${canvasHeight}px`;
  img.style.transform = `matrix(${zoom}, 0, 0, ${zoom}, ${translateX}, ${translateY})`;
}

function applyCardSpriteLayout(img, layout) {
  if (!layout) {
    img.style.width = "171px";
    img.style.height = "178px";
    img.style.transform = "none";
    return;
  }

  const boxWidth = 171;
  const boxHeight = 178;
  const targetWidth = 150;
  const targetHeight = 164;
  const [canvasWidth, canvasHeight] = layout.canvas;
  const [left, top, right, bottom] = layout.bounds;
  const rawZoom = Math.min(
    targetWidth / Math.max(1, right - left),
    targetHeight / Math.max(1, bottom - top)
  ) * (layout.zoom || 1);
  const zoom = Math.round(rawZoom * 64) / 64;
  const visualCenterX = Number(layout.cardCenterX || ((left + right) / 2));
  const translateX = Math.round(boxWidth / 2 - zoom * visualCenterX + Number(layout.cardX || 0));
  const translateY = Math.round(boxHeight / 2 - zoom * ((top + bottom) / 2));

  img.style.width = `${canvasWidth}px`;
  img.style.height = `${canvasHeight}px`;
  img.style.transform = `matrix(${zoom}, 0, 0, ${zoom}, ${translateX}, ${translateY})`;
}

function rarityLabel(value) {
  return ["Archive", "Common", "Rare", "Epic", "Legendary"][Number(value)] || "Archive";
}

function firstLoreSentence(text) {
  const clean = String(text || "Field record unavailable.").trim();
  const match = clean.match(/^.*?[.!?](?:\s|$)/);
  return (match?.[0] || clean).trim();
}

function radarPoints(profile) {
  const centerX = 50;
  const centerY = 48;
  const radius = 36;
  const values = [
    [profile.damageMin, profileCatalog.MAXIMA.damage_min],
    [profile.strength, profileCatalog.MAXIMA.strength_min],
    [profile.stamina, profileCatalog.MAXIMA.stamina_min],
    [profile.dexterity, profileCatalog.MAXIMA.dexterity_min],
    [profile.spirit, profileCatalog.MAXIMA.spirit_min],
  ];
  return values.map(([value, maximum], index) => {
    const strength = 0.12 + 0.88 * clamp(Number(value || 0) / Math.max(1, Number(maximum || 1)), 0, 1);
    const angle = -Math.PI / 2 + index * TWO_PI / 5;
    return `${(centerX + Math.cos(angle) * radius * strength).toFixed(1)},${(centerY + Math.sin(angle) * radius * strength).toFixed(1)}`;
  }).join(" ");
}

function setCypherFlipped(flipped) {
  cypherFlipped = Boolean(flipped);
  const card = $("cypher-card-flip");
  card?.classList.toggle("is-flipped", cypherFlipped);
  card?.setAttribute("aria-pressed", cypherFlipped ? "true" : "false");
}

function setSignalFlipped(flipped) {
  signalFlipped = Boolean(flipped);
  $("signal-card")?.classList.toggle("is-flipped", signalFlipped);
  $("btn-signal-flip")?.setAttribute("aria-pressed", signalFlipped ? "true" : "false");
}

/* ------------------------------------------------------------------
   Views + modes
   ------------------------------------------------------------------ */
function hideAll() {
  ["view-deposit", "view-class"].forEach((id) => $(id).classList.add("hidden"));
}

function show(id) {
  hideAll();
  $(id).classList.remove("hidden");
  $("shell")?.setAttribute("data-view", id);
  if (id !== "view-class") stopLoop();
}

function setHelpFlipped(flipped) {
  helpFlipped = Boolean(flipped);
  const card = $("help-card-flip");
  card?.classList.toggle("is-flipped", helpFlipped);
  card?.setAttribute("aria-pressed", helpFlipped ? "true" : "false");
}

function setHelpOpen(open) {
  helpOpen = Boolean(open);
  if (helpOpen && settingsOpen) setSettingsOpen(false);
  setHelpFlipped(false);
  $("help-screen")?.classList.toggle("hidden", !helpOpen);
  $("btn-help")?.setAttribute("aria-pressed", helpOpen ? "true" : "false");
  $("shell")?.setAttribute("data-help", helpOpen ? "true" : "false");
  flashLcd(true);

  if (helpOpen) {
    stopLoop();
  } else if (bond?.phase === "active" && !$("view-class")?.classList.contains("hidden")) {
    W.lastT = performance.now();
    startLoop();
  }
}

let settingsStatusTimer = null;
function setSettingsStatus(message, error = false) {
  const status = $("settings-status");
  if (!status) return;
  const normalized = signalSentence(message, "LOCAL CONTROL", 96);
  status.textContent = error ? "ERROR" : signalSentence(normalized, "LOCAL CONTROL", 20).toUpperCase();
  status.classList.toggle("error", Boolean(error));
  const detail = $("settings-detail-status");
  if (detail) {
    const showDetail = Boolean(error) || normalized.length > 20;
    detail.textContent = showDetail ? normalized : "";
    detail.classList.toggle("hidden", !showDetail);
    detail.classList.toggle("error", Boolean(error));
    clearTimeout(settingsStatusTimer);
    if (showDetail) {
      settingsStatusTimer = setTimeout(() => detail.classList.add("hidden"), 4500);
    }
  }
}

function setSettingsTab(tab) {
  settingsTab = tab === "device" ? "device" : "brain";
  for (const name of ["brain", "device"]) {
    const active = name === settingsTab;
    $(`settings-tab-${name}`)?.classList.toggle("active", active);
    $(`settings-tab-${name}`)?.setAttribute("aria-selected", active ? "true" : "false");
    $(`settings-${name}-panel`)?.classList.toggle("hidden", !active);
  }
}

function renderSettings(settings) {
  currentSettings = settings;
  const brain = settings?.brain || {};
  if ($("setting-brain-kind")) $("setting-brain-kind").value = brain.kind || "off";
  if ($("setting-brain-endpoint")) $("setting-brain-endpoint").value = brain.endpoint || "";
  if ($("setting-brain-model")) $("setting-brain-model").value = brain.model || "";
  if ($("setting-brain-key")) {
    $("setting-brain-key").value = "";
    $("setting-brain-key").placeholder = brain.hasApiKey ? "saved key unchanged" : "optional for local";
  }
  if ($("setting-brain-auto")) $("setting-brain-auto").checked = brain.autostart !== false;
  if ($("setting-launch-login")) $("setting-launch-login").checked = Boolean(settings?.launchAtLogin);
  if ($("settings-wallet-address")) $("settings-wallet-address").textContent = wallet?.address || "Wallet not loaded";
}

function settingsInput() {
  return {
    launchAtLogin: Boolean($("setting-launch-login")?.checked),
    brain: {
      kind: $("setting-brain-kind")?.value || "off",
      provider: $("setting-brain-kind")?.value || "off",
      endpoint: $("setting-brain-endpoint")?.value.trim() || "",
      model: $("setting-brain-model")?.value.trim() || "",
      apiKey: $("setting-brain-key")?.value || "",
      hasApiKey: Boolean(currentSettings?.brain?.hasApiKey),
      autostart: Boolean($("setting-brain-auto")?.checked),
    },
  };
}

async function setSettingsOpen(open) {
  settingsOpen = Boolean(open);
  if (settingsOpen && helpOpen) setHelpOpen(false);
  $("settings-screen")?.classList.toggle("hidden", !settingsOpen);
  $("btn-settings")?.setAttribute("aria-pressed", settingsOpen ? "true" : "false");
  $("shell")?.setAttribute("data-settings", settingsOpen ? "true" : "false");
  flashLcd(true);
  if (settingsOpen) {
    stopLoop();
    setSettingsTab(settingsTab);
    setSettingsStatus("LOADING");
    try {
      renderSettings(await window.versus.getSettings());
      setSettingsStatus("LOCAL CONTROL");
    } catch (error) {
      setSettingsStatus(settingsErrorMessage(error), true);
    }
  } else if (bond?.phase === "active" && !$("view-class")?.classList.contains("hidden")) {
    W.lastT = performance.now();
    startLoop();
  }
}

function signalSentence(value, fallback, limit = 72) {
  const text = String(value || fallback || "").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(1, limit - 3)).trim()}...`;
}

function ipcErrorMessage(error) {
  return String(error?.message || error || "")
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .trim();
}

function settingsErrorMessage(error) {
  const message = ipcErrorMessage(error);
  if (/http (?:401|403)\b/i.test(message)) {
    return "That brain endpoint rejected the API key.";
  }
  if (/http 429\b/i.test(message)) {
    return "That brain endpoint is rate limited. Try again soon.";
  }
  if (/http 5\d\d\b/i.test(message)) {
    return "That brain endpoint is unavailable right now.";
  }
  if (/fetch failed|failed to fetch|invoking remote method|could not reach|connect(?:ion)? (?:failed|refused)/i.test(message)) {
    return "Could not reach that brain endpoint. Check the address and try again.";
  }
  if (/timed? out|timeout|abort(?:ed|error)|operation was aborted/i.test(message)) {
    return "The brain endpoint timed out. Try again.";
  }
  if (/raw json|invalid decision|decision envelope|choices\[0\]|unexpected token/i.test(message)) {
    return "That brain replied in an unreadable format.";
  }
  return signalSentence(message, "Settings action failed", 96);
}

function deviceErrorMessage(error) {
  const message = ipcErrorMessage(error);
  if (/rpc|json-rpc|walkthrough rpc offline|http 50\d|fetch failed|failed to fetch|network error|server response 50\d/i.test(message)) {
    return "Base connection is offline. Try again when it returns.";
  }
  return signalSentence(message, "Device action failed", 96);
}

function fundingErrorMessage(error) {
  const message = ipcErrorMessage(error);
  if (/funding deposit has not arrived|deposit (?:was )?not found|no new (?:deposit|funding)/i.test(message)) {
    return "Deposit not found yet. Check again in a moment.";
  }
  if (/insufficient.*gas/i.test(message)) return "Not enough ETH remains for gas.";
  if (/insufficient.*runway|runway is empty/i.test(message)) return "That Cypher needs more runway first.";
  return signalSentence(message, "Could not check the deposit yet", 58);
}

function renderSignalGraph(nodes = []) {
  const links = $("signal-graph-links");
  const group = $("signal-graph-nodes");
  if (!links || !group) return;
  const ns = "http://www.w3.org/2000/svg";
  links.replaceChildren();
  group.replaceChildren();
  for (const node of nodes) {
    const line = document.createElementNS(ns, "line");
    line.setAttribute("x1", "90"); line.setAttribute("y1", "57");
    line.setAttribute("x2", String(node.x)); line.setAttribute("y2", String(node.y));
    line.classList.add(node.stance || "neutral");
    links.appendChild(line);
    const circle = document.createElementNS(ns, "circle");
    circle.setAttribute("cx", String(node.x)); circle.setAttribute("cy", String(node.y));
    circle.setAttribute("r", String(node.radius || 4));
    circle.classList.add("awake", node.stance || "neutral");
    if (node.clusterId) circle.dataset.cluster = node.clusterId.slice(0, 10);
    group.appendChild(circle);
  }
  const self = document.createElementNS(ns, "circle");
  self.setAttribute("cx", "90"); self.setAttribute("cy", "57"); self.setAttribute("r", "10");
  self.classList.add("self", "awake");
  group.appendChild(self);
}

function renderNetworkScreen() {
  const status = networkSnapshot?.status || { active: false, peerCount: 0, postcardCount: 0 };
  const coalition = networkSnapshot?.coalition || null;
  const agent = status.agent || networkSnapshot?.agent || {
    configured: false,
    status: "off",
    model: null,
  };
  const utcDay = Math.floor(Date.now() / 86_400_000);
  const hasVoice = Number(bond?.lastCommitDay) === utcDay;
  const active = Boolean(status.active);
  const transportState = String(status.transportStatus?.state || (active ? "live" : "offline"));
  const transportLabels = {
    offline: "OFFLINE",
    reconnecting: "RECONNECTING",
    caught_up: "CAUGHT UP",
    degraded_store: "STORE DEGRADED",
  };
  const state = $("signal-state");
  if (state) state.textContent = transportLabels[transportState] || (active ? (hasVoice ? "VOICE LIVE" : "VOICE ASLEEP") : "OFFLINE");
  $("signal-live-dot")?.classList.toggle("on", active && transportState !== "reconnecting");
  $("signal-live-dot")?.classList.toggle("warn", transportState === "reconnecting" || transportState === "degraded_store");
  $("signal-card")?.setAttribute("data-transport", transportState);
  const launch = $("signal-launch");
  if (launch) launch.textContent = status.launchId ? `CLASS ${status.launchId}` : "CLASS --";

  const proposals = coalition?.proposals || [];
  const leading = proposals[0] || null;
  const mission = leading?.missions?.[0] || null;
  const headline = $("signal-headline");
  const copy = $("signal-copy");
  const kicker = $("signal-kicker");
  if (mission) {
    kicker.textContent = `${String(mission.status || "emerging").toUpperCase()} MISSION`;
    headline.textContent = signalSentence(mission.body, "A mission is forming", 44);
    copy.textContent = `${mission.supporters?.length || 0} support · ${mission.detractors?.length || 0} dissent · tap to inspect brain`;
  } else if (leading) {
    kicker.textContent = `${String(leading.status || "emerging").toUpperCase()} IDEA`;
    headline.textContent = signalSentence(leading.body, "An idea is forming", 48);
    copy.textContent = `${leading.supporters?.length || 0} support · ${leading.detractors?.length || 0} dissent · waiting for a mission`;
  } else if (!active || transportState === "offline") {
    kicker.textContent = hasVoice ? "VOICE EARNED" : "NETWORK SLEEPING";
    headline.textContent = hasVoice ? "Ready for the graph" : "Rain to earn a voice";
    copy.textContent = status.reason === "base_cypher_registry_not_configured"
      ? "Connect a Base deployment to hear registered Cyphers."
      : "Your Cypher will surface the strongest local idea here.";
  } else if (transportState === "reconnecting") {
    kicker.textContent = "FINDING THE NETWORK";
    headline.textContent = "Rejoining the graph";
    copy.textContent = "Your Cypher is finding fresh Filter and LightPush peers.";
  } else if (transportState === "degraded_store") {
    kicker.textContent = "LIVE, HISTORY LIMITED";
    headline.textContent = "New signals can still arrive";
    copy.textContent = "Recent Store catch-up is incomplete. Local memory remains safe.";
  } else {
    kicker.textContent = "LISTENING FOR A SIGNAL";
    headline.textContent = "The graph is quiet";
    copy.textContent = hasVoice
      ? "Your Cypher is listening for the first idea."
      : "Today's penny wakes your Cypher's network voice.";
  }

  const peers = active ? Number(status.peerCount || 0) : 0;
  const notes = Number(status.postcardCount || 0);
  const proposalCount = Number(coalition?.proposalCount || 0);
  $("signal-peers").textContent = formatCompact(peers);
  $("signal-postcards").textContent = formatCompact(notes);
  $("signal-proposals").textContent = formatCompact(proposalCount);
  renderSignalGraph(active ? (status.neighborhood || []) : []);
  $("signal-card")?.classList.toggle("has-traffic", active && (peers > 0 || notes > 0));

  const brainStatus = String(agent.status || (agent.configured ? "sleeping" : "off"));
  $("brain-status").textContent = brainStatus.toUpperCase();
  $("brain-model").textContent = agent.configured
    ? signalSentence(agent.model, "Owner supplied brain", 30)
    : "No brain selected";
  $("brain-live-dot")?.classList.toggle("on", brainStatus === "listening" || brainStatus === "thinking");
  const detail = $("brain-detail");
  if (detail) {
    detail.textContent = agent.lastError
      ? signalSentence(agent.lastError, "Brain error", 92)
      : agent.configured
        ? agent.lastResult
          ? `Last thought: ${String(agent.lastResult).replaceAll("_", " ")}. Peer text remains inert.`
          : "Owner endpoint ready. Peer text stays inert and every output is validated."
        : "The penny cron still works. Add a local model only when you want your Cypher to think with the graph.";
  }
  const think = $("btn-brain-think");
  const auto = $("btn-brain-auto");
  if (think) think.disabled = !agent.configured || brainStatus === "thinking";
  if (auto) {
    auto.disabled = !agent.configured || brainStatus === "thinking";
    auto.textContent = brainStatus === "listening" ? "STOP" : "AUTO";
  }
}

async function refreshNetworkScreen() {
  if (networkRefreshLock || !window.versus?.networkStatus) return;
  networkRefreshLock = true;
  try {
    const status = await window.versus.networkStatus();
    let coalition = null;
    if (status?.active && status.launchId) {
      coalition = await window.versus.networkCoalitionView(status.launchId);
    }
    networkSnapshot = { status: status || { active: false }, coalition };
  } catch (error) {
    networkSnapshot = {
      status: { active: false, reason: "network_error", peerErrors: [{ message: error.message }] },
      coalition: null,
    };
  } finally {
    networkRefreshLock = false;
    renderNetworkScreen();
  }
}

function updateModeScreen() {
  if (!bond || bond.phase !== "active") return;

  $("shell")?.setAttribute("data-mode", activeMode);

  const c = cypherOf(bond.cypherId);

  const cardFace = $("cypher-card-face");
  if (cardFace) {
    cardFace.src = cypherSrc(c.file);
    cardFace.alt = c.name;
    applyCardSpriteLayout(cardFace, layoutOf(c.file));
  }

  const cardName = $("cypher-card-name");
  if (cardName) {
    cardName.textContent = c.name;
    cardName.classList.toggle("long", c.name.length > 9);
  }

  const level = $("cypher-card-level");
  if (level) level.textContent = String(bond.level || 1);

  const profile = profileCatalog.profileOf(c.name);
  const pending = !profile || profile.archivePending;
  const typeName = profile?.type || "Unknown";
  const rarityName = rarityLabel(profile?.rarity);
  const cardType = typeName.toLowerCase();
  const knownCardTypes = new Set(["electric", "fire", "water", "grass", "flying", "ghost", "psychic", "fighting", "normal"]);
  const cardTypeKey = knownCardTypes.has(cardType) ? cardType : "normal";
  const flipCard = $("cypher-card-flip");
  if (flipCard) flipCard.dataset.type = cardTypeKey;
  const cardBg = $("cypher-card-bg");
  if (cardBg) cardBg.src = `../assets/cards/card_${cardTypeKey}.png`;
  const type = $("cypher-card-type");
  if (type) type.textContent = typeName;
  const rarity = $("cypher-card-rarity");
  if (rarity) rarity.textContent = rarityName;
  const backName = $("cypher-card-back-name");
  if (backName) backName.textContent = c.name;
  const backMeta = $("cypher-card-back-meta");
  if (backMeta) backMeta.textContent = `${typeName} · ${rarityName}`;
  const backLevel = $("cypher-card-back-level");
  if (backLevel) backLevel.textContent = String(bond.level || 1);
  const description = $("cypher-card-description");
  if (description) description.textContent = firstLoreSentence(profile?.description);
  const radar = document.querySelector(".cypher-radar");
  radar?.classList.toggle("hidden", pending);
  $("cypher-archive-pending")?.classList.toggle("hidden", !pending);
  const shape = $("cypher-stat-shape");
  if (shape && profile && !pending) shape.setAttribute("points", radarPoints(profile));
  const health = $("cypher-stat-hp");
  if (health) health.textContent = pending ? "--" : formatCompact(profile.health);
  const damage = $("cypher-stat-dmg");
  if (damage) damage.textContent = pending ? "--" : `${profile.damageMin}-${profile.damageMax}`;
  const crit = $("cypher-stat-crit");
  if (crit) crit.textContent = pending ? "--" : `${profile.critChance}%`;
  for (const [id, value] of [
    ["cypher-stat-str", profile?.strength],
    ["cypher-stat-sta", profile?.stamina],
    ["cypher-stat-dex", profile?.dexterity],
    ["cypher-stat-spr", profile?.spirit],
  ]) {
    const stat = $(id);
    if (stat) stat.textContent = pending ? "--" : String(value);
  }

  const vaultMicros = Number(bond.runway || 0);
  const runwayDays = Math.floor(vaultMicros / 10_000);
  const tickets = Number(bond.tickets || 0);
  const totalTickets = Math.max(tickets, Number(bond.totalTickets || 0));
  const claimableMicros = Number(bond.trancheClaimableMicros || 0);

  const vaultAmount = $("vault-card-amount");
  if (vaultAmount) {
    const [d, cents] = formatUsdcDollars(vaultMicros).split(".");
    vaultAmount.innerHTML = `${d}<small>.${cents}</small>`;
  }

  const days = $("vault-days");
  if (days) days.textContent = formatCompact(runwayDays);

  const ticketCount = $("vault-tickets");
  if (ticketCount) ticketCount.textContent = formatCompact(tickets);

  const weight = $("vault-weight");
  if (weight) weight.textContent = formatTicketWeight(tickets, totalTickets);

  const coinWindow = $("vault-coin-window");
  if (coinWindow) {
    const fill = vaultMicros > 0 ? Math.max(7, Math.min(100, (runwayDays / 365) * 100)) : 0;
    coinWindow.style.setProperty("--vault-fill", `${fill.toFixed(1)}%`);
  }

  const today = $("vault-today");
  if (today) {
    const day = Math.floor(Date.now() / 86_400_000);
    const committedToday = Number(bond.lastCommitDay) === day ? 1 : 0;
    const rainPennies = Number(bond.todayRainDay) === day
      ? Number(bond.rainPenniesToday || 0)
      : committedToday;
    today.textContent = rainPennies > 0 ? `Rained ${formatCompact(rainPennies)}¢` : "Not yet";
  }

  const gas = $("vault-gas");
  if (gas) {
    const reserveEth = Number(BigInt(bond.ethGasReserveWei || 0)) / 1e18;
    gas.textContent = reserveEth > 0 ? `${reserveEth.toFixed(4)} ETH` : "Needs ETH";
  }

  const preview = $("vault-tranche-preview");
  if (preview) preview.textContent = formatUsdcDollars(claimableMicros);

  const rewardBalance = $("vault-reward-balance");
  if (rewardBalance) rewardBalance.textContent = formatUsdcDollars(bond.vault || 0);
  const withdraw = $("btn-withdraw-vault");
  if (withdraw) withdraw.disabled = Number(bond.vault || 0) <= 0;

  $("shell")?.setAttribute("data-claim-ready", claimableMicros > 0 ? "true" : "false");
  renderNetworkScreen();

  if (claimableMicros > 0 && !claimNoticeShown) {
    claimNoticeShown = true;
    setTimeout(() => toast(`tranche ready ${formatUsdcDollars(claimableMicros)}`), 450);
  }

  const claimOverlay = $("vault-claim-overlay");
  if (claimOverlay && activeMode === "vault" && claimableMicros > 0 && claimOverlay.dataset.stage === "ready") {
    $("claim-amount").textContent = formatUsdcDollars(claimableMicros);
    claimOverlay.classList.remove("hidden");
  }
}

function setMode(next) {
  if (modeLock || next === activeMode) return;
  modeLock = true;
  if (next === "cypher") setCypherFlipped(false);
  if (next === "network") setSignalFlipped(false);
  const wipe = $("lcd-wipe");
  if (wipe) {
    wipe.classList.remove("run");
    void wipe.offsetWidth;
    wipe.classList.add("run");
  }
  setTimeout(() => {
    activeMode = next;
    updateModeScreen();
    if (next === "network") refreshNetworkScreen();
  }, 50);
  setTimeout(() => {
    modeLock = false;
    wipe?.classList.remove("run");
  }, 170);
}

function staticLcd() {
  if (modeLock) return;
  modeLock = true;
  const canvas = $("lcd-static");
  if (!canvas) {
    modeLock = false;
    return;
  }

  cancelAnimationFrame(staticRaf);
  const rect = $("lcd").getBoundingClientRect();
  const width = 110;
  const height = Math.max(1, Math.round(width * rect.height / rect.width));
  canvas.width = width;
  canvas.height = height;
  canvas.style.clipPath = "inset(0)";
  canvas.classList.add("run");

  const c = canvas.getContext("2d", { alpha: false });
  c.imageSmoothingEnabled = false;
  const snow = c.createImageData(width, height);
  const pixels = snow.data;
  const startedAt = performance.now();
  let lastPaint = -Infinity;

  function paintSnow(elapsed) {
    for (let i = 0; i < pixels.length; i += 4) {
      const bright = Math.pow(Math.random(), 0.7) * 220;
      const pop = Math.random() < 0.025 ? 42 : 0;
      pixels[i] = Math.min(255, bright * 0.52 + pop);
      pixels[i + 1] = Math.min(255, bright + 24 + pop);
      pixels[i + 2] = Math.min(255, bright * 0.66 + 12 + pop);
      pixels[i + 3] = 255;
    }
    c.putImageData(snow, 0, 0);

    for (let i = 0; i < 3; i++) {
      const y = Math.floor(Math.random() * (height - 5));
      const bandHeight = 1 + Math.floor(Math.random() * 4);
      const shift = -10 + Math.floor(Math.random() * 21);
      const band = c.getImageData(0, y, width, bandHeight);
      c.fillStyle = "#07130f";
      c.fillRect(0, y, width, bandHeight);
      c.putImageData(band, shift, y);
    }

    const rollY = Math.floor((elapsed * 0.52) % (height + 12)) - 6;
    c.fillStyle = "rgba(218, 244, 216, 0.78)";
    c.fillRect(0, rollY, width, 2);
    c.fillStyle = "rgba(2, 14, 11, 0.72)";
    c.fillRect(0, rollY + 2, width, 3);
  }

  function frame(now) {
    const elapsed = now - startedAt;
    if (elapsed - lastPaint >= 34) {
      paintSnow(elapsed);
      lastPaint = elapsed;
    }

    if (elapsed > 340) {
      const collapse = Math.min(1, (elapsed - 340) / 110);
      canvas.style.clipPath = `inset(${(collapse * 49.5).toFixed(1)}% 0)`;
    }

    if (elapsed < 450) {
      staticRaf = requestAnimationFrame(frame);
      return;
    }

    canvas.classList.remove("run");
    canvas.style.clipPath = "inset(0)";
    c.clearRect(0, 0, width, height);
    staticRaf = 0;
    modeLock = false;
  }

  staticRaf = requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------
   Scene clock: sky crossfade (fade-in only), phase tokens, moon
   ------------------------------------------------------------------ */
function localScenePhase(date = new Date()) {
  const hour = date.getHours() + date.getMinutes() / 60;
  if (hour >= 5 && hour < 9) return "morning";
  if (hour >= 9 && hour < 14) return "noon";
  if (hour >= 14 && hour < 17) return "late-noon";
  if (hour >= 17 && hour < 20) return "evening";
  return "night";
}

function waterSetPhase(phase) {
  const to = PAL_FLAT[phase] || PAL_FLAT.noon;
  if (W.palT >= 1 && currentScenePhase === "") {
    W.pal.set(to); // first paint: snap
  } else {
    W.palFrom.set(W.pal);
  }
  W.palTo.set(to);
  W.palT = currentScenePhase === "" ? 1 : 0;
  W.paletteDirty = true;
}

function setSkyPhase(phase) {
  if (phase === currentScenePhase) return;
  const nextUrl = OCEAN_BACKGROUNDS[phase] || OCEAN_BACKGROUNDS.night;

  const current = $(activeSkyLayer);
  const nextId = activeSkyLayer === "sky-a" ? "sky-b" : "sky-a";
  const next = $(nextId);
  if (!current || !next) return;

  waterSetPhase(phase); // before currentScenePhase updates (snap detection)

  next.style.backgroundImage = `url("${nextUrl}")`;
  next.style.zIndex = "1";
  current.style.zIndex = "0";
  next.classList.add("active");
  clearTimeout(skyFadeTimer);
  skyFadeTimer = setTimeout(() => current.classList.remove("active"), 1900);
  activeSkyLayer = nextId;
  currentScenePhase = phase;

  W.isNight = phase === "night";
  $("shell")?.setAttribute("data-phase", phase);
  $("celestial")?.classList.toggle("moon", phase === "night");
}

function updateSceneClock() {
  setSkyPhase(forcedPhase || localScenePhase(new Date()));
}

function startSceneClock() {
  updateSceneClock();
  if (sceneTimer) return;
  sceneTimer = setInterval(updateSceneClock, SCENE_TICK_MS);
}

/* ------------------------------------------------------------------
   Canvas setup
   ------------------------------------------------------------------ */
let ctx = null;
let fctx = null;

function resizeCanvas() {
  const cistern = $("cistern");
  const back = $("weather");
  const front = $("weather-front");
  if (!cistern || !back || !front) return;
  const rect = cistern.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  for (const c of [back, front]) {
    c.width = Math.floor(rect.width * dpr);
    c.height = Math.floor(rect.height * dpr);
    c.style.width = `${rect.width}px`;
    c.style.height = `${rect.height}px`;
  }
  ctx = back.getContext("2d");
  fctx = front.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  W.w = rect.width;
  W.h = rect.height;
  W.surfY = new Float32Array(((rect.width / 4) | 0) + 3);
  W.paletteDirty = true;
  // re-arm per-monitor DPI change detection
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener("change", resizeCanvas, { once: true });
}

function palCss(r) {
  const p = W.pal;
  const i = r * 4;
  return `rgba(${p[i] | 0},${p[i + 1] | 0},${p[i + 2] | 0},${p[i + 3].toFixed(3)})`;
}

function rebuildPalette(gradTop) {
  W.css.surface = palCss(0);
  W.css.mid = palCss(1);
  W.css.deep = palCss(2);
  W.css.spec = palCss(3);
  W.css.foam = palCss(4);
  if (ctx && W.h > 0) {
    // anchored at the waterline: vivid mid right below the surface, deep at the floor
    W.gradTop = gradTop != null ? gradTop : W.h * 0.25;
    W.bodyGrad = ctx.createLinearGradient(0, W.gradTop, 0, W.h);
    W.bodyGrad.addColorStop(0, W.css.mid);
    W.bodyGrad.addColorStop(1, W.css.deep);
    W.glowGrad = ctx.createRadialGradient(0, 0, 2, 0, 0, 40);
    W.glowGrad.addColorStop(0, "rgba(174,242,207,0.9)");
    W.glowGrad.addColorStop(1, "rgba(174,242,207,0)");
  }
  W.paletteDirty = false;
}

const waterTopBase = (fill) => W.h * (1 - (0.15 + fill * 0.47));

function surfaceYAt(x) {
  const s = W.surfY;
  if (!s) return 0;
  let i = (x / 4) | 0;
  if (i < 0) i = 0;
  if (i >= s.length) i = s.length - 1;
  return s[i];
}

/* ------------------------------------------------------------------
   Spawners + impact FX
   ------------------------------------------------------------------ */
function spawnDrop(layerIdx, gold, white) {
  const d = poolTake(W.drops);
  if (!d) return;
  const L = RAIN_LAYERS[layerIdx];
  d.layer = layerIdx;
  d.gold = !!gold;
  d.white = !!white;
  d.len = L.len0 + rnd() * (L.len1 - L.len0);
  d.vy = L.spd0 + rnd() * (L.spd1 - L.spd0);
  d.x = (0.06 + 0.88 * rnd()) * W.w;
  d.y = -d.len - rnd() * 20;
  if (gold || white) {
    d.x = (0.32 + 0.36 * rnd()) * W.w; // hero drops fall near the raft
    d.len = 12;
    d.vy = 200;
  }
}

function spawnRipple(x, amp, gold, delay) {
  const r = poolTake(W.ripples) || stealOldestRipple();
  if (!r) return;
  r.x = x;
  r.t = delay ? -delay : 0;
  r.dur = amp > 1.8 ? 1200 : 900;
  r.amp = amp;
  r.gold = !!gold;
}

function stealOldestRipple() {
  let best = -1;
  let bestT = -1e9;
  for (let i = 0; i < W.ripples.n; i++) {
    if (W.ripples.items[i].t > bestT) {
      bestT = W.ripples.items[i].t;
      best = i;
    }
  }
  return best >= 0 ? W.ripples.items[best] : null;
}

function spawnCrown(x, y, count) {
  for (let i = 0; i < count; i++) {
    const s = poolTake(W.splashes);
    if (!s) return;
    s.x = x;
    s.y = y;
    s.vx = (rnd() < 0.5 ? -1 : 1) * (20 + rnd() * 25);
    s.vy = -(60 + rnd() * 30);
    s.t = 0;
    s.life = 380;
  }
}

function spawnSparkle(x, y, dur, size) {
  const s = poolTake(W.sparkles);
  if (!s) return;
  s.x = x;
  s.y = y;
  s.t = 0;
  s.dur = dur;
  s.size = size;
}

function dropImpact(xPx, layerIdx, gold) {
  const xn = xPx / W.w;
  const prox = Math.max(0, 1 - Math.abs(xn - 0.5) / 0.55);
  const weight = gold ? 1.6 : layerIdx === 2 ? 1.0 : 0.6;
  PH.heave.v += 10 * prox * weight;
  PH.roll.v += clamp((xn - 0.5) / 0.35, -1, 1) * 9 * prox * weight;

  if (layerIdx >= 1 || gold) spawnRipple(xPx, gold ? 1.4 : 1, gold, 0);
  if (gold) spawnRipple(xPx, 0.8, true, 180);
  if (layerIdx === 2 || gold) spawnCrown(xPx, surfaceYAt(xPx), gold ? 4 : 3);
  if (gold) {
    spawnSparkle(xPx - 6 + rnd() * 12, surfaceYAt(xPx) - 3, 900, 2);
    spawnSparkle(xPx - 8 + rnd() * 16, surfaceYAt(xPx) + 4, 1100, 1);
  }
  W.causticBoost = Math.min(0.2, W.causticBoost + (gold ? 0.08 : 0.02));
}

/* ------------------------------------------------------------------
   Event choreography
   ------------------------------------------------------------------ */
let displayPotTimer = null;

function potEvent(kind, pennies, { alreadyApplied = false } = {}) {
  if (!bond || bond.phase !== "active") return;
  pennies = Math.max(1, pennies | 0);
  W.lastPotEventAt = performance.now();

  const confirmedPot = Number(bond.classPotMicros || 0);
  const prevPot = alreadyApplied ? Math.max(0, confirmedPot - pennies * 10_000) : confirmedPot;
  if (!alreadyApplied) bond.classPotMicros = prevPot + pennies * 10_000;
  const prevFill = clamp(prevPot / FLOOR_MICROS, 0, 1);
  const nextFill = clamp(bond.classPotMicros / FLOOR_MICROS, 0, 1);
  W.targetFill = nextFill;
  saveDirty = true;

  // the rising water shoves the raft before its slow tracker catches up
  PH.heave.v -= (nextFill - prevFill) * 0.62 * W.h * 1.2;

  if (kind === "self") {
    const cistern = $("cistern");
    if (cistern) {
      cistern.classList.remove("blip");
      void cistern.offsetWidth;
      cistern.classList.add("blip");
    }
    W.goldQueue += pennies;
    setTimeout(() => {
      const face = $("face-motion");
      if (face) {
        face.classList.remove("hop");
        void face.offsetWidth;
        face.classList.add("hop");
      }
      toast(`+${pennies} ticket${pennies === 1 ? "" : "s"}`);
      // hop landing hits the logs at the 70% keyframe (~365ms in)
      setTimeout(() => {
        PH.heave.v += 16;
        PH.roll.v += rnd() < 0.5 ? -5 : 5;
      }, 365);
    }, 470);
  } else if (pennies <= 3) {
    W.whiteQueue += pennies;
  } else {
    W.targetStorm = clamp(pennies / 40, 0.15, 0.65);
    W.stormOffAt = performance.now() + 2000 + pennies * 120;
    W.causticBoost = Math.min(0.2, W.causticBoost + 0.12);
  }

  for (const m of [0.25, 0.5, 0.75, 0.9]) {
    if (prevFill < m && nextFill >= m) milestone(m);
  }
  $("shell")?.setAttribute("data-grad", nextFill >= 0.95 ? "near" : "far");
  W.gradNear = nextFill >= 0.95;

  clearTimeout(displayPotTimer);
  displayPotTimer = setTimeout(() => {
    updateReadout();
    updateModeScreen();
  }, 460);
}

function rainBatchDelay() {
  if (!rainTapIntervals.length) return 380;
  const average = rainTapIntervals.reduce((sum, value) => sum + value, 0) / rainTapIntervals.length;
  if (average < 140) return 850;
  if (average < 280) return 650;
  return 380;
}

function setRainBatchStatus(text, kind = "") {
  const el = $("rain-batch");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("show", Boolean(text));
  el.classList.toggle("error", kind === "error");
}

function rainFailurePresentation(error, queuedPennies) {
  const message = ipcErrorMessage(error);
  if (/insufficient funds|not enough funds|doesn.t have enough funds|funds for gas|insufficient.*gas|not enough.*gas|balance.*gas/i.test(message)) {
    return { status: "NEEDS GAS", toast: "not enough ETH for gas" };
  }
  if (/insufficient.*runway|runway is empty/i.test(message)) {
    return { status: "VAULT EMPTY", toast: "runway needs USDC" };
  }
  if (/rpc|json-rpc|http 50\d|fetch failed|failed to fetch|network error|server response 50\d/i.test(message)) {
    return { status: "OFFLINE RETRY", toast: "Base connection offline" };
  }
  return { status: `RETRY x${queuedPennies}`, toast: "rain not sent" };
}

function scheduleRainFlush(delay = rainBatchDelay()) {
  clearTimeout(rainFlushTimer);
  rainFlushTimer = setTimeout(flushRainBatch, delay);
}

function queueRainTap() {
  const available = Math.floor(Number(bond?.runway || 0) / 10_000) - queuedRainPennies - inFlightRainPennies;
  if (available <= 0) {
    setRainBatchStatus("VAULT EMPTY", "error");
    toast("runway needs USDC");
    return;
  }

  const now = performance.now();
  if (lastRainTapAt > 0) {
    const interval = now - lastRainTapAt;
    if (interval < 1200) {
      rainTapIntervals.push(interval);
      if (rainTapIntervals.length > 5) rainTapIntervals.shift();
    } else {
      rainTapIntervals.length = 0;
    }
  }
  lastRainTapAt = now;
  queuedRainPennies += 1;
  setRainBatchStatus(`QUEUED ×${queuedRainPennies}`);

  const cistern = $("cistern");
  if (cistern) {
    cistern.classList.remove("blip");
    void cistern.offsetWidth;
    cistern.classList.add("blip");
  }

  if (queuedRainPennies >= RAIN_BATCH_MAX && !inFlightRainPennies) flushRainBatch();
  else scheduleRainFlush();
}

async function flushRainBatch() {
  clearTimeout(rainFlushTimer);
  if (inFlightRainPennies || queuedRainPennies <= 0) return;

  const pennies = Math.min(RAIN_BATCH_MAX, queuedRainPennies);
  queuedRainPennies -= pennies;
  inFlightRainPennies = pennies;
  setRainBatchStatus(`SENDING ×${pennies}`);

  try {
    const result = await window.versus.rainFromRunway(pennies);
    if (!result || Number(result.pennies) !== pennies) throw new Error("rain receipt mismatch");
    bond = result.state;
    potEvent("self", pennies, { alreadyApplied: true });
    updateModeScreen();
    setRainBatchStatus(`CONFIRMED +${pennies}`);
    setTimeout(() => {
      if (!queuedRainPennies && !inFlightRainPennies) setRainBatchStatus("");
    }, 900);
  } catch (err) {
    console.error(err);
    queuedRainPennies += pennies;
    const failure = rainFailurePresentation(err, queuedRainPennies);
    setRainBatchStatus(failure.status, "error");
    toast(failure.toast);
  } finally {
    inFlightRainPennies = 0;
    if (queuedRainPennies > 0 && !$("rain-batch")?.classList.contains("error")) {
      scheduleRainFlush(160);
    }
  }
}

function milestone(m) {
  for (const chip of document.querySelectorAll("#readout .chip")) {
    chip.classList.remove("chip-pop");
    void chip.offsetWidth;
    chip.classList.add("chip-pop");
  }
  spawnRipple(W.w / 2, 2.2, false, 0);
  W.causticBoost = Math.min(0.2, W.causticBoost + (m >= 0.5 ? 0.15 : 0.08));
}

let toastTimer = null;
function toast(text) {
  const el = $("toast");
  if (!el) return;
  el.textContent = text;
  el.style.top = `${Math.max(8, PH.heave.p - 12)}px`;
  el.classList.remove("run");
  void el.offsetWidth;
  el.classList.add("run");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("run"), 750);
}

let lastAgents = -1;
function updateReadout() {
  const pot = bond?.classPotMicros ?? 0;
  const agents = Math.max(1, bond?.classAgents ?? 1);
  const others = Math.max(0, agents - 1);
  const fill = clamp(Number(pot) / FLOOR_MICROS, 0, 1);

  W.targetFill = fill;

  $("pot-now").textContent = formatClassPot(pot);
  $("pot-goal").textContent = `/ $${formatCompact(FLOOR_USDC)}`;
  $("fill-pct").textContent = `${Math.round(fill * 100)}%`;
  $("agent-count").textContent = agents === 1 ? "1 agent" : `${formatCompact(agents)} agents`;

  const badge = $("others-badge");
  if (others <= 0) {
    badge.style.display = "none";
  } else {
    badge.style.display = "";
    badge.textContent = `+${formatCompact(others)}`;
    if (lastAgents >= 0 && agents !== lastAgents) {
      badge.classList.remove("badge-pop");
      void badge.offsetWidth;
      badge.classList.add("badge-pop");
    }
  }
  lastAgents = agents;
}

/* ------------------------------------------------------------------
   The frame loop
   ------------------------------------------------------------------ */
function startLoop() {
  if (W.running) return;
  W.running = true;
  W.lastT = performance.now();
  W.rafId = requestAnimationFrame(drawFrame);
}

function stopLoop() {
  W.running = false;
  cancelAnimationFrame(W.rafId);
}

function drawFrame(ts) {
  if (!W.running) return;
  W.rafId = requestAnimationFrame(drawFrame);
  if (!ctx || !W.surfY) return;

  const dt = clamp(ts - W.lastT, 0, 50);
  W.lastT = ts;
  const w = W.w;
  const h = W.h;

  /* --- sim state --- */
  W.fill += (W.targetFill - W.fill) * (1 - Math.exp(-dt / 500));
  W.raftFill += (W.targetFill - W.raftFill) * (1 - Math.exp(-dt / 900));
  if (W.stormOffAt && ts > W.stormOffAt) {
    W.targetStorm = 0;
    W.stormOffAt = 0;
  }
  const tau = W.targetStorm > W.storm ? 800 : 6000;
  W.storm += (W.targetStorm - W.storm) * (1 - Math.exp(-dt / tau));
  W.wind = Math.sin(ts / 23000) * 0.12 + Math.sin(ts / 7100) * 0.05;
  W.causticBoost *= Math.exp(-dt / 500);

  if (W.palT < 1) {
    W.palT = Math.min(1, W.palT + dt / 1800);
    const k = W.palT * W.palT * (3 - 2 * W.palT);
    for (let i = 0; i < 21; i++) W.pal[i] = W.palFrom[i] + (W.palTo[i] - W.palFrom[i]) * k;
    W.paletteDirty = true;
  }
  const gradTopNow = waterTopBase(W.fill);
  if (W.paletteDirty || Math.abs(gradTopNow - W.gradTop) > 3) rebuildPalette(gradTopNow);

  /* --- spawn schedulers --- */
  const storm = W.storm;
  if (storm > 0.01) {
    W.accFar += RAIN_LAYERS[0].rate * storm * dt / 1000;
    W.accMid += RAIN_LAYERS[1].rate * storm * dt / 1000;
    W.accNear += RAIN_LAYERS[2].rate * storm * dt / 1000;
    while (W.accFar >= 1) { W.accFar--; spawnDrop(0); }
    while (W.accMid >= 1) { W.accMid--; spawnDrop(1); }
    while (W.accNear >= 1) { W.accNear--; spawnDrop(2); }
  }
  if ((W.goldQueue > 0 || W.whiteQueue > 0) && ts > W.nextCoinAt) {
    W.nextCoinAt = ts + 110 + rnd() * 60;
    if (W.goldQueue > 0) { W.goldQueue--; spawnDrop(2, true, false); }
    else { W.whiteQueue--; spawnDrop(2, false, true); }
  }
  if (ts > W.nextAmbientAt) {
    W.nextAmbientAt = ts + 8000 + rnd() * 12000;
    if (storm < 0.05) spawnDrop(0);
  }
  const waterH0 = h - waterTopBase(W.fill);
  if (ts > W.nextBubbleAt) {
    const interval = (2500 + rnd() * 3500) * (W.fill >= 0.8 ? 0.5 : 1);
    W.nextBubbleAt = ts + interval;
    if (waterH0 > 40) {
      const nb = 1 + (rnd() < 0.3 ? 1 : 0);
      for (let i = 0; i < nb; i++) {
        const b = poolTake(W.bubbles);
        if (b) {
          b.x = rnd() * w;
          b.y = h - 4;
          b.r = 1 + rnd();
          b.vy = 12 + rnd() * 8;
          b.seed = rnd() * 10;
        }
      }
    }
  }
  if (ts > W.nextSparkleAt) {
    const day = !W.isNight && currentScenePhase !== "evening";
    W.nextSparkleAt = ts + (day ? 700 + rnd() * 800 : 1100 + rnd() * 1000);
    const cap = day ? 6 : 9;
    const stormy = storm > 0.3;
    if (W.sparkles.n < cap && (!day || !stormy || rnd() < 0.5)) {
      let x = rnd() * w;
      if (day && rnd() < 0.4) x = w * 0.5 + (rnd() - 0.5) * 0.4 * w; // cluster in the sun path
      const y = surfaceYAt(x) + rnd() * Math.min(18, waterH0 * 0.3);
      spawnSparkle(x, y, day ? 1200 : 2600, day && rnd() < 0.5 ? 2 : 1);
    }
  }
  if (W.gradNear && ts > W.nextMoteAt) {
    W.nextMoteAt = ts + 45000 + rnd() * 30000;
    const m = poolTake(W.motes);
    if (m) { m.x = rnd() * w; m.t = 0; m.dur = 4000; }
  }
  maybeIdleLife(ts);

  /* --- calm-frame halving: 30fps when the world is at rest --- */
  const calm =
    storm < 0.01 && W.drops.n === 0 && W.ripples.n === 0 && W.splashes.n === 0 &&
    W.goldQueue === 0 && W.whiteQueue === 0 && W.palT >= 1 &&
    Math.abs(W.fill - W.targetFill) < 0.0005 && !W.fish.active && !W.star.active;
  W.frameToggle = !W.frameToggle;
  const skipDraw = calm && W.frameToggle;

  /* --- surface buffer --- */
  const amp = W.pal[20];
  const bobPx = Math.sin((ts * TWO_PI) / 4200) * (1.2 + 1.4 * storm);
  const waterTop = waterTopBase(W.fill) + bobPx;
  const A1 = 2.0 * (1 + 0.9 * storm) * amp;
  const A2 = 1.0 * (1 + 0.9 * storm) * amp;
  const surf = W.surfY;
  for (let i = 0, x = 0; x <= w + 4; i++, x += 4) {
    surf[i] = waterTop + A1 * Math.sin(x * 0.045 + (ts * TWO_PI) / 2900) + A2 * Math.sin(x * 0.11 - (ts * TWO_PI) / 1700);
  }

  if (!skipDraw) {
    ctx.clearRect(0, 0, w, h);

    /* back swell: slower, longer wavelength crest strip peeking over the front */
    const backTop = waterTop - 4 - 3 * storm;
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = W.css.mid;
    ctx.beginPath();
    ctx.moveTo(0, backTop + 3.2 * (1 + 0.8 * storm) * Math.sin((ts * TWO_PI) / 4600));
    for (let x = 6; x <= w + 6; x += 6) {
      ctx.lineTo(x, backTop + 3.2 * (1 + 0.8 * storm) * Math.sin(x * 0.028 + (ts * TWO_PI) / 4600));
    }
    ctx.lineTo(w, waterTop + 10);
    ctx.lineTo(0, waterTop + 10);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;

    /* front body */
    ctx.fillStyle = W.bodyGrad;
    ctx.beginPath();
    ctx.moveTo(0, surf[0]);
    for (let i = 1, x = 4; x <= w + 4; i++, x += 4) ctx.lineTo(x, surf[i]);
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fill();

    /* caustics (breathing) */
    const boost = W.causticBoost + (W.gradNear && !W.isNight ? 0.06 : 0);
    ctx.strokeStyle = W.css.spec;
    ctx.lineWidth = 1;
    for (let i = 0; i < 3; i++) {
      const base = waterTop + 12 + i * 14;
      if (base > h - 4) break;
      ctx.globalAlpha = (0.05 + 0.03 * Math.sin(ts / 1800 + i * 2) + boost) * (W.isNight ? 0.7 : 1);
      ctx.beginPath();
      for (let x = 0; x <= w; x += 6) {
        const yy = base + 3 * Math.sin(x * 0.05 + ts / 1400 + i * 2.1) + 1.2 * Math.sin(x * 0.13 - ts / 900 + i);
        if (x === 0) ctx.moveTo(x, yy);
        else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    /* submerged pot glow as graduation nears */
    if (W.fill >= 0.6 && W.glowGrad) {
      ctx.save();
      ctx.translate(w - 16, Math.min(h - 24, waterTop + (h - waterTop) * 0.45));
      ctx.globalAlpha = (0.05 + 0.12 * ((W.fill - 0.6) / 0.4)) * (1 + 0.1 * Math.sin(ts / 5000));
      ctx.fillStyle = W.glowGrad;
      ctx.fillRect(-40, -40, 80, 80);
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    /* aurora at >=95%, night/evening only */
    if (W.gradNear && (W.isNight || currentScenePhase === "evening")) {
      ctx.strokeStyle = "rgba(140,255,220,1)";
      ctx.lineWidth = 1.5;
      for (let i = 0; i < 3; i++) {
        ctx.globalAlpha = i === 1 ? 0.06 : 0.04;
        ctx.beginPath();
        for (let x = 0; x <= w; x += 8) {
          const yy = waterTop - 16 - i * 4 + 4 * Math.sin(x * 0.02 + ts / 8000 + i * 1.7);
          if (x === 0) ctx.moveTo(x, yy);
          else ctx.lineTo(x, yy);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    /* bubbles */
    ctx.strokeStyle = W.css.surface;
    for (let i = W.bubbles.n - 1; i >= 0; i--) {
      const b = W.bubbles.items[i];
      b.y -= b.vy * dt / 1000;
      const bx = b.x + 1.5 * Math.sin(ts / 350 + b.seed);
      if (b.y < surfaceYAt(bx) + 2) {
        spawnRipple(bx, 0.4, false, 0);
        poolKill(W.bubbles, i);
        continue;
      }
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.arc(bx, b.y, b.r, 0, TWO_PI);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    /* glitter path under the sky's own light column (center) */
    const waterH = h - waterTop;
    if (waterH > 14) {
      const rows = Math.max(4, Math.min(14, (waterH * 0.55 / 7) | 0));
      const cx = 0.5 * w;
      ctx.fillStyle = W.css.spec;
      for (let i = 0; i < rows; i++) {
        const f = i / rows;
        const gy = (waterTop + 4 + f * waterH * 0.55) | 0;
        const wd = (16 - 12 * f) * (0.8 + 0.4 * W.hash[i & 31]);
        const gx = cx + Math.sin(ts / 900 + i * 2.1) * (2 + 6 * f) - wd / 2;
        const flicker = 0.6 + 0.4 * Math.sin(ts / 350 + i * 4.7);
        ctx.globalAlpha = 0.28 * Math.pow(1 - f, 1.5) * flicker * (W.isNight ? 0.8 : 1);
        ctx.fillRect(gx | 0, gy, wd | 0, 2);
      }
      ctx.globalAlpha = 1;
    }

    /* grad motes */
    for (let i = W.motes.n - 1; i >= 0; i--) {
      const m = W.motes.items[i];
      m.t += dt;
      const k = m.t / m.dur;
      if (k >= 1) { poolKill(W.motes, i); continue; }
      const my = h - 4 - (h - 4 - waterTop) * k;
      ctx.globalAlpha = 0.4 * Math.sin(Math.PI * k);
      ctx.fillStyle = "rgba(255,238,170,1)";
      ctx.fillRect((m.x | 0), my | 0, 2, 2);
    }
    ctx.globalAlpha = 1;

    /* surface band + specular crest + underlip + storm foam flecks */
    drawSurfaceStrip(ctx, surf, w, 1);

    /* ripples */
    ctx.lineWidth = 1.2;
    for (let i = W.ripples.n - 1; i >= 0; i--) {
      const r = W.ripples.items[i];
      r.t += dt;
      if (r.t < 0) continue;
      const k = r.t / r.dur;
      if (k >= 1) { poolKill(W.ripples, i); continue; }
      const e = easeOutCubic(k);
      const rx = (2 + 16 * e) * r.amp;
      const alpha = 0.5 * (1 - k) * (1 - k);
      ctx.strokeStyle = r.gold ? "rgba(255,233,168,1)" : W.css.foam;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.ellipse(r.x, surfaceYAt(r.x) + 1, rx, rx * 0.28, 0, 0, TWO_PI);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    /* splash crowns (motion streaks) */
    ctx.strokeStyle = W.css.foam;
    ctx.lineWidth = 1.5;
    for (let i = W.splashes.n - 1; i >= 0; i--) {
      const s = W.splashes.items[i];
      s.t += dt;
      if (s.t >= s.life) { poolKill(W.splashes, i); continue; }
      s.x += s.vx * dt / 1000;
      s.y += s.vy * dt / 1000;
      s.vy += 320 * dt / 1000;
      if (s.vy > 0 && s.y > surfaceYAt(s.x)) { poolKill(W.splashes, i); continue; }
      ctx.globalAlpha = 0.8 * (1 - s.t / s.life);
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x - s.vx * 0.03, s.y - s.vy * 0.03);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    /* sparkles */
    for (let i = W.sparkles.n - 1; i >= 0; i--) {
      const s = W.sparkles.items[i];
      s.t += dt;
      if (s.t >= s.dur) { poolKill(W.sparkles, i); continue; }
      ctx.globalAlpha = 0.5 * Math.sin(Math.PI * (s.t / s.dur)) * (W.isNight ? 0.7 : 1);
      ctx.fillStyle = i % 3 === 0 ? (W.isNight ? "#bfe4ff" : "#ffffff") : W.css.spec;
      ctx.fillRect(s.x | 0, s.y | 0, s.size, s.size);
    }
    ctx.globalAlpha = 1;

    /* idle life: birds / fish / shooting star */
    drawIdleLife(ts, dt);

    /* rain: far -> mid -> near/coin (front) */
    for (let i = W.drops.n - 1; i >= 0; i--) {
      const d = W.drops.items[i];
      const L = RAIN_LAYERS[d.layer];
      d.y += d.vy * dt / 1000;
      d.x += W.wind * L.wind * d.vy * dt / 1000;
      const sy = surfaceYAt(d.x);
      if (d.y + d.len >= sy) {
        dropImpact(d.x, d.layer, d.gold);
        poolKill(W.drops, i);
        continue;
      }
      if (d.y > h + 20) { poolKill(W.drops, i); continue; }
      const slant = W.wind * L.wind * d.len;
      if (d.gold) {
        ctx.strokeStyle = W.isNight ? "#cfe8ff" : "#ffd98a";
        ctx.globalAlpha = 0.95 * (Math.floor(ts / 50) % 2 ? 1 : 0.8); // shimmer
        ctx.lineWidth = 2;
      } else if (d.white) {
        ctx.strokeStyle = W.css.foam;
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = 1.7;
      } else {
        ctx.strokeStyle = d.layer === 2 ? W.css.foam : W.isNight ? "rgba(150,190,204,1)" : "rgba(180,214,224,1)";
        ctx.globalAlpha = L.a;
        ctx.lineWidth = L.w;
      }
      ctx.beginPath();
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x + slant, d.y + d.len);
      ctx.stroke();
      if (d.gold) {
        ctx.fillStyle = W.css.spec;
        ctx.fillRect((d.x + slant - 1) | 0, (d.y + d.len - 1) | 0, 2, 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  /* --- raft physics (always steps, even on skipped draws) --- */
  const half = 70;
  const cx = w / 2;
  const offL = surfaceYAt(cx - half) - waterTop;
  const offR = surfaceYAt(cx + half) - waterTop;
  const waterTopR = waterTopBase(W.raftFill) + bobPx;
  // never let the cypher clip the LCD top, even at 100% fill
  PH.heave.t = Math.max(6, waterTopR + 0.7 * (offL + offR) / 2 - (RAFT_H - SUBMERGE));
  PH.roll.t = clamp(Math.atan2(offR - offL, 140) * 57.29578 * 1.6, -2.5, 2.5) * (1 + 0.8 * storm);

  const hs = Math.min(dt, 50) / 1000;
  const steps = hs > 0.02 ? 2 : 1;
  for (let i = 0; i < steps; i++) {
    stepSpring(PH.heave, hs / steps);
    stepSpring(PH.roll, hs / steps);
  }
  PH.heave.v = clamp(PH.heave.v, -48, 48);
  PH.roll.v = clamp(PH.roll.v, -25, 25);
  PH.heave.p = clamp(PH.heave.p, PH.heave.t - 12, PH.heave.t + 12);
  PH.roll.p = clamp(PH.roll.p, -4, 4);
  PH.nudge *= Math.exp(-dt / 250);
  PH.faceRoll += (-PH.roll.p * 0.45 + PH.nudge - PH.faceRoll) * (1 - Math.exp(-dt / 120));

  if (activeMode === "raft") {
    const sway = 2.5 * Math.sin(ts * 0.00082);
    const raft = $("raft");
    if (raft) raft.style.transform = `translate3d(${sway.toFixed(2)}px, ${PH.heave.p.toFixed(2)}px, 0) rotate(${PH.roll.p.toFixed(2)}deg)`;
    const seat = $("cypher-seat");
    if (seat) seat.style.transform = `rotate(${PH.faceRoll.toFixed(2)}deg)`;
    const badge = $("others-badge");
    if (badge && badge.style.display !== "none") badge.style.translate = `-50% ${(1.5 * Math.sin(ts / 850 + 1.7)).toFixed(2)}px`;
    if (ts - W.lastFoamAt > 100) {
      W.lastFoamAt = ts;
      const foam = $("foam");
      if (foam) foam.style.opacity = clamp(0.22 + Math.abs(PH.heave.v) * 0.012, 0.22, 0.55).toFixed(2);
    }

    /* front strip: the waterline crosses the raft logs */
    if (fctx && !skipDraw) {
      fctx.clearRect(0, 0, w, h);
      fctx.save();
      fctx.beginPath();
      fctx.rect(0, waterTop - 8, w, 18);
      fctx.clip();
      drawSurfaceStrip(fctx, surf, w, 0.55);
      fctx.restore();
    }
  }
}

function drawSurfaceStrip(c, surf, w, alphaScale) {
  /* surface band */
  c.globalAlpha = alphaScale;
  c.fillStyle = W.css.surface;
  c.beginPath();
  c.moveTo(0, surf[0]);
  for (let i = 1, x = 4; x <= w + 4; i++, x += 4) c.lineTo(x, surf[i]);
  for (let i = ((w / 4) | 0) + 1, x = w + 4; x >= 0; i--, x -= 4) {
    const idx = i < 0 ? 0 : i;
    c.lineTo(x, surf[idx] + 7);
  }
  c.closePath();
  c.fill();

  /* specular crest */
  c.globalAlpha = (W.isNight ? 0.4 : 0.55) * alphaScale;
  c.strokeStyle = W.css.spec;
  c.lineWidth = 1.5;
  c.beginPath();
  c.moveTo(0, surf[0] - 0.5);
  for (let i = 1, x = 4; x <= w + 4; i++, x += 4) c.lineTo(x, surf[i] - 0.5);
  c.stroke();

  /* underlip */
  c.globalAlpha = 0.35 * alphaScale;
  c.strokeStyle = W.css.mid;
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(0, surf[0] + 2.5);
  for (let i = 1, x = 4; x <= w + 4; i++, x += 4) c.lineTo(x, surf[i] + 2.5);
  c.stroke();

  /* storm foam flecks on wave troughs */
  if (W.storm > 0.05) {
    c.fillStyle = W.css.foam;
    c.globalAlpha = 0.5 * W.storm * alphaScale;
    for (let i = 1, x = 4; x < w; i++, x += 4) {
      if (surf[i] < surf[i - 1] && surf[i] < surf[i + 1] && W.hash[i & 31] < W.storm) {
        c.fillRect(x - 1, surf[i] - 1, 2, 2);
      }
    }
  }
  c.globalAlpha = 1;
}

/* ------------------------------------------------------------------
   Idle life: rare, one at a time
   ------------------------------------------------------------------ */
function maybeIdleLife(ts) {
  if (W.nextIdleAt === 0) W.nextIdleAt = ts + 45000 + rnd() * 75000;
  if (ts < W.nextIdleAt) return;
  if (ts - W.lastPotEventAt < 10000) return;
  W.nextIdleAt = ts + 45000 + rnd() * 75000;

  const r = rnd();
  const phase = currentScenePhase;
  if (r < 0.5) {
    PH.nudge = rnd() < 0.5 ? -1.5 : 1.5; // the cypher shifts its weight
  } else if (phase === "morning" && r < 0.75) {
    const nb = 2 + (rnd() < 0.5 ? 1 : 0);
    for (let i = 0; i < nb; i++) {
      const b = poolTake(W.birds);
      if (b) {
        b.active = true;
        b.x = -10 - i * 14;
        b.y = W.h * (0.12 + rnd() * 0.16);
        b.vx = (W.w + 40) / 6000;
      }
    }
  } else if ((phase === "noon" || phase === "late-noon") && r < 0.75) {
    if (!W.fish.active) {
      W.fish.active = true;
      W.fish.t = 0;
      W.fish.dir = rnd() < 0.5 ? -1 : 1;
      W.fish.x0 = W.fish.dir < 0 ? W.w * (0.7 + rnd() * 0.2) : W.w * (0.1 + rnd() * 0.2);
    }
  } else if (phase === "night" && ts - W.lastStarAt > 480000) {
    W.lastStarAt = ts;
    W.star.active = true;
    W.star.t = 0;
    W.star.x0 = W.w * (0.15 + rnd() * 0.5);
    W.star.y0 = W.h * (0.08 + rnd() * 0.15);
  }
}

function drawIdleLife(ts, dt) {
  /* birds: 2px chevrons, 2-frame flap */
  if (W.birds.n > 0) {
    ctx.strokeStyle = "rgba(42,74,80,0.8)";
    ctx.lineWidth = 1;
    const flap = Math.floor(ts / 260) % 2 ? 2 : -1;
    for (let i = W.birds.n - 1; i >= 0; i--) {
      const b = W.birds.items[i];
      b.x += b.vx * dt;
      if (b.x > W.w + 12) { b.active = false; poolKill(W.birds, i); continue; }
      ctx.beginPath();
      ctx.moveTo(b.x - 3, b.y + flap);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(b.x + 3, b.y + flap);
      ctx.stroke();
    }
  }
  /* fish jump: parabolic dot, ripple on re-entry */
  if (W.fish.active) {
    W.fish.t += dt;
    const k = W.fish.t / 700;
    if (k >= 1) {
      W.fish.active = false;
      spawnRipple(W.fish.x0 + W.fish.dir * 30, 0.4, false, 0);
    } else {
      const fx = W.fish.x0 + W.fish.dir * 30 * k;
      const fy = surfaceYAt(fx) - 14 * Math.sin(Math.PI * k);
      ctx.fillStyle = "rgba(18,52,58,0.9)";
      ctx.fillRect(fx | 0, fy | 0, 3, 2);
    }
  }
  /* shooting star: 1px streak with 3-dot tail */
  if (W.star.active) {
    W.star.t += dt;
    const k = W.star.t / 600;
    if (k >= 1) {
      W.star.active = false;
    } else {
      const sx = W.star.x0 + k * 44;
      const sy = W.star.y0 + k * 26;
      for (let i = 0; i < 3; i++) {
        ctx.globalAlpha = (1 - k) * (0.8 - i * 0.25);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect((sx - i * 3) | 0, (sy - i * 1.8) | 0, 1, 1);
      }
      ctx.globalAlpha = 1;
    }
  }
}

/* ------------------------------------------------------------------
   Onboarding chrome
   ------------------------------------------------------------------ */
function setPipe(step) {
  ["pipe-swap", "pipe-mint", "pipe-class"].forEach((id) => $(id).classList.remove("on", "done"));
  if (step === "swap") {
    $("work-title").textContent = "Swapping…";
    $("work-sub").textContent = "ETH → USDC. Leaving gas.";
    $("pipe-swap").classList.add("on");
  } else if (step === "mint") {
    $("work-title").textContent = "Minting your Cypher…";
    $("work-sub").textContent = "Boarding the raft.";
    $("pipe-swap").classList.add("done");
    $("pipe-mint").classList.add("on");
  } else {
    $("work-title").textContent = "Joining the class…";
    $("work-sub").textContent = "Your first penny hits the water.";
    $("pipe-swap").classList.add("done");
    $("pipe-mint").classList.add("done");
    $("pipe-class").classList.add("on");
  }
}

function showClass() {
  show("view-class");
  setCypherFace(bond.cypherId);

  updateReadout();
  updateModeScreen();
  resizeCanvas();

  // snap the sim to the current pot — no replay on relaunch
  W.fill = W.raftFill = W.targetFill;
  W.gradNear = W.targetFill >= 0.95;
  $("shell")?.setAttribute("data-grad", W.gradNear ? "near" : "far");
  const bobPx0 = 0;
  PH.heave.t = PH.heave.p = waterTopBase(W.raftFill) + bobPx0 - (RAFT_H - SUBMERGE);
  PH.heave.v = 0;
  PH.roll.p = PH.roll.v = 0;

  startLoop();
}

/* ------------------------------------------------------------------
   Demo poll — rare, small, meaningful (most days: nothing)
   ------------------------------------------------------------------ */
function ambientPoll() {
  if (document.hidden || !bond || bond.phase !== "active") return;
  const r = Math.random();
  if (r < 0.02) {
    W.targetStorm = 0.25;
    W.stormOffAt = performance.now() + 1800;
  } else if (r < 0.12) {
    W.whiteQueue += 1;
  }
}

let thoughtShowing = false;

async function showNextThought() {
  if (
    thoughtShowing || document.hidden || bond?.phase !== "active" || activeMode !== "raft" ||
    W.whiteQueue > 0 || inFlightRainPennies > 0
  ) return;
  const thought = await window.versus?.agentNextThought?.();
  if (!thought) return;
  const bubble = $("cypher-thought");
  thoughtShowing = true;
  await window.versus.agentMarkThoughtShowing(thought.id);
  bubble.textContent = thought.text;
  bubble.classList.remove("hidden");
  await sleep(5000);
  bubble.classList.add("hidden");
  await window.versus.agentMarkThoughtSeen(thought.id);
  thoughtShowing = false;
}

setInterval(() => {
  if (saveDirty && bond) {
    saveDirty = false;
    window.versus?.saveBond?.(bond);
  }
}, 30_000);

/* ------------------------------------------------------------------
   Boot
   ------------------------------------------------------------------ */
function flashLcd(short) {
  const flash = $("boot-flash");
  if (!flash) return;
  flash.classList.remove("run", "run-short");
  void flash.offsetWidth;
  flash.classList.add(short ? "run-short" : "run");
}

async function boot() {
  try {
    if (!window.versus) throw new Error("preload bridge missing");

    flashLcd(false);
    wallet = await window.versus.ensureWallet();
    bond = await window.versus.loadBond();

    if (bond?.phase === "active" && bond.cypherId != null) {
      if (bond.classPotMicros == null) bond.classPotMicros = 10_000;
      if (bond.classAgents == null) bond.classAgents = 1;
      if (bond.tickets == null) bond.tickets = Math.max(1, bond.streak || 1);
      if (bond.totalTickets == null) bond.totalTickets = Math.max(bond.tickets, bond.classAgents);
      if (bond.trancheClaimableMicros == null) bond.trancheClaimableMicros = 0;
      if (bond.tranchePreviewMicros == null) bond.tranchePreviewMicros = 0;
      W.targetFill = clamp((bond.classPotMicros || 0) / FLOOR_MICROS, 0, 1);
      startSceneClock();
      showClass();
    } else if (!bond || !bond.phase || bond.phase === "awaiting_deposit") {
      bond = { phase: "awaiting_deposit", walletAddress: wallet.address };
      await window.versus.saveBond(bond);
      show("view-deposit");
      $("address-qr").src = await window.versus.getAddressQr();
      startSceneClock();
    } else {
      show("view-deposit");
      startSceneClock();
      await runHatchRitual(false);
    }

    setInterval(ambientPoll, POLL_MS);
    setInterval(() => showNextThought().catch(console.error), 2500);
    refreshNetworkScreen();
    setInterval(refreshNetworkScreen, POLL_MS);
    window.addEventListener("resize", resizeCanvas);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        stopLoop();
      } else if (bond?.phase === "active" && !$("view-class").classList.contains("hidden")) {
        flashLcd(true);
        W.lastT = performance.now();
        startLoop();
        // A visual welcome-back drop; balances remain receipt-driven.
        setTimeout(() => { W.whiteQueue += 1; }, 600);
      }
    });
  } catch (err) {
    console.error(err);
    showBootError(err);
  }
}

$("btn-copy").onclick = async () => {
  await window.versus.copyAddress();
  $("btn-copy").textContent = "COPIED";
  setTimeout(() => ($("btn-copy").textContent = "COPY ADDRESS"), 1200);
};

function setHatchState(state) {
  const view = $("view-deposit");
  view.dataset.hatchState = state;
  $("hatch-funding").setAttribute("aria-hidden", state === "funding" ? "false" : "true");
}

async function refreshHatchQuote() {
  const amount = $("deposit-amount");
  if (!amount || !window.versus?.getHatchQuote) return;
  try {
    const quote = await window.versus.getHatchQuote();
    const wei = BigInt(quote.targetDepositWei);
    const eth = Number(wei) / 1e18;
    const runway = Number(quote.quotedRunwayMicros || 0) / 1e6;
    amount.textContent = `${eth.toFixed(5)} ETH · $${runway.toFixed(2)} runway`;
  } catch (_) {
    amount.textContent = "70% runway · 30% gas";
  }
}

function wakeEgg() {
  const view = $("view-deposit");
  if (view.dataset.hatchState !== "dormant") return;
  setHatchState("waking");
  setTimeout(() => {
    setHatchState("funding");
    refreshHatchQuote();
  }, 720);
}

$("btn-wake-egg").onclick = wakeEgg;
$("btn-begin-hatch").onclick = wakeEgg;
$("btn-close-funding").onclick = () => setHatchState("dormant");

let hatchLock = false;

async function runHatchRitual(simulateDeposit = true) {
  if (hatchLock) return;
  hatchLock = true;
  const confirm = $("btn-sim-deposit");
  if (confirm) confirm.disabled = true;

  try {
    if (simulateDeposit) await window.versus.simulateDeposit();

    setHatchState("crack-one");
    const pipeline = window.versus.runOnboardPipeline(CYPHERS.length);
    await sleep(620);
    setHatchState("crack-two");
    await sleep(720);
    setHatchState("burst");
    await sleep(760);

    bond = await pipeline;
    bond.classPotMicros = 0;
    bond.classAgents = 1;
    await window.versus.saveBond(bond);
    W.targetFill = 0;

    const whiteout = $("hatch-whiteout");
    whiteout.classList.remove("run");
    void whiteout.offsetWidth;
    whiteout.classList.add("run");
    await sleep(260);
    showClass();
    setTimeout(() => whiteout.classList.remove("run"), 1100);
    setTimeout(() => potEvent("self", 1), 720);
  } catch (err) {
    console.error(err);
    hatchLock = false;
    if (confirm) confirm.disabled = false;
    setHatchState("funding");
    const status = $("deposit-status");
    status.textContent = "Hatch failed. Try again.";
    status.classList.remove("hidden");
  }
}

$("btn-sim-deposit").onclick = () => runHatchRitual(true);

$("btn-claim").onclick = async () => {
  const overlay = $("vault-claim-overlay");
  const button = $("btn-claim");
  if (overlay.dataset.stage === "received") {
    overlay.classList.add("hidden");
    overlay.dataset.stage = "ready";
    button.textContent = "Claim reward";
    return;
  }
  if (claimLock) return;

  claimLock = true;
  const expected = Number(bond?.trancheClaimableMicros || 0);
  overlay.dataset.stage = "claiming";
  $("claim-kicker").textContent = "Claiming";
  $("claim-sub").textContent = "Moving rewards into the withdrawable balance.";
  button.disabled = true;
  button.textContent = "Claiming...";

  try {
    await sleep(850);
    const result = await window.versus.claimTranche();
    if (!result?.amount) throw new Error("nothing claimable");
    bond = result.state;
    updateModeScreen();

    overlay.dataset.stage = "received";
    $("claim-kicker").textContent = "Received";
    $("claim-amount").textContent = formatUsdcDollars(result.amount || expected);
    $("claim-sub").textContent = `Rewards now ${formatUsdcDollars(bond.vault || 0)}.`;
    button.textContent = "Continue";
  } catch (err) {
    console.error(err);
    overlay.dataset.stage = "ready";
    $("claim-kicker").textContent = "Claim failed";
    $("claim-sub").textContent = "The reward is still safe. Try again.";
    button.textContent = "Try again";
  } finally {
    button.disabled = false;
    claimLock = false;
  }
};

$("btn-withdraw-vault")?.addEventListener("click", async () => {
  const button = $("btn-withdraw-vault");
  if (!bond || Number(bond.vault || 0) <= 0 || button.disabled) return;
  button.disabled = true;
  button.textContent = "Sending";
  try {
    const result = await window.versus.withdrawVault();
    bond = result.state;
    updateModeScreen();
    toast(`${formatUsdcDollars(result.amount)} sent to wallet`);
  } catch (error) {
    console.error(error);
    toast(signalSentence(error.message, "withdraw failed", 30));
  } finally {
    button.textContent = "Withdraw";
    button.disabled = Number(bond?.vault || 0) <= 0;
  }
});

async function openRunwayFunding() {
  if (fundingOpen) return;
  fundingOpen = true;
  const overlay = $("funding-overlay");
  overlay?.classList.remove("hidden");
  $("runway-funding-status").textContent = "Preparing wallet...";
  try {
    const funding = await window.versus.beginFunding();
    $("runway-address-qr").src = funding.qr;
    $("runway-funding-status").textContent = "70% becomes USDC runway. 30% stays for gas.";
  } catch (error) {
    $("runway-funding-status").textContent = fundingErrorMessage(error);
  }
}

function closeRunwayFunding() {
  fundingOpen = false;
  $("funding-overlay")?.classList.add("hidden");
}

$("btn-fund-runway")?.addEventListener("click", openRunwayFunding);
$("btn-close-runway-funding")?.addEventListener("click", closeRunwayFunding);
$("btn-copy-runway-address")?.addEventListener("click", async () => {
  await window.versus.copyAddress();
  $("runway-funding-status").textContent = "Address copied.";
});
$("btn-complete-runway-funding")?.addEventListener("click", async () => {
  const button = $("btn-complete-runway-funding");
  button.disabled = true;
  button.textContent = "Checking...";
  try {
    const result = await window.versus.completeFunding();
    bond = await window.versus.loadBond();
    updateModeScreen();
    $("runway-funding-status").textContent = `${formatUsdcDollars(result.amount)} added to runway.`;
    button.textContent = "Done";
    setTimeout(closeRunwayFunding, 700);
  } catch (error) {
    $("runway-funding-status").textContent = fundingErrorMessage(error);
    button.textContent = "Check again";
  } finally {
    button.disabled = false;
  }
});

$("btn-mint")?.addEventListener("click", async () => {
  show("view-work");
  setPipe("swap");
  const pipeline = window.versus.runOnboardPipeline(picked);
  await sleep(700);
  setPipe("mint");
  await sleep(700);
  setPipe("class");
  bond = await pipeline;
  bond.classPotMicros = 0;
  bond.classAgents = 1;
  await window.versus.saveBond(bond);
  W.targetFill = 0;
  showClass();
  // the first penny is yours — full ritual, hop included
  setTimeout(() => potEvent("self", 1), 600);
});

$("btn-mode").onclick = () => {
  if (settingsOpen) {
    setSettingsOpen(false);
    return;
  }
  if (helpOpen) {
    setHelpOpen(false);
    return;
  }
  if (!bond || bond.phase !== "active" || bond.cypherId == null) {
    staticLcd();
    return;
  }
  const index = MODES.indexOf(activeMode);
  setMode(MODES[(index + 1) % MODES.length]);
};

$("settings-tab-brain")?.addEventListener("click", () => setSettingsTab("brain"));
$("settings-tab-device")?.addEventListener("click", () => setSettingsTab("device"));

$("settings-brain-panel")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  setSettingsStatus("SAVING");
  try {
    currentSettings = await window.versus.saveSettings(settingsInput());
    renderSettings(currentSettings);
    setSettingsStatus("SAVED");
  } catch (error) {
    setSettingsStatus(settingsErrorMessage(error), true);
  }
});

$("setting-launch-login")?.addEventListener("change", async () => {
  setSettingsStatus("SAVING");
  try {
    currentSettings = await window.versus.saveSettings(settingsInput());
    renderSettings(currentSettings);
    setSettingsStatus("SAVED");
  } catch (error) {
    setSettingsStatus(settingsErrorMessage(error), true);
  }
});

$("btn-test-brain")?.addEventListener("click", async () => {
  setSettingsStatus("TESTING");
  try {
    const result = await window.versus.testBrain(settingsInput());
    setSettingsStatus(result.status === "off" ? "BRAIN OFF" : result.silent ? "CONNECTED" : "REPLIED");
  } catch (error) {
    setSettingsStatus(settingsErrorMessage(error), true);
  }
});

function backupPassword() {
  const password = $("setting-backup-password")?.value || "";
  if (password.length < 8) throw new Error("Use an 8+ character password");
  return password;
}

$("btn-backup-wallet")?.addEventListener("click", async () => {
  try {
    setSettingsStatus("BACKING UP");
    const result = await window.versus.createCypherArchive(backupPassword());
    setSettingsStatus(result.canceled ? "CANCELED" : "BACKUP SAVED");
  } catch (error) {
    setSettingsStatus(settingsErrorMessage(error), true);
  }
});

$("btn-restore-wallet")?.addEventListener("click", async () => {
  try {
    setSettingsStatus("RESTORING");
    const result = await window.versus.restoreCypherArchive(backupPassword());
    if (!result.canceled) {
      wallet = await window.versus.getWallet();
      bond = result.state || await window.versus.loadBond();
      renderSettings(currentSettings);
      if (bond?.phase === "active") {
        showClass();
        updateModeScreen();
      }
    }
    setSettingsStatus(result.canceled ? "CANCELED" : "RESTORED");
  } catch (error) {
    setSettingsStatus(settingsErrorMessage(error), true);
  }
});

$("btn-copy-key")?.addEventListener("click", async () => {
  if (!confirm("Copy the emergency private key to the clipboard? Anyone with it controls this Cypher.")) return;
  await window.versus.copyPrivateKey();
  setSettingsStatus("KEY COPIED");
});

$("btn-reconcile")?.addEventListener("click", async () => {
  setSettingsStatus("SYNCING");
  try {
    bond = await window.versus.reconcile() || bond;
    if (bond?.phase === "active") updateModeScreen();
    setSettingsStatus("CHAIN CURRENT");
  } catch (error) {
    setSettingsStatus(deviceErrorMessage(error), true);
  }
});

$("cypher-card-flip")?.addEventListener("click", () => {
  if (activeMode !== "cypher") return;
  setCypherFlipped(!cypherFlipped);
});

$("btn-signal-flip")?.addEventListener("click", () => {
  if (activeMode !== "network") return;
  setSignalFlipped(!signalFlipped);
});

$("btn-brain-think")?.addEventListener("click", async () => {
  const agent = networkSnapshot?.status?.agent;
  if (!agent?.configured) {
    toast("configure a local brain");
    return;
  }
  try {
    await window.versus.agentTick();
  } catch (error) {
    toast(signalSentence(error.message, "brain unavailable", 32));
  }
  await refreshNetworkScreen();
});

$("btn-brain-auto")?.addEventListener("click", async () => {
  const agent = networkSnapshot?.status?.agent;
  if (!agent?.configured) {
    toast("configure a local brain");
    return;
  }
  try {
    if (agent.status === "listening") await window.versus.agentStop();
    else await window.versus.agentStart();
  } catch (error) {
    toast(signalSentence(error.message, "brain unavailable", 32));
  }
  await refreshNetworkScreen();
});

$("help-card-flip")?.addEventListener("click", () => {
  if (!helpOpen) return;
  setHelpFlipped(!helpFlipped);
});

/* Tap the raft/Cypher to queue pennies; accounting moves only after confirmation. */
$("cistern")?.addEventListener("click", (e) => {
  if (!bond || bond.phase !== "active" || activeMode !== "raft") return;
  const rect = $("cistern").getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const onRaft = Math.abs(x - rect.width / 2) < 90 && y > PH.heave.p && y < PH.heave.p + RAFT_H;
  if (onRaft) queueRainTap();
  else {
    W.whiteQueue += 1;
    spawnRipple(x, 0.5, false, 0);
  }
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* debug/test hooks (used by scripts/capture-views.js) */
window.__pet = {
  show,
  showClass,
  runHatchRitual,
  setBond(b) {
    bond = b;
    if (b) W.targetFill = clamp((b.classPotMicros || 0) / FLOOR_MICROS, 0, 1);
  },
  getBond: () => bond,
  setPhase(p) {
    forcedPhase = p;
    updateSceneClock();
  },
  setFill(f) {
    W.targetFill = W.fill = W.raftFill = clamp(f, 0, 1);
    if (bond) bond.classPotMicros = Math.round(f * FLOOR_MICROS);
    PH.heave.t = PH.heave.p = Math.max(6, waterTopBase(W.raftFill) - (RAFT_H - SUBMERGE));
    W.gradNear = W.targetFill >= 0.95;
    $("shell")?.setAttribute("data-grad", W.gradNear ? "near" : "far");
    updateReadout();
  },
  setMode(m) {
    activeMode = m;
    updateModeScreen();
  },
  potEvent,
  queueRainTap,
  flushRainBatch,
  storm(v) {
    W.targetStorm = clamp(v, 0, 1);
    W.stormOffAt = 0;
  },
  _w: W,
  _ph: PH,
  _surfaceYAt: surfaceYAt,
};

boot();
