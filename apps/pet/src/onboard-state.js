const INTERRUPTED_HATCH_PHASES = new Set(["swapping", "minting"]);

function isInterruptedHatch(state) {
  return Boolean(
    state &&
    !state.agentId &&
    INTERRUPTED_HATCH_PHASES.has(String(state.phase || ""))
  );
}

function activateConfirmedHatch(state, result, walletAddress, now = Date.now()) {
  if (!state || typeof state !== "object") throw new TypeError("hatch state is required");
  const agentId = Number(result?.agentId);
  const cypherId = Number(result?.cypherId);
  const runway = Number(result?.runway);
  if (!Number.isSafeInteger(agentId) || agentId <= 0) throw new RangeError("confirmed hatch agent ID is invalid");
  if (!Number.isInteger(cypherId) || cypherId < 0) throw new RangeError("confirmed hatch Cypher ID is invalid");
  if (!Number.isSafeInteger(runway) || runway < 0) throw new RangeError("confirmed hatch runway is invalid");

  Object.assign(state, {
    phase: "active",
    agentId,
    cypherId,
    runway,
    usdcMicros: runway,
    walletAddress: String(walletAddress || result.owner || state.walletAddress || ""),
    level: 0,
    streak: 0,
    lastCommitDay: 0,
    nextCommitAt: Number(result.nextCommitAt || Math.floor(now / 1000)),
    vault: 0,
    tickets: 0,
    totalTickets: Number(state.totalTickets || 0),
    trancheClaimableMicros: 0,
    tranchePreviewMicros: 0,
    rainPenniesToday: 0,
    classAgents: Number(state.classAgents || 0),
    inCurrentClass: false,
    onboardedAt: Number(state.onboardedAt || now),
  });
  if (result.swapHash) state.swapTxHash = String(result.swapHash);
  if (result.hatchHash) state.hatchTxHash = String(result.hatchHash);
  if (result.blockNumber != null) state.hatchBlockNumber = Number(result.blockNumber);
  if (result.referrerAgentId != null) state.referredBy = Number(result.referrerAgentId);
  delete state.pendingReferralCode;
  delete state.pendingReferrerAgentId;
  delete state.lastHatchError;
  return state;
}

module.exports = {
  activateConfirmedHatch,
  isInterruptedHatch,
};
