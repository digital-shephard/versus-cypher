const fs = require("node:fs");
const path = require("node:path");
const {
  ContractFactory,
  keccak256,
} = require("ethers");
const {
  MAXIMUM_SECONDS,
  MINIMUM_SECONDS,
  artifact,
  assert,
  assertCommittedFreeze,
  decryptDeployer,
} = require("./v3-deployment-manifest");
const { buildExactFreezeRecord } = require("./exact-build-freeze");
const {
  networkFor,
  preflightMarketChain,
  preflightMarketDeployment,
  providerFor,
  readMarket,
} = require("./market-candidate-config");

const CONFIRMATION = "I_UNDERSTAND_PUBLIC_TESTNET_ONLY";

function writeJson(filePath, value, { exclusive = false, privateFile = false } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: exclusive ? "wx" : "w",
    mode: privateFile ? 0o600 : 0o644,
  });
}

async function deployOrResume({
  provider,
  signer,
  build,
  args,
  key,
  journal,
  journalPath,
}) {
  const previous = journal.deployments[key];
  if (previous) {
    const [receipt, code] = await Promise.all([
      provider.getTransactionReceipt(previous.transactionHash),
      provider.getCode(previous.address),
    ]);
    assert(
      receipt && Number(receipt.status) === 1 && code !== "0x" &&
        keccak256(code) === previous.runtimeCodeHash,
      `${key} journal does not match the connected chain`
    );
    return previous;
  }
  const factory = new ContractFactory(build.abi, build.bytecode, signer);
  const transactionRequest = await factory.getDeployTransaction(...args);
  const simulation = await provider.call({ ...transactionRequest, from: signer.address });
  assert(simulation !== "0x", `${key} creation simulation failed`);
  const contract = await factory.deploy(...args);
  const receipt = await contract.deploymentTransaction().wait();
  assert(receipt && Number(receipt.status) === 1, `${key} deployment failed`);
  const address = (await contract.getAddress()).toLowerCase();
  const code = await provider.getCode(address);
  assert(code !== "0x", `${key} has no runtime code`);
  const deployed = {
    address,
    transactionHash: receipt.hash.toLowerCase(),
    deploymentBlock: Number(receipt.blockNumber),
    gasUsed: receipt.gasUsed.toString(),
    runtimeCodeHash: keccak256(code),
  };
  journal.deployments[key] = deployed;
  writeJson(journalPath, journal, { privateFile: true });
  return deployed;
}

async function main() {
  assert(
    process.env.FX_MARKET_PUBLIC_TESTNET_DEPLOY === CONFIRMATION,
    `set FX_MARKET_PUBLIC_TESTNET_DEPLOY=${CONFIRMATION} to authorize public-testnet deployment`
  );
  const networkId = String(process.argv[2] || "");
  const contractsRoot = path.resolve(__dirname, "..", "..");
  const repositoryRoot = path.resolve(contractsRoot, "..");
  const market = readMarket(contractsRoot, "testnet");
  const network = networkFor(market, networkId);
  assert(network.deploymentAllowed, "market deployment is restricted to public testnets");
  const outputPath = path.join(
    contractsRoot,
    "deployments",
    "fx",
    `${network.key}-${network.chainId}-market-v1-testnet.json`
  );
  assert(!fs.existsSync(outputPath), `refusing to overwrite ${outputPath}`);

  const { freeze, nativeBuild, erc20Build } = assertCommittedFreeze(contractsRoot);
  const exactFreeze = buildExactFreezeRecord(contractsRoot);
  const committedExact = JSON.parse(fs.readFileSync(
    path.join(contractsRoot, "deployments", "fx", "evm-exact-build.json"),
    "utf8"
  ));
  assert(
    JSON.stringify(exactFreeze) === JSON.stringify(committedExact),
    "exact factory build differs from its committed freeze"
  );
  const factoryBuild = artifact(contractsRoot, "EvmExactHtlcFactory");
  assert(
    keccak256(factoryBuild.bytecode) ===
      committedExact.builds.EvmExactHtlcFactory.creationCodeHash,
    "exact factory creation code differs from its committed freeze"
  );

  const provider = providerFor(network);
  await preflightMarketChain(provider, network);
  const deployer = (await decryptDeployer(repositoryRoot)).connect(provider);
  const connected = await provider.getNetwork();
  assert(String(connected.chainId) === network.chainId, "RPC chain mismatch");
  assert(await provider.getBalance(deployer.address) > 0n, "testnet deployer has no native gas");

  const journalPath = path.join(
    repositoryRoot,
    ".local",
    "fx-market-v1-testnet",
    `${network.id}-deployment-journal.json`
  );
  const expectedJournal = {
    schema: "versus-fx-market-v1-private-deployment-journal",
    schemaVersion: 1,
    marketId: market.marketId,
    chainId: network.chainId,
    deployer: deployer.address.toLowerCase(),
    nativeCreationCodeHash: freeze.builds.native.creationCodeHash,
    erc20CreationCodeHash: freeze.builds.erc20.creationCodeHash,
    exactFactoryCreationCodeHash:
      committedExact.builds.EvmExactHtlcFactory.creationCodeHash,
    deployments: {},
  };
  const journal = fs.existsSync(journalPath)
    ? JSON.parse(fs.readFileSync(journalPath, "utf8"))
    : expectedJournal;
  for (const key of Object.keys(expectedJournal).filter((key) => key !== "deployments")) {
    assert(journal[key] === expectedJournal[key], `deployment journal ${key} mismatch`);
  }

  const native = await deployOrResume({
    provider,
    signer: deployer,
    build: nativeBuild,
    args: [MINIMUM_SECONDS, MAXIMUM_SECONDS],
    key: "native",
    journal,
    journalPath,
  });
  const erc20s = {};
  const exactFactories = {};
  for (const asset of network.assets.filter((item) => item.kind === "erc20")) {
    erc20s[asset.symbol] = await deployOrResume({
      provider,
      signer: deployer,
      build: erc20Build,
      args: [asset.token, asset.decimals, MINIMUM_SECONDS, MAXIMUM_SECONDS],
      key: `${asset.symbol.toLowerCase()}Adapter`,
      journal,
      journalPath,
    });
    exactFactories[asset.symbol] = await deployOrResume({
      provider,
      signer: deployer,
      build: factoryBuild,
      args: [asset.token, erc20s[asset.symbol].address],
      key: `${asset.symbol.toLowerCase()}ExactFactory`,
      journal,
      journalPath,
    });
  }
  const record = {
    schema: "versus-fx-market-v1-testnet-chain",
    schemaVersion: 1,
    marketId: market.marketId,
    chainId: network.chainId,
    name: network.name,
    builds: {
      v3: freeze.builds,
      exact: committedExact,
    },
    native,
    erc20s: network.assets.filter((item) => item.kind === "erc20").map((asset) => ({
      symbol: asset.symbol,
      asset,
      adapter: erc20s[asset.symbol],
      exactFactory: exactFactories[asset.symbol],
    })),
    confirmationPolicy: {
      requiredConfirmations: network.requiredConfirmations,
      reorgSafetyBlocks: network.reorgSafetyBlocks,
    },
    timeoutPolicy: market.timeoutPolicy,
    evidence: {
      deployer: deployer.address.toLowerCase(),
      verificationStatus: "pending",
    },
  };
  await preflightMarketDeployment(provider, network, record);
  writeJson(outputPath, record, { exclusive: true });
  console.log(JSON.stringify({
    outputPath,
    marketId: market.marketId,
    chainId: network.chainId,
    native,
    erc20s,
    exactFactories,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
