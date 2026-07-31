const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");
const {
  MAXIMUM_SECONDS,
  MINIMUM_SECONDS,
  assert,
  networkConfig,
  preflightDeployment,
} = require("./exact-testnet-config");

const IDS = { baseSepolia: "base-sepolia", arbitrumSepolia: "arbitrum-sepolia" };

function retryable(error) {
  return /rate limit|too many requests/i.test(String(error?.message || error));
}

async function verify(args) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      await hre.run("verify:verify", args);
      return "verified";
    } catch (error) {
      if (/already verified|already been verified/i.test(String(error?.message || error))) {
        return "already-verified";
      }
      if (!retryable(error) || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 5_000));
    }
  }
}

async function main() {
  assert(process.env.FX_EXPLORER_VERIFY === "true", "set FX_EXPLORER_VERIFY=true");
  const networkId = IDS[hre.network.name];
  const network = networkConfig(networkId);
  const filePath = path.resolve(
    __dirname,
    "..",
    "..",
    "deployments",
    "fx",
    `${network.key}-${network.chainId}-x402-exact.json`
  );
  const record = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const erc20Status = await verify({
    address: record.erc20.adapterAddress,
    constructorArguments: [
      record.token.address,
      6,
      MINIMUM_SECONDS,
      MAXIMUM_SECONDS,
    ],
    contract: "contracts/fx/EvmHtlcV3.sol:EvmHtlcV3",
  });
  const factoryStatus = await verify({
    address: record.exactFactory.address,
    constructorArguments: [record.token.address, record.erc20.adapterAddress],
    contract: "contracts/fx/EvmExactHtlcFactory.sol:EvmExactHtlcFactory",
  });
  record.evidence.erc20.verification = {
    status: erc20Status,
    sourceVerified: true,
    verifiedAt: new Date().toISOString(),
  };
  record.evidence.exactFactory.verification = {
    status: factoryStatus,
    sourceVerified: true,
    verifiedAt: new Date().toISOString(),
  };
  record.evidence.preflight = await preflightDeployment(
    hre.ethers.provider,
    network,
    record
  );
  fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify({ chainId: network.chainId, erc20Status, factoryStatus }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
