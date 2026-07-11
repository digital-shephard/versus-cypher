#!/usr/bin/env node
/**
 * One-click Versus test suite.
 * Runs: contract unit tests + onboard E2E on local Hardhat + pet headless onboard.
 */
const { spawnSync } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..");
const versus = path.join(root, "versus");
const pet = path.join(root, "apps", "pet");
const sdk = path.join(root, "packages", "sdk");

function run(label, cwd, command, args) {
  console.log("\n════════════════════════════════════════");
  console.log(`▶ ${label}`);
  console.log("════════════════════════════════════════\n");
  const r = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, FORCE_COLOR: "1" },
  });
  if (r.status !== 0) {
    console.error(`\n✖ FAILED: ${label} (exit ${r.status})\n`);
    process.exit(r.status || 1);
  }
  console.log(`\n✔ ${label}\n`);
}

console.log(`
╔══════════════════════════════════════╗
║         VERSUS — ONE-CLICK TEST      ║
║   local chain + pet onboard story    ║
╚══════════════════════════════════════╝
`);

run("1/5  Contract + onboard + Uniswap graduation E2E", versus, "npx", ["hardhat", "test"]);
run("2/5  Full day simulation (oil strike)", versus, "npx", ["hardhat", "run", "scripts/simulate.js"]);
run("3/5  Signed postcard + P2P mesh", path.join(root, "packages", "network"), "npm", ["test"]);
run("4/5  Agent SDK economic methods", sdk, "npm", ["test"]);
run("5/5  Pet onboard + rain + network bridge", pet, "npm", ["test"]);

console.log(`
╔══════════════════════════════════════╗
║     ALL GREEN — Versus is healthy    ║
╚══════════════════════════════════════╝
`);
