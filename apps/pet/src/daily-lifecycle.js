const { EventEmitter } = require("node:events");

const DAY_MS = 86_400_000;
const DEFAULT_CHECK_INTERVAL_MS = 15 * 60_000;
const DEFAULT_RETRY_BASE_MS = 60_000;
const DEFAULT_RETRY_MAX_MS = 15 * 60_000;

function utcDay(now = Date.now()) {
  return Math.floor(Number(now) / DAY_MS);
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
    this.timer = null;
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
    const day = utcDay(now);
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

      if (Number(state.lastCommitDay) !== day) {
        lifecycle.status = "raining";
        lifecycle.rainStatus = "submitting";
        this.persist(state, lifecycle);
        const result = await this.rain({ day, reason });
        state = result?.state || this.loadState() || state;
        lifecycle = lifecycleForDay(state.dailyLifecycle || lifecycle, day);
        if (result?.hash) lifecycle.rainTxHash = result.hash;
      }

      if (Number(state.lastCommitDay) !== day) {
        throw new Error("daily rain did not reconcile as confirmed");
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
    });
    return this.running;
  }

  start({ immediate = true } = {}) {
    if (this.timer) return;
    this.timer = this.setIntervalImpl(() => {
      this.wake("timer").catch((error) => this.emit("fatal", error));
    }, this.checkIntervalMs);
    this.timer.unref?.();
    if (immediate) this.wake("startup", { ignoreBackoff: true }).catch((error) => this.emit("fatal", error));
  }

  stop() {
    if (this.timer) this.clearIntervalImpl(this.timer);
    this.timer = null;
  }
}

module.exports = {
  DAY_MS,
  DEFAULT_CHECK_INTERVAL_MS,
  DailyLifecycleScheduler,
  errorCode,
  lifecycleForDay,
  utcDay,
};
