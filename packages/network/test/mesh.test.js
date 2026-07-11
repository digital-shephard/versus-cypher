const assert = require("node:assert/strict");
const test = require("node:test");
const { CypherIdentity, StaticCypherVerifier, TrustGraph, VersusNode } = require("../src");

function registeredNode(registry, cypherId, options = {}) {
  const identity = options.identity || CypherIdentity.createRandom(cypherId);
  registry.register(identity.address, cypherId);
  return new VersusNode({ ...options, identity, eligibilityVerifier: registry });
}

function waitFor(node, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      node.off("postcard", onPostcard);
      reject(new Error("timed out waiting for postcard"));
    }, timeoutMs);
    const onPostcard = (postcard) => {
      if (!predicate(postcard)) return;
      clearTimeout(timer);
      node.off("postcard", onPostcard);
      resolve(postcard);
    };
    node.on("postcard", onPostcard);
  });
}

test("a signed postcard crosses a three peer mesh once", async (t) => {
  const registry = new StaticCypherVerifier();
  const alice = registeredNode(registry, 1);
  const bob = registeredNode(registry, 2);
  const cyra = registeredNode(registry, 3);
  t.after(async () => Promise.all([alice.close(), bob.close(), cyra.close()]));

  const aliceAddress = await alice.listen({ port: 0 });
  const bobAddress = await bob.listen({ port: 0 });
  await bob.connect(aliceAddress.url);
  await cyra.connect(bobAddress.url);

  const received = waitFor(cyra, (postcard) => postcard.type === "proposal");
  const sent = await alice.publish({
    type: "proposal",
    launchId: "77",
    body: "turn the daily launch into a lighthouse mystery",
  });
  const relayed = await received;

  assert.equal(relayed.id, sent.id);
  assert.equal(cyra.store.size, 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alice.store.size, 1);
  assert.equal(bob.store.size, 1);
  assert.equal(cyra.store.size, 1);
});

test("a local block stops propagation through that trust neighborhood", async (t) => {
  const aliceIdentity = CypherIdentity.createRandom(1);
  const registry = new StaticCypherVerifier();
  const bobTrust = new TrustGraph();
  bobTrust.setBlocked(aliceIdentity.address, true);

  const alice = registeredNode(registry, 1, { identity: aliceIdentity });
  const bob = registeredNode(registry, 2, { trust: bobTrust });
  const cyra = registeredNode(registry, 3);
  t.after(async () => Promise.all([alice.close(), bob.close(), cyra.close()]));

  const aliceAddress = await alice.listen({ port: 0 });
  const bobAddress = await bob.listen({ port: 0 });
  await bob.connect(aliceAddress.url);
  await cyra.connect(bobAddress.url);

  let reachedCyra = false;
  cyra.on("postcard", () => {
    reachedCyra = true;
  });
  await alice.publish({
    type: "observation",
    launchId: "77",
    body: "this neighborhood should reject the message",
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(bob.store.size, 0);
  assert.equal(cyra.store.size, 0);
  assert.equal(reachedCyra, false);
});

test("a node rejects author equivocation at one sequence", async (t) => {
  const identity = CypherIdentity.createRandom(8);
  const registry = new StaticCypherVerifier();
  registry.register(identity.address, 8);
  const receiver = registeredNode(registry, 9);
  t.after(async () => receiver.close());
  const createdAt = Math.floor(Date.now() / 1000);
  const common = {
    type: "proposal",
    launchId: "88",
    sequence: 0,
    createdAt,
    expiresAt: createdAt + 3600,
  };
  const first = await identity.signPostcard({ ...common, body: "choose the lighthouse theme" });
  const conflicting = await identity.signPostcard({ ...common, body: "choose the thunder theme" });

  await receiver.accept(first);
  await assert.rejects(() => receiver.accept(conflicting), {
    code: "SEQUENCE_EQUIVOCATION",
  });
});

test("an authenticated late joiner synchronizes signed history", async (t) => {
  const registry = new StaticCypherVerifier();
  const alice = registeredNode(registry, 31);
  const bob = registeredNode(registry, 32);
  t.after(async () => Promise.all([alice.close(), bob.close()]));

  const aliceAddress = await alice.listen({ port: 0 });
  const oldPostcard = await alice.publish({
    type: "proposal",
    launchId: "901",
    body: "name the launch before choosing its first mission",
  });
  const synchronized = waitFor(bob, (postcard) => postcard.id === oldPostcard.id);
  const peer = await bob.connect(aliceAddress.url);
  await synchronized;

  assert.equal(peer.address, alice.identity.address);
  assert.equal(peer.cypherId, "31");
  assert.equal(bob.store.get(oldPostcard.id).body, oldPostcard.body);
  assert.equal(bob.peerCount, 1);
  assert.equal(alice.peerCount, 1);
});

test("unregistered and transferred away Cyphers cannot enter local history", async (t) => {
  const registry = new StaticCypherVerifier();
  const registered = CypherIdentity.createRandom(41);
  const unregistered = CypherIdentity.createRandom(42);
  const receiver = registeredNode(registry, 43);
  registry.register(registered.address, 41);
  t.after(async () => receiver.close());
  const createdAt = Math.floor(Date.now() / 1000);

  const unknownPostcard = await unregistered.signPostcard({
    type: "proposal",
    launchId: "902",
    sequence: 0,
    createdAt,
    expiresAt: createdAt + 3600,
    body: "this cypher does not exist in the registry",
  });
  await assert.rejects(() => receiver.accept(unknownPostcard), { code: "INELIGIBLE_CYPHER" });

  const first = await registered.signPostcard({
    type: "proposal",
    launchId: "902",
    sequence: 0,
    createdAt,
    expiresAt: createdAt + 3600,
    body: "this cypher currently owns its identity",
  });
  await receiver.accept(first);
  registry.transfer(41, CypherIdentity.createRandom(99).address);
  const afterTransfer = await registered.signPostcard({
    type: "observation",
    launchId: "902",
    sequence: 1,
    createdAt: createdAt + 1,
    expiresAt: createdAt + 3601,
    body: "this old owner should no longer be heard",
  });
  await assert.rejects(() => receiver.accept(afterTransfer), { code: "INELIGIBLE_CYPHER" });
  assert.equal(receiver.store.size, 1);
});

test("nodes fail closed when no Cypher registry verifier is configured", async (t) => {
  const node = new VersusNode({ identity: CypherIdentity.createRandom(50) });
  t.after(async () => node.close());
  await assert.rejects(
    () =>
      node.publish({
        type: "proposal",
        launchId: "903",
        body: "this message must fail without the base registry",
      }),
    { code: "INELIGIBLE_CYPHER" }
  );
  assert.equal(node.store.size, 0);
  await assert.rejects(() => node.listen({ port: 0 }), { code: "INELIGIBLE_LOCAL_CYPHER" });
});

test("authenticated peers recover and verify a referenced mission manifest", async (t) => {
  const registry = new StaticCypherVerifier();
  const alice = registeredNode(registry, 61);
  const bob = registeredNode(registry, 62);
  t.after(async () => Promise.all([alice.close(), bob.close()]));

  const aliceAddress = await alice.listen({ port: 0 });
  await bob.connect(aliceAddress.url);
  const proposalReachedBob = waitFor(bob, (postcard) => postcard.type === "proposal");
  const proposal = await alice.publish({
    type: "proposal",
    launchId: "904",
    body: "build a public garden ritual for the daily launch",
  });
  await proposalReachedBob;

  const missionReachedBob = waitFor(bob, (postcard) => postcard.type === "mission");
  const artifactReachedBob = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for mission artifact")), 3000);
    bob.once("artifact", (result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
  const mission = await alice.publishMission({
    launchId: "904",
    body: "publish one garden clue each day",
    replyTo: proposal.id,
    manifest: {
      title: "The Garden Signal",
      objective: "Give the launch a repeatable public ritual humans can enjoy together.",
      steps: ["Publish one clue each day.", "Archive each answer after twenty four hours."],
      successConditions: ["At least ten humans solve one clue."],
      evidenceRequirements: ["Preserve the clue and answer hashes."],
      budgetMicros: "1000000",
    },
  });
  await missionReachedBob;
  const artifact = await artifactReachedBob;

  assert.equal(artifact.reference, mission.artifact);
  assert.equal(bob.artifactStore.has(mission.artifact), true);
  const manifest = bob.artifactStore.get(mission.artifact);
  assert.equal(manifest.author, alice.identity.address);
  assert.equal(manifest.launchId, "904");
  assert.equal(manifest.budgetMicros, "1000000");
  assert.equal(bob.store.get(mission.id).artifact, mission.artifact);

  const outcomeReachedAlice = waitFor(alice, (postcard) => postcard.type === "outcome");
  const outcomeArtifactReachedAlice = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for outcome artifact")), 3000);
    alice.once("artifact", (result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
  const outcome = await bob.publishOutcome({
    launchId: "904",
    body: "twelve humans solved the first garden clue",
    missionId: mission.id,
    manifest: {
      status: "success",
      summary: "Twelve humans submitted the correct answer before the deadline.",
      evidenceReferences: [mission.artifact],
    },
  });
  await outcomeReachedAlice;
  await outcomeArtifactReachedAlice;
  const assessment = alice.assessOutcome({
    outcomeId: outcome.id,
    verdict: "success",
    confidence: 100,
  });
  assert.equal(assessment.claimedStatus, "success");
  assert.equal(alice.trust.score(alice.identity.address, "execution"), 4);
});
