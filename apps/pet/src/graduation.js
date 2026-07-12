function integer(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function recordGraduationTransition(state, chain, now = Date.now()) {
  const previousClassId = integer(state?.classId);
  const nextClassId = integer(chain?.classId);
  if (!previousClassId || nextClassId <= previousClassId) return null;

  const completedClassId = nextClassId - 1;
  if (integer(state.lastCelebratedClassId) >= completedClassId) return null;
  if (integer(state.pendingGraduation?.classId) >= completedClassId) return state.pendingGraduation;

  const graduationFloorMicros = integer(chain.graduationFloorMicros, 1_000_000_000);
  const observedClassPotMicros = integer(state.classPotMicros, graduationFloorMicros);
  state.pendingGraduation = {
    version: 1,
    classId: completedClassId,
    nextClassId,
    tokenOrdinal: completedClassId - 1,
    classPotMicros: Math.max(observedClassPotMicros, graduationFloorMicros),
    classAgents: integer(state.classAgents, 1),
    graduationFloorMicros,
    detectedAt: integer(now),
  };
  return state.pendingGraduation;
}

function acknowledgeGraduation(state, classId) {
  classId = integer(classId);
  if (!classId || integer(state?.pendingGraduation?.classId) !== classId) {
    throw new Error("graduation acknowledgement does not match the pending class");
  }
  state.lastCelebratedClassId = Math.max(integer(state.lastCelebratedClassId), classId);
  delete state.pendingGraduation;
  return state;
}

module.exports = { acknowledgeGraduation, recordGraduationTransition };
