const fs = require("fs");
const path = require("path");

const PACKAGED_DEPLOYMENT_RELATIVE_PATH = path.join("deployment", "base.json");

function applyPackagedProductionDeployment({
  isPackaged,
  resourcesPath,
  walkthroughProfile = false,
  env = process.env,
  existsSync = fs.existsSync,
} = {}) {
  if (!isPackaged || env.VERSUS_DEPLOYMENT) return env.VERSUS_DEPLOYMENT || null;
  if (walkthroughProfile) return null;

  const deploymentPath = path.join(resourcesPath, PACKAGED_DEPLOYMENT_RELATIVE_PATH);
  if (!existsSync(deploymentPath)) {
    throw new Error(`Packaged Base deployment is missing: ${deploymentPath}`);
  }
  env.VERSUS_DEPLOYMENT = deploymentPath;
  return deploymentPath;
}

module.exports = {
  PACKAGED_DEPLOYMENT_RELATIVE_PATH,
  applyPackagedProductionDeployment,
};
