#!/usr/bin/env node
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const CLUSTER = path.join(__dirname, "waku-cluster.js");
const ROUND_TRIP = path.join(__dirname, "run-public-waku-e2e.js");
const STATE = path.join(ROOT, "research", "waku-lab", "cluster.json");

function run(script, args = [], env = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`${path.basename(script)} ${args.join(" ")} exited ${result.status}`);
}

try {
  run(CLUSTER, ["down"]);
  run(CLUSTER, ["up"], { VERSUS_WAKU_STORE_RETENTION_SECONDS: "2" });
  run(ROUND_TRIP, [], {
    VERSUS_WAKU_CLUSTER_STATE: STATE,
    VERSUS_WAKU_EXPECT_STORE_MISS: "1",
    VERSUS_WAKU_EXPIRY_WAIT_MS: "10000",
  });
} finally {
  try { run(CLUSTER, ["down"]); } catch (error) { console.error(`cluster cleanup failed: ${error.message}`); }
  try { run(CLUSTER, ["up"]); } catch (error) { console.error(`cluster default startup failed: ${error.message}`); }
}
