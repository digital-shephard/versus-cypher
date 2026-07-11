const fs = require("fs");
const path = require("path");

const inputDir = path.resolve(process.argv[2] || path.join(__dirname, "..", "..", "..", "research", "small-model-evals", "runs"));
const files = fs.readdirSync(inputDir).filter((name) => name.endsWith(".json")).sort();
if (!files.length) throw new Error(`no evaluation records found in ${inputDir}`);

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function wilson95(successes, total) {
  if (!total) return [0, 0];
  const z = 1.959964;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total) / denominator;
  return [center - margin, center + margin];
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

for (const file of files) {
  const record = JSON.parse(fs.readFileSync(path.join(inputDir, file), "utf8"));
  console.log(`## ${record.design.reasoningEffort || "provider-default"}`);
  console.log("");
  console.log(`Experiment: \`${record.experimentId}\`  `);
  console.log(`Window: ${record.startedAt} to ${record.completedAt}  `);
  console.log(`Replicates: ${record.design.replicates}; randomized sequential requests: ${record.design.randomizedSequentialOrder}`);
  console.log("");
  console.log("| Model | Pass | Wilson 95% CI | JSON | Action schema | Median ms | P95 ms | Cost USD |");
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const model of record.design.requestedModels) {
    const rows = record.results.filter((row) => row.model === model && !row.reasons.includes("transport_error"));
    const passed = rows.filter((row) => row.passed).length;
    const [low, high] = wilson95(passed, rows.length);
    const latencies = rows.map((row) => row.latencyMs);
    const cost = rows.reduce((sum, row) => sum + row.usage.costUsd, 0);
    console.log(`| \`${model}\` | ${passed}/${rows.length} (${percent(passed / rows.length)}) | ${percent(low)}-${percent(high)} | ${percent(rows.filter((row) => row.validJson).length / rows.length)} | ${percent(rows.filter((row) => row.validAction).length / rows.length)} | ${percentile(latencies, 0.5)} | ${percentile(latencies, 0.95)} | ${cost.toFixed(6)} |`);
  }
  console.log("");
  console.log("| Case | " + record.design.requestedModels.map((model) => `\`${model}\``).join(" | ") + " |");
  console.log("|---|" + record.design.requestedModels.map(() => "---:").join("|") + "|");
  for (const testCase of record.design.fixture.cases) {
    const cells = record.design.requestedModels.map((model) => {
      const rows = record.results.filter((row) => row.model === model && row.case === testCase.id && !row.reasons.includes("transport_error"));
      return `${rows.filter((row) => row.passed).length}/${rows.length}`;
    });
    console.log(`| ${testCase.id} | ${cells.join(" | ")} |`);
  }
  console.log("");
}
