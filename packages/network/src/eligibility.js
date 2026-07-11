const { Contract, getAddress, isAddress } = require("ethers");

const OWNER_OF_ABI = ["function ownerOf(uint256 tokenId) view returns (address)"];
const DAILY_VOICE_ABI = ["function committedDays(uint256 agentId,uint32 day) view returns (bool)"];

class CypherEligibilityError extends Error {
  constructor(message, code = "CYPHER_INELIGIBLE") {
    super(message);
    this.name = "CypherEligibilityError";
    this.code = code;
  }
}

function normalizeIdentity({ address, cypherId }) {
  if (typeof address !== "string" || !isAddress(address)) {
    throw new CypherEligibilityError("cypher address is invalid", "BAD_CYPHER_ADDRESS");
  }
  const tokenId = String(cypherId);
  if (!/^\d{1,78}$/.test(tokenId) || BigInt(tokenId) < 1n) {
    throw new CypherEligibilityError("cypher id must be a positive uint256", "BAD_CYPHER_ID");
  }
  return { address: getAddress(address).toLowerCase(), cypherId: BigInt(tokenId).toString() };
}

function normalizeVoiceDay(value) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  if (!/^\d{1,10}$/.test(text) || BigInt(text) > 4_294_967_295n) {
    throw new CypherEligibilityError("voice day must be a uint32", "BAD_VOICE_DAY");
  }
  return Number(text);
}

class DenyAllCypherVerifier {
  async verify(identity) {
    const normalized = normalizeIdentity(identity);
    return {
      ...normalized,
      voiceDay: normalizeVoiceDay(identity.voiceDay),
      eligible: false,
      reason: "verifier_not_configured",
    };
  }
}

class StaticCypherVerifier {
  constructor(entries = [], { requireDailyVoice = false } = {}) {
    this.owners = new Map();
    this.requireDailyVoice = Boolean(requireDailyVoice);
    this.activeVoiceDays = new Set();
    for (const entry of entries) this.register(entry.address, entry.cypherId);
  }

  register(address, cypherId) {
    const normalized = normalizeIdentity({ address, cypherId });
    this.owners.set(normalized.cypherId, normalized.address);
    return normalized;
  }

  transfer(cypherId, newOwner) {
    return this.register(newOwner, cypherId);
  }

  activateVoice(cypherId, voiceDay) {
    const normalizedId = normalizeIdentity({
      address: this.owners.get(BigInt(cypherId).toString()) || "0x0000000000000000000000000000000000000001",
      cypherId,
    }).cypherId;
    const normalizedDay = normalizeVoiceDay(voiceDay);
    this.activeVoiceDays.add(`${normalizedId}:${normalizedDay}`);
  }

  async verify(identity) {
    const normalized = normalizeIdentity(identity);
    const voiceDay = normalizeVoiceDay(identity.voiceDay);
    const owner = this.owners.get(normalized.cypherId) || null;
    const voiceActive =
      voiceDay === null
        ? null
        : !this.requireDailyVoice || this.activeVoiceDays.has(`${normalized.cypherId}:${voiceDay}`);
    const ownerMatches = owner === normalized.address;
    return {
      ...normalized,
      voiceDay,
      voiceActive,
      eligible: ownerMatches && (voiceDay === null || voiceActive),
      owner,
      reason: !owner
        ? "cypher_not_registered"
        : !ownerMatches
          ? "not_current_owner"
          : voiceDay !== null && !voiceActive
            ? "daily_voice_not_earned"
            : null,
    };
  }
}

class ContractCypherVerifier {
  constructor({
    provider,
    contractAddress,
    arenaAddress,
    expectedChainId = null,
    cacheTtlMs = 0,
    now = () => Date.now(),
  }) {
    if (!provider || typeof provider.getNetwork !== "function") {
      throw new TypeError("an ethers provider is required");
    }
    if (typeof contractAddress !== "string" || !isAddress(contractAddress)) {
      throw new TypeError("a valid AgentNFT contract address is required");
    }
    if (typeof arenaAddress !== "string" || !isAddress(arenaAddress)) {
      throw new TypeError("a valid Arena contract address is required");
    }
    this.provider = provider;
    this.contractAddress = getAddress(contractAddress);
    this.arenaAddress = getAddress(arenaAddress);
    this.expectedChainId = expectedChainId === null ? null : BigInt(expectedChainId);
    this.cacheTtlMs = Math.max(0, Number(cacheTtlMs) || 0);
    this.now = now;
    this.contract = new Contract(this.contractAddress, OWNER_OF_ABI, provider);
    this.arena = new Contract(this.arenaAddress, DAILY_VOICE_ABI, provider);
    this.cache = new Map();
    this.inflight = new Map();
    this.networkCheck = null;
  }

  async assertNetwork() {
    if (this.expectedChainId === null) return;
    if (!this.networkCheck) {
      this.networkCheck = this.provider.getNetwork().then((network) => {
        if (BigInt(network.chainId) !== this.expectedChainId) {
          throw new CypherEligibilityError(
            `provider chain ${network.chainId} does not match deployment chain ${this.expectedChainId}`,
            "WRONG_CHAIN"
          );
        }
        return true;
      });
    }
    return this.networkCheck;
  }

  invalidate(cypherId = null) {
    if (cypherId === null) {
      this.cache.clear();
      return;
    }
    this.cache.delete(BigInt(cypherId).toString());
  }

  async lookupOwner(cypherId) {
    await this.assertNetwork();
    try {
      return getAddress(await this.contract.ownerOf(BigInt(cypherId))).toLowerCase();
    } catch (_) {
      return null;
    }
  }

  async lookupVoice(cypherId, voiceDay) {
    await this.assertNetwork();
    try {
      return Boolean(await this.arena.committedDays(BigInt(cypherId), voiceDay));
    } catch (_) {
      return false;
    }
  }

  async verify(identity) {
    const normalized = normalizeIdentity(identity);
    const voiceDay = normalizeVoiceDay(identity.voiceDay);
    const cached = this.cache.get(normalized.cypherId);
    if (cached && cached.expiresAt >= this.now()) {
      const voiceActive = voiceDay === null ? null : await this.lookupVoice(normalized.cypherId, voiceDay);
      return this.result(normalized, cached.owner, voiceDay, voiceActive);
    }

    let lookup = this.inflight.get(normalized.cypherId);
    if (!lookup) {
      lookup = this.lookupOwner(normalized.cypherId).finally(() => {
        this.inflight.delete(normalized.cypherId);
      });
      this.inflight.set(normalized.cypherId, lookup);
    }
    const owner = await lookup;
    if (this.cacheTtlMs > 0) {
      this.cache.set(normalized.cypherId, {
        owner,
        expiresAt: this.now() + this.cacheTtlMs,
      });
    }
    const voiceActive = voiceDay === null ? null : await this.lookupVoice(normalized.cypherId, voiceDay);
    return this.result(normalized, owner, voiceDay, voiceActive);
  }

  result(normalized, owner, voiceDay = null, voiceActive = null) {
    const ownerMatches = owner === normalized.address;
    return {
      ...normalized,
      voiceDay,
      voiceActive,
      eligible: ownerMatches && (voiceDay === null || voiceActive),
      owner,
      contract: this.contractAddress,
      arena: this.arenaAddress,
      reason: !owner
        ? "cypher_not_registered"
        : !ownerMatches
          ? "not_current_owner"
          : voiceDay !== null && !voiceActive
            ? "daily_voice_not_earned"
            : null,
    };
  }
}

module.exports = {
  DAILY_VOICE_ABI,
  OWNER_OF_ABI,
  ContractCypherVerifier,
  CypherEligibilityError,
  DenyAllCypherVerifier,
  StaticCypherVerifier,
  normalizeIdentity,
  normalizeVoiceDay,
};
