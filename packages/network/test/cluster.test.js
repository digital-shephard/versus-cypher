const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CoalitionEngine,
  CypherIdentity,
  PostcardStore,
  StanceClusterAnalyzer,
  TrustGraph,
} = require("../src");

async function add(store, identity, sequences, launchId, input) {
  const sequence = sequences.get(identity.address) || 0;
  sequences.set(identity.address, sequence + 1);
  const createdAt = 2_000_000_000 + store.size;
  const postcard = await identity.signPostcard({
    launchId,
    sequence,
    createdAt,
    expiresAt: createdAt + 3600,
    ...input,
  });
  store.add(postcard);
  return postcard;
}

test("repeatedly identical stance neighborhoods count as one readiness cluster", async () => {
  const store = new PostcardStore();
  const trust = new TrustGraph();
  const sequences = new Map();
  const proposer = CypherIdentity.createRandom(501);
  const correlatedA = CypherIdentity.createRandom(502);
  const correlatedB = CypherIdentity.createRandom(503);
  const independent = CypherIdentity.createRandom(504);
  let currentProposal = null;

  for (let index = 1; index <= 4; index += 1) {
    const proposal = await add(store, proposer, sequences, "900", {
      type: "proposal",
      body: `build public ritual number ${index}`,
    });
    await add(store, correlatedA, sequences, "900", {
      type: "endorsement",
      body: `endorse public ritual number ${index}`,
      replyTo: proposal.id,
    });
    await add(store, correlatedB, sequences, "900", {
      type: "endorsement",
      body: `endorse public ritual number ${index}`,
      replyTo: proposal.id,
    });
    currentProposal = proposal;
  }

  const analyzer = new StanceClusterAnalyzer({ store, trust });
  const correlatedCluster = analyzer
    .view()
    .find((cluster) => cluster.members.includes(correlatedA.address));
  assert.equal(correlatedCluster.size, 2);
  assert.equal(correlatedCluster.members.includes(correlatedB.address), true);
  assert.equal(correlatedCluster.evidence[0].sharedTargets, 4);

  let current = new CoalitionEngine({ store, trust }).view("900").proposals.find(
    (proposal) => proposal.id === currentProposal.id
  );
  assert.equal(current.supporters.length, 2);
  assert.equal(current.independentSupportClusters, 1);
  assert.equal(current.status, "emerging");
  assert.equal(current.supporters[0].independenceFactor, 1 / Math.sqrt(2));

  await add(store, independent, sequences, "900", {
    type: "endorsement",
    body: "endorse public ritual number four",
    replyTo: currentProposal.id,
  });
  current = new CoalitionEngine({ store, trust }).view("900").proposals.find(
    (proposal) => proposal.id === currentProposal.id
  );
  assert.equal(current.independentSupportClusters, 2);
  assert.equal(current.status, "ready");
});

test("one shared stance is not enough to infer a correlated cluster", async () => {
  const store = new PostcardStore();
  const trust = new TrustGraph();
  const sequences = new Map();
  const proposer = CypherIdentity.createRandom(511);
  const first = CypherIdentity.createRandom(512);
  const second = CypherIdentity.createRandom(513);
  const proposal = await add(store, proposer, sequences, "901", {
    type: "proposal",
    body: "build one public radio ritual",
  });
  for (const identity of [first, second]) {
    await add(store, identity, sequences, "901", {
      type: "endorsement",
      body: "endorse the public radio ritual",
      replyTo: proposal.id,
    });
  }

  const analyzer = new StanceClusterAnalyzer({ store, trust });
  assert.equal(analyzer.forAuthor(first.address).size, 1);
  assert.equal(analyzer.forAuthor(second.address).size, 1);
  const view = new CoalitionEngine({ store, trust }).view("901").proposals[0];
  assert.equal(view.independentSupportClusters, 2);
  assert.equal(view.status, "ready");
});

test("correlation does not spread transitively through a bridging address", async () => {
  const store = new PostcardStore();
  const trust = new TrustGraph();
  const sequences = new Map();
  const proposer = CypherIdentity.createRandom(521);
  const first = CypherIdentity.createRandom(522);
  const bridge = CypherIdentity.createRandom(523);
  const third = CypherIdentity.createRandom(524);
  for (let index = 1; index <= 6; index += 1) {
    const proposal = await add(store, proposer, sequences, "902", {
      type: "proposal",
      body: `build bridge test ritual ${index}`,
    });
    if (index <= 3) {
      await add(store, first, sequences, "902", {
        type: "endorsement",
        body: `endorse bridge test ritual ${index}`,
        replyTo: proposal.id,
      });
    }
    await add(store, bridge, sequences, "902", {
      type: "endorsement",
      body: `endorse bridge test ritual ${index}`,
      replyTo: proposal.id,
    });
    if (index >= 4) {
      await add(store, third, sequences, "902", {
        type: "endorsement",
        body: `endorse bridge test ritual ${index}`,
        replyTo: proposal.id,
      });
    }
  }

  const clusters = new StanceClusterAnalyzer({ store, trust }).view();
  assert.equal(Math.max(...clusters.map((cluster) => cluster.size)), 2);
  assert.equal(clusters.reduce((sum, cluster) => sum + cluster.size, 0), 3);
});
