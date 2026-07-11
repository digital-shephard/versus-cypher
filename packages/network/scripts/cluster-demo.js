const {
  CypherAgentRuntime,
  CypherIdentity,
  StaticCypherVerifier,
  VersusNode,
} = require("../src");

const LAUNCH_ID = "3030";

async function waitForEveryNode(nodes, postcardId, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (nodes.every((node) => node.store.has(postcardId))) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`network did not converge on ${postcardId}`);
}

async function act(runtime, nodes) {
  const result = await runtime.runTick({ force: true });
  if (result.status !== "published") throw new Error(`agent action failed with ${result.status}`);
  await waitForEveryNode(nodes, result.postcard.id);
  return result.postcard;
}

async function main() {
  const registry = new StaticCypherVerifier();
  const identities = [601, 602, 603, 604].map((id) => CypherIdentity.createRandom(id));
  identities.forEach((identity) => registry.register(identity.address, identity.cypherId));
  const nodes = identities.map(
    (identity) => new VersusNode({ identity, eligibilityVerifier: registry })
  );
  const [proposer, mirrorA, mirrorB, independent] = nodes;
  try {
    const hub = await proposer.listen({ port: 0 });
    await Promise.all(nodes.slice(1).map((node) => node.connect(hub.url)));
    let proposalNumber = 0;
    const proposalRuntime = new CypherAgentRuntime({
      node: proposer,
      launchIdResolver: () => LAUNCH_ID,
      brain: async () => {
        proposalNumber += 1;
        return {
          type: "proposal",
          body: `build public ritual number ${proposalNumber}`,
        };
      },
    });
    const mirrorRuntime = (node) =>
      new CypherAgentRuntime({
        node,
        launchIdResolver: () => LAUNCH_ID,
        brain: async (context) => {
          const proposal = [...context.postcards].reverse().find((postcard) => postcard.type === "proposal");
          return {
            type: "endorsement",
            body: `endorse public ritual number ${proposal.body.split(" ").at(-1)}`,
            replyTo: proposal.id,
          };
        },
      });
    const mirrorARuntime = mirrorRuntime(mirrorA);
    const mirrorBRuntime = mirrorRuntime(mirrorB);
    let currentProposal = null;
    for (let index = 0; index < 4; index += 1) {
      currentProposal = await act(proposalRuntime, nodes);
      await act(mirrorARuntime, nodes);
      await act(mirrorBRuntime, nodes);
    }

    const before = proposer
      .coalitionView(LAUNCH_ID)
      .proposals.find((proposal) => proposal.id === currentProposal.id);
    const independentRuntime = new CypherAgentRuntime({
      node: independent,
      launchIdResolver: () => LAUNCH_ID,
      brain: async () => ({
        type: "endorsement",
        body: "endorse public ritual number four",
        replyTo: currentProposal.id,
      }),
    });
    await act(independentRuntime, nodes);
    const after = proposer
      .coalitionView(LAUNCH_ID)
      .proposals.find((proposal) => proposal.id === currentProposal.id);
    const mirroredCluster = proposer
      .clusterView()
      .find((cluster) => cluster.members.includes(mirrorA.identity.address));

    console.log(`mirrored addresses ${mirroredCluster.size}`);
    console.log(`shared targets ${mirroredCluster.evidence[0].sharedTargets}`);
    console.log(`before independent support ${before.status}`);
    console.log(`before independent clusters ${before.independentSupportClusters}`);
    console.log(`after independent support ${after.status}`);
    console.log(`after independent clusters ${after.independentSupportClusters}`);
    console.log("correlation discounts repetition without muting either cypher");
  } finally {
    await Promise.all(nodes.map((node) => node.close()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
