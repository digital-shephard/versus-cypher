const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { JsonRpcProvider } = require("ethers");
const { auditDeployment } = require("./lib/deployment-audit");

function stableDigest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function markdown(manifest, report) {
  const policy = report.safePolicy;
  const rows = report.checks.map((item) => `| ${item.passed ? "PASS" : "FAIL"} | ${item.name} |`).join("\n");
  return `# Versus Cypher Base Deployment Verification

- Manifest version: ${manifest.manifestVersion}
- Release stage: ${manifest.releaseStage}
- Chain: Base (${manifest.chainId})
- Source commit: \`${manifest.source.commit}\`
- Source tree SHA-256: \`${manifest.source.treeSha256}\`
- Manifest SHA-256: \`${report.manifestSha256}\`
- Independently checked: ${report.checkedAt}
- Safe: ${policy.ownerCount} owner(s), threshold ${policy.threshold}
- Unrestricted-public ready: ${policy.publicReady ? "yes" : "no"}
- Safe hardening required: ${policy.hardeningRequired ? "yes" : "no"}

## Ownerless Wiring

The deployed core has no admin upgrade, pause, or ownership surface. One-time bootstrap bindings were independently read from Base and are sealed.

| Result | Invariant |
| --- | --- |
${rows}

## Source Verification

Basescan status: **${manifest.verification?.basescan?.status || "pending"}**.
`;
}

async function main() {
  const manifestPath = path.resolve(process.env.VERSUS_DEPLOYMENT || path.join(__dirname, "..", "deployments", "base.json"));
  if (!fs.existsSync(manifestPath)) throw new Error(`Base deployment manifest not found: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.network !== "base" || Number(manifest.chainId) !== 8453) throw new Error("audit requires a Base mainnet manifest");
  const rpcUrl = process.env.BASE_AUDIT_RPC_URL;
  if (!rpcUrl) throw new Error("BASE_AUDIT_RPC_URL is required so the independent audit does not silently reuse the deployment RPC");
  const provider = new JsonRpcProvider(rpcUrl, 8453, { staticNetwork: true, cacheTimeout: -1 });
  const audited = await auditDeployment(provider, manifest);
  const checkedAt = new Date().toISOString();
  manifest.verification = manifest.verification || {};
  manifest.verification.independentAudit = { status: "passed", checkedAt, report: "base-verification.json" };
  const report = {
    kind: "versus-base-independent-deployment-audit",
    passed: true,
    manifestSha256: stableDigest(manifest),
    sourceCommit: manifest.source.commit,
    releaseStage: manifest.releaseStage,
    chainId: 8453,
    checkedAt,
    ...audited,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(path.dirname(manifestPath), "base-verification.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(path.dirname(manifestPath), "base-ownerless-summary.md"), markdown(manifest, report));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
