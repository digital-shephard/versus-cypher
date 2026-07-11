#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const LAB_ROOT = path.join(ROOT, "research", "pet-walkthrough-harness");
const CURRENT_PATH = path.join(LAB_ROOT, "current.json");
const STATE_NAME = "rpc-fixture.json";
const MODE_NAME = "rpc-fixture-mode.json";
const EVENTS_NAME = "rpc-fixture-events.jsonl";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function current() {
  if (!fs.existsSync(CURRENT_PATH)) throw new Error("No pet walkthrough harness is active");
  const state = JSON.parse(fs.readFileSync(CURRENT_PATH, "utf8"));
  if (state.status !== "ready") throw new Error(`Walkthrough harness is ${state.status}`);
  return state;
}

function saveCurrent(state) {
  fs.writeFileSync(CURRENT_PATH, JSON.stringify(state, null, 2));
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
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

function files(state) {
  const runDir = path.join(LAB_ROOT, state.runId);
  const statePath = path.join(runDir, STATE_NAME);
  return {
    runDir,
    statePath,
    modePath: path.join(runDir, MODE_NAME),
    eventsPath: path.join(runDir, EVENTS_NAME),
    value: fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : null,
  };
}

async function waitForHealth(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/__health`);
      if (response.ok) return response.json();
    } catch (_) {}
    await delay(100);
  }
  throw new Error("RPC fixture did not become ready");
}

async function start() {
  const state = current();
  const existing = files(state).value;
  if (existing && processAlive(existing.pid)) {
    state.appRpcUrl = existing.baseUrl;
    saveCurrent(state);
    console.log(JSON.stringify(existing, null, 2));
    return;
  }
  const port = await freePort();
  const paths = files(state);
  fs.writeFileSync(paths.modePath, JSON.stringify({ mode: "online", changedAt: Date.now() }, null, 2));
  const logFd = fs.openSync(path.join(paths.runDir, "rpc-fixture.log"), "a");
  const child = spawn(process.execPath, [__filename, "serve", String(port), state.rpcUrl, paths.runDir], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(baseUrl);
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
    upstream: state.rpcUrl,
    mode: "online",
    startedAt: new Date().toISOString(),
    recordsSecrets: false,
  };
  fs.writeFileSync(paths.statePath, JSON.stringify(result, null, 2));
  state.appRpcUrl = baseUrl;
  saveCurrent(state);
  console.log(JSON.stringify(result, null, 2));
}

function setMode(mode) {
  const state = current();
  const paths = files(state);
  if (!paths.value || !processAlive(paths.value.pid)) throw new Error("RPC fixture is not running");
  if (!new Set(["online", "offline"]).has(mode)) throw new Error("RPC fixture mode must be online or offline");
  const change = { mode, changedAt: Date.now() };
  fs.writeFileSync(paths.modePath, JSON.stringify(change, null, 2));
  const next = { ...paths.value, mode, modeChangedAt: new Date(change.changedAt).toISOString() };
  fs.writeFileSync(paths.statePath, JSON.stringify(next, null, 2));
  fs.appendFileSync(paths.eventsPath, `${JSON.stringify({ at: change.changedAt, type: "mode", mode })}\n`);
  console.log(JSON.stringify(next, null, 2));
}

function status() {
  const state = current();
  const fixture = files(state).value;
  console.log(JSON.stringify({
    runId: state.runId,
    configured: Boolean(fixture),
    alive: Boolean(fixture && processAlive(fixture.pid)),
    appRpcUrl: state.appRpcUrl || state.rpcUrl,
    fixture,
  }, null, 2));
}

function stop() {
  const state = current();
  const paths = files(state);
  if (paths.value && processAlive(paths.value.pid)) process.kill(paths.value.pid);
  delete state.appRpcUrl;
  saveCurrent(state);
  const result = { ...(paths.value || {}), stopped: true, stoppedAt: new Date().toISOString() };
  if (paths.value) fs.writeFileSync(paths.statePath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

function serve(port, upstream, runDir) {
  const modePath = path.join(runDir, MODE_NAME);
  const eventsPath = path.join(runDir, EVENTS_NAME);
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/__health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, pid: process.pid }));
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) request.destroy();
    });
    request.on("end", async () => {
      const startedAt = Date.now();
      let payload = null;
      try { payload = JSON.parse(body); } catch (_) {}
      const calls = Array.isArray(payload) ? payload : [payload];
      const methods = calls.filter(Boolean).map((call) => String(call.method || "unknown")).slice(0, 100);
      const mode = JSON.parse(fs.readFileSync(modePath, "utf8")).mode;
      if (mode === "offline") {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: payload?.id ?? null, error: { code: -32098, message: "walkthrough rpc offline" } }));
        fs.appendFileSync(eventsPath, `${JSON.stringify({ at: startedAt, type: "request", mode, methods, bodyBytes: Buffer.byteLength(body), status: 503, latencyMs: Date.now() - startedAt })}\n`);
        return;
      }
      try {
        const upstreamResponse = await fetch(upstream, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        const responseBody = await upstreamResponse.text();
        response.writeHead(upstreamResponse.status, { "content-type": upstreamResponse.headers.get("content-type") || "application/json" });
        response.end(responseBody);
        fs.appendFileSync(eventsPath, `${JSON.stringify({ at: startedAt, type: "request", mode, methods, bodyBytes: Buffer.byteLength(body), status: upstreamResponse.status, latencyMs: Date.now() - startedAt })}\n`);
      } catch (error) {
        response.writeHead(502, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: payload?.id ?? null, error: { code: -32097, message: "walkthrough rpc upstream unavailable" } }));
        fs.appendFileSync(eventsPath, `${JSON.stringify({ at: startedAt, type: "request", mode, methods, bodyBytes: Buffer.byteLength(body), status: 502, latencyMs: Date.now() - startedAt, error: error.message })}\n`);
      }
    });
  });
  server.listen(Number(port), "127.0.0.1", () => {
    console.log(JSON.stringify({ ready: true, pid: process.pid, port: Number(port), upstream }));
  });
  const close = () => server.close(() => process.exit(0));
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

const command = String(process.argv[2] || "status").toLowerCase();
Promise.resolve(
  command === "start" ? start()
    : command === "up" ? setMode("online")
      : command === "down" ? setMode("offline")
        : command === "status" ? status()
          : command === "stop" ? stop()
            : command === "serve" ? serve(process.argv[3], process.argv[4], process.argv[5])
              : Promise.reject(new Error("usage: pet-rpc-fixture.js start|up|down|status|stop"))
).catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
