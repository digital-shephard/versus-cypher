const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");
const {
  HARDHAT_NETWORK_IDS,
  MAXIMUM_SECONDS,
  MINIMUM_SECONDS,
  TOKEN_ADDRESS,
  TOKEN_DECIMALS,
  assert,
  deploymentPaths,
  preflightV3Capability,
  validateV3Manifest,
} = require("./v3-deployment-manifest");

function alreadyVerified(error) {
  const message = String(error?.message || error).toLowerCase();
  return message.includes("already verified") || message.includes("already been verified");
}

function rateLimited(error) {
  const message = String(error?.message || error).toLowerCase();
  return message.includes("rate limit") || message.includes("too many requests");
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function verifyOne(arguments_) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      await hre.run("verify:verify", arguments_);
      return "verified";
    } catch (error) {
      if (alreadyVerified(error)) return "already-verified";
      if (!rateLimited(error) || attempt === 4) throw error;
      await sleep(attempt * 5_000);
    }
  }
  throw new Error("unreachable V3 verification retry state");
}

async function main() {
  assert(
    process.env.FX_EXPLORER_VERIFY === "true",
    "set FX_EXPLORER_VERIFY=true to submit V3 explorer verification"
  );
  const networkId = HARDHAT_NETWORK_IDS[hre.network.name];
  assert(networkId, "V3 verification is restricted to public testnets");
  const contractsRoot = path.resolve(__dirname, "..", "..");
  const { network, outputPath } = deploymentPaths(contractsRoot, networkId);
  const record = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  const manifest = validateV3Manifest(record, contractsRoot);
  const preflight = await preflightV3Capability(
    hre.ethers.provider,
    manifest,
    network.chainId
  );
  const nativeStatus = await verifyOne({
    address: preflight.native.adapterAddress,
    constructorArguments: [MINIMUM_SECONDS, MAXIMUM_SECONDS],
    contract: "contracts/fx/EvmNativeHtlcV3.sol:EvmNativeHtlcV3",
  });
  await sleep(2_500);
  const erc20Status = await verifyOne({
    address: preflight.erc20.adapterAddress,
    constructorArguments: [
      TOKEN_ADDRESS,
      TOKEN_DECIMALS,
      MINIMUM_SECONDS,
      MAXIMUM_SECONDS,
    ],
    contract: "contracts/fx/EvmHtlcV3.sol:EvmHtlcV3",
  });
  const verifiedAt = new Date().toISOString();
  record.evidence.native.verification = {
    status: nativeStatus,
    sourceVerified: true,
    verifiedAt,
  };
  record.evidence.erc20.verification = {
    status: erc20Status,
    sourceVerified: true,
    verifiedAt,
  };
  record.evidence.preflight = preflight;
  fs.writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify({
    chainId: network.chainId,
    native: {
      address: preflight.native.adapterAddress,
      status: nativeStatus,
      url: record.evidence.native.explorerUrl,
    },
    erc20: {
      address: preflight.erc20.adapterAddress,
      status: erc20Status,
      url: record.evidence.erc20.explorerUrl,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
