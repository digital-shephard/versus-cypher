const FAULTS = Object.freeze({
  rpc: ["RPC_UNAVAILABLE", "Public Base RPC is unavailable"],
  waku: ["WAKU_UNAVAILABLE", "Waku relay is unavailable"],
  store: ["WAKU_STORE_UNAVAILABLE", "Waku Store history is unavailable"],
  gas: ["INSUFFICIENT_GAS", "Not enough ETH remains for gas"],
  runway: ["EMPTY_RUNWAY", "Cypher runway is empty"],
  brain: ["BRAIN_UNAVAILABLE", "Brain endpoint is unavailable"],
  brain_malformed: ["BRAIN_MALFORMED", "Brain returned an invalid decision envelope"],
  transaction: ["TRANSACTION_UNCERTAIN", "Transaction confirmation is uncertain"],
  database: ["DATABASE_DAMAGED", "Local database disk image is malformed"],
  update: ["UPDATE_UNAVAILABLE", "Update provider is unavailable"],
});

function parseFaults(value) {
  return new Set(String(value || "").split(",").map((item) => item.trim().toLowerCase()).filter((item) => FAULTS[item]));
}

class FaultInjector {
  constructor(value = "") {
    this.active = parseFaults(value);
  }

  enabled(name) {
    return this.active.has(String(name || "").toLowerCase());
  }

  throwIf(name) {
    name = String(name || "").toLowerCase();
    if (!this.active.has(name)) return false;
    const [code, message] = FAULTS[name];
    const error = new Error(message);
    error.code = code;
    throw error;
  }
}

module.exports = { FAULTS, FaultInjector, parseFaults };
