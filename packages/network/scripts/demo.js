const { CypherIdentity, StaticCypherVerifier, VersusNode } = require("../src");

function waitFor(node, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      node.off("postcard", onPostcard);
      reject(new Error("network demo timed out"));
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

async function main() {
  const registry = new StaticCypherVerifier();
  const aliceIdentity = CypherIdentity.createRandom(11);
  const bobIdentity = CypherIdentity.createRandom(12);
  const cyraIdentity = CypherIdentity.createRandom(13);
  registry.register(aliceIdentity.address, 11);
  registry.register(bobIdentity.address, 12);
  registry.register(cyraIdentity.address, 13);
  const alice = new VersusNode({ identity: aliceIdentity, eligibilityVerifier: registry });
  const bob = new VersusNode({ identity: bobIdentity, eligibilityVerifier: registry });
  const cyra = new VersusNode({ identity: cyraIdentity, eligibilityVerifier: registry });

  try {
    const aliceAddress = await alice.listen({ port: 0 });
    await bob.connect(aliceAddress.url);

    console.log("versus mesh online");
    console.log(`alice ${aliceAddress.url}`);
    console.log("bob   authenticated with alice");
    console.log("cyra  offline\n");

    const bobSawProposal = waitFor(bob, (postcard) => postcard.type === "proposal");
    const proposal = await alice.publish({
      type: "proposal",
      launchId: "2042",
      body: "build a lighthouse mystery around the daily launch",
    });
    await bobSawProposal;
    const aliceSawBobSupport = waitFor(
      alice,
      (postcard) => postcard.type === "endorsement" && postcard.replyTo === proposal.id
    );
    await bob.publish({
      type: "endorsement",
      launchId: "2042",
      body: "endorse the lighthouse direction",
      replyTo: proposal.id,
    });
    await aliceSawBobSupport;
    console.log("alice and bob created two signed graph entries");

    const cyraAddress = await cyra.listen({ port: 0 });
    const cyraSyncedProposal = waitFor(cyra, (postcard) => postcard.id === proposal.id);
    await cyra.connect(aliceAddress.url);
    await cyraSyncedProposal;
    console.log(`cyra joined late at ${cyraAddress.url}`);
    console.log(`cyra synchronized ${cyra.store.size} earlier postcards\n`);

    const aliceSawCyraSupport = waitFor(
      alice,
      (postcard) => postcard.author === cyra.identity.address && postcard.type === "endorsement"
    );
    await cyra.publish({
      type: "endorsement",
      launchId: "2042",
      body: "endorse the lighthouse direction",
      replyTo: proposal.id,
    });
    await aliceSawCyraSupport;

    const proposalView = alice.coalitionView("2042").proposals[0];
    console.log(`proposal status ${proposalView.status}`);
    console.log(`supporters ${proposalView.supporters.length} dissenters ${proposalView.detractors.length}`);

    const missionReachedBob = waitFor(bob, (postcard) => postcard.type === "mission");
    const missionReachedCyra = waitFor(cyra, (postcard) => postcard.type === "mission");
    const mission = await alice.publish({
      type: "mission",
      launchId: "2042",
      body: "publish a puzzle that reveals the launch name",
      replyTo: proposal.id,
      artifact: "cid:lighthouse-mission",
      amountMicros: "10000000",
    });
    await Promise.all([missionReachedBob, missionReachedCyra]);

    const bobSupportReachedAlice = waitFor(
      alice,
      (postcard) => postcard.author === bob.identity.address && postcard.replyTo === mission.id
    );
    const cyraSupportReachedAlice = waitFor(
      alice,
      (postcard) => postcard.author === cyra.identity.address && postcard.replyTo === mission.id
    );
    const bobSawCyraSupport = waitFor(
      bob,
      (postcard) => postcard.author === cyra.identity.address && postcard.replyTo === mission.id
    );
    const cyraSawBobSupport = waitFor(
      cyra,
      (postcard) => postcard.author === bob.identity.address && postcard.replyTo === mission.id
    );
    await bob.publish({
      type: "endorsement",
      launchId: "2042",
      body: "endorse the puzzle mission",
      replyTo: mission.id,
    });
    await cyra.publish({
      type: "endorsement",
      launchId: "2042",
      body: "endorse the puzzle mission",
      replyTo: mission.id,
    });
    await Promise.all([
      bobSupportReachedAlice,
      cyraSupportReachedAlice,
      bobSawCyraSupport,
      cyraSawBobSupport,
    ]);

    const finalView = alice.coalitionView("2042").proposals[0];
    console.log(`mission status ${finalView.missions[0].status}`);
    console.log(`mission artifact ${finalView.missions[0].artifact}\n`);
    console.log(`alice history ${alice.store.size}`);
    console.log(`bob history   ${bob.store.size}`);
    console.log(`cyra history  ${cyra.store.size}`);
  } finally {
    await Promise.all([alice.close(), bob.close(), cyra.close()]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
