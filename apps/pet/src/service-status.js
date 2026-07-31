const LIVE_WAKU_STATES = new Set([
  "ready",
  "live",
  "caught_up",
  "degraded_store",
]);

function normalizedState(value) {
  return String(value || "").trim().toLowerCase();
}

function fxWakuStates(status = {}) {
  return [
    status.broker?.transport?.state,
    status.requester?.transport?.state,
    status.relayer?.transport?.state,
    status.dealer?.transport?.state,
  ]
    .map(normalizedState)
    .filter(Boolean);
}

function combinedWakuState(coreState, fxStatus = {}) {
  const states = [normalizedState(coreState), ...fxWakuStates(fxStatus)]
    .filter(Boolean);
  const liveState = states.find((state) => LIVE_WAKU_STATES.has(state));
  if (liveState) return liveState === "degraded_store" ? "live" : liveState;
  if (states.includes("reconnecting")) return "reconnecting";
  if (states.some((state) => ["offline", "off", "error"].includes(state))) {
    return "offline";
  }
  return normalizedState(coreState) || "not_configured";
}

module.exports = {
  combinedWakuState,
  fxWakuStates,
};
