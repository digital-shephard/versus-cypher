const fs = require("node:fs");
const path = require("node:path");

const DATABASE_FILES = Object.freeze(["cypher.sqlite", "cypher.sqlite-wal", "cypher.sqlite-shm"]);

function quarantineDatabaseFiles(dataDir, now = Date.now()) {
  dataDir = path.resolve(dataDir);
  const existing = DATABASE_FILES.filter((name) => fs.existsSync(path.join(dataDir, name)));
  if (!existing.length) return { moved: [], recoveryDirectory: null };
  const recoveryDirectory = path.join(dataDir, "recovery", String(Number(now) || Date.now()));
  fs.mkdirSync(recoveryDirectory, { recursive: true });
  for (const name of existing) {
    fs.renameSync(path.join(dataDir, name), path.join(recoveryDirectory, name));
  }
  return { moved: existing, recoveryDirectory };
}

module.exports = { DATABASE_FILES, quarantineDatabaseFiles };
