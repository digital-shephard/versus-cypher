const assert = require("node:assert/strict");
const test = require("node:test");
const { Wallet } = require("ethers");
const { StaticCypherVerifier } = require("../src");

test("strict test registries require a daily voice activation for postcards", async () => {
  const wallet = Wallet.createRandom();
  const verifier = new StaticCypherVerifier([], { requireDailyVoice: true });
  verifier.register(wallet.address, 41);

  const silent = await verifier.verify({ address: wallet.address, cypherId: 41, voiceDay: 22_222 });
  assert.equal(silent.eligible, false);
  assert.equal(silent.reason, "daily_voice_not_earned");

  verifier.activateVoice(41, 22_222);
  const active = await verifier.verify({ address: wallet.address, cypherId: 41, voiceDay: 22_222 });
  assert.equal(active.eligible, true);
  assert.equal(active.voiceActive, true);
});
