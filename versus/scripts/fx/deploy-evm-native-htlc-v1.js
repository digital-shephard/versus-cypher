const fs = require("node:fs");
const path = require("node:path");
const {
  ContractFactory,
  JsonRpcProvider,
  Wallet,
  keccak256,
} = require("ethers");
const {
  preflightEvmNativeCapability,
} = require("../../../packages/network/src/fx-evm-native-adapter");
const { phase5Network } = require("./phase5-testnet-config");
const { buildNativeFreezeRecord } = require("./native-build-freeze");

const NETWORK_FILE_KEYS = Object.freeze({
  "base-sepolia": "baseSepolia",
  "arbitrum-sepolia": "arbitrumSepolia",
});
const MINIMUM_SECONDS = 60;
const MAXIMUM_SECONDS = 7 * 24 * 60 * 60;
const MINIMUM_DELTA_SECONDS = 120;

function artifact(root) {
  return JSON.parse(
    fs.readFileSync(
      path.join(
        root,
        "artifacts",
        "contracts",
        "fx",
        "EvmNativeHtlcV1.sol",
        "EvmNativeHtlcV1.json"
      ),
      "utf8"
    )
  );
}

async function decryptDeployer(directory) {
  const password = fs
    .readFileSync(path.join(directory, "identity-password.txt"), "utf8")
    .trim();
  return Wallet.fromEncryptedJson(
    fs.readFileSync(path.join(directory, "deployer.keystore.json"), "utf8"),
    password
  );
}

async function main() {
  const networkId = String(process.argv[2] || "");
  const network = phase5Network(networkId);
  const fileKey = NETWORK_FILE_KEYS[networkId];
  if (!fileKey) {
    throw new Error("native deployment is restricted to public testnets");
  }
  const contractsRoot = path.resolve(__dirname, "..", "..");
  const repositoryRoot = path.resolve(contractsRoot, "..");
  const identityDirectory = path.resolve(
    process.env.FX_PHASE5_IDENTITY_DIRECTORY ||
      path.join(repositoryRoot, ".local", "fx-phase5-testnet")
  );
  const rpcUrl =
    process.env[network.rpcEnvironmentVariable] || network.publicRpcUrl;
  const provider = new JsonRpcProvider(rpcUrl, BigInt(network.chainId), {
    staticNetwork: true,
    cacheTimeout: -1,
  });
  const deployer = (await decryptDeployer(identityDirectory)).connect(provider);
  const connected = await provider.getNetwork();
  if (String(connected.chainId) !== network.chainId) {
    throw new Error(
      `RPC returned chain ${connected.chainId}, expected ${network.chainId}`
    );
  }
  const outputPath = path.join(
    contractsRoot,
    "deployments",
    "fx",
    `${fileKey}-${network.chainId}-evm-native-htlc-v1.json`
  );
  if (fs.existsSync(outputPath)) {
    throw new Error(`refusing to overwrite frozen deployment ${outputPath}`);
  }
  const deployerBalance = await provider.getBalance(deployer.address);
  if (deployerBalance < BigInt(network.minimumDeployerBalanceWei)) {
    throw new Error(
      `testnet deployer ${deployer.address} needs at least ` +
        `${network.minimumDeployerBalanceWei} wei on ${network.name}; ` +
        `current balance is ${deployerBalance}`
    );
  }

  const build = artifact(contractsRoot);
  const adapter = await new ContractFactory(
    build.abi,
    build.bytecode,
    deployer
  ).deploy(MINIMUM_SECONDS, MAXIMUM_SECONDS);
  const receipt = await adapter.deploymentTransaction().wait();
  if (!receipt || Number(receipt.status) !== 1) {
    throw new Error(`${network.name} native adapter deployment failed`);
  }
  const adapterAddress = (await adapter.getAddress()).toLowerCase();
  const runtimeCode = await provider.getCode(adapterAddress);
  const freeze = buildNativeFreezeRecord(contractsRoot);
  const manifest = {
    schema: "versus-fx-native-adapter-capabilities",
    schemaVersion: 1,
    adapter: {
      id: "evm-native-htlc",
      version: 1,
      contract: "EvmNativeHtlcV1",
      sourcePath: "versus/contracts/fx/EvmNativeHtlcV1.sol",
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
      runtimeCodeHash: keccak256(runtimeCode),
      deploymentBlock: Number(receipt.blockNumber),
      asset: {
        assetId: "native:eth",
        symbol: "ETH",
        decimals: 18,
        standard: "NATIVE",
      },
      confirmationPolicy: {
        requiredConfirmations: network.requiredConfirmations,
        reorgSafetyBlocks: network.reorgSafetyBlocks,
      },
      timeoutPolicy: {
        minimumSeconds: MINIMUM_SECONDS,
        maximumSeconds: MAXIMUM_SECONDS,
        minimumCrossChainDeltaSeconds: MINIMUM_DELTA_SECONDS,
      },
    }],
  };
  await preflightEvmNativeCapability(provider, manifest, {
    chainId: network.chainId,
    assetId: "native:eth",
  });
  const record = {
    ...manifest,
    evidence: {
      transactionHash: receipt.hash,
      deployer: deployer.address.toLowerCase(),
      gasUsed: receipt.gasUsed.toString(),
    },
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  console.log(JSON.stringify({
    outputPath,
    chainId: network.chainId,
    adapterAddress,
    deploymentBlock: receipt.blockNumber,
    transactionHash: receipt.hash,
    runtimeCodeHash: keccak256(runtimeCode),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
