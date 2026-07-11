const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  CypherIdentity,
  StaticCypherVerifier,
  VersusNode,
  verifyMissionSponsorshipPostcard,
} = require("../src");

class MemoryTransport extends EventEmitter {
  constructor() {
    super();
    this.connectionless = true;
    this.handlesPropagation = true;
  }
  async broadcast() {}
  async close() {}
  get peerCount() { return 0; }
  peerList() { return []; }
}

test("a confirmed mission escrow becomes a signed hash bound sponsorship observation", async (t) => {
  const sponsor = CypherIdentity.createRandom(801);
  const operator = CypherIdentity.createRandom(802);
  const registry = new StaticCypherVerifier([
    { address: sponsor.address, cypherId: 801 },
    { address: operator.address, cypherId: 802 },
  ]);
  const node = new VersusNode({
    identity: sponsor,
    eligibilityVerifier: registry,
    transport: new MemoryTransport(),
  });
  t.after(async () => node.close());
  const createdAt = Math.floor(Date.now() / 1000);
  const proposal = await operator.signPostcard({
    type: "proposal",
    launchId: "88",
    sequence: 0,
    createdAt,
    expiresAt: createdAt + 3600,
    body: "build a public garden ritual",
  });
  const mission = await operator.signPostcard({
    type: "mission",
    launchId: "88",
    sequence: 1,
    createdAt: createdAt + 1,
    expiresAt: createdAt + 3601,
    body: "publish one public garden clue",
    replyTo: proposal.id,
  });
  await node.accept(proposal);
  await node.accept(mission);
  const input = {
    kind: "versus-mission-sponsorship",
    version: 1,
    chainId: "8453",
    escrow: "0x1111111111111111111111111111111111111111",
    escrowId: "7",
    missionId: mission.id,
    launchId: "88",
    sponsorAgentId: "801",
    recipientAgentId: "802",
    sponsor: sponsor.address,
    amountMicros: "5000000",
    deadline: "2000000000",
    transactionHash: `0x${"6".repeat(64)}`,
    blockNumber: "12345",
  };
  const announcement = await node.publishMissionSponsorship(input);
  const proof = node.artifactStore.get(announcement.artifact);

  assert.equal(announcement.type, "receipt");
  assert.equal(proof.missionId, mission.id);
  assert.equal(proof.amountMicros, "5000000");
  assert.deepEqual(verifyMissionSponsorshipPostcard(announcement, proof), proof);
  node.recordVerifiedEconomicProof({
    verified: true,
    kind: "sponsorship",
    sponsorship: proof,
    escrowState: 0,
  });
  assert.equal(node.trust.score(sponsor.address, "sponsorship"), 1);
  assert.equal(node.trust.score(sponsor.address, "taste"), 0);
  node.recordVerifiedEconomicProof({
    verified: true,
    kind: "sponsorship",
    sponsorship: proof,
    escrowState: 1,
  });
  assert.equal(node.trust.score(sponsor.address, "sponsorship"), 4);
  node.recordVerifiedEconomicProof({
    verified: true,
    kind: "sponsorship",
    sponsorship: proof,
    escrowState: 2,
  });
  assert.equal(node.trust.score(sponsor.address, "sponsorship"), 0);
  await assert.rejects(
    () => node.publishMissionSponsorship({ ...input, sponsorAgentId: "999" }),
    { code: "FOREIGN_MISSION_SPONSORSHIP" }
  );
});
