const assert = require("node:assert/strict");
const test = require("node:test");
const { CoalitionEngine, CypherIdentity, PostcardStore, TrustGraph } = require("../src");

async function add(store, identity, input, sequence) {
  const createdAt = 2_000_000_000 + sequence;
  const postcard = await identity.signPostcard({
    launchId: "700",
    sequence,
    createdAt,
    expiresAt: createdAt + 3600,
    ...input,
  });
  store.add(postcard);
  return postcard;
}

test("coalition readiness is local and a mission requires its own support", async () => {
  const store = new PostcardStore();
  const proposer = CypherIdentity.createRandom(1);
  const supporterA = CypherIdentity.createRandom(2);
  const supporterB = CypherIdentity.createRandom(3);
  const critic = CypherIdentity.createRandom(4);
  const operator = CypherIdentity.createRandom(5);

  const proposal = await add(
    store,
    proposer,
    { type: "proposal", body: "build a midnight lighthouse mystery" },
    0
  );
  await add(
    store,
    supporterA,
    { type: "endorsement", body: "endorse the lighthouse direction", replyTo: proposal.id },
    0
  );
  await add(
    store,
    supporterB,
    { type: "endorsement", body: "endorse the lighthouse direction", replyTo: proposal.id },
    0
  );
  await add(
    store,
    critic,
    { type: "critique", body: "the theme needs a concrete human mission", replyTo: proposal.id },
    0
  );
  await add(
    store,
    proposer,
    { type: "endorsement", body: "endorse my own proposal", replyTo: proposal.id },
    1
  );

  const mission = await add(
    store,
    operator,
    {
      type: "mission",
      body: "publish a puzzle that reveals the launch name",
      replyTo: proposal.id,
      artifact: "cid:lighthouse-mission",
      amountMicros: "10000000",
    },
    0
  );
  await add(
    store,
    supporterA,
    { type: "endorsement", body: "endorse the puzzle mission", replyTo: mission.id },
    1
  );
  await add(
    store,
    supporterB,
    { type: "endorsement", body: "endorse the puzzle mission", replyTo: mission.id },
    1
  );

  const permissiveTrust = new TrustGraph();
  permissiveTrust.setBlocked(critic.address, true);
  const permissive = new CoalitionEngine({ store, trust: permissiveTrust }).view("700");
  assert.equal(permissive.proposals[0].status, "ready");
  assert.equal(permissive.currentReferralDrive.id, proposal.id);
  assert.equal(permissive.currentReferralDrive.createdAt, proposal.createdAt);
  assert.equal(permissive.proposals[0].supporters.length, 2);
  assert.equal(permissive.proposals[0].missions[0].status, "ready");
  assert.equal(permissive.proposals[0].missions[0].declaredAmountMicros, "10000000");

  const skepticalTrust = new TrustGraph();
  skepticalTrust.setScore(critic.address, "criticism", 100);
  skepticalTrust.setScore(critic.address, "integrity", 100);
  skepticalTrust.setBlocked(supporterA.address, true);
  const skeptical = new CoalitionEngine({ store, trust: skepticalTrust }).view("700");
  assert.equal(skeptical.proposals[0].status, "contested");
  assert.equal(skeptical.proposals[0].supporters.length, 1);
  assert.equal(skeptical.proposals[0].detractors.length, 1);
  assert.equal(skeptical.currentReferralDrive, null);
});

test("the newest ready proposal is the one owner facing referral drive", async () => {
  const store = new PostcardStore();
  const proposer = CypherIdentity.createRandom(11);
  const supporterA = CypherIdentity.createRandom(12);
  const supporterB = CypherIdentity.createRandom(13);
  const trust = new TrustGraph();

  const first = await add(store, proposer, {
    type: "proposal",
    body: "open the first referral drive",
    amountMicros: "10000000",
  }, 0);
  await add(store, supporterA, { type: "endorsement", body: "support the first drive", replyTo: first.id }, 0);
  await add(store, supporterB, { type: "endorsement", body: "back the first drive", replyTo: first.id }, 0);

  const second = await add(store, proposer, {
    type: "proposal",
    body: "open the replacement referral drive",
    amountMicros: "25000000",
  }, 1);
  await add(store, supporterA, { type: "endorsement", body: "support the replacement drive", replyTo: second.id }, 1);
  await add(store, supporterB, { type: "endorsement", body: "back the replacement drive", replyTo: second.id }, 1);

  const view = new CoalitionEngine({ store, trust }).view("700");
  assert.equal(view.proposalCount, 2);
  assert.equal(view.currentReferralDrive.id, second.id);
  assert.equal(view.currentReferralDrive.fundingGoalMicros, "25000000");
});
