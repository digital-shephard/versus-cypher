const {
  CypherAgentRuntime,
  CypherIdentity,
  StaticCypherVerifier,
  VersusNode,
} = require("../src");

const LAUNCH_ID = "2042";

function findByBody(context, body) {
  return context.postcards.find((postcard) => postcard.body === body);
}

async function waitForEveryNode(nodes, postcardId, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (nodes.every((node) => node.store.has(postcardId))) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`network did not converge on postcard ${postcardId}`);
}

async function waitForEveryArtifact(nodes, reference, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (nodes.every((node) => node.artifactStore.has(reference))) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`network did not recover artifact ${reference}`);
}

function makeRuntime(node, brain) {
  return new CypherAgentRuntime({
    node,
    brain,
    launchIdResolver: () => LAUNCH_ID,
  });
}

async function act(runtime, nodes) {
  const result = await runtime.runTick({ force: true });
  if (result.status !== "published") throw new Error(`agent action failed with ${result.status}`);
  await waitForEveryNode(nodes, result.postcard.id);
  if (String(result.postcard.artifact).startsWith("versus:sha256:")) {
    await waitForEveryArtifact(nodes, result.postcard.artifact);
  }
  return result.postcard;
}

async function main() {
  const registry = new StaticCypherVerifier();
  const identities = [201, 202, 203, 204].map((id) => CypherIdentity.createRandom(id));
  for (const identity of identities) registry.register(identity.address, identity.cypherId);
  const nodes = identities.map(
    (identity) => new VersusNode({ identity, eligibilityVerifier: registry })
  );
  const [aurora, harbor, critic, builder] = nodes;

  try {
    const hub = await aurora.listen({ port: 0 });
    await Promise.all([
      harbor.connect(hub.url),
      critic.connect(hub.url),
      builder.connect(hub.url),
    ]);

    const lighthouseBody = "build a midnight lighthouse mystery for the daily launch";
    const gardenBody = "build a sunrise garden ritual for the daily launch";
    const missionBody = "publish a daily garden clue that humans can solve together";
    let auroraPhase = 0;
    let harborPhase = 0;
    let criticPhase = 0;
    let builderPhase = 0;

    const auroraAgent = makeRuntime(aurora, async (context) => {
      if (auroraPhase++ === 0) return { type: "proposal", body: lighthouseBody };
      const garden = findByBody(context, gardenBody);
      return {
        type: "endorsement",
        body: "endorse the garden ritual direction",
        replyTo: garden.id,
      };
    });
    const harborAgent = makeRuntime(harbor, async (context) => {
      if (harborPhase++ === 0) return { type: "proposal", body: gardenBody };
      const garden = findByBody(context, gardenBody);
      return {
        type: "mission",
        body: missionBody,
        replyTo: garden.id,
        manifest: {
          title: "The Garden Signal",
          objective: "Give humans one small shared ritual around the daily launch.",
          steps: ["Publish one garden clue each day."],
          successConditions: ["Ten humans solve one clue."],
          evidenceRequirements: ["Preserve the clue and answer hashes."],
          budgetMicros: "0",
        },
      };
    });
    const criticAgent = makeRuntime(critic, async (context) => {
      const phase = criticPhase++;
      if (phase === 0) {
        const lighthouse = findByBody(context, lighthouseBody);
        return {
          type: "critique",
          body: "the lighthouse lacks a repeatable human ritual",
          replyTo: lighthouse.id,
        };
      }
      const mission = findByBody(context, missionBody);
      if (phase === 1) {
        return {
          type: "endorsement",
          body: "endorse the daily garden clue mission",
          replyTo: mission.id,
        };
      }
      return {
        type: "outcome",
        body: "twelve humans solved the first garden clue",
        replyTo: mission.id,
        manifest: {
          status: "success",
          summary: "Twelve humans submitted the correct answer before the deadline.",
          evidenceReferences: [mission.artifact],
        },
      };
    });
    const builderAgent = makeRuntime(builder, async (context) => {
      if (builderPhase++ === 0) {
        const garden = findByBody(context, gardenBody);
        return {
          type: "endorsement",
          body: "endorse the garden ritual direction",
          replyTo: garden.id,
        };
      }
      const mission = findByBody(context, missionBody);
      return {
        type: "endorsement",
        body: "endorse the daily garden clue mission",
        replyTo: mission.id,
      };
    });

    console.log("four cypher agent lab online");
    await act(auroraAgent, nodes);
    await act(harborAgent, nodes);
    await act(criticAgent, nodes);
    await act(builderAgent, nodes);
    await act(auroraAgent, nodes);
    await act(harborAgent, nodes);
    await act(criticAgent, nodes);
    await act(builderAgent, nodes);
    const outcome = await act(criticAgent, nodes);

    harbor.assessOutcome({ outcomeId: outcome.id, verdict: "success", confidence: 100 });
    builder.assessOutcome({ outcomeId: outcome.id, verdict: "unsubstantiated", confidence: 100 });

    builder.trust.setBlocked(aurora.identity.address, true);
    builder.trust.setBlocked(critic.identity.address, true);
    const sharedView = harbor.coalitionView(LAUNCH_ID);
    const skepticalView = builder.coalitionView(LAUNCH_ID);
    const sharedGarden = sharedView.proposals.find((proposal) => proposal.body === gardenBody);
    const skepticalGarden = skepticalView.proposals.find((proposal) => proposal.body === gardenBody);

    console.log(`postcards converged ${nodes.every((node) => node.store.size === 9)}`);
    console.log(`artifacts converged ${nodes.every((node) => node.artifactStore.size === 2)}`);
    console.log(`harbor garden ${sharedGarden.status}`);
    console.log(`harbor mission ${sharedGarden.missions[0].status}`);
    console.log(`builder garden ${skepticalGarden.status}`);
    console.log(`builder mission ${skepticalGarden.missions[0].status}`);
    console.log(`harbor execution trust ${harbor.trust.score(harbor.identity.address, "execution")}`);
    console.log(`builder execution trust ${builder.trust.score(harbor.identity.address, "execution")}`);
    console.log("same signed graph different local conclusions");
  } finally {
    await Promise.all(nodes.map((node) => node.close()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
