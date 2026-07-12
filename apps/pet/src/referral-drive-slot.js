const fs = require("node:fs");
const path = require("node:path");

function normalizeDrive(candidate, referralCode, launchId, now) {
  if (!candidate || candidate.status !== "ready") return null;
  const proposalId = String(candidate.id || "");
  if (!/^0x[0-9a-f]{64}$/.test(proposalId)) throw new TypeError("referral drive proposal id is invalid");
  const fundingGoalMicros = String(candidate.fundingGoalMicros || "0");
  if (!/^\d+$/.test(fundingGoalMicros)) throw new TypeError("referral drive funding goal is invalid");
  return {
    proposalId,
    launchId: String(launchId),
    createdAt: Number(candidate.createdAt || 0),
    approvedAt: now,
    body: String(candidate.body || "").replace(/\s+/g, " ").trim().slice(0, 280),
    fundingGoalMicros,
    supporters: Number(candidate.supporters?.length || 0),
    detractors: Number(candidate.detractors?.length || 0),
    referralCode: String(referralCode || ""),
  };
}

class ReferralDriveSlot {
  constructor({ filePath = null, now = () => Date.now() } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.value = this.load();
  }

  load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return parsed?.current && typeof parsed.current === "object" ? parsed.current : null;
    } catch (_) {
      return null;
    }
  }

  save() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, current: this.value }, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, this.filePath);
  }

  sync(candidate, { referralCode, launchId }) {
    const next = normalizeDrive(candidate, referralCode, launchId, this.now());
    if (!next) {
      if (this.value?.launchId === String(launchId)) {
        return { changed: false, current: this.current() };
      }
      const changed = this.value !== null;
      this.value = null;
      if (changed) this.save();
      return { changed, current: null };
    }
    const changed = this.value?.proposalId !== next.proposalId || this.value?.launchId !== next.launchId;
    if (!changed) next.approvedAt = this.value.approvedAt;
    const updated = JSON.stringify(this.value) !== JSON.stringify(next);
    if (updated) {
      this.value = next;
      this.save();
    }
    return { changed, current: this.current() };
  }

  current() {
    return this.value ? { ...this.value } : null;
  }
}

function referralDriveThought(drive) {
  const dollars = Number(BigInt(drive.fundingGoalMicros || 0) / 1_000_000n).toLocaleString("en-US");
  const theme = String(drive.body || "the latest network plan").slice(0, 58);
  return `New referral drive approved: ${theme}. Target $${dollars}. Your code is ${drive.referralCode}.`;
}

module.exports = { ReferralDriveSlot, normalizeDrive, referralDriveThought };
