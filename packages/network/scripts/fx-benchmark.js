const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { FxTradeJournal } = require("../src/fx-journal");
const {
  FxDeterministicSimulator,
  deterministicHash,
} = require("../src/fx-simulator");

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))
  ];
}

async function executeScenario(index, kind) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-fx-bench-"));
  const journal = new FxTradeJournal({
    filePath: path.join(directory, "journal.sqlite"),
    deploymentId: deterministicHash("phase-two-deployment"),
  });
  const started = performance.now();
  try {
    const simulator = new FxDeterministicSimulator({
      seed: `benchmark-${kind}-${index}`,
      journal,
      recoveryDirectory: path.join(directory, "recovery"),
      stateFile: path.join(directory, "simulator.json"),
      gitCommit: process.env.GIT_COMMIT || "working-tree",
    });
    const trade = simulator.newTrade(kind);
    await simulator.openRfq(trade);
    await simulator.quote(trade);
    await simulator.accept(trade);
    await simulator.reserve(trade);
    await simulator.fundSource(trade);
    if (kind === "success") {
      await simulator.fundDestination(trade);
      await simulator.claimDestination(trade);
      await simulator.claimSource(trade);
      await simulator.complete(trade);
    } else {
      await simulator.refundSource(trade);
    }
    return performance.now() - started;
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function main() {
  const samplesPerScenario = Number(process.env.FX_BENCHMARK_SAMPLES || 20);
  const results = {};
  for (const kind of ["success", "source-refund"]) {
    const durations = [];
    for (let index = 0; index < samplesPerScenario; index += 1) {
      durations.push(await executeScenario(index, kind));
    }
    results[kind] = {
      samples: durations.length,
      p50Milliseconds: Number(percentile(durations, 0.5).toFixed(3)),
      p95Milliseconds: Number(percentile(durations, 0.95).toFixed(3)),
      maximumMilliseconds: Number(Math.max(...durations).toFixed(3)),
    };
  }
  const report = {
    schema: "versus-fx-phase2-benchmark",
    version: 1,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    results,
    note: "Local deterministic simulator only; no RPC, Waku, chain, or funds.",
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (process.argv[2]) {
    fs.writeFileSync(path.resolve(process.argv[2]), serialized);
  }
  process.stdout.write(serialized);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
