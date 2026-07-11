const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  ArtifactStore,
  CypherIdentity,
  OutcomeLedger,
  PostcardStore,
  TrustGraph,
  normalizeMissionManifest,
  normalizeOutcomeManifest,
} = require("../src");

async function buildOutcomeGraph(root) {
  const store = new PostcardStore();
  const artifactStore = new ArtifactStore({ directory: path.join(root, "artifacts") });
  const operator = CypherIdentity.createRandom(401);
  const reporter = CypherIdentity.createRandom(402);
  const createdAt = 2_000_000_000;
  const proposal = await operator.signPostcard({
    type: "proposal",
    launchId: "800",
    sequence: 0,
    createdAt,
    expiresAt: createdAt + 3600,
    body: "build a public garden ritual around the launch",
  });
  store.add(proposal);
  const missionManifest = normalizeMissionManifest({
    kind: "versus-mission",
    version: 1,
    launchId: "800",
    author: operator.address,
    title: "The Garden Signal",
    objective: "Give humans one small shared ritual around the launch.",
    steps: ["Publish one clue."],
    successConditions: ["Ten humans solve the clue."],
    evidenceRequirements: ["Preserve the clue and answer hashes."],
    createdAt,
    expiresAt: createdAt + 86_400,
    budgetMicros: "0",
  });
  const missionReference = artifactStore.put(missionManifest);
  const mission = await operator.signPostcard({
    type: "mission",
    launchId: "800",
    sequence: 1,
    createdAt: createdAt + 1,
    expiresAt: createdAt + 3601,
    body: "publish one garden clue for humans to solve",
    replyTo: proposal.id,
    artifact: missionReference,
  });
  store.add(mission);
  const outcomeManifest = normalizeOutcomeManifest({
    kind: "versus-outcome",
    version: 1,
    launchId: "800",
    missionId: mission.id,
    reporter: reporter.address,
    status: "success",
    summary: "Twelve humans submitted the correct answer before the deadline.",
    evidenceReferences: [missionReference],
    completedAt: createdAt + 1800,
  });
  const outcomeReference = artifactStore.put(outcomeManifest);
  const outcome = await reporter.signPostcard({
    type: "outcome",
    launchId: "800",
    sequence: 0,
    createdAt: createdAt + 1800,
    expiresAt: createdAt + 5400,
    body: "twelve humans solved the garden clue",
    replyTo: mission.id,
    artifact: outcomeReference,
  });
  store.add(outcome);
  return { store, artifactStore, operator, reporter, mission, outcome };
}

test("local outcome assessments add replaceable source tracked trust", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "versus-outcomes-"));
  const graph = await buildOutcomeGraph(root);
  const trustPath = path.join(root, "trust.json");
  const ledgerPath = path.join(root, "outcomes.json");
  const trust = new TrustGraph({ filePath: trustPath });
  trust.setScore(graph.operator.address, "integrity", 10);
  const ledger = new OutcomeLedger({
    store: graph.store,
    trust,
    artifactStore: graph.artifactStore,
    filePath: ledgerPath,
    now: () => 1234,
  });

  const success = ledger.assess({
    outcomeId: graph.outcome.id,
    verdict: "success",
    confidence: 50,
    note: "local evidence check passed",
  });
  assert.equal(success.claimedStatus, "success");
  assert.equal(trust.score(graph.operator.address, "execution"), 2);
  assert.equal(trust.score(graph.operator.address, "stewardship"), 1);
  assert.equal(trust.score(graph.operator.address, "integrity"), 11);
  assert.equal(trust.score(graph.reporter.address, "integrity"), 1);

  ledger.assess({ outcomeId: graph.outcome.id, verdict: "failure", confidence: 100 });
  assert.equal(trust.score(graph.operator.address, "execution"), -3);
  assert.equal(trust.score(graph.operator.address, "stewardship"), -2);
  assert.equal(trust.score(graph.operator.address, "integrity"), 10);
  assert.equal(trust.score(graph.reporter.address, "integrity"), 1);

  const reloadedTrust = new TrustGraph({ filePath: trustPath });
  const reloadedLedger = new OutcomeLedger({
    store: graph.store,
    trust: reloadedTrust,
    artifactStore: graph.artifactStore,
    filePath: ledgerPath,
  });
  assert.equal(reloadedLedger.get(graph.outcome.id).verdict, "failure");
  assert.equal(reloadedTrust.score(graph.operator.address, "execution"), -3);

  assert.equal(reloadedLedger.remove(graph.outcome.id), true);
  assert.equal(reloadedTrust.score(graph.operator.address, "execution"), 0);
  assert.equal(reloadedTrust.score(graph.operator.address, "integrity"), 10);
  assert.equal(reloadedTrust.score(graph.reporter.address, "integrity"), 0);
});

test("a positive verdict cannot be recorded without a content addressed outcome", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "versus-outcomes-missing-"));
  const graph = await buildOutcomeGraph(root);
  const bareOutcome = await graph.reporter.signPostcard({
    type: "outcome",
    launchId: "800",
    sequence: 1,
    createdAt: 2_000_002_000,
    expiresAt: 2_000_005_600,
    body: "this outcome has no evidence manifest",
    replyTo: graph.mission.id,
  });
  graph.store.add(bareOutcome);
  const trust = new TrustGraph();
  const ledger = new OutcomeLedger({
    store: graph.store,
    trust,
    artifactStore: graph.artifactStore,
  });

  assert.throws(
    () => ledger.assess({ outcomeId: bareOutcome.id, verdict: "success" }),
    { code: "MISSING_OUTCOME_ARTIFACT" }
  );
  ledger.assess({ outcomeId: bareOutcome.id, verdict: "unsubstantiated" });
  assert.equal(trust.score(graph.reporter.address, "integrity"), -3);
  assert.equal(trust.score(graph.operator.address, "execution"), 0);
});
