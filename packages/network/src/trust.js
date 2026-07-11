const fs = require("fs");
const path = require("path");
const { getAddress, isAddress } = require("ethers");

const TRUST_DIMENSIONS = Object.freeze([
  "taste",
  "prediction",
  "criticism",
  "execution",
  "sponsorship",
  "stewardship",
  "integrity",
]);

function normalizeAddress(address) {
  if (typeof address !== "string" || !isAddress(address)) {
    throw new TypeError("address must be an ethereum address");
  }
  return getAddress(address).toLowerCase();
}

class TrustGraph {
  constructor({ filePath = null } = {}) {
    this.filePath = filePath;
    this.peers = new Map();
    this.contributions = new Map();
    this.load();
  }

  load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    for (const [address, profile] of Object.entries(parsed.peers || {})) {
      this.peers.set(normalizeAddress(address), this.normalizeProfile(profile));
    }
    for (const [source, contribution] of Object.entries(parsed.contributions || {})) {
      if (!/^[a-zA-Z0-9:_-]{1,200}$/.test(source)) continue;
      try {
        this.contributions.set(source, this.normalizeContribution(contribution));
      } catch (_) {
        // Ignore malformed local contribution records while preserving valid trust state.
      }
    }
  }

  normalizeProfile(profile = {}) {
    const scores = {};
    for (const dimension of TRUST_DIMENSIONS) {
      const score = Number(profile.scores?.[dimension] || 0);
      scores[dimension] = Math.max(-100, Math.min(100, Number.isFinite(score) ? score : 0));
    }
    return {
      blocked: Boolean(profile.blocked),
      scores,
      updatedAt: Number(profile.updatedAt || 0),
    };
  }

  profile(address) {
    address = normalizeAddress(address);
    if (!this.peers.has(address)) this.peers.set(address, this.normalizeProfile());
    return this.peers.get(address);
  }

  normalizeContribution(contribution = {}) {
    const scores = {};
    for (const dimension of TRUST_DIMENSIONS) {
      const score = Number(contribution.scores?.[dimension] || 0);
      if (!Number.isFinite(score) || score < -100 || score > 100) {
        throw new RangeError("trust contribution must be between -100 and 100");
      }
      scores[dimension] = score;
    }
    return {
      address: normalizeAddress(contribution.address),
      scores,
      updatedAt: Number(contribution.updatedAt || Date.now()),
    };
  }

  isBlocked(address) {
    return this.profile(address).blocked;
  }

  setBlocked(address, blocked = true) {
    const profile = this.profile(address);
    profile.blocked = Boolean(blocked);
    profile.updatedAt = Date.now();
    this.save();
    return profile.blocked;
  }

  score(address, dimension) {
    if (!TRUST_DIMENSIONS.includes(dimension)) throw new RangeError("unknown trust dimension");
    address = normalizeAddress(address);
    let total = this.profile(address).scores[dimension];
    for (const contribution of this.contributions.values()) {
      if (contribution.address === address) total += contribution.scores[dimension];
    }
    return Math.max(-100, Math.min(100, total));
  }

  setScore(address, dimension, score) {
    if (!TRUST_DIMENSIONS.includes(dimension)) throw new RangeError("unknown trust dimension");
    score = Number(score);
    if (!Number.isFinite(score) || score < -100 || score > 100) {
      throw new RangeError("trust score must be between -100 and 100");
    }
    const profile = this.profile(address);
    profile.scores[dimension] = score;
    profile.updatedAt = Date.now();
    this.save();
    return score;
  }

  adjustScore(address, dimension, delta) {
    const profile = this.profile(address);
    const next = Math.max(-100, Math.min(100, profile.scores[dimension] + Number(delta)));
    return this.setScore(address, dimension, next);
  }

  setContribution(source, address, scores = {}) {
    if (typeof source !== "string" || !/^[a-zA-Z0-9:_-]{1,200}$/.test(source)) {
      throw new TypeError("trust contribution source is invalid");
    }
    const contribution = this.normalizeContribution({ address, scores, updatedAt: Date.now() });
    this.contributions.set(source, contribution);
    this.save();
    return contribution;
  }

  removeContribution(source) {
    const removed = this.contributions.delete(source);
    if (removed) this.save();
    return removed;
  }

  contribution(source) {
    return this.contributions.get(source) || null;
  }

  attentionWeight(address) {
    return this.domainWeight(address, TRUST_DIMENSIONS);
  }

  domainWeight(address, dimensions = TRUST_DIMENSIONS) {
    const profile = this.profile(address);
    if (profile.blocked) return 0;
    if (!Array.isArray(dimensions) || dimensions.length < 1) {
      throw new TypeError("trust dimensions must be a nonempty array");
    }
    const values = dimensions.map((dimension) => {
      if (!TRUST_DIMENSIONS.includes(dimension)) throw new RangeError("unknown trust dimension");
      return this.score(address, dimension);
    });
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    return Math.max(0.1, Math.min(2, 1 + average / 100));
  }

  toJSON() {
    return {
      peers: Object.fromEntries(this.peers),
      contributions: Object.fromEntries(this.contributions),
    };
  }

  save() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.toJSON(), null, 2)}\n`, "utf8");
    fs.renameSync(temporary, this.filePath);
  }
}

module.exports = { TRUST_DIMENSIONS, TrustGraph };
