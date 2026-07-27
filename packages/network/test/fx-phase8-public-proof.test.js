const assert = require("node:assert/strict");
const test = require("node:test");
const { Wallet } = require("ethers");
const {
  verifyFxEnvelope,
} = require("../src");
const {
  DEPLOYMENT_ID,
  TEST_TOKEN,
  proofConfiguration,
  signedRfq,
} = require("../scripts/fx-phase8-public-broker-proof");

test("Phase 8 physical proof keeps the requester outside Waku and settlement off", async () => {
  const configuration = proofConfiguration({
    FX_PHASE8_DATA_DIR: "C:\\tmp\\phase8-proof",
    FX_PHASE8_OBSERVATION_WINDOW_MS: "15000",
    FX_PHASE8_REQUEST_TIMEOUT_MS: "60000",
  });
  assert.equal(configuration.deploymentId, DEPLOYMENT_ID);
  assert.equal(configuration.brokerObservationWindowMs, 15_000);
  assert.equal(configuration.requestTimeoutMs, 60_000);
  assert.equal(configuration.bootstrapPeers.length, 2);

  const now = 1_800_000_000;
  const requester = Wallet.createRandom();
  const rfq = await signedRfq(requester, {
    tradeId: `0x${"aa".repeat(32)}`,
    now,
  });
  const verified = verifyFxEnvelope(rfq, {
    now,
    clockSkewSeconds: 0,
  });
  assert.equal(verified.sender, requester.address.toLowerCase());
  assert.equal(verified.payload.inputOptions[0].token, TEST_TOKEN);
  assert.equal(verified.payload.outputToken, TEST_TOKEN);
  assert.equal(verified.payload.settlementDeadline, now + 7_200);
});
