const assert = require("node:assert/strict");
const test = require("node:test");
const { Wallet } = require("ethers");
const {
  verifyFxEnvelope,
} = require("../src");
const {
  DEPLOYMENT_ID,
  TEST_TOKEN,
  calibrateNetworkClock,
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

test("Phase 8 proof calibrates one clock from two agreeing Base blocks", async () => {
  const timestamps = [1_800_000_005, 1_800_000_007];
  let index = 0;
  const clock = await calibrateNetworkClock({
    rpcUrls: ["https://rpc-a.invalid", "https://rpc-b.invalid"],
    localNowMs: 1_799_999_000_000,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          result: { timestamp: `0x${timestamps[index++].toString(16)}` },
        };
      },
    }),
  });
  assert.equal(clock.timestamp, 1_800_000_007);
  assert.equal(clock.offsetSeconds, 1_007);
  assert.equal(clock.sources.length, 2);
});

test("Phase 8 proof fails closed when Base clocks disagree", async () => {
  const timestamps = [1_800_000_000, 1_800_000_031];
  let index = 0;
  await assert.rejects(
    () => calibrateNetworkClock({
      rpcUrls: ["https://rpc-a.invalid", "https://rpc-b.invalid"],
      localNowMs: 1_800_000_000_000,
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            result: { timestamp: `0x${timestamps[index++].toString(16)}` },
          };
        },
      }),
    }),
    /disagree/
  );
});
