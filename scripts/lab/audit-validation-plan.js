#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");

const ROOT = path.resolve(__dirname, "..", "..");
const PLAN = path.join(ROOT, "docs", "END_TO_END_NETWORK_VALIDATION_PLAN.md");
const OUTPUT_ROOT = path.join(ROOT, "research", "validation-audits");
const REQUIRED_EVIDENCE = Object.freeze([
  ["local economic E2E", "research/network-runs/2026-07-10T22-00-58-592Z-866c571a/summary.json", (value) => value.passed === true],
  ["public Waku E2E", "research/network-runs/2026-07-10T22-15-00-248Z-waku-4cfda859/summary.json", (value) => value.passed === true],
  ["controlled Waku baseline", "research/network-runs/2026-07-11T10-50-17-605Z-waku-controlled-bc9b583c/summary.json", (value) => value.passed === true],
  ["controlled Waku reliability", "research/network-runs/2026-07-11T11-17-35-466Z-waku-reliability-aefed9fe/summary.json", (value) => value.passed === true],
  ["Store expiry and Cypher recovery", "research/network-runs/2026-07-11T11-24-25-017Z-waku-controlled-ec489d40/summary.json", (value) => value.passed === true],
  ["compaction scale", "research/compaction-runs/2026-07-10T22-30-49-630Z-3908c60c/summary.json", (value) => value.passed === true],
  ["controlled capacity", "research/capacity-runs/2026-07-11T11-29-17-505Z-waku-capacity-1727885b/summary.json", (value) => value.passed === true],
  ["eight-Cypher reproducibility control", "research/coalition-runs/2026-07-11T11-53-14-630Z-coalition-control-11b48b89/summary.json", (value) => value.passed === true],
  ["production HTTP brain fixture", "research/coalition-runs/2026-07-11T12-05-00-654Z-coalition-http-fixture-0af81dc3/summary.json", (value) => value.passed === true],
  ["live frontier-model coalition", "research/coalition-runs/2026-07-11T12-21-57-583Z-coalition-frontier-114519b9/summary.json", (value) => value.passed === true && value.mode === "frontier-model-cohort" && value.conversation?.rejected === 0 && value.conversation?.brainErrors === 0],
  ["stable-state visual bounds", "research/visual-audits/2026-07-11T12-00-24-833462Z-stable-baseline/summary.json", (value) => value.passed === true],
  ["packaged SQLite smoke", "research/package-smoke/20260710-180329-result.json", (value) => value.packageResult === "passed" && value.launchResult === "passed" && value.sqliteLoaded === true],
  ["packaged brain effects", "research/pet-walkthrough-harness/2026-07-11T00-07-21-914Z-3943a614/brain-fixture-summary.json", (value) => value.passed === true],
  ["packaged economic failures", "research/pet-walkthrough-harness/2026-07-11T00-07-21-914Z-3943a614/economic-failure-summary.json", (value) => value.passed === true],
  ["packaged recovery", "research/pet-walkthrough-harness/2026-07-11T00-07-21-914Z-3943a614/recovery-summary.json", (value) => value.passed === true],
  ["packaged display scaling", "research/pet-walkthrough-harness/2026-07-11T00-07-21-914Z-3943a614/scaling/summary.json", (value) => value.passed === true],
  ["packaged network states", "research/pet-walkthrough-harness/2026-07-11T00-07-21-914Z-3943a614/network-states/summary.json", (value) => value.passed === true],
]);

function sourceRevision() {
  const hash = createHash("sha256");
  for (const file of [__filename, PLAN, path.join(ROOT, "package.json")]) hash.update(fs.readFileSync(file));
  return `sha256:${hash.digest("hex").slice(0, 16)}`;
}

function readJson(relativePath) {
  const absolute = path.join(ROOT, relativePath);
  if (!fs.existsSync(absolute)) return { exists: false, value: null, error: "missing" };
  try {
    return { exists: true, value: JSON.parse(fs.readFileSync(absolute, "utf8")), error: null };
  } catch (error) {
    return { exists: true, value: null, error: error.message };
  }
}

function latestPassingFrontierRun() {
  const directory = path.join(ROOT, "research", "coalition-runs");
  if (!fs.existsSync(directory)) return null;
  const candidates = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.includes("coalition-frontier"))
    .map((entry) => ({ name: entry.name, summary: readJson(`research/coalition-runs/${entry.name}/summary.json`) }))
    .filter((entry) => entry.summary.value?.passed === true && entry.summary.value?.mode === "frontier-model-cohort")
    .sort((left, right) => right.name.localeCompare(left.name));
  return candidates[0] || null;
}

function ownerAcceptance() {
  const record = readJson("research/owner-visual-acceptance.json");
  if (!record.value) return { passed: false, path: "research/owner-visual-acceptance.json", reason: record.error || "not recorded" };
  const expectedVisualHash = readJson("research/visual-audits/2026-07-11T12-00-24-833462Z-stable-baseline/summary.json").value?.runId;
  const passed = record.value.accepted === true && record.value.visualAuditRunId === expectedVisualHash;
  return {
    passed,
    path: "research/owner-visual-acceptance.json",
    reason: passed ? null : "acceptance does not bind the current visual audit",
    record: record.value,
  };
}

function runTests(outputDir) {
  const result = spawnSync(process.execPath, [path.join(ROOT, "scripts", "test-all.js")], {
    cwd: ROOT,
    env: { ...process.env },
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  fs.writeFileSync(path.join(outputDir, "full-test.log"), output, "utf8");
  return {
    passed: result.status === 0 && output.includes("ALL GREEN"),
    exitCode: result.status,
    allGreenMarker: output.includes("ALL GREEN"),
    error: result.error?.message || null,
  };
}

function secretScan() {
  const command = process.platform === "win32" ? "rg.exe" : "rg";
  const result = spawnSync(command, [
    "-n", "-i", "sk-or-v1-[a-z0-9]{16,}", ".",
    "--glob", "!node_modules/**",
    "--glob", "!apps/pet/node_modules/**",
    "--glob", "!apps/pet/dist*/**",
  ], { cwd: ROOT, encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  return {
    passed: result.status === 1,
    exitCode: result.status,
    matches: String(result.stdout || "").trim().split(/\r?\n/).filter(Boolean),
    error: result.status > 1 ? String(result.stderr || "").trim() : null,
  };
}

function main() {
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-validation-${randomUUID().slice(0, 8)}`;
  const outputDir = path.join(OUTPUT_ROOT, runId);
  fs.mkdirSync(outputDir, { recursive: true });
  const evidence = REQUIRED_EVIDENCE.map(([name, relativePath, predicate]) => {
    const record = readJson(relativePath);
    let passed = false;
    let reason = record.error;
    if (record.value) {
      try {
        passed = Boolean(predicate(record.value));
        reason = passed ? null : "summary did not satisfy its acceptance predicate";
      } catch (error) {
        reason = error.message;
      }
    }
    return { name, path: relativePath, exists: record.exists, passed, reason };
  });
  const planText = fs.readFileSync(PLAN, "utf8");
  const openCheckboxes = planText.split(/\r?\n/)
    .filter((line) => /^- \[ \]/.test(line))
    .map((line) => line.replace(/^- \[ \]\s*/, ""));
  const expectedOpenCheckboxes = [];
  const openGateListExact = JSON.stringify(openCheckboxes) === JSON.stringify(expectedOpenCheckboxes);
  const tests = runTests(outputDir);
  const secrets = secretScan();
  const frontier = latestPassingFrontierRun();
  const owner = ownerAcceptance();
  const coreEvidencePassed = evidence.every((entry) => entry.passed);
  const auditPassed = coreEvidencePassed && tests.passed && secrets.passed && openGateListExact;
  const goForSepolia = auditPassed && Boolean(frontier) && owner.passed;
  const summary = {
    version: 1,
    runId,
    codeRevision: sourceRevision(),
    auditedAt: new Date().toISOString(),
    auditPassed,
    decision: goForSepolia ? "GO" : "NO-GO",
    goForSepolia,
    coreEvidencePassed,
    evidence,
    currentTests: tests,
    secretScan: secrets,
    plan: { openCheckboxes, expectedOpenCheckboxes, openGateListExact },
    gates: {
      frontierModelCoalition: {
        passed: Boolean(frontier),
        runId: frontier?.name || null,
        path: frontier ? `research/coalition-runs/${frontier.name}` : null,
      },
      ownerVisualAcceptance: owner,
    },
    secretsRecorded: false,
  };
  fs.writeFileSync(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(outputDir, "REPORT.md"), [
    "# End-to-End Validation Audit",
    "",
    `- Run: \`${runId}\``,
    `- Audit integrity: **${auditPassed ? "PASS" : "FAIL"}**`,
    `- Sepolia decision: **${summary.decision}**`,
    `- Current repository tests: ${tests.passed ? "pass" : "fail"}`,
    `- Credential scan: ${secrets.passed ? "pass" : "fail"}`,
    "",
    "## Required Evidence",
    "",
    ...evidence.map((entry) => `- [${entry.passed ? "x" : " "}] ${entry.name}: \`${entry.path}\``),
    "",
    "## Remaining Gates",
    "",
    `- [${frontier ? "x" : " "}] Live frontier-model coalition`,
    `- [${owner.passed ? "x" : " "}] Owner visual acceptance bound to the current visual audit`,
    "",
  ].join("\n"), "utf8");
  console.log(`${auditPassed ? "PASS" : "FAIL"} ${summary.decision} ${outputDir}`);
  if (!auditPassed) process.exitCode = 1;
}

main();
