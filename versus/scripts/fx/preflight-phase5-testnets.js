const fs = require("node:fs");
const path = require("node:path");
const {
  ContractFactory,
  JsonRpcProvider,
  keccak256,
} = require("ethers");
const { NETWORKS } = require("./phase5-testnet-config");

const MINIMUM_LOCK_SECONDS = 60;
const MAXIMUM_LOCK_SECONDS = 7 * 24 * 60 * 60;

function artifact(root, source, contract) {
  return JSON.parse(
    fs.readFileSync(
      path.join(root, "artifacts", "contracts", source, `${contract}.json`),
      "utf8"
    )
  );
}

function fee(value) {
  return value == null ? null : BigInt(value).toString();
}

async function preflightNetwork(
  network,
  tokenArtifact,
  adapterArtifact,
  deployerAddress
) {
  const rpcUrl =
    process.env[network.rpcEnvironmentVariable] || network.publicRpcUrl;
  const provider = new JsonRpcProvider(rpcUrl, BigInt(network.chainId), {
    staticNetwork: true,
    cacheTimeout: -1,
  });
  const connected = await provider.getNetwork();
  if (String(connected.chainId) !== network.chainId) {
    throw new Error(
      `${network.name} RPC returned ${connected.chainId}, expected ${network.chainId}`
    );
  }
  const tokenFactory = new ContractFactory(
    tokenArtifact.abi,
    tokenArtifact.bytecode
  );
  const adapterFactory = new ContractFactory(
    adapterArtifact.abi,
    adapterArtifact.bytecode
  );
  const tokenDeployment = await tokenFactory.getDeployTransaction();
  const adapterDeployment = await adapterFactory.getDeployTransaction(
    network.canonicalTestUsdc,
    6,
    MINIMUM_LOCK_SECONDS,
    MAXIMUM_LOCK_SECONDS
  );
  const [
    block,
    feeData,
    tokenRuntime,
    adapterRuntime,
    canonicalUsdcCode,
    deployerBalance,
  ] =
    await Promise.all([
    provider.getBlock("latest"),
    provider.getFeeData(),
    provider.call(tokenDeployment),
    provider.call(adapterDeployment),
    provider.getCode(network.canonicalTestUsdc),
    deployerAddress ? provider.getBalance(deployerAddress) : Promise.resolve(null),
  ]);
  if (!tokenRuntime || tokenRuntime === "0x") {
    throw new Error(`${network.name} did not execute the token creation bytecode`);
  }
  if (!adapterRuntime || adapterRuntime === "0x") {
    throw new Error(`${network.name} did not execute the HTLC creation bytecode`);
  }
  if (!canonicalUsdcCode || canonicalUsdcCode === "0x") {
    throw new Error(`${network.name} canonical test USDC has no contract code`);
  }
  return {
    name: network.name,
    chainId: network.chainId,
    rpcSource: process.env[network.rpcEnvironmentVariable]
      ? network.rpcEnvironmentVariable
      : "official-public-rpc",
    explorerUrl: network.explorerUrl,
    canonicalTestUsdc: network.canonicalTestUsdc.toLowerCase(),
    latestBlock: {
      number: Number(block.number),
      hash: block.hash.toLowerCase(),
      timestamp: Number(block.timestamp),
      ageSeconds: Math.max(
        0,
        Math.floor(Date.now() / 1000) - Number(block.timestamp)
      ),
    },
    fees: {
      gasPrice: fee(feeData.gasPrice),
      maxFeePerGas: fee(feeData.maxFeePerGas),
      maxPriorityFeePerGas: fee(feeData.maxPriorityFeePerGas),
    },
    creationSimulation: {
      tokenRuntimeCodeHash: keccak256(tokenRuntime),
      tokenRuntimeBytes: (tokenRuntime.length - 2) / 2,
      adapterRuntimeCodeHash: keccak256(adapterRuntime),
      adapterRuntimeBytes: (adapterRuntime.length - 2) / 2,
    },
    funding: deployerAddress
      ? {
          deployer: deployerAddress,
          balanceWei: deployerBalance.toString(),
          minimumWei: network.minimumDeployerBalanceWei,
          ready:
            deployerBalance >= BigInt(network.minimumDeployerBalanceWei),
        }
      : null,
  };
}

async function main() {
  const contractsRoot = path.resolve(__dirname, "..", "..");
  const repositoryRoot = path.resolve(contractsRoot, "..");
  const tokenArtifact = artifact(
    contractsRoot,
    "test/MockUSDC.sol",
    "MockUSDC"
  );
  const adapterArtifact = artifact(
    contractsRoot,
    "fx/EvmHtlcV1.sol",
    "EvmHtlcV1"
  );
  const identityPath = path.join(
    repositoryRoot,
    ".local",
    "fx-phase5-testnet",
    "identities.public.json"
  );
  const deployerAddress = fs.existsSync(identityPath)
    ? JSON.parse(fs.readFileSync(identityPath, "utf8")).identities.deployer
    : null;
  const results = [];
  for (const network of Object.values(NETWORKS)) {
    results.push(
      await preflightNetwork(
        network,
        tokenArtifact,
        adapterArtifact,
        deployerAddress
      )
    );
  }
  const evidence = {
    schema: "versus-fx-phase5-testnet-preflight",
    schemaVersion: 1,
    environment: "public-testnet",
    productionFunds: false,
    generatedAt: new Date().toISOString(),
    results,
  };
  const outputPath = path.join(
    repositoryRoot,
    ".local",
    "fx-phase5-testnet",
    "preflight.json"
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify({ outputPath, results }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
