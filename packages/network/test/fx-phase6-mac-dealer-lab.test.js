const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const {
  DEALER_SETTLEMENT_ADDRESS,
  DEPLOYMENT_ID,
  TEST_TOKEN,
  delayFromEnvironment,
  labEnvironment,
} = require("../scripts/fx-phase6-mac-dealer-lab");

test("Mac dealer lab launcher is delayed, ephemeral, and testnet only", () => {
  assert.equal(delayFromEnvironment({}), 30_000);
  assert.throws(
    () => delayFromEnvironment({ FX_PHASE6_ARM_DELAY_MS: "300001" }),
    /between 0 and 300000/
  );

  const environment = labEnvironment({
    environment: {
      FX_PHASE6_SETTLE: "1",
      FX_PHASE6_PRIVATE_KEY: "must-not-survive",
      FX_PHASE6_COORDINATION_PASSWORD: "fixed-test-password",
    },
    homeDirectory: "/Users/tester",
    timestamp: 1234,
  });
  assert.equal(environment.FX_PHASE6_ROLE, "dealer");
  assert.equal(environment.FX_PHASE6_DEPLOYMENT_ID, DEPLOYMENT_ID);
  assert.equal(environment.FX_PHASE6_INPUT_CHAIN_ID, "84532");
  assert.equal(environment.FX_PHASE6_INPUT_TOKEN, TEST_TOKEN);
  assert.equal(environment.FX_PHASE6_SOURCE_CLAIM_ADDRESS, DEALER_SETTLEMENT_ADDRESS);
  assert.equal(
    environment.FX_PHASE6_DESTINATION_REFUND_ADDRESS,
    DEALER_SETTLEMENT_ADDRESS
  );
  assert.equal(
    environment.FX_PHASE6_DATA_DIR,
    path.join(
      "/Users/tester",
      "Library",
      "Application Support",
      "Versus Cypher",
      "fx-phase6-dealer-1234"
    )
  );
  assert.equal(environment.FX_PHASE6_SETTLE, undefined);
  assert.equal(environment.FX_PHASE6_PRIVATE_KEY, undefined);
});
