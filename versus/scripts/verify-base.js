const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const manifestPath = process.env.VERSUS_DEPLOYMENT || path.join(__dirname, "..", "deployments", "base.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`Base deployment manifest not found: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.network !== "base" || Number(manifest.chainId) !== 8453) {
    throw new Error("verification requires a Base mainnet deployment manifest");
  }
  const c = manifest.contracts;
  const floor = BigInt(manifest.economics.graduationFloorRaw);
  const jobs = [
    ["AgentNFT", c.agents, [c.usdc]],
    ["SyndicateEngine", c.syndicate, [c.usdc, floor]],
    ["TrancheTreasury", c.treasury, [c.usdc, manifest.protocolRecipient]],
    ["MissionEscrow", c.missionEscrow, [c.usdc, c.agents]],
    ["Arena", c.arena, [c.usdc, c.agents, c.syndicate, c.treasury]],
    ["GraduationModule", c.graduation, [c.usdc, c.v2Router, c.syndicate, c.treasury]],
  ];

  for (const [name, address, constructorArguments] of jobs) {
    try {
      await hre.run("verify:verify", { address, constructorArguments });
      console.log(`verified ${name}: ${address}`);
    } catch (error) {
      const message = String(error?.message || error);
      if (/already verified/i.test(message)) console.log(`already verified ${name}: ${address}`);
      else throw error;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
