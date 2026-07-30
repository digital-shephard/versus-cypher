const HASH_PATTERN = /^0x[0-9a-f]{64}$/;

function normalizedHash(value, label) {
  const hash = String(value || "").toLowerCase();
  if (!HASH_PATTERN.test(hash)) {
    throw new TypeError(`${label} must be a bytes32 hash`);
  }
  return hash;
}

function resolveFxBrokerCoordinationDomain({
  deploymentId,
  configuredDomain = null,
  x402Manifest = null,
} = {}) {
  const deployment = normalizedHash(deploymentId, "deploymentId");
  const manifestDeployment = x402Manifest
    ? normalizedHash(x402Manifest.deploymentId, "manifest deploymentId")
    : null;
  if (manifestDeployment && manifestDeployment !== deployment) {
    throw new Error("FX x402 manifest and coordination deployment differ");
  }

  const manifestDomain = x402Manifest
    ? normalizedHash(
        x402Manifest.coordinationDomain,
        "manifest coordinationDomain"
      )
    : null;
  const explicitDomain = configuredDomain
    ? normalizedHash(configuredDomain, "configured coordinationDomain")
    : null;
  if (
    manifestDomain &&
    explicitDomain &&
    manifestDomain !== explicitDomain
  ) {
    throw new Error(
      "FX broker coordination domain conflicts with the frozen x402 manifest"
    );
  }
  return explicitDomain || manifestDomain || deployment;
}

module.exports = {
  resolveFxBrokerCoordinationDomain,
};
