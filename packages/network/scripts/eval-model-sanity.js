const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const key = process.env.OPENROUTER_API_KEY;
const models = String(process.env.VERSUS_EVAL_MODELS || "").split(",").map((value) => value.trim()).filter(Boolean);
const replicates = Number(process.env.VERSUS_EVAL_REPLICATES || 2);
const outputDir = String(process.env.VERSUS_EVAL_OUTPUT_DIR || "").trim();
const maxTokens = Number(process.env.VERSUS_EVAL_MAX_TOKENS || 24);
if (!key || !models.length) throw new Error("set OPENROUTER_API_KEY and VERSUS_EVAL_MODELS");

const fixturePath = path.join(__dirname, "..", "fixtures", "small-model-sanity-v1.json");
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const system = "Answer exactly as requested with no explanation.";

function normalize(value) {
  return String(value || "").trim().toLowerCase().replace(/^[\s`'\"]+|[\s.!?`'\"]+$/g, "");
}

async function complete(model, testCase) {
  const started = Date.now();
  let response;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: maxTokens,
        reasoning: { effort: "none" },
        messages: [{ role: "system", content: system }, { role: "user", content: testCase.prompt }],
      }),
    });
    if (response.ok || (response.status !== 429 && response.status < 500)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000 * (2 ** (attempt - 1))));
  }
  if (!response.ok) throw new Error(`${model} returned http ${response.status}`);
  const payload = await response.json();
  const raw = payload.choices?.[0]?.message?.content || "";
  const answer = normalize(raw);
  return {
    raw,
    answer,
    passed: testCase.answers.includes(answer),
    latencyMs: Date.now() - started,
    resolvedModel: payload.model || null,
    generationId: payload.id || null,
    usage: payload.usage || null,
  };
}

(async () => {
  const startedAt = new Date().toISOString();
  const results = [];
  for (const model of models) {
    for (let replicate = 1; replicate <= replicates; replicate += 1) {
      for (const testCase of fixture.cases) {
        try {
          results.push({ model, replicate, case: testCase.id, ...(await complete(model, testCase)) });
        } catch (error) {
          results.push({ model, replicate, case: testCase.id, passed: false, transportError: String(error.message) });
        }
      }
    }
  }
  const summary = models.map((model) => {
    const rows = results.filter((row) => row.model === model);
    return {
      model,
      passed: rows.filter((row) => row.passed).length,
      total: rows.length,
      passRate: rows.filter((row) => row.passed).length / rows.length,
      formatFailures: rows.filter((row) => !row.transportError && !row.passed && row.answer).length,
      emptyResponses: rows.filter((row) => !row.transportError && !row.answer).length,
      transportErrors: rows.filter((row) => row.transportError).length,
      averageLatencyMs: Math.round(rows.filter((row) => row.latencyMs).reduce((sum, row) => sum + row.latencyMs, 0) / rows.filter((row) => row.latencyMs).length),
    };
  });
  const record = { version: 1, experimentId: crypto.randomUUID(), startedAt, completedAt: new Date().toISOString(), system, fixture, models, replicates, maxTokens, summary, results };
  let outputPath = null;
  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    outputPath = path.join(outputDir, `${startedAt.replace(/[:.]/g, "-")}-${record.experimentId}.json`);
    fs.writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
  console.log(JSON.stringify({ experimentId: record.experimentId, outputPath, summary }, null, 2));
})().catch((error) => {
  console.error(String(error.message).replace(/sk-or-v1-[a-z0-9]+/gi, "[redacted]"));
  process.exitCode = 1;
});
