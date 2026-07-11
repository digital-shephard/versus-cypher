const fs = require("fs");
const path = require("path");
const {
  ARTIFACT_REFERENCE_PATTERN,
  verifyOutcomePostcardArtifact,
} = require("./artifact-store");

const OUTCOME_VERDICTS = Object.freeze(["success", "partial", "failure", "unsubstantiated"]);
const VERDICT_DELTAS = Object.freeze({
  success: {
    mission: { execution: 4, stewardship: 2, integrity: 1 },
    reporter: { integrity: 1 },
  },
  partial: {
    mission: { execution: 1 },
    reporter: { integrity: 1 },
  },
  failure: {
    mission: { execution: -3, stewardship: -2 },
    reporter: { integrity: 1 },
  },
  unsubstantiated: {
    mission: {},
    reporter: { integrity: -3 },
  },
});

class OutcomeAssessmentError extends Error {
  constructor(message, code = "INVALID_OUTCOME_ASSESSMENT") {
    super(message);
    this.name = "OutcomeAssessmentError";
    this.code = code;
  }
}

function scaledScores(scores, confidence) {
  return Object.fromEntries(
    Object.entries(scores).map(([dimension, value]) => [
      dimension,
      Math.round((value * confidence) / 100),
    ])
  );
}

function normalizeNote(value) {
  if (value == null || value === "") return "";
  if (typeof value !== "string") throw new OutcomeAssessmentError("assessment note must be text");
  const note = value.normalize("NFC").trim().replace(/\s+/g, " ");
  if (note.length > 240 || /[\u0000-\u001f\u007f]/.test(note)) {
    throw new OutcomeAssessmentError("assessment note must be at most 240 visible characters");
  }
  return note;
}

class OutcomeLedger {
  constructor({ store, trust, artifactStore, filePath = null, now = () => Date.now() }) {
    if (!store || !trust || !artifactStore) {
      throw new TypeError("outcome ledger requires postcard artifact and trust stores");
    }
    this.store = store;
    this.trust = trust;
    this.artifactStore = artifactStore;
    this.filePath = filePath;
    this.now = now;
    this.assessments = new Map();
    this.load();
  }

  load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch (error) {
      throw new OutcomeAssessmentError(`outcome ledger is unreadable: ${error.message}`, "BAD_OUTCOME_LEDGER");
    }
    for (const assessment of parsed.assessments || []) {
      if (assessment && typeof assessment.outcomeId === "string") {
        this.assessments.set(assessment.outcomeId, assessment);
      }
    }
  }

  save() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(
      temporary,
      `${JSON.stringify({ version: 1, assessments: this.list() }, null, 2)}\n`,
      "utf8"
    );
    fs.renameSync(temporary, this.filePath);
  }

  assess({ outcomeId, verdict, confidence = 100, note = "" }) {
    const outcome = this.store.get(outcomeId);
    if (!outcome || outcome.type !== "outcome") {
      throw new OutcomeAssessmentError("assessment target must be an outcome postcard", "UNKNOWN_OUTCOME");
    }
    const mission = this.store.get(outcome.replyTo);
    if (!mission || mission.type !== "mission" || mission.launchId !== outcome.launchId) {
      throw new OutcomeAssessmentError("outcome does not reference a known mission", "UNKNOWN_MISSION");
    }
    verdict = String(verdict || "");
    if (!OUTCOME_VERDICTS.includes(verdict)) {
      throw new OutcomeAssessmentError("assessment verdict is unsupported");
    }
    confidence = Number(confidence);
    if (!Number.isInteger(confidence) || confidence < 1 || confidence > 100) {
      throw new OutcomeAssessmentError("assessment confidence must be an integer from 1 to 100");
    }
    note = normalizeNote(note);

    let manifest = null;
    if (ARTIFACT_REFERENCE_PATTERN.test(String(outcome.artifact))) {
      manifest = this.artifactStore.get(outcome.artifact);
      if (!manifest) {
        throw new OutcomeAssessmentError("outcome evidence manifest is unavailable", "MISSING_OUTCOME_ARTIFACT");
      }
      manifest = verifyOutcomePostcardArtifact(outcome, mission, manifest);
      if (
        verdict !== "unsubstantiated" &&
        (manifest.evidenceReferences.length < 1 ||
          manifest.evidenceReferences.some((reference) => !this.artifactStore.get(reference)))
      ) {
        throw new OutcomeAssessmentError(
          "outcome evidence objects are unavailable locally",
          "MISSING_OUTCOME_EVIDENCE"
        );
      }
    } else if (verdict !== "unsubstantiated") {
      throw new OutcomeAssessmentError(
        "a substantiated verdict requires a content addressed outcome manifest",
        "MISSING_OUTCOME_ARTIFACT"
      );
    }

    const deltas = VERDICT_DELTAS[verdict];
    const missionSource = `outcome:${outcome.id}:mission`;
    const reporterSource = `outcome:${outcome.id}:reporter`;
    this.trust.setContribution(
      missionSource,
      mission.author,
      scaledScores(deltas.mission, confidence)
    );
    this.trust.setContribution(
      reporterSource,
      outcome.author,
      scaledScores(deltas.reporter, confidence)
    );

    const assessment = {
      outcomeId: outcome.id,
      missionId: mission.id,
      missionAuthor: mission.author,
      reporter: outcome.author,
      claimedStatus: manifest?.status || null,
      verdict,
      confidence,
      note,
      assessedAt: this.now(),
    };
    this.assessments.set(outcome.id, assessment);
    this.save();
    return assessment;
  }

  remove(outcomeId) {
    const existed = this.assessments.delete(outcomeId);
    this.trust.removeContribution(`outcome:${outcomeId}:mission`);
    this.trust.removeContribution(`outcome:${outcomeId}:reporter`);
    if (existed) this.save();
    return existed;
  }

  get(outcomeId) {
    return this.assessments.get(outcomeId) || null;
  }

  list() {
    return Array.from(this.assessments.values()).sort((a, b) => a.assessedAt - b.assessedAt);
  }
}

module.exports = {
  OUTCOME_VERDICTS,
  OutcomeAssessmentError,
  OutcomeLedger,
  VERDICT_DELTAS,
};
