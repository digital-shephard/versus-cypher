const { Wallet } = require("ethers");
const {
  RATE_SLOTS_PER_EPOCH,
  assemblePostcard,
  canonicalPayload,
  normalizePayload,
  rateEpochFor,
  voiceDayFor,
} = require("./protocol");
const { canonicalPeerProof, normalizePeerProofPayload } = require("./peer-proof");

class CypherIdentity {
  constructor({ signer, cypherId }) {
    if (!signer || typeof signer.signMessage !== "function" || !signer.address) {
      throw new TypeError("signer must expose address and signMessage");
    }
    this.signer = signer;
    this.address = signer.address.toLowerCase();
    this.cypherId = BigInt(cypherId).toString();
  }

  static fromPrivateKey(privateKey, cypherId) {
    return new CypherIdentity({ signer: new Wallet(privateKey), cypherId });
  }

  static createRandom(cypherId = 0) {
    return new CypherIdentity({ signer: Wallet.createRandom(), cypherId });
  }

  async signPostcard(input) {
    const createdAt = Number(input.createdAt);
    const sequence = Number(input.sequence);
    const payload = normalizePayload({
      ...input,
      author: this.address,
      cypherId: this.cypherId,
      voiceDay: input.voiceDay ?? voiceDayFor(createdAt),
      epoch: input.epoch ?? rateEpochFor(createdAt),
      slot: input.slot ?? sequence % RATE_SLOTS_PER_EPOCH,
    });
    const signature = await this.signer.signMessage(canonicalPayload(payload));
    return assemblePostcard(payload, signature);
  }

  async createPeerProof(challenge, createdAt = Math.floor(Date.now() / 1000)) {
    const payload = normalizePeerProofPayload({
      address: this.address,
      cypherId: this.cypherId,
      challenge,
      createdAt,
    });
    return {
      ...payload,
      signature: await this.signer.signMessage(canonicalPeerProof(payload)),
    };
  }
}

module.exports = { CypherIdentity };
