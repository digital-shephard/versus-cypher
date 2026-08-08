const fs = require("node:fs");
const path = require("node:path");
const {
  ContractFactory,
  Contract,
  keccak256,
} = require("ethers");
const {
  ERC20_READ_ABI,
  MAXIMUM_SECONDS,
  MINIMUM_DELTA_SECONDS,
  MINIMUM_RELAY_WINDOW_SECONDS,
  MINIMUM_SECONDS,
  NATIVE_READ_ABI,
  SCHEMA,
  SCHEMA_VERSION,
  SETTLEMENT_MODE,
  TOKEN_ADDRESS,
  TOKEN_DECIMALS,
  assert,
  assertCommittedFreeze,
  decryptDeployer,
  deploymentPaths,
  explorerUrl,
  preflightV3Capability,
  providerFor,
  validateV3Manifest,
} = require("./v3-deployment-manifest");

function writePrivateJson(filePath, value, flag = "w") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag,
  });
}

async function deployOne(factory, args, label) {
  const contract = await factory.deploy(...args);
  const transaction = contract.deploymentTransaction();
  const receipt = await transaction.wait();
  assert(receipt && Number(receipt.status) === 1, `${label} deployment failed`);
  return {
    address: (await contract.getAddress()).toLowerCase(),
    transactionHash: receipt.hash,
    deploymentBlock: Number(receipt.blockNumber),
    gasUsed: receipt.gasUsed.toString(),
  };
}

async function resumeOrDeploy({
  provider,
  deployer,
  build,
  args,
  label,
  journal,
  journalKey,
  journalPath,
}) {
  const previous = journal.deployments?.[journalKey];
  if (previous) {
    const [receipt, code] = await Promise.all([
      provider.getTransactionReceipt(previous.transactionHash),
      provider.getCode(previous.address),
    ]);
    assert(
      receipt &&
        Number(receipt.status) === 1 &&
        Number(receipt.blockNumber) === previous.deploymentBlock &&
        code !== "0x" &&
        keccak256(code) === previous.runtimeCodeHash,
      `${label} deployment journal does not match the chain`
    );
    return previous;
  }
  const deployed = await deployOne(
    new ContractFactory(build.abi, build.bytecode, deployer),
    args,
    label
  );
  const code = await provider.getCode(deployed.address);
  assert(code !== "0x", `${label} has no runtime code`);
  const record = { ...deployed, runtimeCodeHash: keccak256(code) };
  journal.deployments = { ...(journal.deployments || {}), [journalKey]: record };
  writePrivateJson(journalPath, journal);
  return record;
}

async function main() {
  const networkId = String(process.argv[2] || "");
  const contractsRoot = path.resolve(__dirname, "..", "..");
  const repositoryRoot = path.resolve(contractsRoot, "..");
  const { network, outputPath } = deploymentPaths(contractsRoot, networkId);
  assert(
    !fs.existsSync(outputPath),
    `refusing to overwrite frozen V3 deployment ${outputPath}`
  );
  const { freeze, nativeBuild, erc20Build } =
    assertCommittedFreeze(contractsRoot);
  const provider = providerFor(network);
  const deployer = (await decryptDeployer(repositoryRoot)).connect(provider);
  const connected = await provider.getNetwork();
  assert(
    String(connected.chainId) === network.chainId,
    `RPC returned chain ${connected.chainId}, expected ${network.chainId}`
  );
  const [balance, tokenCode] = await Promise.all([
    provider.getBalance(deployer.address),
    provider.getCode(TOKEN_ADDRESS),
  ]);
  assert(
    balance >= BigInt(network.minimumDeployerBalanceWei),
    `testnet deployer ${deployer.address} has insufficient ${network.name} gas`
  );
  assert(tokenCode !== "0x", `${network.name} V3 test token has no code`);
  const token = new Contract(
    TOKEN_ADDRESS,
    ["function decimals() view returns (uint8)"],
    provider
  );
  assert(
    (await token.decimals()) === BigInt(TOKEN_DECIMALS),
    `${network.name} V3 test token decimals differ`
  );

  const nativeArgs = [MINIMUM_SECONDS, MAXIMUM_SECONDS];
  const erc20Args = [
    TOKEN_ADDRESS,
    TOKEN_DECIMALS,
    MINIMUM_SECONDS,
    MAXIMUM_SECONDS,
  ];
  const nativeFactory = new ContractFactory(
    nativeBuild.abi,
    nativeBuild.bytecode
  );
  const erc20Factory = new ContractFactory(
    erc20Build.abi,
    erc20Build.bytecode
  );
  const [nativeSimulation, erc20Simulation] = await Promise.all([
    provider.call(await nativeFactory.getDeployTransaction(...nativeArgs)),
    provider.call(await erc20Factory.getDeployTransaction(...erc20Args)),
  ]);
  assert(nativeSimulation !== "0x", "native V3 creation simulation failed");
  assert(erc20Simulation !== "0x", "ERC-20 V3 creation simulation failed");

  const journalPath = path.join(
    repositoryRoot,
    ".local",
    "fx-phase12-v3",
    `${networkId}-deployment-journal.json`
  );
  let journal = fs.existsSync(journalPath)
    ? JSON.parse(fs.readFileSync(journalPath, "utf8"))
    : {
        schema: "versus-fx-v3-private-deployment-journal",
        schemaVersion: 1,
        chainId: network.chainId,
        deployer: deployer.address.toLowerCase(),
        nativeCreationCodeHash: freeze.builds.native.creationCodeHash,
        erc20CreationCodeHash: freeze.builds.erc20.creationCodeHash,
        deployments: {},
      };
  assert(
    journal.chainId === network.chainId &&
      journal.deployer === deployer.address.toLowerCase() &&
      journal.nativeCreationCodeHash ===
        freeze.builds.native.creationCodeHash &&
      journal.erc20CreationCodeHash ===
        freeze.builds.erc20.creationCodeHash,
    "private V3 deployment journal belongs to a different build or identity"
  );
  const native = await resumeOrDeploy({
    provider,
    deployer,
    build: nativeBuild,
    args: nativeArgs,
    label: `${network.name} native V3`,
    journal,
    journalKey: "native",
    journalPath,
  });
  const erc20 = await resumeOrDeploy({
    provider,
    deployer,
    build: erc20Build,
    args: erc20Args,
    label: `${network.name} ERC-20 V3`,
    journal,
    journalKey: "erc20",
    journalPath,
  });
  const capability = {
    chainId: network.chainId,
    native: {
      adapterAddress: native.address,
      runtimeCodeHash: native.runtimeCodeHash,
      deploymentBlock: native.deploymentBlock,
      assetId: "native:eth",
    },
    erc20: {
      adapterAddress: erc20.address,
      runtimeCodeHash: erc20.runtimeCodeHash,
      deploymentBlock: erc20.deploymentBlock,
      asset: {
        address: TOKEN_ADDRESS,
        runtimeCodeHash: keccak256(tokenCode),
        symbol: "tUSDC",
        decimals: TOKEN_DECIMALS,
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
  };
  const manifest = validateV3Manifest({
    schema: SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    settlementMode: SETTLEMENT_MODE,
    builds: freeze.builds,
    capabilities: [capability],
  }, contractsRoot);
  const preflight = await preflightV3Capability(
    provider,
    manifest,
    network.chainId
  );
  const record = {
    ...manifest,
    evidence: {
      deployer: deployer.address.toLowerCase(),
      native: {
        transactionHash: native.transactionHash,
        gasUsed: native.gasUsed,
        constructorArguments: {
          minimumLockDuration: MINIMUM_SECONDS,
          maximumLockDuration: MAXIMUM_SECONDS,
        },
        explorerUrl: explorerUrl(network.chainId, native.address),
        verification: { status: "pending" },
      },
      erc20: {
        transactionHash: erc20.transactionHash,
        gasUsed: erc20.gasUsed,
        constructorArguments: {
          asset: TOKEN_ADDRESS,
          expectedDecimals: TOKEN_DECIMALS,
          minimumLockDuration: MINIMUM_SECONDS,
          maximumLockDuration: MAXIMUM_SECONDS,
        },
        explorerUrl: explorerUrl(network.chainId, erc20.address),
        verification: { status: "pending" },
      },
      preflight,
    },
  };
  writePrivateJson(outputPath, record, "wx");
  console.log(JSON.stringify({
    outputPath,
    chainId: network.chainId,
    deployer: deployer.address.toLowerCase(),
    native,
    erc20,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
