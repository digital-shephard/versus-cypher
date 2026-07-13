const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  PACKAGED_DEPLOYMENT_RELATIVE_PATH,
  applyPackagedProductionDeployment,
} = require("../src/runtime-deployment");

test("packaged production defaults to its bundled Base deployment", () => {
  const env = {};
  const resourcesPath = path.resolve("test-resources");
  const expected = path.join(resourcesPath, PACKAGED_DEPLOYMENT_RELATIVE_PATH);

  const selected = applyPackagedProductionDeployment({
    isPackaged: true,
    resourcesPath,
    env,
    existsSync: (candidate) => candidate === expected,
  });

  assert.equal(selected, expected);
  assert.equal(env.VERSUS_DEPLOYMENT, expected);
});

test("packaged production fails closed when its Base deployment is absent", () => {
  assert.throws(
    () => applyPackagedProductionDeployment({
      isPackaged: true,
      resourcesPath: path.resolve("missing-resources"),
      env: {},
      existsSync: () => false,
    }),
    /Packaged Base deployment is missing/
  );
});

test("development and isolated walkthroughs do not silently select Base", () => {
  const developmentEnv = {};
  const walkthroughEnv = {};

  assert.equal(applyPackagedProductionDeployment({
    isPackaged: false,
    resourcesPath: path.resolve("resources"),
    env: developmentEnv,
  }), null);
  assert.equal(applyPackagedProductionDeployment({
    isPackaged: true,
    resourcesPath: path.resolve("resources"),
    walkthroughProfile: true,
    env: walkthroughEnv,
  }), null);
  assert.equal(developmentEnv.VERSUS_DEPLOYMENT, undefined);
  assert.equal(walkthroughEnv.VERSUS_DEPLOYMENT, undefined);
});

test("an explicit deployment remains authoritative", () => {
  const env = { VERSUS_DEPLOYMENT: path.resolve("custom.json") };
  assert.equal(applyPackagedProductionDeployment({
    isPackaged: true,
    resourcesPath: path.resolve("resources"),
    env,
    existsSync: () => false,
  }), env.VERSUS_DEPLOYMENT);
});
