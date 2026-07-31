const DURATION_MS = 60_000;

const GRANT_DEMO_BEATS = Object.freeze({
  ready: 0,
  hatch: 2_500,
  rain: 11_000,
  classOver: 22_000,
  graduation: 24_300,
  signal: 38_000,
  think: 41_000,
  thought: 44_000,
  service: 49_000,
  complete: DURATION_MS,
});

function validateGrantDemoTimeline(beats = GRANT_DEMO_BEATS) {
  const values = Object.values(beats);
  if (values[0] !== 0 || values.at(-1) !== DURATION_MS) return false;
  return values.every((value, index) => (
    Number.isSafeInteger(value) && value >= 0 && (index === 0 || value > values[index - 1])
  ));
}

module.exports = {
  DURATION_MS,
  GRANT_DEMO_BEATS,
  validateGrantDemoTimeline,
};
