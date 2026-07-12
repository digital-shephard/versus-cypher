const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { OperationJournal } = require("../src/operation-journal");

test("operation journal blocks duplicate economic actions across restart", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-operations-"));
  const filePath = path.join(directory, "operations.json");
  try {
    const first = new OperationJournal({ filePath, now: () => 100 });
    first.begin("rain:7", "rain", { agentId: 7, privateKey: "must-not-persist" });
    const restarted = new OperationJournal({ filePath, now: () => 200 });
    assert.throws(() => restarted.begin("rain:7", "rain", { agentId: 7 }), (error) => error.code === "TRANSACTION_UNCERTAIN");
    assert.equal(JSON.stringify(restarted.records).includes("must-not-persist"), false);

    const hash = `0x${"4".repeat(64)}`;
    restarted.submitted("rain:7", hash);
    const submittedRestart = new OperationJournal({ filePath, now: () => 300 });
    assert.equal(submittedRestart.pending()[0].transactionHash, hash);
    submittedRestart.complete("rain:7", { transactionHash: hash, blockNumber: 99 });
    assert.equal(new OperationJournal({ filePath }).pending().length, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an uncertain operation without a receipt remains blocked instead of replaying", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-operations-"));
  try {
    const journal = new OperationJournal({ filePath: path.join(directory, "operations.json") });
    journal.begin("mission:sponsor:abc", "mission_sponsor", { agentId: 2 });
    journal.uncertain("mission:sponsor:abc");
    assert.equal(journal.summary().pending, 1);
    assert.throws(() => journal.begin("mission:sponsor:abc", "mission_sponsor"), /will not be repeated/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a damaged journal is preserved and blocks new economic actions", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-operations-"));
  const filePath = path.join(directory, "operations.json");
  try {
    fs.writeFileSync(filePath, "not-json", "utf8");
    const journal = new OperationJournal({ filePath });
    assert.equal(journal.summary().damaged, true);
    assert.throws(() => journal.begin("rain:1", "rain"), (error) => error.code === "DATABASE_DAMAGED");
    assert.equal(fs.readFileSync(filePath, "utf8"), "not-json");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an encrypted archive can replace a damaged journal without deleting its evidence", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-operations-"));
  const sourcePath = path.join(directory, "source.json");
  const targetPath = path.join(directory, "target.json");
  try {
    const source = new OperationJournal({ filePath: sourcePath, now: () => 10 });
    source.begin("claim:2", "tranche_claim", { agentId: 2 });
    source.fail("claim:2", "preflight_failed");
    const archive = source.exportArchive();

    fs.writeFileSync(targetPath, "damaged", "utf8");
    const target = new OperationJournal({ filePath: targetPath, now: () => 20 });
    assert.equal(target.damaged, true);
    assert.equal(target.importArchive(archive).damaged, false);
    assert.equal(target.current("claim:2").status, "failed");
    assert.equal(fs.readFileSync(`${targetPath}.damaged-20`, "utf8"), "damaged");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
