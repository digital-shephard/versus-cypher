const fs = require("node:fs");
const path = require("node:path");
const { buildFxDesktopMarket } = require("@versus/network");

const FX_MARKET_DEPLOYMENT_ENVIRONMENT_VARIABLE =
  "VERSUS_FX_MARKET_DEPLOYMENT";

function loadFxMarketRuntime(environment = process.env) {
  const configuredPath = String(
    environment[FX_MARKET_DEPLOYMENT_ENVIRONMENT_VARIABLE] || ""
  ).trim();
  if (!configuredPath) return null;
  if (!path.isAbsolute(configuredPath)) {
    throw new Error(
      `${FX_MARKET_DEPLOYMENT_ENVIRONMENT_VARIABLE} must be an absolute path`
    );
  }
  const deployment = JSON.parse(fs.readFileSync(configuredPath, "utf8"));
  return {
    deploymentPath: path.resolve(configuredPath),
    ...buildFxDesktopMarket(deployment),
  };
}

module.exports = {
  FX_MARKET_DEPLOYMENT_ENVIRONMENT_VARIABLE,
  loadFxMarketRuntime,
};
