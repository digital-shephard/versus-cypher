#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..", "..");
const LAB_ROOT = path.join(ROOT, "research", "pet-walkthrough-harness");
const CURRENT_PATH = path.join(LAB_ROOT, "current.json");
const STATE_NAME = "brain-fixture.json";
const REQUESTS_NAME = "brain-fixture-requests.jsonl";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function current() {
  if (!fs.existsSync(CURRENT_PATH)) throw new Error("No pet walkthrough harness is active");
  const state = JSON.parse(fs.readFileSync(CURRENT_PATH, "utf8"));
  if (state.status !== "ready") throw new Error(`Walkthrough harness is ${state.status}`);
  return state;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function fixtureState(state) {
  const file = path.join(LAB_ROOT, state.runId, STATE_NAME);
  return { file, value: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null };
}

async function waitForHealth(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`brain fixture did not become ready: ${lastError?.message || "timeout"}`);
}

async function start() {
  const state = current();
  const existing = fixtureState(state).value;
  if (existing && processAlive(existing.pid)) {
    console.log(JSON.stringify(existing, null, 2));
    return;
  }
  const port = await freePort();
  const runDir = path.join(LAB_ROOT, state.runId);
  const statePath = path.join(runDir, STATE_NAME);
  const logPath = path.join(runDir, "brain-fixture.log");
  const logFd = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, [__filename, "serve", String(port), runDir], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(`${baseUrl}/health`);
  } catch (error) {
    if (processAlive(child.pid)) process.kill(child.pid);
    throw error;
  }
  const result = {
    version: 1,
    runId: state.runId,
    pid: child.pid,
    port,
    baseUrl,
    endpoints: {
      success: `${baseUrl}/v1/success`,
      key: `${baseUrl}/v1/key`,
      timeout: `${baseUrl}/v1/timeout`,
      malformed: `${baseUrl}/v1/malformed`,
      httpError: `${baseUrl}/v1/http-error`,
    },
    requiredTestKey: "walkthrough-key",
    recordsSecrets: false,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(statePath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

async function stop() {
  const state = current();
  const fixture = fixtureState(state);
  if (!fixture.value) {
    console.log(JSON.stringify({ runId: state.runId, stopped: false, reason: "not_started" }, null, 2));
    return;
  }
  const wasAlive = processAlive(fixture.value.pid);
  if (wasAlive) process.kill(fixture.value.pid);
  const result = { ...fixture.value, stopped: true, wasAlive, stoppedAt: new Date().toISOString() };
  fs.writeFileSync(fixture.file, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

function status() {
  const state = current();
  const fixture = fixtureState(state).value;
  console.log(JSON.stringify({
    runId: state.runId,
    configured: Boolean(fixture),
    alive: Boolean(fixture && processAlive(fixture.pid)),
    fixture,
  }, null, 2));
}

function report() {
  const state = current();
  const runDir = path.join(LAB_ROOT, state.runId);
  const requestsPath = path.join(runDir, REQUESTS_NAME);
  const requests = fs.existsSync(requestsPath)
    ? fs.readFileSync(requestsPath, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)
    : [];
  const thoughtsPath = path.join(state.profilePath, "Network", "thoughts.json");
  const thoughts = fs.existsSync(thoughtsPath)
    ? JSON.parse(fs.readFileSync(thoughtsPath, "utf8")).items || []
    : [];
  const wallet = JSON.parse(fs.readFileSync(path.join(state.profilePath, "wallet.json"), "utf8"));
  const database = new DatabaseSync(path.join(state.profilePath, "Network", "cypher.sqlite"), { readOnly: true });
  const postcardCount = Number(database.prepare("select count(*) as count from postcards").get().count);
  const ownPostcardCount = Number(database.prepare(
    "select count(*) as count from postcards where author = ?"
  ).get(wallet.address.toLowerCase()).count);
  database.close();
  const byRoute = {};
  for (const request of requests) {
    const route = String(request.route || "unknown");
    byRoute[route] ||= { count: 0, keyAccepted: 0, keyRejected: 0 };
    byRoute[route].count += 1;
    if (request.keyPresent && request.keyValid) byRoute[route].keyAccepted += 1;
    if (request.keyPresent && !request.keyValid) byRoute[route].keyRejected += 1;
  }
  const summary = {
    version: 1,
    runId: state.runId,
    generatedAt: new Date().toISOString(),
    requestCount: requests.length,
    byRoute,
    requests: requests.map((request) => ({
      at: request.at,
      route: request.route,
      bodyBytes: request.bodyBytes,
      bodySha256: request.bodySha256,
      model: request.model,
      messageCount: request.messageCount,
      keyPresent: request.keyPresent,
      keyValid: request.keyValid,
    })),
    privateThoughts: thoughts.map((thought) => ({
      id: thought.id,
      text: thought.text,
      state: thought.state,
      createdAt: thought.createdAt,
      seenAt: thought.seenAt || null,
    })),
    publicPostcards: {
      total: postcardCount,
      authoredByLocalCypher: ownPostcardCount,
    },
    checks: {
      successfulResponseObserved: requests.some((request) => request.route === "/v1/success"),
      badKeyObserved: requests.some((request) => request.route === "/v1/key" && request.keyPresent && !request.keyValid),
      validKeyObserved: requests.some((request) => request.route === "/v1/key" && request.keyValid),
      timeoutObserved: requests.some((request) => request.route === "/v1/timeout"),
      malformedObserved: requests.some((request) => request.route === "/v1/malformed"),
      privateThoughtSeen: thoughts.some((thought) => thought.state === "seen"),
      silencePublishedNothing: ownPostcardCount === 0,
    },
    secretsRecorded: false,
  };
  summary.passed = Object.values(summary.checks).every(Boolean);
  fs.writeFileSync(path.join(runDir, "brain-fixture-summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.passed) throw new Error("brain fixture acceptance checks failed");
}

function sendDecision(response, decision) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    id: "versus-local-fixture",
    choices: [{ message: { role: "assistant", content: JSON.stringify(decision) } }],
  }));
}

function serve(port, runDir) {
  const requestsPath = path.join(runDir, REQUESTS_NAME);
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, pid: process.pid }));
      return;
    }
    const route = new URL(request.url, `http://127.0.0.1:${port}`).pathname;
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 256_000) request.destroy();
    });
    request.on("end", async () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch (_) {}
      const keyPresent = typeof request.headers.authorization === "string";
      const keyValid = request.headers.authorization === "Bearer walkthrough-key";
      fs.appendFileSync(requestsPath, `${JSON.stringify({
        at: Date.now(),
        method: request.method,
        route,
        bodyBytes: Buffer.byteLength(body),
        bodySha256: createHash("sha256").update(body).digest("hex"),
        model: typeof parsed?.model === "string" ? parsed.model.slice(0, 120) : null,
        messageCount: Array.isArray(parsed?.messages) ? parsed.messages.length : null,
        keyPresent,
        keyValid,
      })}\n`);

      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      if (route === "/v1/key" && !keyValid) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "fixture key rejected" } }));
        return;
      }
      if (route === "/v1/http-error") {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "fixture unavailable" } }));
        return;
      }
      if (route === "/v1/timeout") {
        await delay(3_000);
        if (!response.destroyed) sendDecision(response, { thought: "this response arrived too late", action: null });
        return;
      }
      if (route === "/v1/malformed") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content: "not json" } }] }));
        return;
      }
      if (route === "/v1/success" || route === "/v1/key") {
        sendDecision(response, { thought: "the shared tide is worth watching quietly", action: null });
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "fixture route not found" } }));
    });
  });
  server.listen(Number(port), "127.0.0.1", () => {
    console.log(JSON.stringify({ ready: true, pid: process.pid, port: Number(port) }));
  });
  const close = () => server.close(() => process.exit(0));
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

const command = process.argv[2] || "status";
Promise.resolve(
  command === "start" ? start()
    : command === "stop" ? stop()
      : command === "status" ? status()
        : command === "report" ? report()
        : command === "serve" ? serve(process.argv[3], process.argv[4])
          : Promise.reject(new Error("usage: pet-brain-fixture.js start|stop|status|report"))
).catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
