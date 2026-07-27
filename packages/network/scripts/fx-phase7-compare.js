const fs = require("node:fs");
const path = require("node:path");
const {
  compileSelfRoutedProposal,
  queryBrokerRoutes,
} = require("../src");

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

async function main() {
  const rfq = readJson(required("FX_PHASE7_RFQ_FILE"));
  if (process.env.FX_PHASE7_QUOTES_FILE) {
    const quotes = readJson(process.env.FX_PHASE7_QUOTES_FILE);
    const result = compileSelfRoutedProposal(rfq, quotes, {
      policy: process.env.FX_PHASE7_ROUTE_POLICY,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const endpoints = required("FX_PHASE7_BROKER_URLS")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const result = await queryBrokerRoutes({
    endpoints,
    rfq,
    timeoutMs: Number(process.env.FX_PHASE7_QUERY_TIMEOUT_MS || 20_000),
  });
  process.stdout.write(`${JSON.stringify({
    selected: result.selected,
    brokers: result.attempts.map((attempt) => ({
      endpoint: attempt.endpoint,
      ok: attempt.ok,
      latencyMs: attempt.latencyMs,
      status: attempt.status,
      error: attempt.error,
      proposalId: attempt.proposal?.proposalId,
      allInInputAtomic: attempt.proposal?.route.totalInputAtomic,
      feeAtomic: attempt.proposal?.fee.amountAtomic,
    })),
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
