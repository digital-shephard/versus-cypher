const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeSettings, publicSettings } = require("../src/settings");

test("FX development remains disabled when the build does not expose it", () => {
  const settings = normalizeSettings(
    { fxDevelopmentEnabled: true },
    { fxDevelopmentAvailable: false }
  );
  assert.equal(settings.fxDevelopmentEnabled, false);
});

test("FX development can be enabled only under an explicit development gate", () => {
  const settings = {
    ...normalizeSettings(
      { fxDevelopmentEnabled: true },
      { fxDevelopmentAvailable: true }
    ),
    fxDevelopmentAvailable: true,
  };
  assert.equal(settings.fxDevelopmentEnabled, true);
  assert.deepEqual(
    {
      available: publicSettings(settings).fxDevelopmentAvailable,
      enabled: publicSettings(settings).fxDevelopmentEnabled,
    },
    { available: true, enabled: true }
  );
});
