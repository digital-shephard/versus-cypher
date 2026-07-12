const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { validateManifest } = require("./lib/deployment-manifest");

async function main() {
  const manifestPath = process.env.VERSUS_DEPLOYMENT || path.join(__dirname, "..", "deployments", "base.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`Base deployment manifest not found: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.network !== "base" || Number(manifest.chainId) !== 8453) {
    throw new Error("verification requires a Base mainnet deployment manifest");
  }
  const schema = validateManifest(manifest);
  if (!schema.valid) throw new Error(`invalid manifest: ${schema.errors.join("; ")}`);
  const c = manifest.contracts;
  const args = manifest.constructorArguments;
  const jobs = [
    ["AgentNFT", "agents"],
    ["SyndicateEngine", "syndicate"],
    ["TrancheTreasury", "treasury"],
    ["MissionEscrow", "missionEscrow"],
    ["ReferralPool", "referralPool"],
    ["Arena", "arena"],
    ["GraduationModule", "graduation"],
  ];

  const results = [];
  for (const [name, key] of jobs) {
    const address = c[key];
    const constructorArguments = args[key];
    try {
      await hre.run("verify:verify", { address, constructorArguments });
      console.log(`verified ${name}: ${address}`);
      results.push({ name, address, status: "verified" });
    } catch (error) {
      const message = String(error?.message || error);
      if (/already verified/i.test(message)) {
        console.log(`already verified ${name}: ${address}`);
        results.push({ name, address, status: "already-verified" });
      }
      else throw error;
    }
  }
  const checkedAt = new Date().toISOString();
  manifest.verification = manifest.verification || {};
  manifest.verification.basescan = { status: "verified", checkedAt, contracts: results };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const reportPath = path.join(path.dirname(manifestPath), "base-source-verification.json");
  fs.writeFileSync(reportPath, JSON.stringify({
    kind: "versus-base-source-verification",
    manifestVersion: manifest.manifestVersion,
    source: manifest.source,
    checkedAt,
    contracts: results,
  }, null, 2));
  console.log(`wrote ${reportPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
