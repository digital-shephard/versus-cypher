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
  syncServiceScrewControls();
}

function serviceScrewsCanMove() {
  return serviceStage === "closed" || serviceStage === "awaiting-screws";
}

function syncServiceScrewControls() {
  const canMove = serviceScrewsCanMove();
  document.querySelectorAll("[data-screw-id]").forEach((button) => {
    button.disabled = !canMove || button.classList.contains("is-loosening");
  });
  document.querySelectorAll("[data-loose-screw-id]").forEach((button) => {
    button.disabled = !canMove || button.classList.contains("is-returning");
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
  if (!serviceScrewsCanMove() || button.classList.contains("is-loosening")) return;
  const id = Number(button.dataset.screwId);
  if (!Number.isInteger(id) || removedServiceScrews.has(id)) return;
  button.classList.add("is-loosening");
  button.disabled = true;
  window.setTimeout(() => {
    button.classList.remove("is-visible", "is-loosening");
    const loose = document.querySelector(`[data-loose-screw-id="${id}"]`);
    loose.classList.add("is-visible", "is-landed");
    removedServiceScrews.add(id);
    syncServiceScrewControls();
    if (serviceStage === "closed" && removedServiceScrews.size === SERVICE_SCREW_COUNT) openServiceChassis();
  }, 620);
}

function reinstallServiceScrew(loose) {
  if (!serviceScrewsCanMove() || loose.classList.contains("is-returning")) return;
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
  // Reserve the socket immediately so another removal cannot open the chassis
  // while this screw is visibly travelling home.
  removedServiceScrews.delete(id);
  window.setTimeout(() => {
    loose.classList.remove("is-visible", "is-returning");
    loose.style.removeProperty("--return-x");
    loose.style.removeProperty("--return-y");
    installed.classList.add("is-visible", "is-tightening");
    syncServiceScrewControls();
    window.setTimeout(() => installed.classList.remove("is-tightening"), 460);
    if (serviceStage === "awaiting-screws" && removedServiceScrews.size === 0) {
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

function wireFxWheel() {
  const button = $("btn-fx-wheel");
  const layer = $("fx-wheel-layer");
  const image = layer?.querySelector("img");
  if (!button || !layer || !image) return;

  let rotation = 0;
  let lastWheelAt = 0;
  let activeAnimation = null;
  const turn = (direction) => {
    const step = direction < 0 ? -90 : 90;
    const start = rotation;
    const target = start + step;
    const overshoot = target + Math.sign(step) * 11;
    const rebound = target - Math.sign(step) * 3;

    activeAnimation?.cancel();
    activeAnimation = null;
    rotation = target;
    layer.style.setProperty("--fx-wheel-rotation", `${target}deg`);
    layer.classList.add("is-turning");

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || typeof image.animate !== "function") {
      layer.classList.remove("is-turning");
      return;
    }

    const animation = image.animate([
      {
        transform: `rotate(${start}deg)`,
        offset: 0,
        easing: "cubic-bezier(0.42, 0, 0.58, 1)",
      },
      {
        transform: `rotate(${overshoot}deg)`,
        offset: 0.68,
        easing: "cubic-bezier(0.16, 1, 0.3, 1)",
      },
      {
        transform: `rotate(${rebound}deg)`,
        offset: 0.86,
        easing: "cubic-bezier(0.4, 0, 0.2, 1)",
      },
      { transform: `rotate(${target}deg)`, offset: 1 },
    ], {
      duration: 320,
      easing: "linear",
    });
    activeAnimation = animation;
    animation.addEventListener("finish", () => {
      if (activeAnimation !== animation) return;
      layer.classList.remove("is-turning");
      activeAnimation = null;
    }, { once: true });
  };

  button.addEventListener("click", () => {
    turn(1);
    toggleFxSurface();
  });
  button.addEventListener("wheel", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const now = performance.now();
    if (now - lastWheelAt < 90) return;
    lastWheelAt = now;
    turn(event.deltaY || event.deltaX || 1);
  }, { passive: false });
}

wireChrome();
wireFxWheel();
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

function networkNowMs() {
  return Date.now() + Number(bond?.networkClockOffsetMs || 0);
}

const MODES = ["raft", "cypher", "vault", "network"];
const FX_MODES = ["desk", "stock", "tape", "risk"];
const MODE_LABELS = {
  cypher: [
    ["raft", "Raft"],
    ["cypher", "Cypher"],
    ["vault", "Vault"],
    ["network", "Signal"],
  ],
  fx: [
    ["desk", "Desk"],
    ["stock", "Stock"],
    ["tape", "Tape"],
    ["risk", "Risk"],
  ],
};
let activeMode = "raft";
let activeFxMode = "desk";
let activeSurface = "cypher";
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
let updateStatus = null;
let healthSnapshot = { version: 1, status: "healthy", issues: [] };
let selectedHealthCode = null;
let currentSettings = null;
let brainCapabilities = null;
let fundingOpen = false;
let signalFlipped = false;
let networkSnapshot = null;
let networkRefreshLock = false;
let brainThinkPending = false;
let graduationRunning = false;
let classOverUntil = 0;
let classOverTimer = null;

function clearClassOverNotice() {
  clearTimeout(classOverTimer);
  classOverTimer = null;
  classOverUntil = 0;
  const notice = $("class-over-notice");
  notice?.classList.remove("run");
  notice?.setAttribute("aria-hidden", "true");
}
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
  { len0: 5, len1: 9, spd0: 110, spd1: 155, w: 1.1, a: 0.42, wind: 1.08, rate: 18 },
  { len0: 9, len1: 14, spd0: 170, spd1: 225, w: 1.35, a: 0.58, wind: 1, rate: 12 },
  { len0: 14, len1: 21, spd0: 245, spd1: 320, w: 2, a: 0.82, wind: 0.92, rate: 7 },
];
const RAIN_RATE_WINDOW_MS = 4_000;
const MAX_RAIN_RATE = 5;
const MAX_RAIN_RATE_SAMPLES = MAX_RAIN_RATE * (RAIN_RATE_WINDOW_MS / 1000);
const MAX_PENDING_RAIN_BURSTS = 24;
const MAX_COALESCED_RAIN_PENNIES = 1_000_000;

const W = {
  w: 0, h: 0,
  fill: 0, targetFill: 0, raftFill: 0,
  storm: 0, targetStorm: 0, stormOffAt: 0,
  verifiedDropsRendered: 0,
  microburstsRendered: 0,
  coalescedRainPennies: 0,
  rainRate: 0, rainPressure: 0, rainTimes: [],
  wind: 0, isNight: false, gradNear: false,
  causticBoost: 0,
  palFrom: new Float32Array(21), palTo: new Float32Array(21), pal: new Float32Array(21),
  palT: 1, paletteDirty: true,
  css: { surface: "", mid: "", deep: "", spec: "", foam: "" },
  bodyGrad: null, glowGrad: null, gradTop: -1,
  surfY: null,
  hash: new Float32Array(32),
  drops: pool(128, () => ({
    x: 0, y: 0, vy: 0, len: 0, layer: 0,
    gold: false, white: false, hero: false, front: false,
    drift: 0, alphaScale: 1, widthScale: 1, headSize: 1, impactScale: 1,
  })),
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
  const rawZoom = Math.min(targetWidth / visibleWidth, targetHeight / visibleHeight) * (layout.raftZoom || 1);
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

function fieldNoteText(text) {
  return String(text || "Field record unavailable.").trim();
}

function resetFieldNoteScroll() {
  const viewport = $("cypher-field-note-copy");
  if (viewport) viewport.scrollTop = 0;
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
  if (!cypherFlipped) resetFieldNoteScroll();
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
  ["view-boot", "view-deposit", "view-class"].forEach((id) => $(id).classList.add("hidden"));
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
  settingsTab = ["brain", "device", "health"].includes(tab) ? tab : "brain";
  for (const name of ["brain", "device", "health"]) {
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
  if ($("setting-referral-funding")) $("setting-referral-funding").checked = Boolean(settings?.allowReferralFunding);
  if ($("setting-launch-login")) $("setting-launch-login").checked = Boolean(settings?.launchAtLogin);
  $("setting-fx-development-row")?.classList.toggle(
    "hidden",
    settings?.fxDevelopmentAvailable !== true
  );
  if ($("setting-fx-development")) {
    $("setting-fx-development").checked = Boolean(settings?.fxDevelopmentEnabled);
  }
  if ($("settings-wallet-address")) $("settings-wallet-address").textContent = wallet?.address || "Wallet not loaded";
  if ($("btn-backup-wallet")) {
    $("btn-backup-wallet").textContent = bond?.phase === "active" && bond?.agentId ? "Back up all" : "Back up wallet";
  }
  updateBrainAdapterFields();
  renderFxScreen();
}

function renderUpdateStatus(status) {
  updateStatus = status || { status: "disabled", currentVersion: "--" };
  const button = $("btn-update");
  const detail = $("settings-update-status");
  if (!button || !detail) return;
  const version = updateStatus.currentVersion || "--";
  const next = updateStatus.availableVersion || "";
  const labels = {
    idle: "Check for updates",
    checking: "Checking...",
    current: "Check again",
    available: `Download ${next}`,
    downloading: `Downloading ${updateStatus.progress || 0}%`,
    ready: "Restart to update",
    error: "Try update again",
    disabled: "Updates unavailable",
  };
  button.textContent = labels[updateStatus.status] || "Check for updates";
  button.disabled = ["checking", "downloading", "disabled"].includes(updateStatus.status);
  detail.textContent = updateStatus.status === "ready"
    ? `Version ${next} downloaded and ready`
    : updateStatus.status === "available"
      ? `Version ${next} is available`
      : updateStatus.status === "error"
        ? signalSentence(updateStatus.error, "Update check failed", 64)
        : `Version ${version}`;
  detail.classList.toggle("error", updateStatus.status === "error");
}

function renderHealth(health) {
  healthSnapshot = health?.version === 1 ? health : { version: 1, status: "healthy", issues: [] };
  const issues = Array.isArray(healthSnapshot.issues) ? healthSnapshot.issues : [];
  if (!issues.some((issue) => issue.code === selectedHealthCode)) selectedHealthCode = issues[0]?.code || null;
  const selected = issues.find((issue) => issue.code === selectedHealthCode) || null;
  const summary = $("health-summary");
  if (summary) {
    summary.dataset.status = healthSnapshot.status;
    const title = summary.querySelector("strong");
    const detail = summary.querySelector("small");
    if (title) title.textContent = healthSnapshot.status === "healthy"
      ? "DEVICE HEALTHY"
      : healthSnapshot.status === "limited" ? "RUNNING LIMITED" : healthSnapshot.status === "recovery" ? "RECOVERY NEEDED" : "OWNER ATTENTION";
    if (detail) detail.textContent = issues.length
      ? `${issues.length} checked ${issues.length === 1 ? "issue" : "issues"}. Your keys remain local.`
      : "All checked systems are ready.";
  }
  const container = $("health-issues");
  if (container) {
    container.replaceChildren();
    if (!issues.length) {
      const empty = document.createElement("p");
      empty.className = "health-empty";
      empty.textContent = "NO ACTIVE ISSUES";
      container.appendChild(empty);
    }
    for (const issue of issues) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `health-issue${issue.code === selectedHealthCode ? " active" : ""}`;
      button.dataset.issueCode = issue.code;
      const title = document.createElement("strong");
      title.textContent = signalSentence(issue.title, "Device issue", 44);
      const detail = document.createElement("small");
      detail.textContent = signalSentence(issue.detail, "A subsystem needs attention.", 82);
      button.append(title, detail);
      button.addEventListener("click", () => {
        selectedHealthCode = issue.code;
        renderHealth(healthSnapshot);
      });
      container.appendChild(button);
    }
  }
  if ($("health-recovery")) {
    $("health-recovery").textContent = selected
      ? signalSentence(selected.action, "Recheck the device before repeating the action.", 112)
      : "No recovery action is needed.";
  }
  $("btn-settings")?.setAttribute("data-health", healthSnapshot.status);
}

function updateBrainAdapterFields() {
  const kind = $("setting-brain-kind")?.value || "off";
  const http = ["cloud", "local", "external"].includes(kind);
  const cli = ["codex", "claude"].includes(kind);
  $("brain-endpoint-field")?.classList.toggle("hidden", !http);
  $("brain-key-field")?.classList.toggle("hidden", !http);
  $("brain-model-field")?.classList.toggle("hidden", kind === "off");
  if ($("setting-brain-model")) {
    $("setting-brain-model").placeholder = cli ? "default model" : "model name";
    $("setting-brain-model").required = http;
  }
  if ($("setting-brain-endpoint")) {
    $("setting-brain-endpoint").required = http;
    $("setting-brain-endpoint").placeholder = kind === "external"
      ? "http://127.0.0.1:8642/v1/chat/completions"
      : "http://127.0.0.1:11434/v1/chat/completions";
  }
  const status = $("brain-adapter-status");
  if (!status) return;
  status.classList.remove("ready", "missing");
  if (kind === "off") status.textContent = "Daily rain only - no inference";
  else if (kind === "codex" || kind === "claude") {
    const installed = Boolean(brainCapabilities?.[kind]?.installed);
    status.textContent = installed
      ? `${kind} found - uses its own account login`
      : `${kind} not found on this computer`;
    status.classList.add(installed ? "ready" : "missing");
  } else if (kind === "local") {
    status.textContent = "Local OpenAI-compatible inference";
    status.classList.add("ready");
  } else if (kind === "external") {
    status.textContent = "Narrowband HTTP - no tools";
    status.classList.add("ready");
  } else {
    status.textContent = "Hosted OpenAI-compatible inference";
    status.classList.add("ready");
  }
}

function settingsInput() {
  return {
    launchAtLogin: Boolean($("setting-launch-login")?.checked),
    allowReferralFunding: Boolean($("setting-referral-funding")?.checked),
    fxDevelopmentEnabled: Boolean($("setting-fx-development")?.checked),
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
  if (settingsOpen && $("btn-copy-referral")) {
    const code = await window.versus.getReferralCode();
    $("btn-copy-referral").textContent = code || "No Cypher yet";
    $("btn-copy-referral").dataset.code = code || "";
  }
  $("shell")?.setAttribute("data-settings", settingsOpen ? "true" : "false");
  flashLcd(true);
  if (settingsOpen) {
    stopLoop();
    setSettingsTab(settingsTab);
    setSettingsStatus("LOADING");
    try {
      const [settings, capabilities, updater, health] = await Promise.all([
        window.versus.getSettings(),
        window.versus.getBrainCapabilities(),
        window.versus.getUpdateStatus(),
        window.versus.getHealth(),
      ]);
      brainCapabilities = capabilities;
      renderSettings(settings);
      renderUpdateStatus(updater);
      renderHealth(health);
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
  if (/disabled Claude subscription access|Claude subscription access.*disabled|Use an Anthropic API key|Claude Code needs.*API key/i.test(message)) {
    return "Claude account blocked. Enable subscription or add an API key.";
  }
  if (/Codex.*(?:login|sign in|authentication)|unauthorized.*Codex/i.test(message)) {
    return "Sign into Codex CLI on this computer, then test again.";
  }
  if (/(?:Codex CLI|Claude Code) is not installed/i.test(message)) {
    return message;
  }
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
  const utcDay = Math.floor(networkNowMs() / 86_400_000);
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
  const drive = coalition?.currentReferralDrive || null;
  const leading = proposals[0] || null;
  const mission = leading?.missions?.[0] || null;
  const headline = $("signal-headline");
  const copy = $("signal-copy");
  const kicker = $("signal-kicker");
  const copyCode = $("btn-signal-copy-code");
  copyCode?.classList.toggle("hidden", !drive);
  if (drive) {
    kicker.textContent = "REFERRAL DRIVE";
    headline.textContent = signalSentence(drive.body, "A new invite drive is ready", 48);
    copy.textContent = `${formatUsdcDollars(drive.fundingGoalMicros)} target · ${Number(drive.supporters || 0)} support · ${drive.referralCode}`;
  } else if (mission) {
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
  const proposalCount = drive ? 1 : 0;
  $("signal-peers").textContent = formatCompact(peers);
  $("signal-postcards").textContent = formatCompact(notes);
  $("signal-proposals").textContent = formatCompact(proposalCount);
  renderSignalGraph(active ? (status.neighborhood || []) : []);
  $("signal-card")?.classList.toggle("has-traffic", active && (peers > 0 || notes > 0));

  const brainStatus = brainThinkPending
    ? "thinking"
    : String(agent.status || (agent.configured ? "sleeping" : "off"));
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
  const testSignal = $("btn-test-signal");
  if (think) {
    think.disabled = !agent.configured || brainStatus === "thinking";
    think.textContent = brainThinkPending ? "THINKING" : "THINK";
    think.setAttribute("aria-busy", brainThinkPending ? "true" : "false");
  }
  if (auto) {
    auto.disabled = !agent.configured || brainStatus === "thinking";
    auto.textContent = brainStatus === "listening" ? "STOP" : "AUTO";
  }
  testSignal?.classList.toggle("hidden", !status.testSignalEnabled);
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

function updateNextRainCountdown() {
  const label = $("vault-today");
  if (!label || !bond) return;
  const remaining = Math.ceil(Number(bond.nextCommitAt || 0) - networkNowMs() / 1000);
  if (remaining <= 0) {
    label.textContent = "Ready";
    return;
  }
  const hours = Math.floor(remaining / 3600);
  const minutes = Math.ceil((remaining % 3600) / 60);
  label.textContent = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function renderModeDock() {
  const entries = MODE_LABELS[activeSurface] || MODE_LABELS.cypher;
  const selected = activeSurface === "fx" ? activeFxMode : activeMode;
  const dots = [...document.querySelectorAll("#mode-dots span")];
  dots.forEach((dot, index) => {
    const [mode, label] = entries[index];
    dot.dataset.m = mode;
    dot.textContent = label;
    dot.classList.toggle("active", mode === selected);
  });
}

/* ------------------------------------------------------------------
   FX dealer surface — inventory bays, receipt tape, risk console.
   The renderer consumes the fail-closed main-process service; keys,
   recovery packets, Waku sessions, and chain writes stay outside this
   process. __pet.setFxDemo() remains screenshot-only sample data.
   ------------------------------------------------------------------ */

const FX_SUPPORTED_POSITIONS = [
  {
    id: "base-sepolia-usdc",
    chainId: "84532",
    chainKey: "base",
    chain: "BASE SEPOLIA",
    asset: "USDC",
    decimals: 6,
    assetAddress: "0xcba3d9354dd4c30bb6961abb4473a6340486e01b",
  },
  {
    id: "arbitrum-sepolia-usdc",
    chainId: "421614",
    chainKey: "arbitrum",
    chain: "ARBITRUM SEPOLIA",
    asset: "USDC",
    decimals: 6,
    assetAddress: "0xcba3d9354dd4c30bb6961abb4473a6340486e01b",
  },
];

const FX_SUPPORTED_CHAINS = [
  {
    chainId: "84532",
    chainKey: "base",
    chain: "BASE SEPOLIA",
    nativeAsset: "ETH",
    nativeDecimals: 18,
  },
  {
    chainId: "421614",
    chainKey: "arbitrum",
    chain: "ARBITRUM SEPOLIA",
    nativeAsset: "ETH",
    nativeDecimals: 18,
  },
];

const FX_RISK_CONTROLS = {
  maxTradeUsd: {
    readout: "fx-risk-max-trade",
    steps: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500],
    format: (value) => `$${value.toLocaleString("en-US")}`,
  },
  maxExposureUsd: {
    readout: "fx-risk-max-exposure",
    steps: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
    format: (value) => `$${value.toLocaleString("en-US")}`,
  },
  minSpreadBps: {
    readout: "fx-risk-min-spread",
    steps: [1, 5, 10, 15, 25, 40, 60, 100],
    format: (value) => `${value} BPS`,
  },
  quoteTimeoutSec: {
    readout: "fx-risk-timeout",
    steps: [10, 15, 30, 45, 60],
    format: (value) => `${value}s`,
  },
  reservationSec: {
    readout: "fx-risk-reservation",
    steps: [30, 60, 90, 120, 300, 600],
    format: (value) => (value < 120 ? `${value}s` : `${value / 60}m`),
  },
  requesterExposureUsd: {
    readout: "fx-risk-requester-exposure",
    steps: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500],
    format: (value) => `$${value.toLocaleString("en-US")}`,
    label: "PER REQUESTER",
    policyKey: "maximumRequesterExposureUsd",
  },
  assetExposureUsd: {
    readout: "fx-risk-asset-exposure",
    steps: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
    format: (value) => `$${value.toLocaleString("en-US")}`,
    label: "PER ASSET",
    policyKey: "maximumAssetExposureUsd",
  },
  maxGasUsd: {
    readout: "fx-risk-max-gas",
    steps: [0, 1, 2, 5, 10, 25, 50, 100],
    format: (value) => `$${value.toLocaleString("en-US")}`,
    label: "MAX GAS",
    policyKey: "maximumGasUsd",
  },
  overheadBps: {
    readout: "fx-risk-overhead",
    steps: [0, 25, 50, 100, 200, 500, 1000],
    format: (value) => `${value} BPS`,
    label: "MAX OVERHEAD",
    policyKey: "maximumOverheadBps",
  },
  inventoryPremiumBps: {
    readout: "fx-risk-inventory-premium",
    steps: [0, 5, 10, 25, 50, 100, 250],
    format: (value) => `${value} BPS`,
    label: "INVENTORY PREMIUM",
    policyKey: "inventoryPremiumBps",
  },
};

const ELLIPSIS = "\u2026";
const MIDDOT = "\u00b7";
const FX_TAPE_DEMO_RECEIPTS = [
  { kind: "SETTLED", at: "14:02", route: `BASE USDC ${MIDDOT} ARBITRUM USDC`, amount: "$0.50", detail: "SPREAD +$0.0012", reference: "0x9f2c4a71d3b6e05812fa7c93de40188cb6d24b17", state: "settled" },
  { kind: "SETTLED", at: "13:41", route: `ARBITRUM USDC ${MIDDOT} BASE USDC`, amount: "$0.25", detail: "SPREAD +$0.0008", reference: "0x41b8d0e27ca5f9314d6027ba88e5137fa0c93e42", state: "settled" },
  { kind: "RESERVED", at: "13:37", route: `BASE USDC ${MIDDOT} ARBITRUM USDC`, amount: "$0.75", detail: "HOLD 90s", reference: "0x77ad91fe4c2b8350ea16d47c9b0f2381ce5a7d90", state: "pending" },
  { kind: "REFUND", at: "12:18", route: `BASE USDC ${MIDDOT} ARBITRUM USDC`, amount: "$0.40", detail: "QUOTE LAPSED", reference: "0x2be05c8137da49f6b0e71c3a95d8046f2ac13b58", state: "refunded" },
];

function emptyFxInventory() {
  return FX_SUPPORTED_POSITIONS.map((bay) => ({
    ...bay,
    kind: "token",
    address: null,
    availableMicros: 0,
    reservedMicros: 0,
    capacityMicros: 0,
    inFlight: 0,
    enabled: false,
  }));
}

let fxInventory = emptyFxInventory();
let fxChains = FX_SUPPORTED_CHAINS.map((chain) => ({
  ...chain,
  enabled: false,
  gasReady: false,
  address: null,
  balanceAtomic: "0",
  balanceUsd: 0,
  rpcUrl: "",
}));
let fxTape = [];
let fxOpenBay = null;
let fxSheetBay = null;
let fxSheetChain = null;
let fxSheetChainRole = "dealer";
let fxStockFilter = "all";
let fxExpandedChains = new Set();
let fxTapeDemoTimers = [];
let fxDesktopSnapshot = null;
let fxRequesterTrade = null;
let fxRequesterView = "swap";
let fxQuoteRefreshActive = false;
let fxQuoteRefreshRetryAt = 0;
let fxQuoteAcceptActive = false;
let fxCancelActive = false;
let fxDealerTogglePending = null;
const fxRisk = {
  armed: false,
  maxTradeUsd: 250,
  maxExposureUsd: 1000,
  minSpreadBps: 25,
  quoteTimeoutSec: 30,
  reservationSec: 90,
  requesterExposureUsd: 100,
  assetExposureUsd: 500,
  maxGasUsd: 5,
  overheadBps: 100,
  inventoryPremiumBps: 0,
};

function fxAtomicMicros(value, decimals = 6) {
  const atomic = BigInt(String(value || "0"));
  if (decimals === 6) return Number(atomic);
  if (decimals > 6) return Number(atomic / (10n ** BigInt(decimals - 6)));
  return Number(atomic * (10n ** BigInt(6 - decimals)));
}

function fxAssetAmount(value, decimals = 18, asset = "ETH", maxFractionDigits = 6) {
  const atomic = BigInt(String(value || "0"));
  const scale = 10n ** BigInt(decimals);
  const whole = atomic / scale;
  const remainder = atomic % scale;
  const digits = Math.max(0, Math.min(decimals, maxFractionDigits));
  const fraction = remainder
    .toString()
    .padStart(decimals, "0")
    .slice(0, digits)
    .replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} ${asset}`;
}

function fxTradeReceipt(trade) {
  const settled = ["funds_ready", "complete"].includes(trade.state);
  const refunded = trade.state === "refunded";
  const reference =
    trade.receipt?.destinationTransactionHash ||
    trade.receipt?.sourceTransactionHash ||
    trade.refund?.transactionHash ||
    trade.transactionHash ||
    trade.tradeId;
  const confirmations =
    trade.receipt?.confirmations ||
    trade.fundingVerification?.confirmations ||
    null;
  return {
    tradeId: trade.tradeId,
    role: trade.role,
    kind: settled ? "SETTLED" : refunded ? "REFUND" : trade.state.toUpperCase().slice(0, 12),
    at: new Date(trade.updatedAt || trade.createdAt || Date.now())
      .toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    route: `${trade.source?.chain || "SOURCE"} ${trade.source?.asset || ""} ${MIDDOT} ${trade.destination?.chain || "DEST"} ${trade.destination?.asset || ""}`,
    amount: trade.outputAmountDisplay || "--",
    detail: [
      trade.route ? `${trade.route.spreadBps} BPS` : "PENDING",
      confirmations ? `${confirmations} CONF` : null,
    ].filter(Boolean).join(` ${MIDDOT} `),
    reference,
    state: settled ? "settled" : refunded ? "refunded" : "pending",
    dealerRefundReady:
      trade.role === "dealer" &&
      trade.state === "refund_wait" &&
      trade.refund?.eligible === true,
  };
}

function applyFxSnapshot(snapshot) {
  if (!snapshot) return;
  fxDesktopSnapshot = snapshot;
  fxChains = (snapshot.chains || []).map((chain) => ({
    ...chain,
    chainKey: chain.chainKey?.includes("arbitrum") ? "arbitrum" : "base",
    balanceUsd: Number(chain.balanceUsd || 0),
  }));
  const gasInventory = fxChains
    .filter((chain) =>
      chain.enabled === true
      || BigInt(chain.dealerBalanceAtomic || chain.balanceAtomic || "0") > 0n
    )
    .map((chain) => {
      const nativePosition = (snapshot.positions || []).find(
        (position) =>
          position.chainId === chain.chainId &&
          position.assetKind === "native"
      );
      return ({
      ...chain,
      id: nativePosition?.id || `${chain.chainKey}-native-eth`,
      kind: "gas",
      asset: chain.nativeAsset,
      decimals: chain.nativeDecimals,
      address: nativePosition?.address || chain.dealerAddress || chain.address,
      dealerBalanceAtomic:
        chain.dealerBalanceAtomic || chain.balanceAtomic || "0",
      availableAtomic: nativePosition?.availableAtomic || "0",
      reservedAtomic: nativePosition?.reservedAtomic || "0",
      availableMicros: Number(nativePosition?.availableUsdMicros || 0),
      reservedMicros: Number(nativePosition?.reservedUsdMicros || 0),
      inFlight: Number(nativePosition?.activeLocks || 0),
    });
    });
  const tokenInventory = (snapshot.positions || [])
    .filter(
      (position) =>
        position.enabled &&
        position.assetKind !== "native"
    )
    .map((position) => ({
      ...position,
      kind: "token",
      chainKey: position.chainKey.includes("arbitrum") ? "arbitrum" : "base",
      availableMicros: fxAtomicMicros(position.availableAtomic, position.decimals),
      reservedMicros: fxAtomicMicros(position.reservedAtomic, position.decimals),
      capacityMicros: Math.max(
        fxAtomicMicros(position.availableAtomic, position.decimals)
          + fxAtomicMicros(position.reservedAtomic, position.decimals),
        1_000_000,
      ),
      inFlight: position.activeLocks,
    }));
  fxInventory = [...gasInventory, ...tokenInventory];
  fxRisk.armed = snapshot.policy?.armed === true;
  fxRisk.maxTradeUsd = Number(snapshot.policy?.maximumTradeUsd || 50);
  fxRisk.maxExposureUsd = Number(snapshot.policy?.maximumExposureUsd || 1000);
  fxRisk.minSpreadBps = Number(snapshot.policy?.minimumSpreadBps || 25);
  fxRisk.quoteTimeoutSec = Number(snapshot.policy?.quoteLifetimeSeconds || 30);
  fxRisk.reservationSec = Number(snapshot.policy?.reservationSeconds || 90);
  fxRisk.requesterExposureUsd = Number(
    snapshot.policy?.maximumRequesterExposureUsd || 100
  );
  fxRisk.assetExposureUsd = Number(
    snapshot.policy?.maximumAssetExposureUsd || 500
  );
  fxRisk.maxGasUsd = Number(snapshot.policy?.maximumGasUsd || 5);
  fxRisk.overheadBps = Number(snapshot.policy?.maximumOverheadBps || 100);
  fxRisk.inventoryPremiumBps = Number(
    snapshot.policy?.inventoryPremiumBps || 0
  );
  fxTape = (snapshot.trades || []).map(fxTradeReceipt);
  if (fxRequesterTrade) {
    fxRequesterTrade = (snapshot.trades || []).find(
      (trade) => trade.tradeId === fxRequesterTrade.tradeId
    ) || fxRequesterTrade;
  }
  renderFxScreen();
  if (!$("fx-requester")?.classList.contains("hidden")) renderFxRequester();
}

async function refreshFxSnapshot(force = false) {
  try {
    applyFxSnapshot(await window.versus.fxSnapshot(force));
  } catch (error) {
    console.error("Versus FX state error:", error);
  }
}

function fxNode(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

function fxShortAddress(address) {
  if (typeof address !== "string" || address.length < 14) return address || "";
  return `${address.slice(0, 6)}${ELLIPSIS}${address.slice(-4)}`;
}

function fxAddressInputValue(input) {
  return input?.dataset?.fullAddress || input?.value?.trim() || "";
}

function wireFxAddressInput(input) {
  if (!input) return;
  input.addEventListener("focus", () => {
    if (input.dataset.fullAddress) input.value = input.dataset.fullAddress;
  });
  input.addEventListener("input", () => {
    if (input.dataset.fullAddress && input.value !== input.dataset.fullAddress) {
      delete input.dataset.fullAddress;
    }
  });
  input.addEventListener("blur", () => {
    const value = input.value.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return;
    input.dataset.fullAddress = value;
    input.value = fxShortAddress(value);
  });
}

function fxBayOf(id) {
  return fxInventory.find((bay) => bay.id === id) || null;
}

function fxVisibleInventory() {
  const filtered = fxInventory.filter((bay) => {
    const funded = bay.kind === "gas"
      ? BigInt(bay.dealerBalanceAtomic || "0") > 0n
      : bay.availableMicros + bay.reservedMicros > 0;
    const active = bay.kind === "token"
      && (bay.reservedMicros > 0 || bay.inFlight > 0);
    if (fxStockFilter === "funded") return funded;
    if (fxStockFilter === "active") return active;
    return true;
  });
  return filtered.sort((a, b) => {
    const priority = (bay) => {
      if (
        bay.kind === "token"
        && (bay.reservedMicros > 0 || bay.inFlight > 0)
      ) return 0;
      if (
        bay.kind === "gas"
          ? BigInt(bay.dealerBalanceAtomic || "0") > 0n
          : bay.availableMicros + bay.reservedMicros > 0
      ) return 1;
      return 2;
    };
    return priority(a) - priority(b)
      || a.chain.localeCompare(b.chain)
      || a.asset.localeCompare(b.asset);
  });
}

function setFxOpenBay(id) {
  fxOpenBay = id;
  let openCard = null;
  for (const card of document.querySelectorAll(".fx-bay")) {
    const open = card.dataset.positionId === id;
    card.classList.toggle("is-open", open);
    card.querySelector(".fx-bay-head")?.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) openCard = card;
  }
  openCard?.scrollIntoView({ block: "start" });
}

function fxGasBayNode(bay) {
  const dealerAtomic = BigInt(bay.availableAtomic || "0");
  const open = fxOpenBay === bay.id;

  const card = fxNode("article", open ? "fx-bay fx-gas-bay is-open" : "fx-bay fx-gas-bay");
  card.dataset.positionId = bay.id;
  card.dataset.chain = bay.chainKey;
  card.dataset.kind = "gas";
  card.dataset.state = dealerAtomic > 0n ? "stocked" : "idle";

  const head = fxNode("button", "fx-bay-head");
  head.type = "button";
  head.setAttribute("aria-expanded", open ? "true" : "false");
  head.append(fxNode("span", "fx-bay-mark"));

  const identity = fxNode("span", "fx-bay-id");
  identity.append(
    fxNode("b", null, bay.asset),
    fxNode("small", null, bay.chain),
  );
  const figure = fxNode("span", "fx-bay-figure");
  figure.append(
    fxNode(
      "b",
      null,
      fxAssetAmount(dealerAtomic, bay.decimals, bay.asset),
    ),
  );
  head.append(identity, figure, fxNode("span", "fx-bay-caret"));
  head.addEventListener("click", () =>
    setFxOpenBay(fxOpenBay === bay.id ? null : bay.id)
  );

  const rail = fxNode("div", "fx-bay-rail");
  const railFill = fxNode("i");
  railFill.style.width = bay.dealerGasReady ? "100%" : "0%";
  rail.append(railFill);

  const body = fxNode("div", "fx-bay-body");
  const actions = fxNode("div", "fx-bay-acts");
  const fund = fxNode("button", "fx-act fx-act-fill", "ADD ETH");
  fund.type = "button";
  fund.disabled = !(bay.dealerAddress || bay.address);
  fund.addEventListener("click", () =>
    openFxChainDepositSheet(bay.chainId, "dealer")
  );
  const withdraw = fxNode("button", "fx-act", "WITHDRAW");
  withdraw.type = "button";
  withdraw.disabled = dealerAtomic <= 0n;
  withdraw.addEventListener("click", () => openFxWithdrawSheet(bay.id));
  actions.append(fund, withdraw);
  body.append(actions);

  const clip = fxNode("div");
  clip.append(body);
  const drawer = fxNode("div", "fx-bay-drawer");
  drawer.append(clip);
  card.append(head, rail, drawer);
  return card;
}

function fxBayNode(bay) {
  if (bay.kind === "gas") return fxGasBayNode(bay);
  const provisioned = Boolean(bay.address);
  const stocked = bay.availableMicros + bay.reservedMicros;
  const open = fxOpenBay === bay.id;

  const card = fxNode("article", open ? "fx-bay is-open" : "fx-bay");
  card.dataset.positionId = bay.id;
  card.dataset.chain = bay.chainKey;
  card.dataset.state = stocked > 0 ? "stocked" : "idle";

  const head = fxNode("button", "fx-bay-head");
  head.type = "button";
  head.setAttribute("aria-expanded", open ? "true" : "false");
  head.append(fxNode("span", "fx-bay-mark"));

  const identity = fxNode("span", "fx-bay-id");
  identity.append(fxNode("b", null, bay.chain), fxNode("small", null, bay.asset));

  const figure = fxNode("span", "fx-bay-figure");
  figure.append(
    fxNode("b", null, formatUsdcDollars(bay.availableMicros)),
    fxNode("small", null, provisioned ? "AVAILABLE" : "NOT PROVISIONED"),
  );

  head.append(identity, figure, fxNode("span", "fx-bay-caret"));
  head.addEventListener("click", () => setFxOpenBay(fxOpenBay === bay.id ? null : bay.id));

  const rail = fxNode("div", "fx-bay-rail");
  const railFill = fxNode("i");
  const used = bay.capacityMicros > 0 ? clamp(stocked / bay.capacityMicros, 0, 1) : 0;
  railFill.style.width = `${Math.round(used * 100)}%`;
  rail.append(railFill);

  const body = fxNode("div", "fx-bay-body");

  const split = fxNode("div", "fx-bay-split");
  for (const [label, value] of [
    ["RESERVED", formatUsdcDollars(bay.reservedMicros)],
    ["IN FLIGHT", String(bay.inFlight)],
  ]) {
    const cell = fxNode("span");
    cell.append(fxNode("small", null, label), fxNode("b", null, value));
    split.append(cell);
  }
  body.append(split);

  if (provisioned) {
    const addressRow = fxNode("div", "fx-bay-addr");
    const copy = fxNode("button", "fx-mini", "COPY");
    copy.type = "button";
    copy.addEventListener("click", () => copyFxBayAddress(bay, copy));
    addressRow.append(fxNode("code", null, fxShortAddress(bay.address)), copy);
    body.append(addressRow);
  } else {
    body.append(fxNode("p", "fx-bay-hint", "NO DEALER ADDRESS ON THIS CHAIN YET"));
  }

  const actions = fxNode("div", "fx-bay-acts");
  const deposit = fxNode("button", "fx-act fx-act-fill", "DEPOSIT");
  deposit.type = "button";
  deposit.disabled = !provisioned;
  deposit.addEventListener("click", () => openFxDepositSheet(bay.id));
  const withdraw = fxNode("button", "fx-act", "WITHDRAW");
  withdraw.type = "button";
  withdraw.disabled = !provisioned || bay.availableMicros <= 0;
  withdraw.addEventListener("click", () => openFxWithdrawSheet(bay.id));
  actions.append(deposit, withdraw);
  body.append(actions);

  const clip = fxNode("div");
  clip.append(body);
  const drawer = fxNode("div", "fx-bay-drawer");
  drawer.append(clip);

  card.append(head, rail, drawer);
  return card;
}

function renderFxStock() {
  const list = $("fx-bays");
  if (!list) return;

  const positions = fxInventory;
  const available = positions.reduce((sum, bay) => sum + bay.availableMicros, 0);
  const reserved = positions.reduce((sum, bay) => sum + bay.reservedMicros, 0);
  const fundedGasChains = fxChains.reduce(
    (sum, chain) =>
      sum
      + Number(BigInt(chain.dealerBalanceAtomic || chain.balanceAtomic || "0") > 0n),
    0,
  );
  const visible = fxVisibleInventory();

  $("fx-stock-total").textContent = formatUsdcDollars(available + reserved);
  $("fx-stock-reserved").textContent = formatUsdcDollars(reserved);
  $("fx-stock-foot").textContent =
    `${fundedGasChains}/${fxChains.length} CHAINS FUNDED ${MIDDOT} ${positions.length} ASSET BAYS`;

  for (const button of document.querySelectorAll("[data-fx-stock-filter]")) {
    button.setAttribute("aria-pressed", button.dataset.fxStockFilter === fxStockFilter ? "true" : "false");
  }

  if (visible.length) {
    list.replaceChildren(...visible.map(fxBayNode));
  } else {
    const empty = fxNode("div", "fx-bays-empty");
    empty.append(
      fxNode("b", null, "NO MATCHING POSITIONS"),
      fxNode("small", null, "Change the filter or add inventory with +."),
    );
    list.replaceChildren(empty);
  }
}

function fxReceiptNode(receipt) {
  const item = fxNode("article", "fx-receipt");
  item.dataset.state = receipt.state;

  const head = fxNode("header");
  head.append(fxNode("b", null, receipt.kind), fxNode("time", null, receipt.at));

  const amount = fxNode("div", "fx-receipt-amount");
  amount.append(fxNode("b", null, receipt.amount), fxNode("small", null, receipt.detail));

  const foot = fxNode("footer");
  foot.append(
    fxNode("code", null, fxShortAddress(receipt.reference)),
    fxNode("span", null, receipt.state.toUpperCase()),
  );
  if (receipt.dealerRefundReady) {
    const refund = fxNode("button", "fx-tape-action", "REFUND");
    refund.type = "button";
    refund.addEventListener("click", async () => {
      refund.disabled = true;
      refund.textContent = "CHECKING...";
      try {
        applyFxSnapshot(
          await window.versus.fxRefundDealer(receipt.tradeId)
        );
      } catch (error) {
        toast(error.message || "dealer refund is not ready");
        refund.disabled = false;
        refund.textContent = "REFUND";
      }
    });
    foot.append(refund);
  }

  item.append(head, fxNode("p", "fx-receipt-route", receipt.route), amount, foot);
  return item;
}

function renderFxTapeCounters() {
  $("fx-tape-complete").textContent = `COMPLETE ${fxTape.filter((r) => r.state === "settled").length}`;
  $("fx-tape-refunded").textContent = `REFUNDED ${fxTape.filter((r) => r.state === "refunded").length}`;
}

function renderFxTape() {
  const paper = $("fx-roll-paper");
  if (!paper) return;

  if (fxTape.length) {
    paper.replaceChildren(...fxTape.map(fxReceiptNode));
  } else {
    const empty = fxNode("div", "fx-roll-empty");
    empty.append(
      fxNode("b", null, "TAPE IS BLANK"),
      fxNode("i"),
      fxNode("small", null, "Every quote, fill, and refund prints here with its route and settlement hash."),
    );
    paper.replaceChildren(empty);
  }

  renderFxTapeCounters();
}

function pushFxReceipt(receipt) {
  const paper = $("fx-roll-paper");
  const roll = paper?.closest(".fx-roll");
  fxTape.unshift(receipt);
  if (!paper || !roll) return;

  const node = fxReceiptNode(receipt);
  if (paper.querySelector(".fx-roll-empty")) {
    paper.replaceChildren(node);
  } else {
    paper.prepend(node);
  }
  paper.scrollTop = 0;
  roll.classList.remove("is-feeding");
  void roll.offsetWidth;
  roll.classList.add("is-feeding");
  setTimeout(() => roll.classList.remove("is-feeding"), 460);
  renderFxTapeCounters();
}

function clearFxTapeDemo() {
  for (const timer of fxTapeDemoTimers) clearTimeout(timer);
  fxTapeDemoTimers = [];
}

function playFxTapeDemo(intervalMs = 850) {
  clearFxTapeDemo();
  fxTape = [];
  renderFxTape();
  const chronological = [...FX_TAPE_DEMO_RECEIPTS].reverse();
  fxTapeDemoTimers = chronological.map((receipt, index) => setTimeout(() => {
    pushFxReceipt(receipt);
  }, 450 + index * intervalMs));
}

function renderFxRisk() {
  const panel = document.querySelector('[data-fx-panel="risk"]');
  const screen = $("fx-screen");
  if (!panel || !screen) return;

  const armed = fxRisk.armed ? "true" : "false";
  const pendingArmed = fxDealerTogglePending === "arming";
  const switchArmed = fxDealerTogglePending
    ? pendingArmed
    : fxRisk.armed;
  const stateLabel = fxDealerTogglePending
    ? (pendingArmed ? "ARMING" : "DISARMING")
    : (fxRisk.armed ? "DEALING" : "DISARMED");
  screen.dataset.armed = armed;
  panel.dataset.armed = armed;
  for (const label of document.querySelectorAll(".fx-state-label")) {
    label.textContent = stateLabel;
  }
  const toggle = $("fx-risk-armed");
  toggle.setAttribute("aria-checked", switchArmed ? "true" : "false");
  toggle.setAttribute(
    "aria-busy",
    fxDealerTogglePending ? "true" : "false"
  );
  toggle.disabled = Boolean(fxDealerTogglePending);

  for (const [key, control] of Object.entries(FX_RISK_CONTROLS)) {
    const readout = control.readout ? $(control.readout) : null;
    if (readout) readout.textContent = control.format(fxRisk[key]);
    const index = control.steps.indexOf(fxRisk[key]);
    for (const button of document.querySelectorAll(`[data-fx-step^="${key}:"]`)) {
      const next = index + Number(button.dataset.fxStep.split(":")[1]);
      button.disabled = next < 0 || next >= control.steps.length;
    }
  }

  const foot = $("fx-risk-foot");
  if (fxDealerTogglePending) {
    foot.textContent = pendingArmed
      ? "VERIFYING INVENTORY · STARTING DEALER"
      : "CLOSING DEALER · SAVING STATE";
  } else if (fxDesktopSnapshot?.enabled !== true) {
    foot.textContent = "FX IS OFF \u2014 REQUESTS AND DEALING DISABLED";
  } else if (!fxRisk.armed) {
    foot.textContent = "DEALING OFF \u2014 NOTHING QUOTED";
  } else {
    foot.textContent = "REFUND: DEALER 10m \u00b7 REQUESTER 2h";
  }
}

function setFxRiskValue(key, value) {
  fxRisk[key] = value;
  if (key === "maxTradeUsd" && value > fxRisk.maxExposureUsd) {
    fxRisk.maxExposureUsd = value;
  }
  if (key === "maxExposureUsd" && value < fxRisk.maxTradeUsd) {
    fxRisk.maxTradeUsd = value;
  }
}

function closeFxSheets() {
  fxSheetBay = null;
  fxSheetChain = null;
  fxSheetChainRole = "dealer";
  $("fx-deposit-sheet")?.classList.add("hidden");
  $("fx-withdraw-sheet")?.classList.add("hidden");
  $("fx-add-position-sheet")?.classList.add("hidden");
}

function fxPositionOptionNode(position) {
  const current = (fxDesktopSnapshot?.positions || []).find(
    (candidate) => candidate.id === position.id
  );
  const selected = current?.enabled === true;
  const chain = fxChains.find(
    (candidate) => candidate.chainId === position.chainId
  );
  const locked = Boolean(current && (
    BigInt(current.availableAtomic || "0") > 0n
    || BigInt(current.reservedAtomic || "0") > 0n
    || current.activeLocks > 0
  ));

  const row = fxNode("div", "fx-position-option fx-token-option");
  const identity = fxNode("span");
  identity.append(
    fxNode("b", null, position.asset),
    fxNode(
      "small",
      null,
      chain?.dealerGasReady
        ? `INVENTORY ASSET ${MIDDOT} LIMIT $${fxRisk.assetExposureUsd}`
        : `INVENTORY ASSET ${MIDDOT} FUND ${chain?.nativeAsset || "GAS"} FIRST`
    ),
  );

  const toggle = fxNode("button", "fx-position-toggle");
  toggle.type = "button";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-label", `${position.asset} on ${position.chain}`);
  toggle.setAttribute("aria-checked", selected ? "true" : "false");
  toggle.disabled = locked || (!selected && !chain?.dealerGasReady);
  toggle.title = locked
    ? "Empty this position before removing it"
    : !chain?.dealerGasReady
      ? `Enable and fund ${chain?.nativeAsset || "gas"} first`
      : "";
  toggle.append(fxNode("i"));
  toggle.addEventListener("click", async () => {
    toggle.disabled = true;
    try {
      applyFxSnapshot(await window.versus.fxSetPositionEnabled(position.id, !selected));
      if (selected && fxOpenBay === position.id) fxOpenBay = null;
      fxStockFilter = "all";
      renderFxPositionOptions();
    } catch (error) {
      toast(error.message || "position unchanged");
      toggle.disabled = locked;
    }
  });

  row.append(identity, toggle);
  return row;
}

function fxChainOptionNode(chain) {
  const depositedAtomic =
    BigInt(chain.dealerBalanceAtomic || chain.balanceAtomic || "0");
  const positions = FX_SUPPORTED_POSITIONS
    .filter((position) => position.chainId === chain.chainId);
  const tokenEnabled = positions.some((position) =>
    (fxDesktopSnapshot?.positions || []).some(
      (current) => current.id === position.id && current.enabled === true
    )
  );
  const expanded = fxExpandedChains.has(chain.chainId);
  const row = fxNode(
    "section",
    expanded ? "fx-chain-group" : "fx-chain-group is-collapsed",
  );
  const groupHead = fxNode("button", "fx-chain-group-head");
  groupHead.type = "button";
  groupHead.setAttribute("aria-expanded", expanded ? "true" : "false");
  groupHead.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} ${chain.chain}`);
  const groupIdentity = fxNode("span", "fx-chain-group-identity");
  groupIdentity.append(
    fxNode("b", null, chain.chain),
    fxNode(
      "small",
      null,
      `${fxAssetAmount(depositedAtomic, chain.nativeDecimals, chain.nativeAsset)} ${MIDDOT} TOKENS ${tokenEnabled ? "ON" : "OFF"}`,
    ),
  );
  const groupMeta = fxNode("span", "fx-chain-group-meta");
  groupMeta.append(
    fxNode("small", null, "TESTNET"),
    fxNode("i", "fx-chain-caret"),
  );
  groupHead.append(groupIdentity, groupMeta);
  groupHead.addEventListener("click", () => {
    const willExpand = row.classList.contains("is-collapsed");
    row.classList.toggle("is-collapsed", !willExpand);
    groupHead.setAttribute("aria-expanded", willExpand ? "true" : "false");
    groupHead.setAttribute("aria-label", `${willExpand ? "Collapse" : "Expand"} ${chain.chain}`);
    body.inert = !willExpand;
    body.setAttribute("aria-hidden", willExpand ? "false" : "true");
    if (willExpand) fxExpandedChains.add(chain.chainId);
    else fxExpandedChains.delete(chain.chainId);
  });

  const head = fxNode("div", "fx-position-option fx-native-option");
  const identity = fxNode("span");
  const readiness = chain.enabled
    ? `${fxAssetAmount(depositedAtomic, chain.nativeDecimals, chain.nativeAsset)} DEPOSITED`
    : "CHAIN OFF";
  identity.append(
    fxNode("b", null, chain.nativeAsset),
    fxNode("small", null, readiness),
  );
  const controls = fxNode("span", "fx-chain-controls");
  const toggle = fxNode("button", "fx-position-toggle");
  toggle.type = "button";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-label", `${chain.nativeAsset} on ${chain.chain}`);
  toggle.setAttribute("aria-checked", chain.enabled ? "true" : "false");
  toggle.append(fxNode("i"));
  toggle.addEventListener("click", async () => {
    toggle.disabled = true;
    try {
      applyFxSnapshot(
        await window.versus.fxSetChainSettings(chain.chainId, {
          enabled: !chain.enabled,
        })
      );
      renderFxPositionOptions();
    } catch (error) {
      toast(error.message || "chain unchanged");
      toggle.disabled = false;
    }
  });
  controls.append(toggle);
  head.append(identity, controls);

  const rpc = fxNode("label", "fx-rpc-field");
  rpc.append(fxNode("small", null, "CUSTOM RPC (OPTIONAL)"));
  const input = fxNode("input");
  input.type = "url";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.placeholder = "PUBLIC RPC";
  input.value = chain.rpcUrl || "";
  const saveRpc = async () => {
    const value = input.value.trim();
    if (value === (chain.rpcUrl || "")) return;
    input.disabled = true;
    try {
      applyFxSnapshot(
        await window.versus.fxSetChainSettings(chain.chainId, {
          rpcUrl: value,
        })
      );
      renderFxPositionOptions();
    } catch (error) {
      toast(error.message || "RPC unchanged");
      input.disabled = false;
    }
  };
  input.addEventListener("blur", saveRpc);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") input.blur();
  });
  rpc.append(input);
  const bodyClip = fxNode("div");
  bodyClip.append(
    head,
    ...positions.map(fxPositionOptionNode),
    rpc,
  );
  const body = fxNode("div", "fx-chain-group-body");
  body.inert = !expanded;
  body.setAttribute("aria-hidden", expanded ? "false" : "true");
  body.append(bodyClip);
  row.append(groupHead, body);
  return row;
}

function renderFxPositionOptions() {
  const host = $("fx-position-options");
  if (!host) return;
  const nodes = fxChains.map(fxChainOptionNode);
  host.replaceChildren(...nodes);
}

function openFxAddPositionSheet() {
  closeFxSheets();
  renderFxPositionOptions();
  const sheet = $("fx-add-position-sheet");
  const host = $("fx-position-options");
  if (host) host.scrollTop = 0;
  sheet.classList.remove("hidden");
  void refreshFxSnapshot(true).then(renderFxPositionOptions);
}

async function copyFxBayAddress(bay, button) {
  if (!bay.address) return;
  const label = button.textContent;
  try {
    await window.versus.fxCopyAddress(bay.address);
    button.textContent = "COPIED";
  } catch (error) {
    console.error("Versus FX address copy error:", error);
    button.textContent = "FAILED";
  }
  setTimeout(() => { button.textContent = label; }, 900);
}

async function openFxDepositSheet(bayId) {
  const bay = fxBayOf(bayId);
  if (!bay?.address) return;
  fxSheetBay = bayId;

  $("fx-deposit-route").textContent = `${bay.chain} ${MIDDOT} ${bay.asset}`;
  $("fx-deposit-address").textContent = fxShortAddress(bay.address);
  $("fx-deposit-note").textContent = `Send only ${bay.asset} on ${bay.chain}. Anything else is lost.`;

  const image = $("fx-deposit-qr");
  const placeholder = $("fx-deposit-qr-empty");
  image.classList.add("hidden");
  placeholder.classList.remove("hidden");
  $("fx-deposit-sheet").classList.remove("hidden");

  try {
    const dataUrl = await window.versus.fxAddressQr(bay.address);
    if (!dataUrl || fxSheetBay !== bayId) return;
    image.src = dataUrl;
    image.classList.remove("hidden");
    placeholder.classList.add("hidden");
  } catch (error) {
    console.error("Versus FX deposit QR error:", error);
  }
}

function openFxWithdrawSheet(bayId) {
  const bay = fxBayOf(bayId);
  if (!bay?.address) return;
  fxSheetBay = bayId;

  $("fx-withdraw-route").textContent = `${bay.chain} ${MIDDOT} ${bay.asset}`;
  $("fx-withdraw-note").textContent = `Available ${formatUsdcDollars(bay.availableMicros)}`;
  $("fx-withdraw-dest").value = "";
  $("fx-withdraw-amount").value = "";
  $("fx-withdraw-sheet").classList.remove("hidden");
  $("fx-withdraw-dest").focus();
}

async function submitFxWithdraw() {
  const bay = fxBayOf(fxSheetBay);
  if (!bay) return;
  const destination = fxAddressInputValue($("fx-withdraw-dest"));
  const amount = Number($("fx-withdraw-amount").value.trim());
  const note = $("fx-withdraw-note");

  if (!/^0x[0-9a-fA-F]{40}$/.test(destination)) {
    note.textContent = `Enter a ${bay.chain} destination address.`;
    return;
  }
  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount * 1e6 > bay.availableMicros
  ) {
    note.textContent = `Enter an amount up to ${formatUsdcDollars(bay.availableMicros)}.`;
    return;
  }
  const button = $("fx-withdraw-send");
  button.disabled = true;
  button.textContent = "SENDING...";
  note.textContent = "Waiting for chain confirmation...";
  try {
    const snapshot = await window.versus.fxWithdrawPosition({
      positionId: bay.id,
      destination,
      amount: $("fx-withdraw-amount").value.trim(),
    });
    applyFxSnapshot(snapshot);
    const hash = snapshot.inventoryTransfer?.transactionHash;
    note.textContent = hash
      ? `Sent ${fxShortAddress(hash)}`
      : "Withdrawal confirmed";
    button.textContent = "SENT";
    setTimeout(closeFxSheets, 900);
  } catch (error) {
    note.textContent = error.message || "Withdrawal failed";
    button.disabled = false;
    button.textContent = "SEND";
  }
}

async function openFxChainDepositSheet(chainId, role = "dealer") {
  const chain = fxChains.find(
    (candidate) => candidate.chainId === String(chainId)
  );
  const depositAddress = role === "requester"
    ? chain?.requesterAddress
    : chain?.dealerAddress || chain?.address;
  if (!depositAddress) return;
  closeFxSheets();
  fxSheetChain = chain.chainId;
  fxSheetChainRole = role;
  $("fx-deposit-route").textContent =
    `${chain.chain} ${MIDDOT} ${chain.nativeAsset} ${MIDDOT} ${
      role === "requester" ? "SWAP" : "DEALER"
    }`;
  $("fx-deposit-address").textContent = fxShortAddress(depositAddress);
  $("fx-deposit-note").textContent =
    `Send only ${chain.nativeAsset} on ${chain.chain}. Minimum $${chain.minimumGasUsd || 1}.`;
  const image = $("fx-deposit-qr");
  const placeholder = $("fx-deposit-qr-empty");
  image.classList.add("hidden");
  placeholder.classList.remove("hidden");
  $("fx-deposit-sheet").classList.remove("hidden");
  try {
    const dataUrl = await window.versus.fxAddressQr(depositAddress);
    if (
      !dataUrl ||
      fxSheetChain !== chain.chainId ||
      fxSheetChainRole !== role
    ) return;
    image.src = dataUrl;
    image.classList.remove("hidden");
    placeholder.classList.add("hidden");
  } catch (error) {
    console.error("Versus FX gas deposit QR error:", error);
  }
}

function fxPositionLabel(position) {
  return `${position.asset} \u00b7 ${position.chain}`;
}

function fxRequesterPositionLabel(position) {
  const chain = {
    "BASE SEPOLIA": "BASE",
    "ARBITRUM SEPOLIA": "ARB",
  }[position.chain] || position.chain;
  return `${position.asset} \u00b7 ${chain}`;
}

function fxPopulateRequesterAssets() {
  const positions =
    fxDesktopSnapshot?.supportedPositions ||
    fxDesktopSnapshot?.positions ||
    FX_SUPPORTED_POSITIONS;
  for (const [id, preferred] of [
    ["fx-swap-source", "base-sepolia-usdc"],
    ["fx-swap-destination", "arbitrum-sepolia-usdc"],
  ]) {
    const select = $(id);
    if (!select) continue;
    const current = select.value || preferred;
    select.replaceChildren(...positions.map((position) => {
      const option = document.createElement("option");
      option.value = position.id;
      option.textContent = fxRequesterPositionLabel(position);
      return option;
    }));
    select.value = positions.some((position) => position.id === current)
      ? current
      : positions[0]?.id || "";
  }
}

function fxRequesterError(message = "") {
  const host = $("fx-requester-error");
  if (!host) return;
  host.textContent = message;
  host.classList.toggle("hidden", !message);
}

function fxTimelineLabel(state) {
  return ({
    requesting: "Request sent",
    quoted: "Quote verified",
    accepted: "Quote accepted",
    reserved: "Dealer reserved",
    awaiting_source_funds: "Waiting for source funds",
    source_funds_detected: "Source funds detected",
    source_lock_pending: "Source lock pending",
    source_lock_confirmed: "Source lock confirmed",
    destination_lock_pending: "Destination lock pending",
    destination_lock_confirmed: "Destination lock confirmed",
    destination_claimed: "Destination claimed",
    source_claimed: "Source claimed",
    funds_ready: "Destination funds verified",
    complete: "Complete",
    refund_wait: "Refund waiting period",
    refunded: "Refunded",
    cancelled: "Cancelled",
    failed: "Stopped",
  })[state] || state.replaceAll("_", " ");
}

function fxRemainingTime(eligibleAt) {
  const remaining = Math.max(
    0,
    Number(eligibleAt || 0) - Math.floor(networkNowMs() / 1000),
  );
  if (remaining === 0) return "now";
  const hours = Math.floor(remaining / 3600);
  const minutes = Math.ceil((remaining % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function renderFxHistory() {
  const list = $("fx-history-list");
  if (!list) return;
  const trades = fxDesktopSnapshot?.trades || [];
  if (!trades.length) {
    list.replaceChildren(fxNode("div", "fx-history-empty", "NO SWAPS YET"));
    return;
  }
  list.replaceChildren(...trades.map((trade) => {
    const entry = fxNode("article", "fx-history-entry");
    const head = fxNode("header");
    head.append(
      fxNode("b", null, fxTimelineLabel(trade.state).toUpperCase()),
      fxNode("time", null, new Date(trade.updatedAt || trade.createdAt).toLocaleDateString()),
    );
    const route = fxNode(
      "p",
      null,
      `${trade.source?.asset || "?"} ${trade.source?.chain || ""} \u2192 ${trade.destination?.asset || "?"} ${trade.destination?.chain || ""}`,
    );
    const foot = fxNode("footer");
    foot.append(
      fxNode("span", null, trade.outputAmountDisplay || "--"),
      fxNode("code", null, fxShortAddress(trade.tradeId)),
    );
    const terminal = [
      "funds_ready",
      "complete",
      "refunded",
      "cancelled",
      "failed",
    ].includes(trade.state);
    if (!terminal && trade.state !== "quoted") {
      const status = fxNode("button", "fx-history-status", "CHECK");
      status.type = "button";
      status.addEventListener("click", async (event) => {
        event.stopPropagation();
        status.disabled = true;
        status.textContent = "CHECKING";
        try {
          const result = trade.state === "awaiting_source_funds"
            ? await window.versus.fxCheckFunding(trade.tradeId)
            : await window.versus.fxReconcile(trade.tradeId);
          if (result?.detected !== false) {
            fxRequesterTrade = result;
          }
          await refreshFxSnapshot(true);
        } catch (error) {
          toast(error.message || "status unavailable");
        } finally {
          renderFxHistory();
        }
      });
      foot.append(status);
    }
    entry.append(head, route, foot);
    entry.addEventListener("click", () => {
      fxRequesterTrade = trade;
      fxRequesterView = "swap";
      renderFxRequester();
    });
    return entry;
  }));
}

function renderFxRequester() {
  const requester = $("fx-requester");
  if (!requester) return;
  fxPopulateRequesterAssets();
  const history = fxRequesterView === "history";
  $("fx-requester-title").textContent = history ? "SWAP HISTORY" : "SWAP";
  $("fx-requester-swap-view").classList.toggle("hidden", history);
  $("fx-requester-history-view").classList.toggle("hidden", !history);
  if (history) {
    renderFxHistory();
    return;
  }

  const getQuotes = $("fx-get-quotes");
  const requesterPositions = fxDesktopSnapshot?.supportedPositions || [];
  $("fx-requester-compose").classList.toggle("hidden", Boolean(fxRequesterTrade));
  if (getQuotes) {
    getQuotes.disabled = requesterPositions.length < 2;
    getQuotes.textContent = fxDesktopSnapshot?.enabled
      ? "GET QUOTES"
      : "TURN ON FX";
    getQuotes.classList.toggle("hidden", Boolean(fxRequesterTrade));
  }

  const quote = fxRequesterTrade?.state === "quoted" ? fxRequesterTrade : null;
  const quoteRemaining = quote
    ? Math.max(0, quote.route.expiresAt - Math.floor(networkNowMs() / 1000))
    : null;
  const quoteExpired = quoteRemaining === 0;
  const quoteSearching = quoteExpired || fxQuoteAcceptActive;
  const funding = fxRequesterTrade?.funding;
  const awaitingFunding =
    Boolean(funding) && fxRequesterTrade?.state === "awaiting_source_funds";
  $("fx-quote-result").classList.toggle("hidden", !quote);
  $("fx-quote-result").classList.toggle("is-refreshing", quoteSearching);
  $("fx-funding-result").classList.toggle("hidden", !awaitingFunding);
  const settling = Boolean(
    fxRequesterTrade &&
    !["quoted", "awaiting_source_funds"].includes(fxRequesterTrade.state)
  );
  $("fx-settlement-result").classList.toggle("hidden", !settling);

  if (quote) {
    const route = quote.route;
    const source = quote.source;
    const destination = quote.destination;
    $("fx-quote-input").textContent = quote.inputAmountDisplay;
    $("fx-quote-route").textContent =
      `${source.asset} ${source.chain} \u2192 ${destination.asset} ${destination.chain}`;
    $("fx-quote-dealer").textContent = fxShortAddress(route.dealer);
    $("fx-quote-spread").textContent = `${route.spreadBps} BPS`;
    $("fx-quote-fee").textContent =
      `${(Number(route.brokerFeeAtomic) / (10 ** source.decimals)).toFixed(6)} ${source.asset}`;
    $("fx-quote-time").textContent = `${route.estimatedCompletionSeconds}s`;
    $("fx-quote-label").textContent = fxQuoteAcceptActive
      ? "RESERVING DEALER"
      : quoteExpired
        ? "FETCHING NEW QUOTES"
        : "BEST VERIFIED QUOTE";
    $("fx-quote-expiry").textContent = `${quoteRemaining}s`;
  }

  if (funding) {
    const source = fxRequesterTrade.source;
    const fundingRemaining = Number.isSafeInteger(Number(funding.expiresAt))
      ? Math.max(0, Number(funding.expiresAt) - Math.floor(networkNowMs() / 1000))
      : 0;
    const fundingExpired = fundingRemaining === 0;
    $("fx-funding-amount").textContent =
      `${(Number(funding.amountAtomic) / (10 ** source.decimals)).toFixed(source.decimals)} ${source.asset}`;
    $("fx-funding-address").textContent = funding.addressShort || fxShortAddress(funding.address);
    $("fx-funding-note").textContent =
      `${source.asset} on ${source.chain} only. Locks after confirmation.`;
    const fundingWindow = $("fx-funding-expiry")?.closest(".fx-funding-window");
    fundingWindow?.classList.toggle("is-expired", fundingExpired);
    fundingWindow?.querySelector("span")?.replaceChildren(
      document.createTextNode(fundingExpired ? "RESERVATION EXPIRED" : "DEALER RESERVED"),
    );
    $("fx-funding-expiry").textContent = fundingExpired
      ? "0:00"
      : `${Math.floor(fundingRemaining / 60)}:${String(fundingRemaining % 60).padStart(2, "0")}`;
    $("fx-check-funding").textContent =
      fxRequesterTrade.state === "awaiting_source_funds"
        ? fundingExpired
          ? "CLOSE EXPIRED ORDER"
          : "I SENT IT"
        : "CHECK STATUS";
    $("fx-cancel-trade").classList.toggle("hidden", fundingExpired);
    $("fx-cancel-trade").disabled = fxCancelActive;
    $("fx-cancel-trade").textContent = fxCancelActive
      ? "CANCELLING..."
      : "CANCEL SWAP";
  }

  if (settling) {
    const settlementTerminal = [
      "funds_ready",
      "complete",
      "refunded",
      "cancelled",
      "failed",
    ].includes(fxRequesterTrade.state);
    const swapComplete = ["funds_ready", "complete"].includes(fxRequesterTrade.state);
    $("fx-settlement-kicker").textContent = swapComplete ? "SETTLED" : "SETTLEMENT";
    $("fx-settlement-state").textContent = swapComplete
      ? "SWAP COMPLETE"
      : fxRequesterTrade.state === "refunded"
        ? "REFUND COMPLETE"
        : fxRequesterTrade.state === "cancelled"
          ? "SWAP CANCELLED"
          : fxTimelineLabel(fxRequesterTrade.state).toUpperCase();
    $("fx-settlement-detail").textContent = swapComplete
      ? `${fxRequesterTrade.outputAmountDisplay || "Destination funds"} arrived at ${
          fxRequesterTrade.destination?.addressShort ||
          fxShortAddress(fxRequesterTrade.destination?.address)
        }. Receipt saved to Tape.`
      : fxRequesterTrade.state === "cancelled"
        ? "No source lock was created. The dealer reservation was released."
      : fxRequesterTrade.state === "refund_wait" &&
          fxRequesterTrade.refund?.eligible === true
        ? "The contract timeout has passed. Source refund is available now."
      : fxRequesterTrade.lastFailure?.message
        ? `${fxRequesterTrade.lastFailure.message}. Status checks will not rebroadcast.`
        : fxRequesterTrade.refund?.eligibleAt
          ? `If settlement stops, the source refund unlocks in ${fxRemainingTime(
              fxRequesterTrade.refund.eligibleAt,
            )}. Refunds are not instant.`
          : fxRequesterTrade.refundEligibleAt
            ? `If settlement stops, the source refund unlocks in ${fxRemainingTime(
                fxRequesterTrade.refundEligibleAt,
              )}. Refunds are not instant.`
        : "Chain confirmation decides what happens next.";
    const timeline = $("fx-settlement-timeline");
    timeline.replaceChildren(...(fxRequesterTrade.timeline || []).map((event) => {
      const item = fxNode("li", "is-complete", fxTimelineLabel(event.state));
      return item;
    }));
    const refund = $("fx-refund-trade");
    const refundReady =
      fxRequesterTrade.state === "refund_wait" &&
      fxRequesterTrade.refund?.eligible === true;
    refund.classList.toggle("hidden", !refundReady);
    if (refundReady) {
      refund.textContent = "REFUND SOURCE";
    }
    const checkStatus = $("fx-check-status");
    checkStatus.classList.toggle(
      "hidden",
      settlementTerminal || refundReady
    );
    checkStatus.disabled = false;
    checkStatus.textContent = "CHECK STATUS";
    $("fx-settlement-done").classList.toggle("hidden", !settlementTerminal);
  }
}

async function refreshExpiredFxQuote() {
  const trade = fxRequesterTrade;
  if (
    fxQuoteRefreshActive ||
    fxQuoteAcceptActive ||
    Date.now() < fxQuoteRefreshRetryAt ||
    trade?.state !== "quoted" ||
    trade.route.expiresAt > Math.floor(networkNowMs() / 1000)
  ) {
    return;
  }

  fxQuoteRefreshActive = true;
  renderFxRequester();
  try {
    const outputAmount = String(trade.outputAmountDisplay || "").split(/\s+/)[0];
    const replacement = await window.versus.fxRequestQuote({
      sourcePositionId: trade.sourcePositionId,
      destinationPositionId: trade.destinationPositionId,
      outputAmount,
      destinationAddress: trade.destination.address,
      sourceRefundAddress: trade.refundAddress,
    });
    if (
      fxRequesterTrade?.tradeId === trade.tradeId &&
      !$("fx-requester")?.classList.contains("hidden")
    ) {
      fxRequesterTrade = replacement;
      fxRequesterError("");
      await refreshFxSnapshot();
    }
    fxQuoteRefreshRetryAt = 0;
  } catch (error) {
    fxQuoteRefreshRetryAt = Date.now() + 5_000;
    fxRequesterError(
      `${error.message || "No fresh verified quote was returned."} Retrying...`,
    );
  } finally {
    fxQuoteRefreshActive = false;
    renderFxRequester();
  }
}

window.setInterval(() => {
  if (!$("fx-requester")?.classList.contains("hidden")) {
    renderFxRequester();
    void refreshExpiredFxQuote();
  }
}, 1000);

window.setInterval(() => {
  if (
    !document.hidden &&
    activeSurface === "fx" &&
    (
      activeFxMode === "stock" ||
      !$("fx-add-position-sheet")?.classList.contains("hidden")
    )
  ) {
    void refreshFxSnapshot();
  }
}, 30_000);

function openFxRequester(view = "swap") {
  closeFxSheets();
  fxRequesterView = view;
  if (view === "swap") {
    const resumable = (fxDesktopSnapshot?.trades || []).find((trade) =>
      !["funds_ready", "complete", "refunded", "cancelled", "failed"].includes(trade.state)
    );
    if (
      !fxRequesterTrade ||
      ["funds_ready", "complete", "refunded", "cancelled", "failed"].includes(fxRequesterTrade.state)
    ) {
      fxRequesterTrade = resumable || null;
    }
  }
  fxRequesterError("");
  $("fx-requester").classList.remove("hidden");
  renderFxRequester();
}

function closeFxRequester() {
  $("fx-requester")?.classList.add("hidden");
  fxRequesterError("");
}

function finishFxRequester() {
  fxRequesterTrade = null;
  fxRequesterView = "swap";
  closeFxRequester();
  renderFxScreen();
}

function returnToFxSwapMain() {
  const state = fxRequesterTrade?.state;
  const mayAbandon =
    !fxRequesterTrade ||
    state === "quoted" ||
    ["funds_ready", "complete", "refunded", "cancelled", "failed"].includes(state);
  if (fxRequesterView !== "history" && !mayAbandon) return;
  fxRequesterTrade = null;
  fxRequesterView = "swap";
  fxRequesterError("");
  const scroll = $("fx-requester-swap-view");
  if (scroll) scroll.scrollTop = 0;
  renderFxRequester();
}

function navigateBackFromFxRequester() {
  const state = fxRequesterTrade?.state;
  if (fxRequesterView === "history") {
    closeFxRequester();
    return;
  }
  const nestedView =
    state === "quoted" ||
    ["funds_ready", "complete", "refunded", "cancelled", "failed"].includes(state);
  if (nestedView) {
    returnToFxSwapMain();
    return;
  }
  closeFxRequester();
}

function scrollFxRequesterToBottom() {
  const scroll = $("fx-requester-swap-view");
  if (!scroll) return;
  window.requestAnimationFrame(() => {
    scroll.scrollTo({
      top: scroll.scrollHeight,
      behavior: "smooth",
    });
  });
}

async function submitFxQuoteRequest() {
  const button = $("fx-get-quotes");
  fxRequesterError("");
  const requesterPositions = fxDesktopSnapshot?.supportedPositions || [];
  if (requesterPositions.length < 2) {
    fxRequesterError("No requester routes are available in this build.");
    return;
  }
  if (fxDesktopSnapshot?.enabled !== true) {
    button.disabled = true;
    button.textContent = "TURNING ON...";
    try {
      applyFxSnapshot(await window.versus.fxSetEnabled(true));
      button.textContent = "GET QUOTES";
    } catch (error) {
      fxRequesterError(error.message || "FX could not be enabled.");
    } finally {
      button.disabled = false;
    }
    return;
  }
  button.disabled = true;
  button.textContent = "REQUESTING...";
  $("fx-quote-result").classList.add("hidden");
  $("fx-funding-result").classList.add("hidden");
  try {
    fxRequesterTrade = await window.versus.fxRequestQuote({
      sourcePositionId: $("fx-swap-source").value,
      destinationPositionId: $("fx-swap-destination").value,
      outputAmount: $("fx-swap-amount").value,
      destinationAddress: fxAddressInputValue($("fx-swap-recipient")),
    });
    await refreshFxSnapshot();
    renderFxRequester();
    $("fx-quote-result")?.scrollIntoView({ block: "start", behavior: "smooth" });
  } catch (error) {
    fxRequesterError(error.message || "No verified quote was returned.");
  } finally {
    button.disabled = false;
    button.textContent = "GET QUOTES";
  }
}

async function acceptFxQuote() {
  if (!fxRequesterTrade?.tradeId) return;
  const button = $("fx-accept-quote");
  fxQuoteAcceptActive = true;
  button.disabled = true;
  button.textContent = "RESERVING...";
  fxRequesterError("");
  renderFxRequester();
  try {
    fxRequesterTrade = await window.versus.fxAcceptQuote(fxRequesterTrade.tradeId);
    const dataUrl = await window.versus.fxAddressQr(fxRequesterTrade.funding.address);
    $("fx-funding-qr-image").src = dataUrl;
    await refreshFxSnapshot();
    renderFxRequester();
    scrollFxRequesterToBottom();
  } catch (error) {
    fxRequesterError(error.message || "The quote could not be accepted.");
  } finally {
    fxQuoteAcceptActive = false;
    button.disabled = false;
    button.textContent = "ACCEPT QUOTE";
    renderFxRequester();
  }
}

async function checkFxFunding(trigger = null) {
  if (!fxRequesterTrade?.tradeId) return;
  const button = trigger?.currentTarget || trigger || $("fx-check-funding");
  button.disabled = true;
  button.textContent = "CHECKING...";
  fxRequesterError("");
  try {
    const result = fxRequesterTrade.state === "awaiting_source_funds"
      ? await window.versus.fxCheckFunding(fxRequesterTrade.tradeId)
      : await window.versus.fxReconcile(fxRequesterTrade.tradeId);
    if (result?.detected === false) {
      fxRequesterError("Funds are not confirmed yet. Nothing has been locked.");
      return;
    }
    fxRequesterTrade = result;
    await refreshFxSnapshot();
    renderFxRequester();
    $("fx-settlement-result")?.scrollIntoView({
      block: "start",
      behavior: "smooth",
    });
  } catch (error) {
    fxRequesterError(error.message || "Funding could not be verified.");
  } finally {
    button.disabled = false;
    button.textContent = fxRequesterTrade?.state === "awaiting_source_funds"
      ? "I SENT IT"
      : "CHECK STATUS";
  }
}

async function cancelFxTrade() {
  if (
    !fxRequesterTrade?.tradeId ||
    fxRequesterTrade.state !== "awaiting_source_funds" ||
    fxCancelActive
  ) {
    return;
  }
  const button = $("fx-cancel-trade");
  fxCancelActive = true;
  button.disabled = true;
  button.textContent = "CANCELLING...";
  fxRequesterError("");
  try {
    fxRequesterTrade = await window.versus.fxCancel(fxRequesterTrade.tradeId);
    await refreshFxSnapshot();
    renderFxRequester();
  } catch (error) {
    fxRequesterError(error.message || "The swap could not be cancelled.");
  } finally {
    fxCancelActive = false;
    button.disabled = false;
    button.textContent = "CANCEL SWAP";
    renderFxRequester();
  }
}

async function refundFxTrade() {
  if (
    !fxRequesterTrade?.tradeId ||
    fxRequesterTrade.state !== "refund_wait" ||
    fxRequesterTrade.refund?.eligible !== true
  ) {
    return;
  }
  const button = $("fx-refund-trade");
  button.disabled = true;
  button.textContent = "REFUNDING...";
  fxRequesterError("");
  try {
    fxRequesterTrade = await window.versus.fxRefund(
      fxRequesterTrade.tradeId
    );
    await refreshFxSnapshot();
    renderFxRequester();
  } catch (error) {
    fxRequesterError(error.message || "The source refund could not be confirmed.");
  } finally {
    button.disabled = false;
    button.textContent = "REFUND SOURCE";
  }
}

function wireFxControls() {
  wireFxAddressInput($("fx-swap-recipient"));
  wireFxAddressInput($("fx-withdraw-dest"));
  $("fx-add-position")?.addEventListener("click", openFxAddPositionSheet);
  $("fx-refresh-stock")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await refreshFxSnapshot(true);
    } finally {
      button.disabled = false;
    }
  });
  $("fx-open-swap")?.addEventListener("click", () => openFxRequester("swap"));
  $("fx-open-history")?.addEventListener("click", () => openFxRequester("history"));
  $("fx-requester-back")?.addEventListener("click", navigateBackFromFxRequester);
  $("fx-requester-title")?.addEventListener("click", returnToFxSwapMain);
  $("fx-get-quotes")?.addEventListener("click", submitFxQuoteRequest);
  $("fx-accept-quote")?.addEventListener("click", acceptFxQuote);
  $("fx-check-funding")?.addEventListener("click", checkFxFunding);
  $("fx-check-status")?.addEventListener("click", checkFxFunding);
  $("fx-cancel-trade")?.addEventListener("click", cancelFxTrade);
  $("fx-refund-trade")?.addEventListener("click", refundFxTrade);
  $("fx-settlement-done")?.addEventListener("click", finishFxRequester);
  $("fx-copy-funding")?.addEventListener("click", async (event) => {
    const address = fxRequesterTrade?.funding?.address;
    if (!address) return;
    const button = event.currentTarget;
    try {
      await window.versus.fxCopyAddress(address);
      button.classList.add("is-copied");
      button.setAttribute("aria-label", "Funding address copied");
      button.title = "Copied";
      setTimeout(() => {
        button.classList.remove("is-copied");
        button.setAttribute("aria-label", "Copy funding address");
        button.title = "Copy funding address";
      }, 900);
    } catch (error) {
      fxRequesterError(error.message || "Address copy failed.");
    }
  });
  $("fx-swap-flip")?.addEventListener("click", () => {
    const source = $("fx-swap-source");
    const destination = $("fx-swap-destination");
    [source.value, destination.value] = [destination.value, source.value];
  });
  $("fx-export-evidence")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const filePath = await window.versus.fxExportEvidence();
      if (filePath) toast("FX evidence exported");
    } catch (error) {
      toast(error.message || "export failed");
    } finally {
      button.disabled = false;
    }
  });

  for (const button of document.querySelectorAll("[data-fx-stock-filter]")) {
    button.addEventListener("click", () => {
      fxStockFilter = button.dataset.fxStockFilter;
      fxOpenBay = null;
      renderFxStock();
    });
  }

  $("fx-risk-armed")?.addEventListener("click", async () => {
    if (fxDealerTogglePending) return;
    const targetArmed = !fxRisk.armed;
    fxDealerTogglePending = targetArmed ? "arming" : "disarming";
    renderFxRisk();
    try {
      if (fxDesktopSnapshot?.enabled !== true) {
        applyFxSnapshot(await window.versus.fxSetEnabled(true));
      }
      applyFxSnapshot(
        await window.versus.fxSetPolicy({ armed: targetArmed })
      );
    } catch (error) {
      toast(error.message || "dealer policy unchanged");
    } finally {
      fxDealerTogglePending = null;
      renderFxRisk();
    }
  });

  for (const button of document.querySelectorAll("[data-fx-step]")) {
    const [key, rawDirection] = button.dataset.fxStep.split(":");
    const control = FX_RISK_CONTROLS[key];
    if (!control) continue;
    button.addEventListener("click", async () => {
      const next = control.steps.indexOf(fxRisk[key]) + Number(rawDirection);
      if (next < 0 || next >= control.steps.length) return;
      const nextValue = control.steps[next];
      const policyKey = control.policyKey || ({
        maxTradeUsd: "maximumTradeUsd",
        maxExposureUsd: "maximumExposureUsd",
        minSpreadBps: "minimumSpreadBps",
        quoteTimeoutSec: "quoteLifetimeSeconds",
        reservationSec: "reservationSeconds",
      })[key];
      try {
        applyFxSnapshot(await window.versus.fxSetPolicy({ [policyKey]: nextValue }));
      } catch (error) {
        toast(error.message || "dealer policy unchanged");
      }
    });
  }

  for (const button of document.querySelectorAll("[data-fx-sheet-close]")) {
    button.addEventListener("click", closeFxSheets);
  }
  for (const sheet of document.querySelectorAll(".fx-sheet")) {
    sheet.addEventListener("click", (event) => { if (event.target === sheet) closeFxSheets(); });
  }

  $("fx-deposit-copy")?.addEventListener("click", (event) => {
    let target = fxBayOf(fxSheetBay);
    const chain = fxChains.find(
      (chain) => chain.chainId === fxSheetChain
    );
    if (!target && chain) {
      target = {
        ...chain,
        address: fxSheetChainRole === "requester"
          ? chain.requesterAddress
          : chain.dealerAddress || chain.address,
      };
    }
    if (target) copyFxBayAddress(target, event.currentTarget);
  });

  $("fx-withdraw-max")?.addEventListener("click", () => {
    const bay = fxBayOf(fxSheetBay);
    if (bay) $("fx-withdraw-amount").value = (bay.availableMicros / 1e6).toFixed(2);
  });

  $("fx-withdraw-send")?.addEventListener("click", submitFxWithdraw);
}

function renderFxScreen() {
  const shell = $("shell");
  if (!shell) return;
  shell.dataset.surface = activeSurface;
  shell.dataset.fxMode = activeFxMode;

  const cypher = bond?.cypherId == null ? null : cypherOf(bond.cypherId);
  const portrait = $("fx-desk-cypher");
  if (portrait && cypher) {
    portrait.src = cypherSrc(cypher.file);
    portrait.alt = `${cypher.name} at the FX desk`;
  }

  if (activeSurface === "fx") {
    renderFxStock();
    renderFxTape();
    renderFxRisk();
  }

  document.querySelectorAll("[data-fx-panel]").forEach((panel) => {
    const selected = panel.dataset.fxPanel === activeFxMode;
    panel.classList.toggle("hidden", !selected);
    panel.setAttribute("aria-hidden", selected ? "false" : "true");
  });
  renderModeDock();
}

wireFxControls();

function updateModeScreen() {
  if (!bond || bond.phase !== "active") return;

  $("shell")?.setAttribute("data-mode", activeMode);
  renderFxScreen();

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
  const pending = Boolean(!profile || profile.archivePending);
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
  if (description) {
    const nextFieldNote = fieldNoteText(profile?.description);
    if (description.textContent !== nextFieldNote) {
      description.textContent = nextFieldNote;
      resetFieldNoteScroll();
    }
  }
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

  updateNextRainCountdown();

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

function setFxMode(next) {
  if (modeLock || next === activeFxMode || !FX_MODES.includes(next)) return;
  closeFxSheets();
  modeLock = true;
  const wipe = $("lcd-wipe");
  if (wipe) {
    wipe.classList.remove("run");
    void wipe.offsetWidth;
    wipe.classList.add("run");
  }
  setTimeout(() => {
    activeFxMode = next;
    renderFxScreen();
    if (next === "stock") void refreshFxSnapshot(true);
  }, 50);
  setTimeout(() => {
    modeLock = false;
    wipe?.classList.remove("run");
  }, 170);
}

function setSurface(next) {
  if (modeLock || next === activeSurface || !["cypher", "fx"].includes(next)) return;
  if (!bond || bond.phase !== "active" || bond.cypherId == null) return;
  if (graduationRunning || settingsOpen || helpOpen) return;

  closeFxSheets();
  modeLock = true;
  const wipe = $("lcd-wipe");
  if (wipe) {
    wipe.classList.remove("run");
    void wipe.offsetWidth;
    wipe.classList.add("run");
  }
  setTimeout(() => {
    activeSurface = next;
    renderFxScreen();
    if (next === "fx") void refreshFxSnapshot(true);
  }, 50);
  setTimeout(() => {
    modeLock = false;
    wipe?.classList.remove("run");
  }, 170);
}

function toggleFxSurface() {
  setSurface(activeSurface === "fx" ? "cypher" : "fx");
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
function spawnDrop(layerIdx, options = {}) {
  const d = poolTake(W.drops);
  if (!d) return;
  const L = RAIN_LAYERS[layerIdx];
  d.layer = layerIdx;
  d.gold = Boolean(options.gold);
  d.white = Boolean(options.white);
  d.hero = Boolean(options.hero);
  d.front = Boolean(options.front);
  d.len = L.len0 + rnd() * (L.len1 - L.len0);
  d.vy = L.spd0 + rnd() * (L.spd1 - L.spd0);
  d.y = -d.len - rnd() * (d.hero ? 18 : 32);
  d.drift = options.drift ?? (rnd() - 0.5) * 0.018;
  d.alphaScale = options.alphaScale ?? 1;
  d.widthScale = options.widthScale ?? 1;
  d.impactScale = options.impactScale ?? 1;
  d.headSize = options.headSize ?? (layerIdx === 2 ? 1.35 : layerIdx === 1 ? 1 : 0.7);
  if (d.hero) {
    d.len = 12 + rnd() * 8;
    d.vy = 230 + rnd() * 80;
    d.widthScale = options.widthScale ?? 1.05;
    d.headSize = options.headSize ?? 1.75;
  }
  const targetX = clamp(options.xNorm ?? (0.06 + 0.88 * rnd()), 0.035, 0.965) * W.w;
  const fallDistance = Math.max(60, waterTopBase(W.fill) - d.y);
  d.x = targetX - (W.wind + d.drift) * L.wind * fallDistance;
}

function spawnMicroburst(kind, pressure = W.rainPressure) {
  const self = kind === "self";
  const center = self ? 0.42 + rnd() * 0.16 : 0.09 + rnd() * 0.82;
  const burstDrift = Math.sin(performance.now() / 2200 + center * 4.2) * (0.018 + pressure * 0.028);
  spawnDrop(2, {
    xNorm: center,
    gold: self,
    white: !self,
    hero: true,
    front: !self && rnd() < 0.38,
    impactScale: 1,
    drift: burstDrift,
  });

  const satellites = 2 + Math.floor(clamp(pressure, 0, 1) * 3 + rnd() * 1.7);
  const spread = 0.26 + 0.38 * clamp(pressure, 0, 1);
  for (let i = 0; i < satellites; i++) {
    const depth = rnd();
    const layer = depth < 0.15 ? 0 : depth < 0.6 ? 1 : 2;
    spawnDrop(layer, {
      xNorm: center + (rnd() - 0.5) * spread,
      front: layer === 2 && rnd() < 0.68,
      alphaScale: 0.76 + rnd() * 0.22,
      widthScale: 0.86 + rnd() * 0.34,
      impactScale: layer === 2 ? 0.32 : layer === 1 ? 0.16 : 0,
      drift: burstDrift + (rnd() - 0.5) * (0.012 + pressure * 0.012),
    });
  }
  W.microburstsRendered += 1;
}

function noteVerifiedRain(now) {
  W.rainTimes.push(now);
  while (W.rainTimes.length && W.rainTimes[0] < now - RAIN_RATE_WINDOW_MS) W.rainTimes.shift();
  if (W.rainTimes.length > MAX_RAIN_RATE_SAMPLES) {
    W.rainTimes.splice(0, W.rainTimes.length - MAX_RAIN_RATE_SAMPLES);
  }
  W.rainRate = W.rainTimes.length / (RAIN_RATE_WINDOW_MS / 1000);
  W.rainPressure = clamp(Math.pow(W.rainRate / MAX_RAIN_RATE, 0.72), 0.04, 1);
  W.targetStorm = Math.max(W.targetStorm * 0.92, W.rainPressure);
  W.stormOffAt = now + 2_800;
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

function dropImpact(xPx, layerIdx, gold, impactScale = 1) {
  if (impactScale <= 0) return;
  const xn = xPx / W.w;
  const prox = Math.max(0, 1 - Math.abs(xn - 0.5) / 0.55);
  const weight = (gold ? 1.6 : layerIdx === 2 ? 1.0 : 0.6) * impactScale;
  PH.heave.v += 10 * prox * weight;
  PH.roll.v += clamp((xn - 0.5) / 0.35, -1, 1) * 9 * prox * weight;

  if (gold || impactScale >= 0.7) spawnRipple(xPx, gold ? 1.4 : 1, gold, 0);
  if (gold) spawnRipple(xPx, 0.8, true, 180);
  if (gold || impactScale >= 0.7) {
    spawnCrown(xPx, surfaceYAt(xPx), (gold ? 4 : 3) + Math.round(W.rainPressure * 2));
  }
  if (gold) {
    spawnSparkle(xPx - 6 + rnd() * 12, surfaceYAt(xPx) - 3, 900, 2);
    spawnSparkle(xPx - 8 + rnd() * 16, surfaceYAt(xPx) + 4, 1100, 1);
  }
  W.causticBoost = Math.min(0.2, W.causticBoost + (gold ? 0.08 : 0.02) * impactScale);
}

/* ------------------------------------------------------------------
   Verified event choreography
   ------------------------------------------------------------------ */

function verifiedRainDrop(kind, classPotMicros) {
  if (!bond || bond.phase !== "active") return;
  W.verifiedDropsRendered += 1;
  const now = performance.now();
  W.lastPotEventAt = now;
  noteVerifiedRain(now);
  const prevFill = W.targetFill;
  const absoluteFill = clamp(Number(classPotMicros) / FLOOR_MICROS, 0, 1);
  const nextFill = Math.max(prevFill, absoluteFill);
  W.targetFill = nextFill;
  bond.classPotMicros = Math.max(Number(bond.classPotMicros || 0), Number(classPotMicros));
  updateReadout({ preserveFill: true });
  PH.heave.v -= (nextFill - prevFill) * 0.62 * W.h * 1.2;

  const pendingBursts = W.goldQueue + W.whiteQueue;
  if (kind === "self") {
    if (pendingBursts >= MAX_PENDING_RAIN_BURSTS && W.whiteQueue > 0) {
      W.whiteQueue -= 1;
      W.coalescedRainPennies = Math.min(MAX_COALESCED_RAIN_PENNIES, W.coalescedRainPennies + 1);
    }
    if (W.goldQueue + W.whiteQueue < MAX_PENDING_RAIN_BURSTS) W.goldQueue += 1;
    else W.coalescedRainPennies = Math.min(MAX_COALESCED_RAIN_PENNIES, W.coalescedRainPennies + 1);
    const cistern = $("cistern");
    if (cistern) {
      cistern.classList.remove("blip");
      void cistern.offsetWidth;
      cistern.classList.add("blip");
    }
    setTimeout(() => {
      const face = $("face-motion");
      if (face) {
        face.classList.remove("hop");
        void face.offsetWidth;
        face.classList.add("hop");
      }
      toast("+1 verified ticket");
    }, 470);
  } else if (pendingBursts < MAX_PENDING_RAIN_BURSTS) {
    W.whiteQueue += 1;
  } else {
    W.coalescedRainPennies = Math.min(MAX_COALESCED_RAIN_PENNIES, W.coalescedRainPennies + 1);
  }

  for (const milestoneFill of [0.25, 0.5, 0.75, 0.9]) {
    if (prevFill < milestoneFill && nextFill >= milestoneFill) milestone(milestoneFill);
  }
  $("shell")?.setAttribute("data-grad", nextFill >= 0.95 ? "near" : "far");
  W.gradNear = nextFill >= 0.95;
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
    updateReadout({ preserveFill: true });
    updateModeScreen();
    setRainBatchStatus(`BASE OK · WAITING ×${pennies}`);
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
function updateReadout({ preserveFill = false } = {}) {
  const pot = bond?.classPotMicros ?? 0;
  const agents = Math.max(0, bond?.classAgents ?? 0);
  const others = Math.max(0, agents - 1);
  const fill = clamp(Number(pot) / FLOOR_MICROS, 0, 1);

  if (!preserveFill) W.targetFill = fill;

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

function updateRainDrops(dt) {
  for (let i = W.drops.n - 1; i >= 0; i--) {
    const d = W.drops.items[i];
    const L = RAIN_LAYERS[d.layer];
    const drift = (W.wind + d.drift) * L.wind;
    d.y += d.vy * dt / 1000;
    d.x += drift * d.vy * dt / 1000;
    const impactX = d.x + drift * d.len;
    if (d.y + d.len >= surfaceYAt(impactX)) {
      dropImpact(impactX, d.layer, d.gold, d.impactScale);
      poolKill(W.drops, i);
      continue;
    }
    if (d.y > W.h + 20 || d.x < -W.w || d.x > W.w * 2) poolKill(W.drops, i);
  }
}

function drawRainDrops(c, ts, front) {
  c.save();
  c.lineCap = "round";
  for (let layer = 0; layer < RAIN_LAYERS.length; layer++) {
    for (let i = 0; i < W.drops.n; i++) {
      const d = W.drops.items[i];
      if (d.layer !== layer || d.front !== front) continue;
      const L = RAIN_LAYERS[d.layer];
      const slant = (W.wind + d.drift) * L.wind * d.len;
      const splitX = d.x + slant * 0.58;
      const splitY = d.y + d.len * 0.58;
      const headX = d.x + slant;
      const headY = d.y + d.len;
      const color = d.gold
        ? (W.isNight ? "#cfe8ff" : "#ffd98a")
        : d.white
          ? (W.isNight ? "#c9edf4" : "#d9f2ec")
          : d.layer === 2
            ? W.css.foam
            : W.isNight ? "rgba(128,174,190,1)" : "rgba(151,194,201,1)";
      const shimmer = d.gold ? (Math.floor(ts / 50) % 2 ? 1 : 0.82) : 1;
      const alpha = (d.gold ? 0.96 : d.white ? 0.82 : L.a) * d.alphaScale * shimmer;
      const width = L.w * d.widthScale;

      c.strokeStyle = color;
      c.globalAlpha = alpha * 0.24;
      c.lineWidth = Math.max(0.55, width * 0.58);
      c.beginPath();
      c.moveTo(d.x, d.y);
      c.lineTo(splitX, splitY);
      c.stroke();

      c.globalAlpha = alpha * 0.78;
      c.lineWidth = width;
      c.beginPath();
      c.moveTo(splitX, splitY);
      c.lineTo(headX, headY);
      c.stroke();

      const head = d.headSize;
      c.globalAlpha = alpha;
      c.fillStyle = color;
      c.beginPath();
      c.moveTo(headX, headY - head * 1.3);
      c.lineTo(headX + head * 0.78, headY - head * 0.1);
      c.lineTo(headX, headY + head);
      c.lineTo(headX - head * 0.78, headY - head * 0.1);
      c.closePath();
      c.fill();

      if (d.hero) {
        c.globalAlpha = alpha * 0.8;
        c.fillStyle = d.gold ? W.css.spec : "#f5fff5";
        c.fillRect(Math.round(headX), Math.round(headY - head), 1, 1);
      }
    }
  }
  c.restore();
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
  W.wind = Math.sin(ts / 23000) * 0.1 + Math.sin(ts / 9300) * 0.04
    + W.storm * (Math.sin(ts / 3200) * 0.2 + Math.sin(ts / 8100) * 0.08);
  $("cistern")?.style.setProperty("--storm-shade-opacity", (W.storm * 0.24).toFixed(3));
  W.causticBoost *= Math.exp(-dt / 500);

  if (W.palT < 1) {
    W.palT = Math.min(1, W.palT + dt / 1800);
    const k = W.palT * W.palT * (3 - 2 * W.palT);
    for (let i = 0; i < 21; i++) W.pal[i] = W.palFrom[i] + (W.palTo[i] - W.palFrom[i]) * k;
    W.paletteDirty = true;
  }
  const gradTopNow = waterTopBase(W.fill);
  if (W.paletteDirty || Math.abs(gradTopNow - W.gradTop) > 3) rebuildPalette(gradTopNow);

  /* --- verified penny scheduler --- */
  const storm = W.storm;
  if ((W.goldQueue > 0 || W.whiteQueue > 0) && ts > W.nextCoinAt) {
    W.nextCoinAt = ts + 88 + (1 - storm) * 130 + rnd() * 42;
    if (W.goldQueue > 0) { W.goldQueue--; spawnMicroburst("self"); }
    else { W.whiteQueue--; spawnMicroburst("peer"); }
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
  updateRainDrops(dt);

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

    /* far and mid rain stay behind the Cypher */
    drawRainDrops(ctx, ts, false);
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
      drawRainDrops(fctx, ts, true);
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
   Confirmed class graduation ritual
   ------------------------------------------------------------------ */

function setGraduationStage(stage) {
  const ritual = $("graduation-ritual");
  ritual.dataset.stage = stage;
  ritual.setAttribute("aria-hidden", stage === "idle" ? "true" : "false");
}

function raftCypherVisibleCenter() {
  const cypher = cypherOf(bond?.cypherId);
  const layout = layoutOf(cypher.file);
  if (!layout) return { x: 75, y: 75 };
  const [left, top, right, bottom] = layout.bounds;
  const visibleWidth = Math.max(1, right - left);
  const visibleHeight = Math.max(1, bottom - top);
  const zoom = Math.round(
    Math.min(140 / visibleWidth, 130 / visibleHeight) * (layout.raftZoom || 1) * 64
  ) / 64;
  return {
    x: 75 + Number(layout.x || 0),
    y: 139.5 + Number(layout.y || 0) - zoom * Number(layout.baseline) + zoom * (top + bottom) / 2,
  };
}

function prepareGraduationRigGeometry() {
  const cisternRect = $("cistern").getBoundingClientRect();
  const faceRect = $("face-motion").getBoundingClientRect();
  const visibleCenter = raftCypherVisibleCenter();
  const ritual = $("graduation-ritual");
  const anchorX = cisternRect.width * 0.58;
  const anchorY = 68;
  const targetX = faceRect.left - cisternRect.left + visibleCenter.x;
  const targetY = faceRect.top - cisternRect.top + visibleCenter.y;
  const dx = targetX - anchorX;
  const dy = targetY - anchorY;
  const length = Math.max(1, Math.hypot(dx, dy));
  const angle = Math.atan2(-dx, dy) * 180 / Math.PI;
  ritual.style.setProperty("--rig-dx", `${dx.toFixed(1)}px`);
  ritual.style.setProperty("--rig-dy", `${dy.toFixed(1)}px`);
  ritual.style.setProperty("--rig-length", `${length.toFixed(1)}px`);
  ritual.style.setProperty("--rig-angle", `${angle.toFixed(1)}deg`);
  const liftScale = 0.58;
  const scaledCenterShiftX = (1 - liftScale) * (75 - visibleCenter.x);
  const scaledCenterShiftY = (1 - liftScale) * (150 - visibleCenter.y);
  $("face-motion").style.setProperty("--cypher-lift-x", `${(-dx - scaledCenterShiftX).toFixed(1)}px`);
  $("face-motion").style.setProperty("--cypher-lift-y", `${(-dy - scaledCenterShiftY).toFixed(1)}px`);
  return { x: targetX, y: targetY };
}

function normalizedGraduationPayload(payload) {
  const ceremony = payload?.ceremony || payload;
  const classId = Number(ceremony?.classId);
  const nextClassId = Number(ceremony?.nextClassId);
  if (!Number.isSafeInteger(classId) || classId < 1 || !Number.isSafeInteger(nextClassId) || nextClassId <= classId) {
    throw new Error("graduation ceremony payload is invalid");
  }
  return { ceremony, nextState: payload?.state || null };
}

function showClassOverNotice(payload = {}) {
  if (graduationRunning || bond?.phase !== "active") return false;
  const notice = $("class-over-notice");
  if (!notice) return false;
  const classId = Number(payload.classId);
  $("class-over-title").textContent = Number.isSafeInteger(classId) && classId > 0
    ? `CLASS ${classId} OVER`
    : "CLASS OVER";
  clearTimeout(classOverTimer);
  notice.classList.remove("run");
  notice.setAttribute("aria-hidden", "false");
  void notice.offsetWidth;
  notice.classList.add("run");
  classOverUntil = Date.now() + 2400;
  classOverTimer = setTimeout(() => {
    clearClassOverNotice();
  }, 2400);
  return true;
}

async function runGraduationWhenReady(payload, options) {
  const wait = Math.max(0, classOverUntil - Date.now());
  if (wait) await sleep(wait);
  clearClassOverNotice();
  return runGraduationCeremony(payload, options);
}

async function runGraduationCeremony(payload, { acknowledge = true } = {}) {
  if (graduationRunning) return false;
  const { ceremony, nextState } = normalizedGraduationPayload(payload);
  clearClassOverNotice();
  graduationRunning = true;
  saveDirty = false;
  const shell = $("shell");
  const raftLayer = $("raft-layer");
  const faceMotion = $("face-motion");
  const thought = $("cypher-thought");
  try {
    shell.dataset.graduationActive = "true";
    if (thought) thought.classList.add("hidden");
    thoughtShowing = false;
    if (helpOpen) setHelpOpen(false);
    if (settingsOpen) await setSettingsOpen(false);
    activeMode = "raft";
    updateModeScreen();

    bond = {
      ...bond,
      classId: ceremony.classId,
      classPotMicros: ceremony.classPotMicros,
      classAgents: ceremony.classAgents || bond.classAgents || 1,
    };
    W.fill = W.raftFill = W.targetFill = clamp(
      Number(ceremony.classPotMicros) / Number(ceremony.graduationFloorMicros || FLOOR_MICROS),
      0,
      1
    );
    W.gradNear = true;
    shell.dataset.grad = "near";
    updateReadout({ preserveFill: true });
    $("graduation-class-label").textContent = `CLASS ${ceremony.classId} COMPLETE`;
    $("graduation-token-label").textContent = `VRS${ceremony.tokenOrdinal} LAUNCHED`;
    raftLayer.classList.remove("graduation-offstage", "graduation-return");
    faceMotion.classList.remove("graduation-captured", "graduation-lifted", "graduation-departing");

    setGraduationStage("approach");
    await sleep(2350);
    prepareGraduationRigGeometry();
    setGraduationStage("lower");
    await sleep(1400);
    faceMotion.classList.add("graduation-captured");
    setGraduationStage("capture");
    await sleep(560);
    faceMotion.classList.add("graduation-lifted");
    setGraduationStage("lift");
    await sleep(1450);
    faceMotion.classList.add("graduation-departing");
    setGraduationStage("depart");
    await sleep(2150);

    raftLayer.classList.add("graduation-offstage");
    bond = {
      ...bond,
      ...(nextState || {}),
      classId: ceremony.nextClassId,
      classPotMicros: Number(nextState?.classPotMicros || 0),
      classAgents: Number(nextState?.classAgents || 0),
    };
    W.targetFill = 0;
    W.gradNear = false;
    shell.dataset.grad = "far";
    updateReadout({ preserveFill: true });
    setGraduationStage("drain");
    await sleep(2450);

    faceMotion.classList.remove("graduation-captured", "graduation-lifted", "graduation-departing");
    raftLayer.classList.remove("graduation-offstage", "graduation-return");
    void raftLayer.offsetWidth;
    raftLayer.classList.add("graduation-return");
    setGraduationStage("return");
    await sleep(1850);

    if (acknowledge && window.versus?.acknowledgeGraduation) {
      bond = await window.versus.acknowledgeGraduation(ceremony.classId) || bond;
    } else {
      delete bond.pendingGraduation;
      bond.lastCelebratedClassId = ceremony.classId;
    }
    return true;
  } finally {
    raftLayer.classList.remove("graduation-offstage", "graduation-return");
    faceMotion.classList.remove("graduation-captured", "graduation-lifted", "graduation-departing");
    faceMotion.style.removeProperty("--cypher-lift-x");
    faceMotion.style.removeProperty("--cypher-lift-y");
    setGraduationStage("idle");
    delete shell.dataset.graduationActive;
    graduationRunning = false;
    updateReadout();
    updateModeScreen();
  }
}

/* ------------------------------------------------------------------
   Verified rain delivery
   ------------------------------------------------------------------ */
let thoughtShowing = false;
let verifiedRainPumpTimer = null;
let verifiedRainPumpRunning = false;

function scheduleVerifiedRainPump(delay = 0) {
  clearTimeout(verifiedRainPumpTimer);
  verifiedRainPumpTimer = setTimeout(pumpVerifiedRain, Math.max(0, delay));
}

async function pumpVerifiedRain() {
  if (verifiedRainPumpRunning) return;
  if (graduationRunning || document.hidden || bond?.phase !== "active" || activeMode !== "raft") {
    scheduleVerifiedRainPump(1_000);
    return;
  }
  verifiedRainPumpRunning = true;
  try {
    const result = await window.versus?.nextVerifiedRain?.();
    if (result?.drop) {
      const belongsToVisibleClass = bond.classId == null || String(result.drop.classId) === String(bond.classId);
      if (belongsToVisibleClass) {
        verifiedRainDrop(
          String(result.drop.agentId) === String(bond.agentId) ? "self" : "peer",
          result.drop.classPotMicros
        );
      }
    }
    const wait = result?.nextAt
      ? clamp(result.nextAt - Date.now(), 100, 60_000)
      : result?.pending ? 250 : 2_000;
    scheduleVerifiedRainPump(wait);
  } catch (error) {
    console.error("Verified rain pump failed:", error);
    scheduleVerifiedRainPump(2_000);
  } finally {
    verifiedRainPumpRunning = false;
  }
}

async function showNextThought() {
  if (
    graduationRunning || thoughtShowing || document.hidden || bond?.phase !== "active" || activeMode !== "raft" ||
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
  if (bond?.phase === "active" && activeMode === "vault") updateNextRainCountdown();
  if (saveDirty && bond && !graduationRunning) {
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

function activateRestoredBond(restored) {
  if (restored?.phase !== "active" || restored.cypherId == null) return false;
  bond = restored;
  if (bond.classPotMicros == null) bond.classPotMicros = 0;
  if (bond.classAgents == null) bond.classAgents = 0;
  if (bond.tickets == null) bond.tickets = 0;
  if (bond.totalTickets == null) bond.totalTickets = Math.max(bond.tickets, bond.classAgents);
  if (bond.trancheClaimableMicros == null) bond.trancheClaimableMicros = 0;
  if (bond.tranchePreviewMicros == null) bond.tranchePreviewMicros = 0;
  W.targetFill = clamp((bond.classPotMicros || 0) / FLOOR_MICROS, 0, 1);
  startSceneClock();
  showClass();
  if (currentSettings) renderSettings(currentSettings);
  return true;
}

async function refreshForegroundState() {
  scheduleVerifiedRainPump(0);
  refreshNetworkScreen();
  try {
    const synced = await window.versus.refreshForeground();
    if (synced?.phase !== "active" || synced.cypherId == null) return;
    bond = synced;
    W.targetFill = clamp((bond.classPotMicros || 0) / FLOOR_MICROS, 0, 1);
    updateReadout();
    updateModeScreen();
  } catch (error) {
    console.error("Versus foreground state refresh error:", error);
  }
}

async function boot() {
  try {
    if (!window.versus) throw new Error("preload bridge missing");

    window.versus.onHatchProgress?.((progress) => {
      const view = $("view-deposit");
      if (view && progress?.stage) view.dataset.hatchProgress = progress.stage;
    });
    window.versus.onBondChanged?.((next) => {
      if (next?.phase !== "active" || next.cypherId == null) return;
      bond = next;
      W.targetFill = clamp((bond.classPotMicros || 0) / FLOOR_MICROS, 0, 1);
      if (!$("view-class").classList.contains("hidden")) {
        updateReadout();
        updateModeScreen();
      }
    });
    window.versus.onFxChanged?.(applyFxSnapshot);

    flashLcd(false);
    wallet = await window.versus.ensureWallet();
    await refreshFxSnapshot();
    bond = await window.versus.loadLocalBond();

    const localCypherIsActive = bond?.phase === "active" && bond.cypherId != null;
    if (!localCypherIsActive) {
      show("view-boot");
      bond = await window.versus.loadBond();
    }

    if (bond?.phase === "active" && bond.cypherId != null) {
      activateRestoredBond(bond);
      if (bond.pendingGraduation) {
        setTimeout(() => runGraduationWhenReady({ ceremony: bond.pendingGraduation, state: bond }).catch(console.error), 420);
      }
      if (localCypherIsActive) {
        window.versus.loadBond().then((synced) => {
          if (synced?.phase !== "active" || synced.cypherId == null) return;
          bond = synced;
          W.targetFill = clamp((bond.classPotMicros || 0) / FLOOR_MICROS, 0, 1);
          updateModeScreen();
        }).catch((error) => console.error("Versus background chain sync error:", error));
      }
    } else if (!bond || !bond.phase || bond.phase === "awaiting_deposit") {
      bond = { phase: "awaiting_deposit", walletAddress: wallet.address };
      await window.versus.saveBond(bond);
      show("view-deposit");
      ensureDepositQr();
      refreshHatchQuote();
      startSceneClock();
    } else if (bond.phase === "awaiting_referral") {
      show("view-deposit");
      ensureDepositQr();
      refreshHatchQuote();
      setHatchState("referral");
      startSceneClock();
    } else {
      show("view-deposit");
      ensureDepositQr();
      startSceneClock();
      await runHatchRitual(false);
    }

    setInterval(() => showNextThought().catch(console.error), 2500);
    refreshNetworkScreen();
    setInterval(refreshNetworkScreen, POLL_MS);
    window.versus.onVerifiedRain?.(() => scheduleVerifiedRainPump(0));
    window.versus.onClassOver?.(showClassOverNotice);
    window.versus.onGraduation?.((payload) => runGraduationWhenReady(payload).catch(console.error));
    scheduleVerifiedRainPump(0);
    window.addEventListener("resize", resizeCanvas);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        stopLoop();
      } else if (bond?.phase === "active" && !$("view-class").classList.contains("hidden")) {
        flashLcd(true);
        W.lastT = performance.now();
        startLoop();
        refreshForegroundState();
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
  $("hatch-referral").setAttribute("aria-hidden", state === "referral" ? "false" : "true");
  $("hatch-incubation").setAttribute("aria-hidden", ["lifting", "incubating"].includes(state) ? "false" : "true");
}

async function ensureDepositQr() {
  const qr = $("address-qr");
  if (!qr || qr.hasAttribute("src")) return;
  try {
    qr.hidden = true;
    qr.src = await window.versus.getAddressQr();
    qr.hidden = false;
  } catch (_) {
    qr.removeAttribute("src");
    qr.hidden = true;
    const status = $("deposit-status");
    if (status) {
      status.textContent = "QR unavailable. Copy the address instead.";
      status.classList.remove("hidden");
    }
  }
}

let hatchQuotePromise = null;

async function refreshHatchQuote() {
  const title = $("fund-title");
  if (!title || !window.versus?.getHatchQuote) return;
  if (hatchQuotePromise) return hatchQuotePromise;
  title.textContent = "CHECKING BASE...";
  hatchQuotePromise = (async () => {
    try {
      const quote = await window.versus.getHatchQuote();
      const wei = BigInt(quote.targetDepositWei);
      const eth = Number(wei) / 1e18;
      title.textContent = `FUND ABOUT ${eth.toFixed(5)} BASE ETH`;
    } catch (_) {
      title.textContent = "FUND WITH BASE ETH";
    }
  })().finally(() => {
    hatchQuotePromise = null;
  });
  return hatchQuotePromise;
}

function wakeEgg() {
  const view = $("view-deposit");
  if (view.dataset.hatchState !== "dormant") return;
  setHatchState("waking");
  setTimeout(() => {
    setHatchState("funding");
    ensureDepositQr();
    refreshHatchQuote();
  }, 720);
}

$("btn-wake-egg").onclick = wakeEgg;
$("btn-begin-hatch").onclick = wakeEgg;
$("btn-close-funding").onclick = () => setHatchState("dormant");

let hatchLock = false;

async function revealHatchedCypher() {
  W.targetFill = clamp((bond.classPotMicros || 0) / FLOOR_MICROS, 0, 1);
  const whiteout = $("hatch-whiteout");
  whiteout.classList.remove("run");
  void whiteout.offsetWidth;
  whiteout.classList.add("run");
  await sleep(480);
  showClass();
  setTimeout(() => whiteout.classList.remove("run"), 1600);
}

async function runHatchRitual(simulateDeposit = true) {
  if (hatchLock) return;
  hatchLock = true;
  const confirm = $("btn-sim-deposit");
  const depositStatus = $("deposit-status");
  if (confirm) {
    confirm.disabled = true;
    confirm.textContent = "CHECKING...";
  }
  if (simulateDeposit && depositStatus) {
    depositStatus.textContent = "Checking Base for your funds...";
    depositStatus.classList.remove("hidden");
  }

  try {
    if (simulateDeposit) {
      await window.versus.simulateDeposit();
      const referral = await window.versus.getReferralStatus();
      if (referral.funded) {
        bond = await window.versus.loadBond();
        $("referral-reward").textContent = `$${(Number(referral.rewardPerReferral) / 1e6).toFixed(2)} goes to the Cypher that invited you.`;
        $("referral-code").value = "";
        $("referral-status").classList.add("hidden");
        setHatchState("referral");
        hatchLock = false;
        if (confirm) {
          confirm.disabled = false;
          confirm.textContent = "I SENT IT";
        }
        setTimeout(() => $("referral-code").focus(), 80);
        return;
      }
      await window.versus.setReferralCode(null);
    }

    const onboardPipeline = window.versus.runOnboardPipeline(CYPHERS.length).then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    setHatchState("lifting");
    await sleep(920);
    setHatchState("incubating");
    const onboardResult = await onboardPipeline;
    if (onboardResult.error) throw onboardResult.error;
    bond = onboardResult.value;
    await revealHatchedCypher();
  } catch (err) {
    console.error(err);
    hatchLock = false;
    if (confirm) {
      confirm.disabled = false;
      confirm.textContent = "I SENT IT";
    }
    bond = await window.versus.loadBond();
    if (bond?.phase === "active" && bond.cypherId != null) {
      await revealHatchedCypher();
      return;
    }
    const referralPending = Boolean(bond?.pendingReferrerAgentId);
    setHatchState(referralPending ? "referral" : "funding");
    const status = referralPending ? $("referral-status") : $("deposit-status");
    if (referralPending) {
      status.textContent = "Referral changed or the pool emptied. Check the code or choose no one.";
    } else if (err?.code === "TRANSACTION_UNCERTAIN") {
      status.textContent = "Transaction submitted. Waiting for Base; do not resend.";
    } else if (/rpc|network|timeout|batch/i.test(String(err?.message || ""))) {
      status.textContent = "Base is taking longer to respond. Funds are safe; check again shortly.";
    } else {
      status.textContent = "Hatch did not complete. Check the funding amount and try again.";
    }
    status.classList.remove("hidden");
  }
}

$("btn-sim-deposit").onclick = () => runHatchRitual(true);

$("btn-referral-skip").onclick = async () => {
  await window.versus.setReferralCode(null);
  runHatchRitual(false);
};

$("btn-referral-hatch").onclick = async () => {
  const button = $("btn-referral-hatch");
  const status = $("referral-status");
  button.disabled = true;
  try {
    const referral = await window.versus.setReferralCode($("referral-code").value);
    status.textContent = `Cypher #${referral.referrerAgentId} confirmed.`;
    status.classList.remove("hidden");
    await runHatchRitual(false);
  } catch (error) {
    status.textContent = signalSentence(error?.message, "That invite code is not valid", 58);
    status.classList.remove("hidden");
  } finally {
    button.disabled = false;
  }
};

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
  W.targetFill = clamp((bond.classPotMicros || 0) / FLOOR_MICROS, 0, 1);
  showClass();
  // The first drop arrives later through the verified node weather stream.
});

$("btn-mode").onclick = () => {
  if (graduationRunning) return;
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
  if (activeSurface === "fx") {
    const index = FX_MODES.indexOf(activeFxMode);
    setFxMode(FX_MODES[(index + 1) % FX_MODES.length]);
    return;
  }
  const index = MODES.indexOf(activeMode);
  setMode(MODES[(index + 1) % MODES.length]);
};

$("settings-tab-brain")?.addEventListener("click", () => setSettingsTab("brain"));
$("settings-tab-device")?.addEventListener("click", () => setSettingsTab("device"));
$("settings-tab-health")?.addEventListener("click", () => setSettingsTab("health"));
$("setting-brain-kind")?.addEventListener("change", updateBrainAdapterFields);

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

$("setting-fx-development")?.addEventListener("change", async () => {
  setSettingsStatus("SAVING");
  try {
    currentSettings = await window.versus.saveSettings(settingsInput());
    renderSettings(currentSettings);
    setSettingsStatus("SAVED");
  } catch (error) {
    setSettingsStatus(settingsErrorMessage(error), true);
  }
});

$("setting-referral-funding")?.addEventListener("change", async () => {
  setSettingsStatus("SAVING");
  try {
    currentSettings = await window.versus.saveSettings(settingsInput());
    renderSettings(currentSettings);
    setSettingsStatus("SAVED");
  } catch (error) {
    setSettingsStatus(settingsErrorMessage(error), true);
  }
});

$("btn-copy-referral")?.addEventListener("click", async () => {
  try {
    const code = await window.versus.copyReferralCode();
    $("btn-copy-referral").textContent = `${code} COPIED`;
    setTimeout(() => { $("btn-copy-referral").textContent = code; }, 1200);
  } catch (error) {
    setSettingsStatus(settingsErrorMessage(error), true);
  }
});

$("btn-fund-referrals")?.addEventListener("click", async () => {
  const dollars = Number($("setting-referral-amount")?.value || 0);
  if (!Number.isFinite(dollars) || dollars <= 0) {
    setSettingsStatus("ENTER AN AMOUNT", true);
    return;
  }
  const amountMicros = Math.round(dollars * 1e6);
  setSettingsStatus("FUNDING");
  try {
    await window.versus.fundReferralPool(String(amountMicros));
    bond = await window.versus.reconcile() || bond;
    $("setting-referral-amount").value = "";
    setSettingsStatus("POOL FUNDED");
  } catch (error) {
    setSettingsStatus(deviceErrorMessage(error), true);
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
    const activeCypher = bond?.phase === "active" && bond?.agentId;
    const result = activeCypher
      ? await window.versus.createCypherArchive(backupPassword())
      : await window.versus.createWalletBackup(backupPassword());
    setSettingsStatus(result.canceled ? "CANCELED" : activeCypher ? "ARCHIVE SAVED" : "WALLET SAVED");
  } catch (error) {
    setSettingsStatus(settingsErrorMessage(error), true);
  }
});

$("btn-restore-wallet")?.addEventListener("click", async () => {
  try {
    setSettingsStatus("RESTORING");
    const result = await window.versus.restoreVersusBackup(backupPassword());
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

$("btn-update")?.addEventListener("click", async () => {
  try {
    if (updateStatus?.status === "available") await window.versus.downloadUpdate();
    else if (updateStatus?.status === "ready") await window.versus.installUpdate();
    else await window.versus.checkForUpdates();
  } catch (error) {
    setSettingsStatus(signalSentence(ipcErrorMessage(error), "Update failed", 96), true);
  }
});

$("btn-health-refresh")?.addEventListener("click", async () => {
  setSettingsStatus("CHECKING");
  try {
    renderHealth(await window.versus.getHealth());
    setSettingsStatus(healthSnapshot.status === "healthy" ? "HEALTHY" : "CHECK HEALTH");
  } catch (error) {
    setSettingsStatus(deviceErrorMessage(error), true);
  }
});

$("btn-export-diagnostics")?.addEventListener("click", async () => {
  setSettingsStatus("EXPORTING");
  try {
    const result = await window.versus.exportDiagnostics();
    setSettingsStatus(result.canceled ? "CANCELED" : "REPORT SAVED");
  } catch (error) {
    setSettingsStatus(deviceErrorMessage(error), true);
  }
});

$("cypher-card-flip")?.addEventListener("click", () => {
  if (activeMode !== "cypher") return;
  setCypherFlipped(!cypherFlipped);
});

$("cypher-field-note-copy")?.addEventListener("wheel", (event) => {
  const viewport = event.currentTarget;
  if (activeMode !== "cypher" || !cypherFlipped || viewport.scrollHeight <= viewport.clientHeight) return;

  event.preventDefault();
  event.stopPropagation();
  const rawDelta = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 12 : event.deltaY;
  viewport.scrollTop += clamp(rawDelta * 0.45, -30, 30);
}, { passive: false });

$("btn-signal-flip")?.addEventListener("click", () => {
  if (activeMode !== "network") return;
  setSignalFlipped(!signalFlipped);
});

$("btn-signal-copy-code")?.addEventListener("click", async () => {
  const button = $("btn-signal-copy-code");
  try {
    await window.versus.copyReferralCode();
    button.textContent = "COPIED";
    setTimeout(() => { button.textContent = "COPY CODE"; }, 1200);
  } catch (error) {
    toast(signalSentence(error.message, "code unavailable", 32));
  }
});

$("btn-brain-think")?.addEventListener("click", async () => {
  const button = $("btn-brain-think");
  if (brainThinkPending || button?.disabled) return;
  const agent = networkSnapshot?.status?.agent;
  if (!agent?.configured) {
    toast("configure a local brain");
    return;
  }
  brainThinkPending = true;
  renderNetworkScreen();
  try {
    await window.versus.agentTick();
  } catch (error) {
    toast(signalSentence(error.message, "brain unavailable", 32));
  } finally {
    brainThinkPending = false;
    renderNetworkScreen();
  }
  await refreshNetworkScreen();
});

$("btn-test-signal")?.addEventListener("click", async () => {
  const button = $("btn-test-signal");
  if (!window.versus?.agentSendTestSignal || button?.disabled) return;
  button.disabled = true;
  button.textContent = "SEND";
  try {
    const result = await window.versus.agentSendTestSignal();
    toast(result.deliveryPending ? "signal paid delivery pending" : "test signal sent");
    await refreshNetworkScreen();
  } catch (error) {
    toast(signalSentence(error.message, "signal failed", 32));
  } finally {
    button.disabled = false;
    button.textContent = "PING";
  }
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
  if (graduationRunning || !bond || bond.phase !== "active" || activeMode !== "raft") return;
  const rect = $("cistern").getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const onRaft = Math.abs(x - rect.width / 2) < 90 && y > PH.heave.p && y < PH.heave.p + RAFT_H;
  if (onRaft) queueRainTap();
  else {
    spawnRipple(x, 0.5, false, 0);
  }
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* debug/test hooks (used by scripts/capture-views.js) */
window.versus.onUpdateStatus(renderUpdateStatus);
window.versus.onHealth(renderHealth);

window.__pet = {
  show,
  showClass,
  runHatchRitual,
  runGraduationCeremony,
  graduationRunning: () => graduationRunning,
  previewGraduationCapture() {
    $("shell").dataset.graduationActive = "true";
    setGraduationStage("capture");
    const target = prepareGraduationRigGeometry();
    $("face-motion").classList.add("graduation-captured");
    return target;
  },
  resetGraduationPreview() {
    $("face-motion").classList.remove("graduation-captured", "graduation-lifted", "graduation-departing");
    setGraduationStage("idle");
    delete $("shell").dataset.graduationActive;
  },
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
  setSurface(surface) {
    activeSurface = surface === "fx" ? "fx" : "cypher";
    renderFxScreen();
  },
  setFxMode(mode) {
    if (!FX_MODES.includes(mode)) return;
    activeFxMode = mode;
    renderFxScreen();
  },
  /** Design-review only: populate the FX panels with sample dealer rows. */
  setFxDemo(on = true) {
    clearFxTapeDemo();
    if (!on) {
      fxInventory = emptyFxInventory();
      fxTape = [];
      fxOpenBay = null;
      fxStockFilter = "all";
      fxRisk.armed = false;
      renderFxScreen();
      return;
    }
    fxInventory = [
      { ...FX_SUPPORTED_POSITIONS[0], address: "0x9f2c4a71d3b6e05812fa7c93de40188cb6d24b17", availableMicros: 1_240_180_000, reservedMicros: 260_000_000, capacityMicros: 2_000_000_000, inFlight: 1, enabled: true },
      { ...FX_SUPPORTED_POSITIONS[1], address: "0x41b8d0e27ca5f9314d6027ba88e5137fa0c93e42", availableMicros: 486_500_000, reservedMicros: 0, capacityMicros: 1_000_000_000, inFlight: 0, enabled: true },
    ];
    fxTape = [...FX_TAPE_DEMO_RECEIPTS];
    fxStockFilter = "all";
    fxOpenBay = null;
    fxRisk.armed = true;
    renderFxScreen();
  },
  playFxTapeDemo,
  queueRainTap,
  flushRainBatch,
  verifiedRainDrop,
  storm(v) {
    W.targetStorm = clamp(v, 0, 1);
    W.stormOffAt = 0;
  },
  _w: W,
  _ph: PH,
  _surfaceYAt: surfaceYAt,
};

boot();
