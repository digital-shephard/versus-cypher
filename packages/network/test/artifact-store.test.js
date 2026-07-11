const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  ArtifactStore,
  ArtifactValidationError,
  CypherIdentity,
  artifactReference,
  canonicalJson,
  normalizeMissionManifest,
  verifyMissionPostcardArtifact,
} = require("../src");

function missionInput(author) {
  return {
    kind: "versus-mission",
    version: 1,
    launchId: "700",
    author,
    title: "The Garden Signal",
    objective: "Give the daily launch a small public ritual humans can enjoy together.",
    steps: ["Publish one clue each day.", "Archive the answer after the launch closes."],
    successConditions: ["At least ten humans solve one clue."],
    evidenceRequirements: ["Publish the clue and answer hashes."],
    createdAt: 2_000_000_000,
    expiresAt: 2_000_086_400,
    budgetMicros: "1000000",
  };
}

test("artifact references are deterministic across object key order", () => {
  const first = { z: [3, 2, 1], a: { right: true, left: "value" } };
  const second = { a: { left: "value", right: true }, z: [3, 2, 1] };
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(artifactReference(first), artifactReference(second));
  assert.match(artifactReference(first), /^versus:sha256:[0-9a-f]{64}$/);
});

test("artifact storage persists canonical bytes and detects tampering", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-artifacts-"));
  const store = new ArtifactStore({ directory });
  const value = { kind: "test", version: 1, body: "content addressed" };
  const reference = store.put(value);
  assert.deepEqual(new ArtifactStore({ directory }).get(reference), value);

  const hash = reference.split(":").at(-1);
  fs.writeFileSync(path.join(directory, `${hash}.json`), '{"kind":"tampered"}\n', "utf8");
  assert.throws(() => new ArtifactStore({ directory }).get(reference), {
    code: "ARTIFACT_HASH_MISMATCH",
  });
});

test("mission manifests bind launch author and budget to the signed postcard", async () => {
  const identity = CypherIdentity.createRandom(301);
  const manifest = normalizeMissionManifest(missionInput(identity.address));
  const createdAt = 2_000_000_000;
  const postcard = await identity.signPostcard({
    type: "mission",
    launchId: "700",
    sequence: 0,
    createdAt,
    expiresAt: createdAt + 3600,
    body: "publish one garden clue each day",
    replyTo: `0x${"1".repeat(64)}`,
    artifact: artifactReference(manifest),
    amountMicros: "1000000",
  });
  assert.deepEqual(verifyMissionPostcardArtifact(postcard, manifest), manifest);
  assert.throws(
    () => verifyMissionPostcardArtifact(postcard, { ...manifest, budgetMicros: "2000000" }),
    ArtifactValidationError
  );
  assert.throws(
    () => verifyMissionPostcardArtifact(postcard, { ...manifest, author: CypherIdentity.createRandom(302).address }),
    ArtifactValidationError
  );
});

test("artifact storage rejects oversized and non-json-shaped values", () => {
  const store = new ArtifactStore({ maxBytes: 256 });
  assert.throws(() => store.put({ body: "x".repeat(300) }), { code: "ARTIFACT_TOO_LARGE" });
  assert.throws(() => store.put({ value: 1.5 }), ArtifactValidationError);
  assert.throws(() => store.import(`versus:sha256:${"0".repeat(64)}`, { body: "wrong" }), {
    code: "ARTIFACT_HASH_MISMATCH",
  });
});
