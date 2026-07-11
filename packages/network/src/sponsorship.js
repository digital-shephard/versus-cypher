const { getAddress, isAddress } = require("ethers");

const MISSION_SPONSORSHIP_KIND = "versus-mission-sponsorship";
const MISSION_SPONSORSHIP_VERSION = 1;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;

class SponsorshipValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "SponsorshipValidationError";
    this.code = "INVALID_MISSION_SPONSORSHIP";
  }
}

function uintString(value, label, { positive = false, maxDigits = 78 } = {}) {
  const text = String(value);
  if (!/^\d+$/.test(text) || text.length > maxDigits || (positive && BigInt(text) === 0n)) {
    throw new SponsorshipValidationError(`${label} must be an unsigned integer`);
  }
  return BigInt(text).toString();
}

function normalizeMissionSponsorship(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new SponsorshipValidationError("mission sponsorship must be an object");
  }
  if (
    input.kind !== MISSION_SPONSORSHIP_KIND ||
    Number(input.version) !== MISSION_SPONSORSHIP_VERSION
  ) {
    throw new SponsorshipValidationError("mission sponsorship kind or version is unsupported");
  }
  for (const [label, value] of [
    ["escrow", input.escrow],
    ["sponsor", input.sponsor],
  ]) {
    if (typeof value !== "string" || !isAddress(value)) {
      throw new SponsorshipValidationError(`${label} must be an ethereum address`);
    }
  }
  if (!HASH_PATTERN.test(String(input.missionId))) {
    throw new SponsorshipValidationError("missionId must be a postcard hash");
  }
  if (!HASH_PATTERN.test(String(input.transactionHash))) {
    throw new SponsorshipValidationError("transactionHash must be a transaction hash");
  }
  return {
    kind: MISSION_SPONSORSHIP_KIND,
    version: MISSION_SPONSORSHIP_VERSION,
    chainId: uintString(input.chainId, "chainId", { positive: true, maxDigits: 20 }),
    escrow: getAddress(input.escrow).toLowerCase(),
    escrowId: uintString(input.escrowId, "escrowId", { positive: true }),
    missionId: input.missionId,
    launchId: uintString(input.launchId, "launchId", { positive: true }),
    sponsorAgentId: uintString(input.sponsorAgentId, "sponsorAgentId", { positive: true }),
    recipientAgentId: uintString(input.recipientAgentId, "recipientAgentId", { positive: true }),
    sponsor: getAddress(input.sponsor).toLowerCase(),
    amountMicros: uintString(input.amountMicros, "amountMicros", { positive: true, maxDigits: 39 }),
    deadline: uintString(input.deadline, "deadline", { positive: true, maxDigits: 20 }),
    transactionHash: input.transactionHash,
    blockNumber: uintString(input.blockNumber, "blockNumber", { positive: true }),
  };
}

function verifyMissionSponsorshipPostcard(postcard, value) {
  const sponsorship = normalizeMissionSponsorship(value);
  if (postcard.type !== "receipt") {
    throw new SponsorshipValidationError("mission sponsorship must attach to a receipt postcard");
  }
  if (
    postcard.author !== sponsorship.sponsor ||
    postcard.cypherId !== sponsorship.sponsorAgentId ||
    postcard.launchId !== sponsorship.launchId
  ) {
    throw new SponsorshipValidationError("mission sponsorship does not match its announcing postcard");
  }
  return sponsorship;
}

module.exports = {
  MISSION_SPONSORSHIP_KIND,
  MISSION_SPONSORSHIP_VERSION,
  SponsorshipValidationError,
  normalizeMissionSponsorship,
  verifyMissionSponsorshipPostcard,
};
