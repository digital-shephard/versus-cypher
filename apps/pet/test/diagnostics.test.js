const assert = require("node:assert/strict");
const test = require("node:test");
const { createDiagnosticsReport } = require("../src/diagnostics");

test("diagnostics are human readable and built from a strict allowlist", () => {
  const secret = `0x${"a".repeat(64)}`;
  const report = createDiagnosticsReport({
    generatedAt: 1_700_000_000_000,
    application: { version: "0.1.0", packaged: true, platform: "win32", architecture: "x64" },
    service: { chain: "base", waku: "caught_up", brain: "cloud" },
    health: { version: 1, status: "attention", issues: [{ code: "rpc_unavailable", subsystem: "base", severity: "error", occurrences: 1 }] },
    state: {
      phase: "active", agentId: 7, cypherId: 4, runway: 6_000_000, tickets: 9, totalTickets: 20,
      walletAddress: "0x93645ce5BCF0009026D8100aea5901cDd52217bF",
      privateKey: secret,
      dailyLifecycle: { status: "error", lastError: { code: "RPC_UNAVAILABLE", message: "password=secret" } },
    },
    network: {
      active: true, address: "0x93645ce5BCF0009026D8100aea5901cDd52217bF", peerCount: 2, postcardCount: 5,
      peers: [{ body: "private peer text" }], transportStatus: { state: "caught_up" },
      localDatabase: { postcards: 5, peers: 2, memories: 1, integrity: "ok", filePath: "C:\\Users\\Owner\\secrets.sqlite" },
    },
    update: { status: "current", currentVersion: "0.1.0" },
    activity: [{ at: 1_700_000_000_000, channel: "base", operation: "state_sync", destination: "base_rpc", status: "error", privateKey: secret }],
    privateThoughts: [{ text: "never export me" }],
    settings: { apiKey: "sk-owner-secret", password: "hunter2" },
  });
  assert.match(report, /VERSUS CYPHER DIAGNOSTICS/);
  assert.match(report, /Issue: rpc_unavailable/);
  assert.match(report, /Agent: 7/);
  assert.doesNotMatch(report, /93645ce5/i);
  assert.doesNotMatch(report, /never export me|hunter2|sk-owner|Owner\\secrets|a{64}/i);
});
