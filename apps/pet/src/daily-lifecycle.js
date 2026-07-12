const { EventEmitter } = require("node:events");

const DAY_MS = 86_400_000;
const DAY_SECONDS = 86_400;
const DEFAULT_CHECK_INTERVAL_MS = 15 * 60_000;
const DEFAULT_RETRY_BASE_MS = 60_000;
const DEFAULT_RETRY_MAX_MS = 15 * 60_000;

function utcDay(now = Date.now()) {
  return Math.floor(Number(now) / DAY_MS);
}

function nextCommitAtFor(state, now = Date.now()) {
  const explicit = Number(state?.nextCommitAt);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  const referenceMs = Number(state?.lastRainAt || state?.onboardedAt);
  if (Number.isFinite(referenceMs) && referenceMs > 0) {
    return Math.floor(referenceMs / 1000) + DAY_SECONDS;
  }
  const lastCommitDay = Number(state?.lastCommitDay);
  if (Number.isInteger(lastCommitDay) && lastCommitDay > 0) return (lastCommitDay + 1) * DAY_SECONDS;
  return 0;
}

function commitIsDue(state, now = Date.now()) {
  const dueAt = nextCommitAtFor(state, now);
  return dueAt === 0 || Math.floor(Number(now) / 1000) >= dueAt;
}

function nextCadenceStreak(dueAt, currentStreak, committedAt) {
  return Number(dueAt) > 0 && Number(committedAt) < Number(dueAt) + DAY_SECONDS
    ? Number(currentStreak || 0) + 1
    : 1;
}

function errorCode(error) {
  if (error?.code) return String(error.code);
  const message = String(error?.message || error || "daily lifecycle failed").toLowerCase();
  if (message.includes("runway") && (message.includes("empty") || message.includes("insufficient"))) {
    return "EMPTY_RUNWAY";
  }
  if (message.includes("gas") || message.includes("funds")) return "INSUFFICIENT_GAS";
  if (message.includes("owner") || message.includes("ownership")) return "OWNERSHIP_LOST";
  if (message.includes("active cypher")) return "NO_ACTIVE_CYPHER";
  return "TEMPORARY_FAILURE";
}

function lifecycleForDay(value, day) {
  if (value?.day === day) return { ...value };
  return {
    day,
    status: "pending",
    attempts: 0,
    rainStatus: "pending",
    thoughtStatus: "pending",
    thoughtDay: null,
    nextRetryAt: 0,
    lastError: null,
  };
}

class DailyLifecycleScheduler extends EventEmitter {
  constructor({
    loadState,
    saveState,
    reconcile,
    rain,
    think = null,
    shouldThink = () => false,
    now = () => Date.now(),
    checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
    retryBaseMs = DEFAULT_RETRY_BASE_MS,
    retryMaxMs = DEFAULT_RETRY_MAX_MS,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  }) {
    super();
    if (typeof loadState !== "function" || typeof saveState !== "function") {
      throw new TypeError("daily lifecycle requires state load and save functions");
    }
    if (typeof reconcile !== "function" || typeof rain !== "function") {
      throw new TypeError("daily lifecycle requires reconcile and rain functions");
    }
    if (think !== null && typeof think !== "function") throw new TypeError("think must be a function");
    if (typeof shouldThink !== "function") throw new TypeError("shouldThink must be a function");
    for (const [name, value] of Object.entries({ checkIntervalMs, retryBaseMs, retryMaxMs })) {
      if (!Number.isInteger(value) || value < 100) throw new RangeError(`${name} must be at least 100ms`);
    }
    this.loadState = loadState;
    this.saveState = saveState;
    this.reconcile = reconcile;
    this.rain = rain;
    this.think = think;
    this.shouldThink = shouldThink;
    this.now = now;
    this.checkIntervalMs = checkIntervalMs;
    this.retryBaseMs = retryBaseMs;
    this.retryMaxMs = retryMaxMs;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.timer = null;
    this.dueTimer = null;
    this.running = null;
  }

  persist(state, lifecycle) {
    state.dailyLifecycle = lifecycle;
    this.saveState(state);
  }

  failure(state, lifecycle, error) {
    const now = this.now();
    const code = errorCode(error);
    const retryDelay = Math.min(
      this.retryMaxMs,
      this.retryBaseMs * (2 ** Math.max(0, lifecycle.attempts - 1))
    );
    lifecycle.status = "error";
    lifecycle.lastError = {
      code,
      message: String(error?.message || error || "daily lifecycle failed").slice(0, 240),
      at: now,
    };
    lifecycle.nextRetryAt = now + retryDelay;
    this.persist(state, lifecycle);
    this.emit("errorState", { day: lifecycle.day, error: lifecycle.lastError, nextRetryAt: lifecycle.nextRetryAt });
    return { status: "error", day: lifecycle.day, error: lifecycle.lastError, nextRetryAt: lifecycle.nextRetryAt };
  }

  async execute(reason, { ignoreBackoff = false } = {}) {
    const now = this.now();
    let day = utcDay(now);
    let state = this.loadState() || {};
    if (state.phase !== "active" || !state.agentId) return { status: "inactive", day };

    let lifecycle = lifecycleForDay(state.dailyLifecycle, day);
    if (!ignoreBackoff && lifecycle.nextRetryAt > now) {
      return { status: "deferred", day, nextRetryAt: lifecycle.nextRetryAt };
    }

    lifecycle.attempts += 1;
    lifecycle.status = "reconciling";
    lifecycle.lastAttemptAt = now;
    lifecycle.lastWakeReason = String(reason || "timer").slice(0, 32);
    lifecycle.nextRetryAt = 0;
    lifecycle.lastError = null;
    this.persist(state, lifecycle);

    try {
      const reconciled = await this.reconcile();
      state = reconciled || this.loadState() || state;
      lifecycle = lifecycleForDay(state.dailyLifecycle || lifecycle, day);

      if (state.ownershipLost) {
        const error = new Error("Cypher ownership no longer belongs to this wallet");
        error.code = "OWNERSHIP_LOST";
        throw error;
      }

      if (commitIsDue(state, now)) {
        lifecycle.status = "raining";
        lifecycle.rainStatus = "submitting";
        this.persist(state, lifecycle);
        const result = await this.rain({ day, reason });
        state = result?.state || this.loadState() || state;
        day = utcDay(this.now());
        lifecycle = lifecycleForDay(state.dailyLifecycle || lifecycle, day);
        if (result?.hash) lifecycle.rainTxHash = result.hash;
      }

      if (commitIsDue(state, this.now())) {
        throw new Error("daily rain did not reconcile as confirmed");
      }

      if (Number(state.lastCommitDay) !== day) {
        lifecycle.status = "waiting";
        lifecycle.rainStatus = "waiting";
        lifecycle.thoughtStatus = "waiting";
        lifecycle.nextCommitAt = nextCommitAtFor(state, this.now());
        lifecycle.nextRetryAt = 0;
        this.persist(state, lifecycle);
        return { status: "waiting", day, nextCommitAt: lifecycle.nextCommitAt };
      }

      lifecycle.rainStatus = "confirmed";
      lifecycle.rainConfirmedAt ||= this.now();
      lifecycle.status = "rain_confirmed";
      this.persist(state, lifecycle);

      if (this.think && this.shouldThink(state) && lifecycle.thoughtDay !== day) {
        lifecycle.status = "thinking";
        lifecycle.thoughtStatus = "running";
        this.persist(state, lifecycle);
        const result = await this.think({ day, reason });
        if (result?.status === "brain_error" || result?.status === "error") {
          throw result.error || new Error("daily brain cycle failed");
        }
        state = this.loadState() || state;
        lifecycle = lifecycleForDay(state.dailyLifecycle || lifecycle, day);
        lifecycle.thoughtDay = day;
        lifecycle.thoughtStatus = result?.status || "complete";
        lifecycle.thoughtAt = this.now();
      } else if (!this.shouldThink(state)) {
        lifecycle.thoughtStatus = "disabled";
      }

      lifecycle.status = "complete";
      lifecycle.completedAt = this.now();
      lifecycle.nextRetryAt = 0;
      this.persist(state, lifecycle);
      const result = { status: "complete", day, rainStatus: lifecycle.rainStatus, thoughtStatus: lifecycle.thoughtStatus };
      this.emit("complete", result);
      return result;
    } catch (error) {
      state = this.loadState() || state;
      lifecycle = lifecycleForDay(state.dailyLifecycle || lifecycle, day);
      return this.failure(state, lifecycle, error);
    }
  }

  wake(reason = "timer", options = {}) {
    if (this.running) return this.running;
    this.running = this.execute(reason, options).finally(() => {
      this.running = null;
      this.scheduleDueWake();
    });
    return this.running;
  }

  scheduleDueWake() {
    if (this.dueTimer) this.clearTimeoutImpl(this.dueTimer);
    this.dueTimer = null;
    const state = this.loadState() || {};
    if (state.phase !== "active" || !state.agentId) return;
    const dueAt = nextCommitAtFor(state, this.now());
    const delay = dueAt * 1000 - this.now();
    if (dueAt <= 0 || delay <= 0) return;
    this.dueTimer = this.setTimeoutImpl(() => {
      this.dueTimer = null;
      this.wake("due", { ignoreBackoff: true }).catch((error) => this.emit("fatal", error));
    }, Math.max(100, Math.min(delay, 2_147_000_000)));
    this.dueTimer.unref?.();
  }

  start({ immediate = true } = {}) {
    if (this.timer) return;
    this.timer = this.setIntervalImpl(() => {
      this.wake("timer").catch((error) => this.emit("fatal", error));
    }, this.checkIntervalMs);
    this.timer.unref?.();
    if (immediate) this.wake("startup", { ignoreBackoff: true }).catch((error) => this.emit("fatal", error));
    else this.scheduleDueWake();
  }

  stop() {
    if (this.timer) this.clearIntervalImpl(this.timer);
    if (this.dueTimer) this.clearTimeoutImpl(this.dueTimer);
    this.timer = null;
    this.dueTimer = null;
  }
}

module.exports = {
  DAY_MS,
  DAY_SECONDS,
  DEFAULT_CHECK_INTERVAL_MS,
  DailyLifecycleScheduler,
  commitIsDue,
  errorCode,
  lifecycleForDay,
  nextCadenceStreak,
  nextCommitAtFor,
  utcDay,
};
