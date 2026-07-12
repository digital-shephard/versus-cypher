const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { quarantineDatabaseFiles } = require("../src/local-recovery");

test("archive recovery preserves every SQLite file before rebuilding local memory", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-recovery-"));
  try {
    for (const name of ["cypher.sqlite", "cypher.sqlite-wal", "cypher.sqlite-shm"]) {
      fs.writeFileSync(path.join(directory, name), `evidence-${name}`, "utf8");
    }
    const result = quarantineDatabaseFiles(directory, 1234);
    assert.deepEqual(result.moved, ["cypher.sqlite", "cypher.sqlite-wal", "cypher.sqlite-shm"]);
    for (const name of result.moved) {
      assert.equal(fs.existsSync(path.join(directory, name)), false);
      assert.equal(fs.readFileSync(path.join(result.recoveryDirectory, name), "utf8"), `evidence-${name}`);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
