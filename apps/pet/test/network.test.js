const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Wallet } = require("ethers");
const { StaticCypherVerifier } = require("@versus/network");
const {
  createPetNetworkService,
  parsePeerUrls,
} = require("../src/network");

async function waitUntil(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for pet network state");
}

async function createService(dataDir, agentId, eligibilityVerifier) {
  const wallet = Wallet.createRandom();
  eligibilityVerifier.register(wallet.address, agentId);
  return createPetNetworkService({
    privateKey: wallet.privateKey,
    agentId,
    dataDir,
    env: { VERSUS_P2P_PORT: "0" },
    eligibilityVerifier,
  });
}

class LaunchAwareTransport extends EventEmitter {
  constructor(launchId = "7") {
    super();
    this.connectionless = true;
    this.handlesPropagation = true;
    this.launchId = launchId;
    this.contentTopic = `/test/${launchId}`;
    this.switches = [];
  }

  async listen() {
    return { transport: "test", contentTopic: this.contentTopic, peerCount: 0 };
  }

  async switchLaunch(launchId) {
    const next = String(launchId);
    if (next === this.launchId) {
      return { changed: false, launchId: this.launchId, contentTopic: this.contentTopic };
    }
    this.launchId = next;
    this.contentTopic = `/test/${next}`;
    this.switches.push(next);
    return { changed: true, launchId: next, contentTopic: this.contentTopic };
  }

  validatePostcard(postcard) {
    if (String(postcard.launchId) !== this.launchId) throw new Error("wrong test launch");
  }

  async broadcast() {}
  async close() {}

  get peerCount() {
    return 0;
  }

  peerList() {
    return [];
  }
}

test("pet network bridge starts a wallet backed peer and persists received postcards", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "versus-pet-network-"));
  const registry = new StaticCypherVerifier();
  const alpha = await createService(path.join(root, "alpha"), 21, registry);
  const beta = await createService(path.join(root, "beta"), 22, registry);
  t.after(async () => Promise.all([alpha.close(), beta.close()]));

  const alphaStatus = await alpha.start();
  await beta.start();
  await beta.connect(alphaStatus.listen.url);

  const postcard = await alpha.publish({
    type: "proposal",
    launchId: "501",
    body: "let the agents name the daily launch",
  });
  await waitUntil(() => beta.list().length === 1);

  const received = beta.list()[0];
  assert.equal(received.id, postcard.id);
  assert.equal(received.author, alpha.status().address);
  assert.equal(received.cypherId, "21");
  assert.equal(beta.status().peerCount, 1);
  assert.equal(beta.status().peers[0].address, alpha.status().address);
  assert.equal(beta.coalitionView("501").proposals[0].status, "emerging");
  assert.equal(fs.existsSync(path.join(root, "beta", "cypher.sqlite")), true);

  beta.setBlocked(alpha.status().address, true);
  await alpha.publish({
    type: "observation",
    launchId: "501",
    body: "this second postcard should stop at the local block",
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(beta.list().length, 1);
});

test("approved referral drives replace the owner slot and its unseen raft notice", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "versus-pet-drive-"));
  const registry = new StaticCypherVerifier();
  const service = await createService(root, 41, registry);
  let proposalId = `0x${"1".repeat(64)}`;
  service.node.coalitionView = () => ({
    launchId: "501",
    proposals: [],
    currentReferralDrive: {
      id: proposalId,
      status: "ready",
      createdAt: 100,
      body: "open the first referral drive",
      fundingGoalMicros: "10000000",
      supporters: [{}, {}],
      detractors: [],
    },
  });

  const first = service.coalitionView("501").currentReferralDrive;
  assert.equal(first.proposalId, proposalId);
  assert.match(first.referralCode, /^VRS-41-/);
  assert.equal(service.thoughts.items.filter((item) => item.slotKey === "referral-drive").length, 1);

  proposalId = `0x${"2".repeat(64)}`;
  const second = service.coalitionView("501").currentReferralDrive;
  assert.equal(second.proposalId, proposalId);
  assert.equal(service.thoughts.items.filter((item) => item.slotKey === "referral-drive").length, 1);
  assert.match(service.thoughts.next().text, /VRS-41-/);
});

test("peer environment parsing removes empty entries", () => {
  assert.deepEqual(parsePeerUrls("tcp://127.0.0.1:1, ,tcp://127.0.0.1:2"), [
    "tcp://127.0.0.1:1",
    "tcp://127.0.0.1:2",
  ]);
});

test("pet network refuses to start without the Base Cypher registry", async () => {
  await assert.rejects(
    () =>
      createPetNetworkService({
        privateKey: Wallet.createRandom().privateKey,
        agentId: 1,
        dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "versus-no-registry-")),
        env: {},
      }),
    { code: "CYPHER_REGISTRY_NOT_CONFIGURED" }
  );
});

test("pet network follows the current on-chain launch without restarting", async (t) => {
  const registry = new StaticCypherVerifier();
  const wallet = Wallet.createRandom();
  registry.register(wallet.address, 81);
  const transport = new LaunchAwareTransport("7");
  let currentLaunch = "7";
  const service = await createPetNetworkService({
    privateKey: wallet.privateKey,
    agentId: 81,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "versus-launch-rollover-")),
    env: { VERSUS_P2P_PORT: "0" },
    eligibilityVerifier: registry,
    transport,
    launchResolver: async () => currentLaunch,
    launchPollMs: 60_000,
  });
  t.after(async () => service.close());

  await service.start();
  assert.equal(service.status().launchId, "7");
  currentLaunch = "8";
  const result = await service.refreshLaunch();

  assert.equal(result.changed, true);
  assert.deepEqual(transport.switches, ["8"]);
  assert.equal(service.status().launchId, "8");
  assert.equal(service.status().contentTopic, "/test/8");
  assert.equal(service.status().listen.contentTopic, "/test/8");
});

test("an owner supplied brain hands a prepared postcard to the payment sink before propagation", async (t) => {
  const registry = new StaticCypherVerifier();
  const wallet = Wallet.createRandom();
  registry.register(wallet.address, 91);
  let prepared = null;
  const service = await createPetNetworkService({
    privateKey: wallet.privateKey,
    agentId: 91,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "versus-agent-bridge-")),
    env: { VERSUS_P2P_PORT: "0" },
    eligibilityVerifier: registry,
    transport: new LaunchAwareTransport("9"),
    agentConfig: { mode: "custom", model: "test brain", autostart: false, tickIntervalMs: 60_000 },
    agentBrain: async () => ({ action: { type: "observation", body: "the launch needs one clear ritual" } }),
    onAgentAction: (postcard) => { prepared = postcard; },
  });
  t.after(async () => service.close());
  await service.start();

  const tick = await service.runAgentTick();
  assert.equal(tick.result.status, "published");
  assert.equal(prepared.id, tick.result.postcard.id);
  assert.equal(service.list({ launchId: "9" }).length, 0);
  assert.equal(service.agentStatus().lastResult, "published");
});

test("desktop AUTO waits for confirmed commit cycles instead of running a free timer", async (t) => {
  const registry = new StaticCypherVerifier();
  const wallet = Wallet.createRandom();
  registry.register(wallet.address, 93);
  let calls = 0;
  const service = await createPetNetworkService({
    privateKey: wallet.privateKey,
    agentId: 93,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "versus-agent-cadence-")),
    env: { VERSUS_P2P_PORT: "0" },
    eligibilityVerifier: registry,
    transport: new LaunchAwareTransport("9"),
    agentConfig: { mode: "custom", model: "test brain", autostart: true, tickIntervalMs: 100 },
    agentBrain: async () => {
      calls += 1;
      return { thought: "the confirmed penny opened this thinking cycle", action: null };
    },
  });
  t.after(async () => service.close());
  await service.start();

  assert.equal(service.agentStatus().status, "listening");
  assert.equal(service.agentRuntime.timer, null);
  assert.equal(calls, 0);
  await service.runDailyAgentTick("commit:100");
  await service.runDailyAgentTick("commit:100");
  assert.equal(calls, 1);
  await service.runDailyAgentTick("commit:101");
  assert.equal(calls, 2);
  service.stopAgent();
  assert.equal((await service.runDailyAgentTick("commit:102")).status, "brain_off");
});

test("pet network bridge persists mission artifacts outcomes and local assessments", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "versus-pet-artifacts-"));
  const registry = new StaticCypherVerifier();
  const alpha = await createService(path.join(root, "alpha"), 91, registry);
  const beta = await createService(path.join(root, "beta"), 92, registry);
  t.after(async () => Promise.all([alpha.close(), beta.close()]));
  const alphaStatus = await alpha.start();
  await beta.start();
  await beta.connect(alphaStatus.listen.url);

  const proposal = await alpha.publish({
    type: "proposal",
    launchId: "601",
    body: "build a daily radio signal around the launch",
  });
  await waitUntil(() => beta.list().some((postcard) => postcard.id === proposal.id));
  const mission = await beta.publishMission({
    launchId: "601",
    body: "publish one radio riddle each day",
    replyTo: proposal.id,
    manifest: {
      title: "The Daily Signal",
      objective: "Give humans one small shared riddle around the launch.",
      steps: ["Publish one riddle each day."],
      successConditions: ["Ten humans submit an answer."],
      evidenceRequirements: ["Preserve the riddle and answer hashes."],
      budgetMicros: "0",
    },
  });
  const sponsorship = beta.missionForSponsorship(mission.id);
  assert.equal(sponsorship.recipientAgentId, "92");
  assert.equal(sponsorship.launchId, "601");
  await waitUntil(() => alpha.getArtifact(mission.artifact) !== null);
  const outcome = await alpha.publishOutcome({
    launchId: "601",
    body: "twelve humans solved the first radio riddle",
    missionId: mission.id,
    manifest: {
      status: "success",
      summary: "Twelve humans submitted the correct answer before the deadline.",
      evidenceReferences: [mission.artifact],
    },
  });
  await waitUntil(() => beta.getArtifact(outcome.artifact) !== null);
  const assessment = beta.assessOutcome({
    outcomeId: outcome.id,
    verdict: "success",
    confidence: 100,
  });

  assert.equal(assessment.missionId, mission.id);
  assert.equal(beta.listOutcomeAssessments().length, 1);
  assert.equal(beta.node.trust.score(beta.status().address, "execution"), 4);
  assert.equal(beta.status().artifactCount, 2);
  assert.equal(beta.status().outcomeAssessmentCount, 1);
  assert.equal(fs.existsSync(path.join(root, "beta", "outcomes.json")), true);
});

test("pet network reserves and persists deterministic durable signal batches", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "versus-pet-signals-"));
  const registry = new StaticCypherVerifier();
  const wallet = Wallet.createRandom();
  registry.register(wallet.address, 101);
  const service = await createPetNetworkService({
    privateKey: wallet.privateKey,
    agentId: 101,
    dataDir,
    env: { VERSUS_P2P_PORT: "0" },
    eligibilityVerifier: registry,
    signalSettlement: {
      chainId: 8453,
      arena: "0x1111111111111111111111111111111111111111",
    },
  });
  t.after(async () => service.close());
  await service.start();
  await service.publish({
    type: "proposal",
    launchId: "701",
    body: "build a public signal ritual",
  });
  await service.publish({
    type: "observation",
    launchId: "701",
    body: "ordinary gossip also buys one penny of ink",
  });
  const record = service.prepareSignalBatch("701", 100);
  const transactionHash = `0x${"4".repeat(64)}`;
  service.markSignalBatchSubmitted(record.batch.root, transactionHash);
  service.confirmSignalBatch(record.batch.root, { transactionHash, blockNumber: 123 });

  assert.equal(record.batch.signalCount, 2);
  assert.equal(record.batch.inkPennies, 4);
  assert.equal(record.batch.amountMicros, "40000");
  assert.equal(service.listSignalBatches()[0].status, "confirmed");
  assert.equal(service.status().signalBatchCount, 1);
  assert.equal(fs.existsSync(path.join(dataDir, "signal-settlements.json")), true);
});
