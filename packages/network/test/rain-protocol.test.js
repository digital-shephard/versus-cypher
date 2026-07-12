const assert = require("node:assert/strict");
const test = require("node:test");
const { Wallet, getBytes } = require("ethers");
const {
  WakuPostcardTransport,
  createRainContentTopic,
  rainBatchDigest,
  unsignedRainBatch,
  verifyRainBatch,
} = require("../src");

const ARENA = "0x1000000000000000000000000000000000000001";

async function envelope(signer) {
  const event = {
    eventId: `8453:${ARENA.toLowerCase()}:0x${"ab".repeat(32)}:0`,
    type: "rain",
    transactionHash: `0x${"ab".repeat(32)}`,
    logIndex: 0,
    blockNumber: "42",
    agentId: "7",
    classId: "3",
    classTotalMicros: "250000",
    pennies: 25,
  };
  const unsigned = unsignedRainBatch({
    kind: "versus-verified-rain",
    version: 1,
    chainId: 8453,
    arena: ARENA,
    fromBlock: 42,
    toBlock: 42,
    issuedAt: 1234,
    distributionWindowMs: 300_000,
    events: [event],
  });
  const batchId = rainBatchDigest(unsigned);
  return { ...unsigned, batchId, attestor: signer.address, signature: await signer.signMessage(getBytes(batchId)) };
}

test("verified rain is deployment scoped and signed by an allowlisted node", async () => {
  const signer = Wallet.createRandom();
  const value = await envelope(signer);
  const verified = verifyRainBatch(value, { chainId: 8453, arenaAddress: ARENA, trustedAttestors: [signer.address] });
  assert.equal(verified.events[0].pennies, 25);
  assert.equal(createRainContentTopic({ chainId: 8453, arenaAddress: ARENA }),
    "/versus/1/rain-8453-1000000000000000000000000000000000000001/json");
  assert.throws(() => verifyRainBatch(value, { chainId: 1, arenaAddress: ARENA, trustedAttestors: [signer.address] }), /chain mismatch/);
});

test("Waku rain channel rejects forgery before emitting", async () => {
  const signer = Wallet.createRandom();
  const transport = new WakuPostcardTransport({
    chainId: 8453,
    contractAddress: "0x1111111111111111111111111111111111111111",
    launchId: 1,
    arenaAddress: ARENA,
    trustedRainAttestors: [signer.address],
  });
  const accepted = [];
  const rejected = [];
  transport.on("rainBatch", (batch) => accepted.push(batch));
  transport.on("rainRejected", (error) => rejected.push(error));
  const value = await envelope(signer);
  const message = { payload: new TextEncoder().encode(JSON.stringify(value)) };
  assert.equal(transport.onRainMessage(message), true);
  assert.equal(accepted.length, 1);
  assert.equal(transport.onRainMessage({ payload: new TextEncoder().encode(JSON.stringify({ ...value, events: [{ ...value.events[0], pennies: 24 }] })) }), false);
  assert.equal(rejected.length, 1);
});
