const fs = require("node:fs");
const path = require("node:path");
const {
  ContractFactory,
  JsonRpcProvider,
  Wallet,
  keccak256,
} = require("ethers");
const {
  preflightEvmCapability,
} = require("../../../packages/network/src/fx-evm-adapter");
const { buildFreezeRecord } = require("./build-freeze");
const { phase5Network } = require("./phase5-testnet-config");

const TOKEN_MINT_ATOMIC = 10_000_000n;
const MINIMUM_LOCK_SECONDS = 60;
const MAXIMUM_LOCK_SECONDS = 7 * 24 * 60 * 60;
const MINIMUM_CROSS_CHAIN_DELTA_SECONDS = 120;

function artifact(root, source, contract) {
  return JSON.parse(
    fs.readFileSync(
      path.join(root, "artifacts", "contracts", source, `${contract}.json`),
      "utf8"
    )
  );
}

async function decryptIdentity(directory, role, password) {
  return Wallet.fromEncryptedJson(
    fs.readFileSync(path.join(directory, `${role}.keystore.json`), "utf8"),
    password
  );
}

async function main() {
  const contractsRoot = path.resolve(__dirname, "..", "..");
  const repositoryRoot = path.resolve(contractsRoot, "..");
  const identityDirectory = path.resolve(
    process.env.FX_PHASE5_IDENTITY_DIRECTORY ||
      path.join(repositoryRoot, ".local", "fx-phase5-testnet")
  );
  const network = phase5Network(process.env.FX_PHASE5_NETWORK);
  const rpcUrl =
    process.env[network.rpcEnvironmentVariable] || network.publicRpcUrl;
  const password = fs
    .readFileSync(path.join(identityDirectory, "identity-password.txt"), "utf8")
    .trim();
  const identities = JSON.parse(
    fs.readFileSync(
      path.join(identityDirectory, "identities.public.json"),
      "utf8"
    )
  ).identities;
  const deployer = (
    await decryptIdentity(identityDirectory, "deployer", password)
  ).connect(
    new JsonRpcProvider(rpcUrl, BigInt(network.chainId), {
      staticNetwork: true,
      cacheTimeout: -1,
    })
  );
  const connected = await deployer.provider.getNetwork();
  if (String(connected.chainId) !== network.chainId) {
    throw new Error(`RPC returned chain ${connected.chainId}, expected ${network.chainId}`);
  }

  const outputPath = path.join(
    identityDirectory,
    "deployments",
    `${process.env.FX_PHASE5_NETWORK}.json`
  );
  if (fs.existsSync(outputPath)) {
    throw new Error(`deployment record already exists at ${outputPath}`);
  }
  const balance = await deployer.provider.getBalance(deployer.address);
  if (balance < BigInt(network.minimumDeployerBalanceWei)) {
    throw new Error(
      `deployer ${deployer.address} needs at least ${network.minimumDeployerBalanceWei} wei on ${network.name}; current balance is ${balance}`
    );
  }

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
  const token = await new ContractFactory(
    tokenArtifact.abi,
    tokenArtifact.bytecode,
    deployer
  ).deploy();
  const tokenDeployment = await token.deploymentTransaction().wait();
  const tokenAddress = (await token.getAddress()).toLowerCase();

  const adapter = await new ContractFactory(
    adapterArtifact.abi,
    adapterArtifact.bytecode,
    deployer
  ).deploy(
    tokenAddress,
    6,
    MINIMUM_LOCK_SECONDS,
    MAXIMUM_LOCK_SECONDS
  );
  const adapterDeployment = await adapter.deploymentTransaction().wait();
  const adapterAddress = (await adapter.getAddress()).toLowerCase();

  const mintReceipts = {};
  for (const role of ["requester", "dealer"]) {
    const transaction = await token.mint(identities[role], TOKEN_MINT_ATOMIC);
    const receipt = await transaction.wait();
    mintReceipts[role] = {
      transactionHash: receipt.hash,
      gasUsed: receipt.gasUsed.toString(),
      amountAtomic: TOKEN_MINT_ATOMIC.toString(),
    };
  }
  const nativeGasGrants = {};
  for (const role of ["requester", "dealer", "relayer"]) {
    const transaction = await deployer.sendTransaction({
      to: identities[role],
      value: BigInt(network.roleGasGrantWei),
    });
    const receipt = await transaction.wait();
    nativeGasGrants[role] = {
      transactionHash: receipt.hash,
      gasUsed: receipt.gasUsed.toString(),
      amountWei: network.roleGasGrantWei,
    };
  }

  const [adapterCode, tokenCode] = await Promise.all([
    deployer.provider.getCode(adapterAddress),
    deployer.provider.getCode(tokenAddress),
  ]);
  const freeze = buildFreezeRecord(contractsRoot);
  const manifest = {
    schema: "versus-fx-adapter-capabilities",
    schemaVersion: 1,
    adapter: {
      id: "evm-htlc",
      version: 1,
      contract: "EvmHtlcV1",
      sourcePath: "versus/contracts/fx/EvmHtlcV1.sol",
    },
    build: {
      compiler: freeze.compiler.version,
      evmVersion: freeze.compiler.evmVersion,
      sourceTag: freeze.sourceControl.tag,
      optimizerRuns: freeze.compiler.optimizer.runs,
      viaIR: freeze.compiler.viaIR,
      sourceSha256: freeze.sourceSha256,
      creationCodeHash: freeze.creationCodeHash,
    },
    capabilities: [{
      chainId: network.chainId,
      adapterAddress,
      runtimeCodeHash: keccak256(adapterCode),
      asset: {
        address: tokenAddress,
        runtimeCodeHash: keccak256(tokenCode),
        symbol: "tUSDC",
        decimals: 6,
        standard: "ERC20",
        features: {
          feeOnTransfer: false,
          rebasing: false,
          callbacks: false,
          issuerControls: "documented",
        },
      },
      confirmationPolicy: {
        requiredConfirmations: network.requiredConfirmations,
        reorgSafetyBlocks: network.reorgSafetyBlocks,
      },
      timeoutPolicy: {
        minimumSeconds: MINIMUM_LOCK_SECONDS,
        maximumSeconds: MAXIMUM_LOCK_SECONDS,
        minimumCrossChainDeltaSeconds: MINIMUM_CROSS_CHAIN_DELTA_SECONDS,
      },
    }],
  };
  await preflightEvmCapability(deployer.provider, manifest, {
    chainId: network.chainId,
    token: tokenAddress,
    decimals: 6,
  });
  const record = {
    schema: "versus-fx-phase5-testnet-deployment",
    schemaVersion: 1,
    environment: "public-testnet",
    productionFunds: false,
    network,
    deployer: deployer.address.toLowerCase(),
    identities,
    manifest,
    evidence: {
      tokenDeployment: {
        transactionHash: tokenDeployment.hash,
        blockNumber: tokenDeployment.blockNumber,
        gasUsed: tokenDeployment.gasUsed.toString(),
      },
      adapterDeployment: {
        transactionHash: adapterDeployment.hash,
        blockNumber: adapterDeployment.blockNumber,
        gasUsed: adapterDeployment.gasUsed.toString(),
      },
      mintReceipts,
      nativeGasGrants,
    },
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  console.log(JSON.stringify({ outputPath, record }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
