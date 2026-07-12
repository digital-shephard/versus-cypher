const { EventEmitter } = require("node:events");

const ISSUE_DEFINITIONS = Object.freeze({
  rpc_unavailable: Object.freeze({
    subsystem: "base",
    severity: "error",
    title: "Base is unreachable",
    detail: "Chain activity is paused while public RPC service is unavailable.",
    action: "Keep Versus open and use Refresh when the connection returns.",
  }),
  waku_unavailable: Object.freeze({
    subsystem: "waku",
    severity: "warning",
    title: "Signal is offline",
    detail: "Daily rain can continue, but peer messages cannot move right now.",
    action: "Versus will reconnect automatically. No inbound port is required.",
  }),
  store_history_unavailable: Object.freeze({
    subsystem: "waku",
    severity: "warning",
    title: "Recent Signal history is delayed",
    detail: "Live messages may work while older Waku Store history is unavailable.",
    action: "Leave Versus open. Bounded history recovery will retry automatically.",
  }),
  insufficient_gas: Object.freeze({
    subsystem: "wallet",
    severity: "error",
    title: "Gas reserve is empty",
    detail: "The Cypher cannot submit its next Base transaction without ETH.",
    action: "Send a small amount of ETH to the Cypher wallet, then refresh.",
  }),
  runway_depleted: Object.freeze({
    subsystem: "wallet",
    severity: "warning",
    title: "Runway is depleted",
    detail: "The Cypher is safe, but daily rain and paid Signal actions are paused.",
    action: "Open Vault and add runway when you are ready.",
  }),
  brain_unavailable: Object.freeze({
    subsystem: "brain",
    severity: "warning",
    title: "Brain is disconnected",
    detail: "Daily rain continues without inference or public speech.",
    action: "Open Brain settings, check the connection, and test it again.",
  }),
  brain_malformed: Object.freeze({
    subsystem: "brain",
    severity: "warning",
    title: "Brain reply was unreadable",
    detail: "The reply was rejected before it could become an action or payment.",
    action: "Test the brain again or choose another model. No funds were spent.",
  }),
  transaction_uncertain: Object.freeze({
    subsystem: "base",
    severity: "error",
    title: "Transaction is still uncertain",
    detail: "Versus will not repeat the action until Base confirms what happened.",
    action: "Keep Versus open and refresh chain state. Do not repeat the action.",
  }),
  database_damaged: Object.freeze({
    subsystem: "disk",
    severity: "critical",
    title: "Local memory needs recovery",
    detail: "The Cypher wallet remains separate, but its local Signal memory could not open.",
    action: "Restore an encrypted full Cypher archive. Do not delete the damaged files.",
  }),
  update_unavailable: Object.freeze({
    subsystem: "update",
    severity: "warning",
    title: "Update service is unavailable",
    detail: "The installed version keeps running and no update was downloaded.",
    action: "Try again later or verify a release directly on GitHub.",
  }),
});

const CODE_MAP = Object.freeze({
  EMPTY_RUNWAY: "runway_depleted",
  INSUFFICIENT_RUNWAY: "runway_depleted",
  INSUFFICIENT_GAS: "insufficient_gas",
  TRANSACTION_UNCERTAIN: "transaction_uncertain",
  SQLITE_CORRUPT: "database_damaged",
  SQLITE_NOTADB: "database_damaged",
  DATABASE_DAMAGED: "database_damaged",
  BRAIN_MALFORMED: "brain_malformed",
  BRAIN_UNAVAILABLE: "brain_unavailable",
  WAKU_UNAVAILABLE: "waku_unavailable",
  WAKU_STORE_UNAVAILABLE: "store_history_unavailable",
  RPC_UNAVAILABLE: "rpc_unavailable",
  UPDATE_UNAVAILABLE: "update_unavailable",
});

function classifyFailure(error, context = {}) {
  const forced = String(context.issueCode || "").toLowerCase();
  if (ISSUE_DEFINITIONS[forced]) return forced;
  const code = String(error?.code || "").toUpperCase();
  if (CODE_MAP[code]) return CODE_MAP[code];
  const operation = String(context.operation || "").toLowerCase();
  const channel = String(context.channel || "").toLowerCase();
  const message = String(error?.message || error || "").toLowerCase();
  if (/sqlite|database.*(?:malformed|corrupt|disk image)/.test(message)) return "database_damaged";
  if (/runway/.test(message) && /empty|deplet|insufficient/.test(message)) return "runway_depleted";
  if (/insufficient funds|intrinsic gas|gas required|not enough eth/.test(message)) return "insufficient_gas";
  if (/invalid decision|decision envelope|raw json|unexpected token|unreadable format|malformed/.test(message) && channel === "brain") {
    return "brain_malformed";
  }
  if (channel === "brain" || operation.includes("brain") || operation.includes("inference")) return "brain_unavailable";
  if (operation.includes("store") || context.store === true) return "store_history_unavailable";
  if (channel === "waku" || operation.includes("mesh") || operation.includes("waku")) return "waku_unavailable";
  if (operation.includes("update") || channel === "update") return "update_unavailable";
  if (/transaction/.test(message) && /pending|unknown|uncertain|timeout|not confirm/.test(message)) return "transaction_uncertain";
  if (channel === "base" || operation.includes("state_sync") || /rpc|network error|failed to fetch|server response/.test(message)) {
    return "rpc_unavailable";
  }
  return null;
}

function publicIssue(code, input = {}, now = Date.now()) {
  const definition = ISSUE_DEFINITIONS[code];
  if (!definition) throw new RangeError("health issue code is invalid");
  return Object.freeze({
    code,
    ...definition,
    operation: String(input.operation || "").replace(/[^a-z0-9_:-]/gi, "_").slice(0, 40) || null,
    firstSeenAt: Number(input.firstSeenAt || now),
    lastSeenAt: Number(now),
    occurrences: Math.max(1, Number(input.occurrences || 1)),
  });
}

class HealthMonitor extends EventEmitter {
  constructor({ now = () => Date.now() } = {}) {
    super();
    this.now = now;
    this.issues = new Map();
  }

  report(error, context = {}) {
    const code = classifyFailure(error, context);
    if (!code) return null;
    const previous = this.issues.get(code);
    const issue = publicIssue(code, {
      operation: context.operation,
      firstSeenAt: previous?.firstSeenAt,
      occurrences: Number(previous?.occurrences || 0) + 1,
    }, this.now());
    this.issues.set(code, issue);
    this.emit("changed", this.snapshot());
    return { ...issue };
  }

  resolve(code) {
    if (!this.issues.delete(code)) return false;
    this.emit("changed", this.snapshot());
    return true;
  }

  resolveSubsystem(subsystem) {
    let changed = false;
    for (const [code, issue] of this.issues) {
      if (issue.subsystem === subsystem) {
        this.issues.delete(code);
        changed = true;
      }
    }
    if (changed) this.emit("changed", this.snapshot());
    return changed;
  }

  snapshot() {
    const rank = { critical: 0, error: 1, warning: 2 };
    const issues = [...this.issues.values()]
      .sort((a, b) => (rank[a.severity] - rank[b.severity]) || (b.lastSeenAt - a.lastSeenAt))
      .map((issue) => ({ ...issue }));
    return {
      version: 1,
      status: issues.some((issue) => issue.severity === "critical")
        ? "recovery"
        : issues.some((issue) => issue.severity === "error") ? "attention" : issues.length ? "limited" : "healthy",
      issues,
    };
  }
}

module.exports = { HealthMonitor, ISSUE_DEFINITIONS, classifyFailure };
