const fs = require("node:fs");
const path = require("node:path");
const {
  ContractFactory,
  Interface,
  JsonRpcProvider,
  Wallet,
  keccak256,
} = require("ethers");
const {
  preflightEvmV2Capability,
  validateEvmV2Manifest,
} = require("../../../packages/network/src/fx-evm-v2-adapter");
const { phase5Network } = require("./phase5-testnet-config");
const { buildV2FreezeRecord } = require("./v2-build-freeze");

const NETWORK_FILE_KEYS = Object.freeze({
  "base-sepolia": "baseSepolia",
  "arbitrum-sepolia": "arbitrumSepolia",
});
const TOKEN_ADDRESS = "0xcba3d9354dd4c30bb6961abb4473a6340486e01b";
const MINIMUM_SECONDS = 60;
const MAXIMUM_SECONDS = 7 * 24 * 60 * 60;
const MINIMUM_DELTA_SECONDS = 3_600;
const MINIMUM_RELAY_WINDOW_SECONDS = 3_600;

function artifact(root, name) {
  return JSON.parse(fs.readFileSync(path.join(
    root,
    "artifacts",
    "contracts",
    "fx",
    `${name}.sol`,
    `${name}.json`
  ), "utf8"));
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

async function deploy(factory, args, label) {
  const contract = await factory.deploy(...args);
  const receipt = await contract.deploymentTransaction().wait();
  if (!receipt || Number(receipt.status) !== 1) {
    throw new Error(`${label} deployment failed`);
  }
  return { contract, receipt };
}

async function main() {
  const networkId = String(process.argv[2] || "");
  const network = phase5Network(networkId);
  const fileKey = NETWORK_FILE_KEYS[networkId];
  if (!fileKey) throw new Error("V2 deployment is restricted to public testnets");

  const contractsRoot = path.resolve(__dirname, "..", "..");
  const repositoryRoot = path.resolve(contractsRoot, "..");
  const identityDirectory = path.resolve(
    process.env.FX_PHASE5_IDENTITY_DIRECTORY ||
      path.join(repositoryRoot, ".local", "fx-phase5-testnet")
  );
  const outputPath = path.join(
    contractsRoot,
    "deployments",
    "fx",
    `${fileKey}-${network.chainId}-evm-htlc-v2.json`
  );
  if (fs.existsSync(outputPath)) {
    throw new Error(`refusing to overwrite frozen deployment ${outputPath}`);
  }

  const rpcUrl =
    process.env[network.rpcEnvironmentVariable] || network.publicRpcUrl;
  const provider = new JsonRpcProvider(rpcUrl, BigInt(network.chainId), {
    staticNetwork: true,
    cacheTimeout: -1,
  });
  const deployer = (await decryptDeployer(identityDirectory)).connect(provider);
  const connected = await provider.getNetwork();
  if (String(connected.chainId) !== network.chainId) {
    throw new Error(`RPC returned chain ${connected.chainId}, expected ${network.chainId}`);
  }
  const deployerBalance = await provider.getBalance(deployer.address);
  if (deployerBalance < BigInt(network.minimumDeployerBalanceWei)) {
    throw new Error(
      `testnet deployer ${deployer.address} needs at least ` +
      `${network.minimumDeployerBalanceWei} wei on ${network.name}; ` +
      `current balance is ${deployerBalance}`
    );
  }

  const nativeBuild = artifact(contractsRoot, "EvmNativeHtlcV2");
  const erc20Build = artifact(contractsRoot, "EvmHtlcV2");
  const native = await deploy(
    new ContractFactory(nativeBuild.abi, nativeBuild.bytecode, deployer),
    [MINIMUM_SECONDS, MAXIMUM_SECONDS],
    `${network.name} native V2`
  );
  const erc20 = await deploy(
    new ContractFactory(erc20Build.abi, erc20Build.bytecode, deployer),
    [TOKEN_ADDRESS, 6, MINIMUM_SECONDS, MAXIMUM_SECONDS],
    `${network.name} ERC-20 V2`
  );

  const nativeAddress = (await native.contract.getAddress()).toLowerCase();
  const erc20Address = (await erc20.contract.getAddress()).toLowerCase();
  const [nativeCode, erc20Code, tokenCode] = await Promise.all([
    provider.getCode(nativeAddress),
    provider.getCode(erc20Address),
    provider.getCode(TOKEN_ADDRESS),
  ]);
  const freeze = buildV2FreezeRecord(contractsRoot);
  const manifest = {
    schema: "versus-fx-evm-v2-capabilities",
    schemaVersion: 2,
    settlementMode: "dealer-secret-destination-first",
    builds: {
      native: freeze.builds.native,
      erc20: freeze.builds.erc20,
    },
    capabilities: [{
      chainId: network.chainId,
      native: {
        adapterAddress: nativeAddress,
        runtimeCodeHash: keccak256(nativeCode),
        deploymentBlock: Number(native.receipt.blockNumber),
        assetId: "native:eth",
      },
      erc20: {
        adapterAddress: erc20Address,
        runtimeCodeHash: keccak256(erc20Code),
        deploymentBlock: Number(erc20.receipt.blockNumber),
        asset: {
          address: TOKEN_ADDRESS,
          runtimeCodeHash: keccak256(tokenCode),
          symbol: "tUSDC",
          decimals: 6,
          standard: "ERC20",
        },
      },
      confirmationPolicy: {
        requiredConfirmations: network.requiredConfirmations,
        reorgSafetyBlocks: network.reorgSafetyBlocks,
      },
      timeoutPolicy: {
        minimumSeconds: MINIMUM_SECONDS,
        maximumSeconds: MAXIMUM_SECONDS,
        minimumCrossChainDeltaSeconds: MINIMUM_DELTA_SECONDS,
        minimumDestinationRelayWindowSeconds: MINIMUM_RELAY_WINDOW_SECONDS,
      },
    }],
  };
  validateEvmV2Manifest(manifest);
  await Promise.all([
    preflightEvmV2Capability(provider, manifest, {
      chainId: network.chainId,
      token: "native:eth",
    }),
    preflightEvmV2Capability(provider, manifest, {
      chainId: network.chainId,
      token: TOKEN_ADDRESS,
    }),
  ]);

  const record = {
    ...manifest,
    evidence: {
      deployer: deployer.address.toLowerCase(),
      native: {
        transactionHash: native.receipt.hash,
        gasUsed: native.receipt.gasUsed.toString(),
      },
      erc20: {
        transactionHash: erc20.receipt.hash,
        gasUsed: erc20.receipt.gasUsed.toString(),
      },
    },
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  console.log(JSON.stringify({
    outputPath,
    chainId: network.chainId,
    nativeAddress,
    nativeDeploymentBlock: native.receipt.blockNumber,
    nativeTransactionHash: native.receipt.hash,
    erc20Address,
    erc20DeploymentBlock: erc20.receipt.blockNumber,
    erc20TransactionHash: erc20.receipt.hash,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
