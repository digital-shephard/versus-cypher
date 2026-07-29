const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeSettings, publicSettings } = require("../src/settings");

test("FX development availability follows the build gate", () => {
  const settings = normalizeSettings(
    { fxDevelopmentEnabled: true },
    { fxDevelopmentAvailable: false }
  );
  assert.equal("fxDevelopmentEnabled" in settings, false);
  assert.equal(
    publicSettings({ ...settings, fxDevelopmentAvailable: false })
      .fxDevelopmentAvailable,
    false
  );
});

test("legacy FX laboratory preference is not exposed as a user toggle", () => {
  const settings = {
    ...normalizeSettings(
      { fxDevelopmentEnabled: false },
      { fxDevelopmentAvailable: true }
    ),
    fxDevelopmentAvailable: true,
  };
  const publicState = publicSettings(settings);
  assert.equal(publicState.fxDevelopmentAvailable, true);
  assert.equal("fxDevelopmentEnabled" in publicState, false);
});
