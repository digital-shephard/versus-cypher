const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const CONTAINER = "versus-base-fork";
const IMAGE = "ghcr.io/foundry-rs/foundry:latest";
const PORT = 8546;
const BASE_RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
  }
  return result;
}

async function rpc(url, method, params = []) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message);
  return payload.result;
}

async function waitForFork(url) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      if ((await rpc(url, "eth_chainId")) === "0x2105") return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Anvil Base fork did not become ready within 60 seconds");
}

async function main() {
  run("docker", ["info"], { capture: true });
  const blockHex = await rpc(BASE_RPC, "eth_blockNumber");
  const block = Number(BigInt(blockHex));
  const existing = run("docker", ["ps", "-aq", "--filter", `name=^${CONTAINER}$`], {
    capture: true,
    allowFailure: true,
  }).stdout.trim();
  if (existing) run("docker", ["rm", "-f", CONTAINER], { capture: true });

  const anvil = [
    "anvil",
    `--fork-url ${BASE_RPC}`,
    `--fork-block-number ${block}`,
    "--host 0.0.0.0",
    "--port 8545",
    "--chain-id 8453",
    "--auto-impersonate",
  ].join(" ");
  run("docker", [
    "run", "-d", "--name", CONTAINER,
    "-p", `127.0.0.1:${PORT}:8545`,
    IMAGE,
    anvil,
  ], { capture: true });

  try {
    const forkUrl = `http://127.0.0.1:${PORT}`;
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const reportDir = path.join(__dirname, "..", "..", "research", "base-fork-runs", runId);
    const reportPath = path.join(reportDir, "report.json");
    fs.mkdirSync(reportDir, { recursive: true });
    await waitForFork(forkUrl);
    console.log(`Base fork ready at block ${block.toLocaleString()} on ${forkUrl}`);
    const hardhatCli = require.resolve("hardhat/internal/cli/bootstrap");
    run(process.execPath, [hardhatCli, "test", "test/ProductionBaseFork.test.js", "--network", "baseFork"], {
      env: {
        ...process.env,
        VERSUS_BASE_FORK_RPC_URL: forkUrl,
        VERSUS_BASE_FORK_BLOCK: String(block),
        VERSUS_BASE_FORK_REPORT: reportPath,
      },
    });
    if (!fs.existsSync(reportPath)) throw new Error("Base fork test did not write its evidence report");
    console.log(`Evidence: ${reportPath}`);
  } finally {
    run("docker", ["rm", "-f", CONTAINER], { capture: true, allowFailure: true });
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
