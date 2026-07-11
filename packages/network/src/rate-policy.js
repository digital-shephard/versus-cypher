const { SIGNAL_TYPES } = require("./protocol");

class RateLimitError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "RateLimitError";
    this.code = code;
  }
}

class RatePolicy {
  constructor({
    maxPerMinute = 12,
    maxPerLaunch = 64,
    maxSignalsPerLaunch = 12,
    now = () => Date.now(),
  } = {}) {
    this.maxPerMinute = maxPerMinute;
    this.maxPerLaunch = maxPerLaunch;
    this.maxSignalsPerLaunch = maxSignalsPerLaunch;
    this.now = now;
    this.recent = new Map();
    this.launchCounts = new Map();
    this.signalCounts = new Map();
    this.usedRateNullifiers = new Set();
  }

  seed(postcards = []) {
    for (const postcard of postcards) {
      if (postcard?.rateNullifier) this.usedRateNullifiers.add(postcard.rateNullifier);
    }
  }

  consume(postcard, multiplier = 1, { ignoreMinute = false } = {}) {
    const author = postcard.author.toLowerCase();
    const now = this.now();
    const minuteLimit = Math.max(1, Math.floor(this.maxPerMinute * multiplier));
    const launchLimit = Math.max(1, Math.floor(this.maxPerLaunch * multiplier));
    const signalLimit = Math.max(1, Math.floor(this.maxSignalsPerLaunch * multiplier));
    if (this.usedRateNullifiers.has(postcard.rateNullifier)) {
      throw new RateLimitError("Cypher epoch slot has already been used", "EPOCH_SLOT_REUSED");
    }

    const recent = (this.recent.get(author) || []).filter((time) => now - time < 60_000);
    if (!ignoreMinute && recent.length >= minuteLimit) {
      throw new RateLimitError("author exceeded the local minute allowance", "MINUTE_LIMIT");
    }

    const launchKey = `${postcard.launchId}:${author}`;
    const launchCount = this.launchCounts.get(launchKey) || 0;
    if (launchCount >= launchLimit) {
      throw new RateLimitError("author exceeded the local launch allowance", "LAUNCH_LIMIT");
    }

    const isSignal = SIGNAL_TYPES.includes(postcard.type);
    const signalCount = this.signalCounts.get(launchKey) || 0;
    if (isSignal && signalCount >= signalLimit) {
      throw new RateLimitError("author exceeded the local signal allowance", "SIGNAL_LIMIT");
    }

    if (!ignoreMinute) {
      recent.push(now);
      this.recent.set(author, recent);
    }
    this.launchCounts.set(launchKey, launchCount + 1);
    if (isSignal) this.signalCounts.set(launchKey, signalCount + 1);
    this.usedRateNullifiers.add(postcard.rateNullifier);

    return {
      minuteRemaining: ignoreMinute ? minuteLimit : minuteLimit - recent.length,
      launchRemaining: launchLimit - launchCount - 1,
      signalRemaining: signalLimit - signalCount - (isSignal ? 1 : 0),
    };
  }
}

module.exports = { RateLimitError, RatePolicy };
