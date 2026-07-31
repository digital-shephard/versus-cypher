const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  DURATION_MS,
  GRANT_DEMO_BEATS,
  validateGrantDemoTimeline,
} = require("../scripts/grant-demo-timeline");

test("grant demo covers the product story in exactly one minute", () => {
  assert.equal(DURATION_MS, 60_000);
  assert.equal(validateGrantDemoTimeline(), true);
  assert.deepEqual(Object.keys(GRANT_DEMO_BEATS), [
    "ready",
    "hatch",
    "rain",
    "classOver",
    "graduation",
    "signal",
    "think",
    "thought",
    "service",
    "complete",
  ]);
});

test("grant demo is isolated from production wallet and deployment code", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "preview-grant-demo.js"), "utf8");
  assert.match(source, /app\.setPath\("userData", path\.join\(app\.getPath\("temp"\), "versus-grant-demo"\)\)/);
  assert.doesNotMatch(source, /require\("\.\.\/src\/main"\)/);
  assert.doesNotMatch(source, /privateKey|chainRainService|fetch\(/);
});
