function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function token(value, fallback = "unknown", maximum = 64) {
  const output = String(value ?? "").trim().replace(/[^a-z0-9._:-]+/gi, "_").slice(0, maximum);
  return output || fallback;
}

function safeActivity(events) {
  if (!Array.isArray(events)) return [];
  return events.slice(-128).map((event) => ({
    at: finite(event.at, 0),
    channel: token(event.channel, "system", 12),
    direction: token(event.direction, "local", 8),
    operation: token(event.operation, "activity", 34),
    destination: token(event.destination, "device", 34),
    status: token(event.status, "unknown", 10),
    durationMs: finite(event.durationMs),
  }));
}

function safeState(state = {}) {
  const lifecycle = state.dailyLifecycle || {};
  return {
    phase: token(state.phase, "unknown", 24),
    agentId: finite(state.agentId),
    cypherId: finite(state.cypherId),
    level: finite(state.level),
    streak: finite(state.streak),
    runwayMicros: finite(state.runway),
    gasReserveWei: /^\d{1,40}$/.test(String(state.ethGasReserveWei || "")) ? String(state.ethGasReserveWei) : null,
    tickets: finite(state.tickets),
    totalTickets: finite(state.totalTickets),
    classId: finite(state.classId),
    classPotMicros: finite(state.classPotMicros),
    classAgents: finite(state.classAgents),
    lastCommitDay: finite(state.lastCommitDay),
    chainSyncedAt: finite(state.chainSyncedAt),
    lifecycle: {
      day: finite(lifecycle.day),
      status: token(lifecycle.status, "unknown", 24),
      attempts: finite(lifecycle.attempts, 0),
      rainStatus: token(lifecycle.rainStatus, "unknown", 24),
      thoughtStatus: token(lifecycle.thoughtStatus, "unknown", 24),
      nextRetryAt: finite(lifecycle.nextRetryAt, 0),
      lastErrorCode: lifecycle.lastError?.code ? token(lifecycle.lastError.code, "unknown", 32) : null,
    },
  };
}

function safeNetwork(status = {}) {
  const transport = status.transportStatus || {};
  const history = transport.historySync || status.historySync || {};
  const database = status.localDatabase || {};
  return {
    active: Boolean(status.active),
    peerCount: finite(status.peerCount, 0),
    postcardCount: finite(status.postcardCount, 0),
    launchId: status.launchId == null ? null : token(status.launchId, "unknown", 32),
    transport: {
      state: token(transport.state, "unknown", 24),
      historyReceived: finite(history.received),
      historyCompletedAt: finite(history.completedAt),
    },
    localDatabase: {
      postcards: finite(database.postcards, 0),
      peers: finite(database.peers, 0),
      memories: finite(database.memories, 0),
      integrity: token(database.integrity, "unknown", 16),
    },
  };
}

function safeUpdate(update = {}) {
  return {
    status: token(update.status, "unknown", 24),
    currentVersion: token(update.currentVersion, "unknown", 24),
    availableVersion: update.availableVersion ? token(update.availableVersion, "unknown", 24) : null,
    progress: finite(update.progress),
    errorCode: update.status === "error" ? "update_unavailable" : null,
  };
}

function buildDiagnosticsSnapshot(input = {}) {
  const health = input.health?.version === 1 ? input.health : { version: 1, status: "unknown", issues: [] };
  return {
    format: "versus-cypher-diagnostics",
    version: 1,
    generatedAt: finite(input.generatedAt, Date.now()),
    application: {
      name: "Versus Cypher",
      version: token(input.application?.version, "unknown", 24),
      packaged: Boolean(input.application?.packaged),
      platform: token(input.application?.platform, "unknown", 16),
      architecture: token(input.application?.architecture, "unknown", 16),
    },
    service: {
      chain: token(input.service?.chain, "unknown", 20),
      waku: token(input.service?.waku, "unknown", 24),
      brain: token(input.service?.brain, "unknown", 24),
      telemetry: "none",
    },
    health: {
      status: token(health.status, "unknown", 16),
      issues: Array.isArray(health.issues) ? health.issues.slice(0, 16).map((issue) => ({
        code: token(issue.code, "unknown", 40),
        subsystem: token(issue.subsystem, "unknown", 16),
        severity: token(issue.severity, "unknown", 16),
        firstSeenAt: finite(issue.firstSeenAt),
        lastSeenAt: finite(issue.lastSeenAt),
        occurrences: finite(issue.occurrences, 1),
      })) : [],
    },
    cypher: safeState(input.state),
    network: safeNetwork(input.network),
    update: safeUpdate(input.update),
    operations: {
      damaged: Boolean(input.operations?.damaged),
      pending: Math.max(0, finite(input.operations?.pending, 0)),
      prepared: Math.max(0, finite(input.operations?.counts?.prepared, 0)),
      submitted: Math.max(0, finite(input.operations?.counts?.submitted, 0)),
      uncertain: Math.max(0, finite(input.operations?.counts?.uncertain, 0)),
      complete: Math.max(0, finite(input.operations?.counts?.complete, 0)),
      failed: Math.max(0, finite(input.operations?.counts?.failed, 0)),
    },
    activity: safeActivity(input.activity),
  };
}

function formatDiagnostics(snapshot) {
  const lines = [
    "VERSUS CYPHER DIAGNOSTICS",
    `Generated: ${new Date(snapshot.generatedAt).toISOString()}`,
    "Telemetry: none",
    "",
    "APPLICATION",
    `Version: ${snapshot.application.version}`,
    `Runtime: ${snapshot.application.platform} ${snapshot.application.architecture}`,
    `Packaged: ${snapshot.application.packaged ? "yes" : "no"}`,
    "",
    "HEALTH",
    `Overall: ${snapshot.health.status}`,
  ];
  if (!snapshot.health.issues.length) lines.push("Issues: none");
  for (const issue of snapshot.health.issues) {
    lines.push(`Issue: ${issue.code} | ${issue.severity} | ${issue.subsystem} | seen ${issue.occurrences}`);
  }
  lines.push(
    "",
    "CHAIN AND CYPHER",
    `Chain mode: ${snapshot.service.chain}`,
    `Phase: ${snapshot.cypher.phase}`,
    `Agent: ${snapshot.cypher.agentId ?? "none"}`,
    `Species: ${snapshot.cypher.cypherId ?? "none"}`,
    `Runway micros: ${snapshot.cypher.runwayMicros ?? "unknown"}`,
    `Gas reserve wei: ${snapshot.cypher.gasReserveWei ?? "unknown"}`,
    `Tickets: ${snapshot.cypher.tickets ?? "unknown"} / ${snapshot.cypher.totalTickets ?? "unknown"}`,
    `Class: ${snapshot.cypher.classId ?? "unknown"}`,
    `Daily lifecycle: ${snapshot.cypher.lifecycle.status} / rain ${snapshot.cypher.lifecycle.rainStatus} / thought ${snapshot.cypher.lifecycle.thoughtStatus}`,
    `Last lifecycle error: ${snapshot.cypher.lifecycle.lastErrorCode || "none"}`,
    `Economic operations: ${snapshot.operations.pending} pending, ${snapshot.operations.complete} complete, ${snapshot.operations.failed} failed, journal ${snapshot.operations.damaged ? "damaged" : "ok"}`,
    "",
    "NETWORK",
    `Waku: ${snapshot.service.waku}`,
    `Transport: ${snapshot.network.transport.state}`,
    `Peers: ${snapshot.network.peerCount}`,
    `Postcards: ${snapshot.network.postcardCount}`,
    `Store recovered: ${snapshot.network.transport.historyReceived ?? "unknown"}`,
    `Local rows: ${snapshot.network.localDatabase.postcards} postcards, ${snapshot.network.localDatabase.peers} peers, ${snapshot.network.localDatabase.memories} memories`,
    `Database integrity: ${snapshot.network.localDatabase.integrity}`,
    "",
    "UPDATE",
    `Status: ${snapshot.update.status}`,
    `Current: ${snapshot.update.currentVersion}`,
    `Available: ${snapshot.update.availableVersion || "none"}`,
    "",
    "RECENT SANITIZED ACTIVITY",
  );
  for (const event of snapshot.activity) {
    lines.push(`${new Date(event.at).toISOString()} ${event.channel}/${event.direction} ${event.operation} ${event.status} ${event.durationMs ?? "-"}ms`);
  }
  lines.push("", "This report intentionally excludes wallet addresses, transaction hashes, credentials, private thoughts, peer content, and filesystem paths.");
  return `${lines.join("\n")}\n`;
}

function assertSafeDiagnostics(report) {
  const forbidden = [
    /0x[a-f0-9]{64}/i,
    /\b(?:sk|pk)-[a-z0-9_-]{12,}\b/i,
    /bearer\s+[a-z0-9._-]+/i,
    /-----begin [^-]*private key-----/i,
    /\b(?:api[_ -]?key|mnemonic|seed phrase|password)\s*[:=]/i,
    /[a-z]:\\users\\[^\\\s]+/i,
    /\/(?:users|home)\/[^/\s]+/i,
  ];
  if (forbidden.some((pattern) => pattern.test(report))) throw new Error("diagnostics safety invariant failed");
  return report;
}

function createDiagnosticsReport(input = {}) {
  return assertSafeDiagnostics(formatDiagnostics(buildDiagnosticsSnapshot(input)));
}

module.exports = {
  assertSafeDiagnostics,
  buildDiagnosticsSnapshot,
  createDiagnosticsReport,
  formatDiagnostics,
};
