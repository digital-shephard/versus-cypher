const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { FxTradeJournal } = require("../src/fx-journal");
const {
  FxDeterministicSimulator,
  deterministicHash,
} = require("../src/fx-simulator");

async function runScenario(outputDirectory, scenario, execute) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `versus-fx-${scenario}-`));
  const journal = new FxTradeJournal({
    filePath: path.join(directory, "journal.sqlite"),
    deploymentId: deterministicHash("phase-two-deployment"),
  });
  const started = performance.now();
  try {
    const simulator = new FxDeterministicSimulator({
      seed: `phase-two-${scenario}`,
      journal,
      recoveryDirectory: path.join(directory, "recovery"),
      stateFile: path.join(directory, "simulator.json"),
      gitCommit: process.env.GIT_COMMIT || "working-tree",
    });
    const trade = simulator.newTrade(scenario);
    await execute(simulator, trade);
    const report = simulator.report(scenario);
    report.metrics.elapsedMilliseconds = Number(
      (performance.now() - started).toFixed(3)
    );
    const outputPath = path.join(outputDirectory, `${scenario}.json`);
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    return {
      scenario,
      state: journal.snapshot(trade.tradeId).settlementState,
      reportHash: report.reportHash,
      elapsedMilliseconds: report.metrics.elapsedMilliseconds,
    };
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function main() {
  const outputDirectory = path.resolve(
    process.argv[2] || path.join(process.cwd(), "fx-simulation-runs")
  );
  fs.mkdirSync(outputDirectory, { recursive: true });
  const summaries = [];
  summaries.push(await runScenario(outputDirectory, "success", async (simulator, trade) => {
    await simulator.openRfq(trade);
    await simulator.quote(trade);
    await simulator.accept(trade);
    await simulator.reserve(trade);
    await simulator.fundSource(trade);
    await simulator.fundDestination(trade);
    await simulator.claimDestination(trade);
    await simulator.claimSource(trade);
    await simulator.complete(trade);
  }));
  summaries.push(await runScenario(
    outputDirectory,
    "requester-disappears",
    async (simulator, trade) => {
      await simulator.openRfq(trade);
      await simulator.quote(trade);
      await simulator.accept(trade);
      await simulator.reserve(trade);
      await simulator.fundSource(trade);
      await simulator.refundSource(trade);
    }
  ));
  summaries.push(await runScenario(
    outputDirectory,
    "dealer-disappears",
    async (simulator, trade) => {
      await simulator.openRfq(trade);
      await simulator.quote(trade);
      await simulator.accept(trade);
      await simulator.reserve(trade);
      await simulator.fundSource(trade);
      await simulator.fundDestination(trade);
      await simulator.refundDestination(trade);
      await simulator.refundSource(trade);
    }
  ));
  fs.writeFileSync(
    path.join(outputDirectory, "summary.json"),
    `${JSON.stringify({ schema: "versus-fx-phase2-summary", summaries }, null, 2)}\n`
  );
  process.stdout.write(`${JSON.stringify(summaries, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
