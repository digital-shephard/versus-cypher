const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appDir = path.resolve(__dirname, "..");
const distDir = path.resolve(appDir, process.argv[2] || process.env.VERSUS_DIST_DIR || "dist");
const sourcePath = path.resolve(appDir, "..", "..", "versus", "deployments", "base.json");

function findBundledManifests(directory, found = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      findBundledManifests(candidate, found);
    } else if (
      candidate.toLowerCase().endsWith(path.join("resources", "deployment", "base.json"))
    ) {
      found.push(candidate);
    }
  }
  return found;
}

assert.ok(fs.existsSync(sourcePath), `Reviewed Base deployment is missing: ${sourcePath}`);
assert.ok(fs.existsSync(distDir), `Desktop build output is missing: ${distDir}`);

const expected = fs.readFileSync(sourcePath);
const manifests = findBundledManifests(distDir);
assert.ok(manifests.length > 0, `No packaged Base deployment was found under ${distDir}`);

for (const manifestPath of manifests) {
  const actual = fs.readFileSync(manifestPath);
  assert.deepEqual(actual, expected, `Packaged Base deployment differs from ${sourcePath}`);
}

console.log(`Verified ${manifests.length} packaged Base deployment manifest(s).`);
