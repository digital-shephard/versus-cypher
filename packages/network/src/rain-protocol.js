const crypto = require("crypto");
const {
  getAddress,
  getBytes,
  keccak256,
  toUtf8Bytes,
  verifyMessage,
} = require("ethers");

const RAIN_BATCH_KIND = "versus-verified-rain";
const RAIN_BATCH_VERSION = 1;
const RAIN_TOPIC_VERSION = 1;

function uintString(value, name) {
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new TypeError(`${name} must be an unsigned integer`);
  return BigInt(text).toString();
}

function createRainContentTopic({ chainId, arenaAddress }) {
  return `/versus/${RAIN_TOPIC_VERSION}/rain-${uintString(chainId, "chainId")}-${getAddress(arenaAddress).slice(2).toLowerCase()}/json`;
}

function rainContentTopicShard(contentTopic, shardCount = 8) {
  if (!Number.isInteger(shardCount) || shardCount < 1) throw new RangeError("shardCount must be positive");
  const parts = String(contentTopic).split("/");
  if (parts.length < 5 || parts.length > 6) throw new TypeError("invalid Waku content topic");
  const fields = parts.slice(-4);
  const digest = crypto.createHash("sha256").update(fields[0]).update(fields[1]).digest();
  return Number(digest.readBigUInt64BE(digest.length - 8) % BigInt(shardCount));
}

function unsignedRainBatch(input) {
  if (!Array.isArray(input?.events) || input.events.length < 1 || input.events.length > 50) {
    throw new RangeError("rain batch must contain 1 to 50 events");
  }
  const issuedAt = Number(input.issuedAt);
  const distributionWindowMs = Number(input.distributionWindowMs);
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new TypeError("issuedAt is invalid");
  if (!Number.isInteger(distributionWindowMs) || distributionWindowMs < 1_000 || distributionWindowMs > 86_400_000) {
    throw new RangeError("distributionWindowMs is invalid");
  }
  return {
    kind: RAIN_BATCH_KIND,
    version: RAIN_BATCH_VERSION,
    chainId: uintString(input.chainId, "chainId"),
    arena: getAddress(input.arena),
    fromBlock: uintString(input.fromBlock, "fromBlock"),
    toBlock: uintString(input.toBlock, "toBlock"),
    issuedAt,
    distributionWindowMs,
    events: input.events.map((event) => {
      const pennies = Number(event.pennies);
      const logIndex = Number(event.logIndex);
      if (!Number.isInteger(pennies) || pennies < 1 || pennies > 500) throw new RangeError("rain pennies are invalid");
      if (!Number.isInteger(logIndex) || logIndex < 0) throw new RangeError("rain logIndex is invalid");
      if (!["commit", "rain", "signal"].includes(event.type)) throw new TypeError("rain event type is invalid");
      const transactionHash = String(event.transactionHash).toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(transactionHash)) throw new TypeError("rain transaction hash is invalid");
      const eventId = String(event.eventId);
      const expectedId = `${uintString(input.chainId, "chainId")}:${getAddress(input.arena).toLowerCase()}:${transactionHash}:${logIndex}`;
      if (eventId !== expectedId) throw new Error("rain event ID does not match its proof location");
      return {
        eventId,
        type: event.type,
        transactionHash,
        logIndex,
        blockNumber: uintString(event.blockNumber, "event.blockNumber"),
        agentId: uintString(event.agentId, "event.agentId"),
        classId: uintString(event.classId, "event.classId"),
        classTotalMicros: uintString(event.classTotalMicros, "event.classTotalMicros"),
        pennies,
      };
    }),
  };
}

function rainBatchDigest(input) {
  return keccak256(toUtf8Bytes(JSON.stringify(unsignedRainBatch(input))));
}

function verifyRainBatch(envelope, { chainId, arenaAddress, trustedAttestors }) {
  const unsigned = unsignedRainBatch(envelope);
  if (unsigned.chainId !== uintString(chainId, "chainId")) throw new Error("rain batch chain mismatch");
  if (unsigned.arena !== getAddress(arenaAddress)) throw new Error("rain batch Arena mismatch");
  const expected = rainBatchDigest(unsigned);
  if (String(envelope.batchId).toLowerCase() !== expected.toLowerCase()) throw new Error("rain batch digest mismatch");
  const recovered = getAddress(verifyMessage(getBytes(expected), envelope.signature));
  if (recovered !== getAddress(envelope.attestor)) throw new Error("rain attestor signature mismatch");
  const trusted = new Set(Array.from(trustedAttestors || [], getAddress));
  if (!trusted.has(recovered)) throw new Error("rain attestor is not trusted");
  return Object.freeze({ ...unsigned, batchId: expected, attestor: recovered, signature: envelope.signature });
}

module.exports = {
  RAIN_BATCH_KIND,
  RAIN_BATCH_VERSION,
  RAIN_TOPIC_VERSION,
  createRainContentTopic,
  rainBatchDigest,
  rainContentTopicShard,
  unsignedRainBatch,
  verifyRainBatch,
};
