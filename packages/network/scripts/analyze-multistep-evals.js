const fs = require("fs");
const path = require("path");

const inputDir = path.resolve(process.argv[2] || path.join(__dirname, "..", "..", "..", "research", "small-model-evals", "multistep-runs"));
const files = fs.readdirSync(inputDir).filter((name) => name.endsWith(".json")).sort();
if (!files.length) throw new Error(`no multi-step records found in ${inputDir}`);

function percent(value) {
  return value == null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

console.log("| Started | Label | Fixture | Prompt | Level | Model | N | Strict | Decision | Functional | Calls | Cost USD |");
console.log("|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|");
for (const file of files) {
  const record = JSON.parse(fs.readFileSync(path.join(inputDir, file), "utf8"));
  for (const row of record.summary) {
    const fixture = `${record.design.fixture.status || "development"}-v${record.design.fixture.version}`;
    console.log([
      `| ${record.startedAt}`,
      record.design.experimentLabel || "exploratory",
      fixture,
      record.design.promptVariant || "minimal",
      row.level,
      `\`${row.model}\``,
      row.total,
      percent(row.passRate),
      percent(row.decisionRate),
      percent(row.functionalRate),
      row.calls,
      Number(row.costUsd || 0).toFixed(6),
    ].join(" | ") + " |");
  }
}
