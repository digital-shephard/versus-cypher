const { getAddress, isAddress, verifyMessage } = require("ethers");

const PEER_PROOF_PROTOCOL = "versus-peer-proof";
const PEER_PROOF_VERSION = 1;
const CHALLENGE_PATTERN = /^0x[0-9a-f]{32}$/;

class PeerProofError extends Error {
  constructor(message, code = "INVALID_PEER_PROOF") {
    super(message);
    this.name = "PeerProofError";
    this.code = code;
  }
}

function normalizePeerProofPayload(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PeerProofError("peer proof must be an object");
  }
  if (typeof input.address !== "string" || !isAddress(input.address)) {
    throw new PeerProofError("peer proof address is invalid");
  }
  const cypherId = String(input.cypherId);
  if (!/^\d{1,78}$/.test(cypherId)) throw new PeerProofError("peer proof cypher id is invalid");
  if (typeof input.challenge !== "string" || !CHALLENGE_PATTERN.test(input.challenge)) {
    throw new PeerProofError("peer proof challenge is invalid");
  }
  const createdAt = Number(input.createdAt);
  if (!Number.isSafeInteger(createdAt) || createdAt < 1) {
    throw new PeerProofError("peer proof timestamp is invalid");
  }
  return {
    protocol: PEER_PROOF_PROTOCOL,
    version: PEER_PROOF_VERSION,
    address: getAddress(input.address).toLowerCase(),
    cypherId: BigInt(cypherId).toString(),
    challenge: input.challenge,
    createdAt,
  };
}

function canonicalPeerProof(input) {
  return JSON.stringify(normalizePeerProofPayload(input));
}

function verifyPeerProof(proof, { challenge, now = Math.floor(Date.now() / 1000), clockSkew = 60 } = {}) {
  const payload = normalizePeerProofPayload(proof);
  if (payload.challenge !== challenge) {
    throw new PeerProofError("peer proof does not answer this connection challenge", "BAD_CHALLENGE");
  }
  if (Math.abs(now - payload.createdAt) > clockSkew) {
    throw new PeerProofError("peer proof timestamp is outside the handshake window", "STALE_PROOF");
  }
  if (typeof proof.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(proof.signature)) {
    throw new PeerProofError("peer proof signature is invalid", "BAD_SIGNATURE");
  }
  let recovered;
  try {
    recovered = verifyMessage(canonicalPeerProof(payload), proof.signature).toLowerCase();
  } catch (_) {
    throw new PeerProofError("peer proof signature is invalid", "BAD_SIGNATURE");
  }
  if (recovered !== payload.address) {
    throw new PeerProofError("peer proof signer does not match its address", "BAD_SIGNATURE");
  }
  return { ...payload, signature: proof.signature };
}

module.exports = {
  CHALLENGE_PATTERN,
  PEER_PROOF_PROTOCOL,
  PEER_PROOF_VERSION,
  PeerProofError,
  canonicalPeerProof,
  normalizePeerProofPayload,
  verifyPeerProof,
};
