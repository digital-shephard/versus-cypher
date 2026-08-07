const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");
const {
  assert,
  networkFor,
  preflightMarketChain,
  preflightMarketDeployment,
  readMarket,
} = require("./market-candidate-config");

const NETWORK_IDS = Object.freeze({
  baseSepolia: "base-sepolia",
  avalancheFuji: "avalanche-fuji",
});

function alreadyVerified(error) {
  return /already verified|already been verified/i.test(String(error?.message || error));
}

function retryable(error) {
  return /rate limit|too many requests/i.test(String(error?.message || error));
}

async function verify(args) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      await hre.run("verify:verify", args);
      return "verified";
    } catch (error) {
      if (alreadyVerified(error)) return "already-verified";
      if (!retryable(error) || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 5_000));
    }
  }
  throw new Error("unreachable market verification state");
}

async function main() {
  assert(
    process.env.FX_EXPLORER_VERIFY === "true",
    "set FX_EXPLORER_VERIFY=true to submit explorer verification"
  );
  const networkId = NETWORK_IDS[hre.network.name];
  assert(networkId, "market verification is restricted to Base Sepolia and Avalanche Fuji");
  const contractsRoot = path.resolve(__dirname, "..", "..");
  const market = readMarket(contractsRoot, "testnet");
  const network = networkFor(market, networkId);
  const recordPath = path.join(
    contractsRoot,
    "deployments",
    "fx",
    `${network.key}-${network.chainId}-market-v1-testnet.json`
  );
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  await preflightMarketChain(hre.ethers.provider, network);
  await preflightMarketDeployment(hre.ethers.provider, network, record);

  record.evidence.nativeVerification = await verify({
    address: record.native.address,
    constructorArguments: [
      market.timeoutPolicy.minimumSeconds,
      market.timeoutPolicy.maximumSeconds,
    ],
    contract: "contracts/fx/EvmNativeHtlcV3.sol:EvmNativeHtlcV3",
  });
  record.evidence.erc20Verification = {};
  for (const deployed of record.erc20s) {
    const asset = network.assets.find((candidate) => candidate.symbol === deployed.symbol);
    const adapterStatus = await verify({
      address: deployed.adapter.address,
      constructorArguments: [
        asset.token,
        asset.decimals,
        market.timeoutPolicy.minimumSeconds,
        market.timeoutPolicy.maximumSeconds,
      ],
      contract: "contracts/fx/EvmHtlcV3.sol:EvmHtlcV3",
    });
    const exactFactoryStatus = await verify({
      address: deployed.exactFactory.address,
      constructorArguments: [asset.token, deployed.adapter.address],
      contract: "contracts/fx/EvmExactHtlcFactory.sol:EvmExactHtlcFactory",
    });
    record.evidence.erc20Verification[deployed.symbol] = {
      adapterStatus,
      exactFactoryStatus,
    };
  }
  record.evidence.verificationStatus = "verified";
  record.evidence.verifiedAt = new Date().toISOString();
  record.evidence.preflight = await preflightMarketDeployment(
    hre.ethers.provider,
    network,
    record
  );
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify({
    chainId: network.chainId,
    verificationStatus: record.evidence.verificationStatus,
    native: record.native.address,
    erc20s: record.evidence.erc20Verification,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
