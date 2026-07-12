function referralChecksum(agentId) {
  return ((BigInt(agentId) * 97n + 23n) % 1296n).toString(36).padStart(2, "0").toUpperCase();
}

function referralCodeFor(agentId) {
  const id = BigInt(agentId);
  if (id < 1n) throw new RangeError("referral agent id must be positive");
  return `VRS-${id}-${referralChecksum(id)}`;
}

function parseReferralCode(value) {
  const match = /^VRS-([1-9][0-9]*)-([0-9A-Z]{2})$/.exec(String(value || "").trim().toUpperCase());
  if (!match) throw new TypeError("referral code is invalid");
  const agentId = BigInt(match[1]);
  if (match[2] !== referralChecksum(agentId)) throw new TypeError("referral code checksum is invalid");
  return agentId;
}

function availableReferralRewards(balanceMicros, rewardMicros) {
  const balance = BigInt(balanceMicros || 0);
  const reward = BigInt(rewardMicros || 0);
  return reward > 0n ? balance / reward : 0n;
}

module.exports = { availableReferralRewards, parseReferralCode, referralCodeFor };
