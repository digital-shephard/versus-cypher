#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");

const ROOT = path.resolve(__dirname, "..", "..");
const STAGE_SCRIPT = path.join(__dirname, "run-waku-capacity-stage.js");
const CLUSTER_STATE = path.join(ROOT, "research", "waku-lab", "cluster.json");
const RUN_ROOT = path.join(ROOT, "research", "capacity-runs");
const STAGES = [2, 8, 32, 100, 500];

function runStage(count, output, topicScope) {
  const timeoutMs = count >= 500 ? 10 * 60_000 : count >= 100 ? 5 * 60_000 : 3 * 60_000;
  return new Promise((resolve) => {
    const log = fs.createWriteStream(path.join(output, "process.log"), { flags: "a" });
    const child = spawn(process.execPath, [
      "--max-old-space-size=6144",
      STAGE_SCRIPT,
      "--count", String(count),
      "--output", output,
      "--cluster", CLUSTER_STATE,
      "--topic-scope", topicScope,
    ], { cwd: ROOT, env: { ...process.env }, windowsHide: true });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, timedOut, spawnError: error.message });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: code, signal, timedOut });
    });
  });
}

async function main() {
  const cluster = JSON.parse(fs.readFileSync(CLUSTER_STATE, "utf8"));
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-waku-capacity-${randomUUID().slice(0, 8)}`;
  const runDir = path.join(RUN_ROOT, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const revision = `sha256:${createHash("sha256").update(fs.readFileSync(__filename)).update(fs.readFileSync(STAGE_SCRIPT)).digest("hex").slice(0, 16)}`;
  fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify({
    version: 1,
    runId,
    startedAt: new Date().toISOString(),
    codeRevision: revision,
    stages: STAGES,
    cluster: { image: cluster.image, clusterId: cluster.clusterId, nodes: cluster.nodes.map((node) => ({ name: node.name, peerId: node.peerId })) },
    workload: "one real js-waku light client and one paid postcard per logical Cypher on one launch topic",
    expectedFanout: "all clients accept every postcard exactly once",
    acceptanceStages: [2, 8, 32, 100],
    stressStage: 500,
    secretsRecorded: false,
  }, null, 2));

  const results = [];
  for (const count of STAGES) {
    const stageDir = path.join(runDir, `stage-${count}`);
    fs.mkdirSync(stageDir, { recursive: true });
    const topicScope = `cap-${createHash("sha256").update(`${runId}:${count}`).digest("hex").slice(0, 12)}`;
    const processResult = await runStage(count, stageDir, topicScope);
    const resultPath = path.join(stageDir, "result.json");
    const measured = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, "utf8")) : {
      count,
      stagePassed: false,
      error: { message: processResult.timedOut ? "stage timed out" : processResult.spawnError || `stage exited ${processResult.exitCode}/${processResult.signal}` },
    };
    results.push({ ...measured, process: processResult });
    if (!measured.stagePassed && count < 500) break;
  }

  const acceptance = results.filter((result) => result.count <= 100);
  const acceptancePassed = acceptance.length === 4 && acceptance.every((result) => result.stagePassed);
  const firstFailed = results.find((result) => !result.stagePassed) || null;
  const highestPassed = results.filter((result) => result.stagePassed).at(-1) || null;
  const sharding = firstFailed
    ? { measuredLowerBound: highestPassed?.count || 0, measuredFailure: firstFailed.count, recommendation: `introduce neighborhood or interest sharding above ${highestPassed?.count || 0} concurrent launch clients before retrying ${firstFailed.count}` }
    : { measuredLowerBound: highestPassed?.count || 0, measuredFailure: null, recommendation: `no one-topic failure was observed through ${highestPassed?.count || 0}; do not extrapolate beyond the measured stage` };
  const summary = { version: 1, runId, passed: acceptancePassed, completedAt: new Date().toISOString(), results, sharding };
  fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(runDir, "metrics.csv"), "agents,passed,connect_ms,publish_ms,converge_ms,delivery_ratio,p50_ms,p95_ms,max_ms,peak_rss_bytes,error\n" + results.map((result) => [
    result.count, result.stagePassed, result.connectDurationMs || "", result.publishDurationMs || "", result.convergenceDurationMs || "", result.deliveryRatio ?? "", result.latencyMs?.p50 ?? "", result.latencyMs?.p95 ?? "", result.latencyMs?.max ?? "", result.peakRssBytes || "", JSON.stringify(result.error?.message || ""),
  ].join(",")).join("\n") + "\n");
  fs.writeFileSync(path.join(runDir, "REPORT.md"), `# Controlled Waku capacity\n\n- Run: \`${runId}\`\n- Acceptance result through 100 clients: **${acceptancePassed ? "PASS" : "FAIL"}**\n- Stages: ${results.map((result) => `${result.count} ${result.stagePassed ? "pass" : "fail"}`).join(", ")}\n- Sharding result: ${sharding.recommendation}\n\n| Clients | Result | Delivery | p95 | Peak RSS |\n| ---: | --- | ---: | ---: | ---: |\n${results.map((result) => `| ${result.count} | ${result.stagePassed ? "pass" : "fail"} | ${result.deliveryRatio == null ? "n/a" : (result.deliveryRatio * 100).toFixed(3) + "%"} | ${result.latencyMs?.p95 ?? "n/a"} ms | ${result.peakRssBytes ? (result.peakRssBytes / 1024 / 1024).toFixed(1) + " MiB" : "n/a"} |`).join("\n")}\n`);
  console.log(`${acceptancePassed ? "PASS" : "FAIL"} ${runDir}`);
  if (!acceptancePassed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
