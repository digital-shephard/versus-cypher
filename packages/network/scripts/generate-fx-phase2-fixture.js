const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { FxTradeJournal } = require("../src/fx-journal");
const {
  FxDeterministicSimulator,
  deterministicHash,
} = require("../src/fx-simulator");

async function main() {
  const outputPath = path.resolve(
    process.argv[2] ||
      path.join(__dirname, "..", "fixtures", "fx-phase2-transcript.json")
  );
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "versus-fx-fixture-"));
  const deploymentId = deterministicHash("phase-two-deployment");
  const journal = new FxTradeJournal({
    filePath: path.join(temporary, "journal.sqlite"),
    deploymentId,
  });
  try {
    const simulator = new FxDeterministicSimulator({
      seed: "phase-two-parity",
      journal,
      recoveryDirectory: path.join(temporary, "recovery"),
      stateFile: path.join(temporary, "simulator.json"),
      gitCommit: "fixture",
    });
    const trade = simulator.newTrade("parity");
    await simulator.openRfq(trade);
    await simulator.quote(trade);
    await simulator.accept(trade);
    await simulator.reserve(trade);
    await simulator.fundSource(trade);
    await simulator.fundDestination(trade);
    await simulator.claimDestination(trade);
    await simulator.claimSource(trade);
    await simulator.complete(trade);
    const fixture = {
      schema: "versus-fx-phase2-transcript",
      version: 1,
      seed: simulator.seed,
      deploymentId,
      tradeId: trade.tradeId,
      messages: [
        trade.messages.rfq,
        trade.messages.quote,
        trade.messages.accept,
        trade.messages.reserve,
        trade.messages.sourceLock,
        trade.messages.destinationLock,
        trade.messages.destinationClaim,
        trade.messages.sourceClaim,
        trade.messages.complete,
      ],
      expectedSnapshot: journal.snapshot(trade.tradeId),
    };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(fixture, null, 2)}\n`);
    process.stdout.write(`${outputPath}\n`);
  } finally {
    journal.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
