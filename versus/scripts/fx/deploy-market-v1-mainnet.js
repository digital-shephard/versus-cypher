const fs = require("node:fs");
const path = require("node:path");
const { ContractFactory, keccak256 } = require("ethers");
const {
  MAXIMUM_SECONDS,
  MINIMUM_SECONDS,
  artifact,
  assert,
  assertCommittedFreeze,
} = require("./v3-deployment-manifest");
const { buildExactFreezeRecord } = require("./exact-build-freeze");
const {
  networkFor,
  preflightMarketChainAcrossRpcs,
  preflightMarketDeploymentAcrossRpcs,
  providerFor,
  readMarket,
  rpcUrlsFor,
} = require("./market-candidate-config");
const {
  decryptMainnetDeployer,
  reviewedSourceCommit,
  validateMainnetDeployAuthorization,
} = require("./mainnet-market-guard");

const RUNTIME_VISIBILITY_ATTEMPTS = 30;
const RUNTIME_VISIBILITY_DELAY_MS = 1_000;
const GAS_BUFFER_NUMERATOR = 120n;
const GAS_BUFFER_DENOMINATOR = 100n;

function writeJson(filePath, value, { exclusive = false, privateFile = false } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: exclusive ? "wx" : "w",
    mode: privateFile ? 0o600 : 0o644,
  });
}

async function waitForRuntimeCode(provider, address) {
  for (let attempt = 1; attempt <= RUNTIME_VISIBILITY_ATTEMPTS; attempt += 1) {
    const code = await provider.getCode(address);
    if (code !== "0x") return code;
    if (attempt < RUNTIME_VISIBILITY_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, RUNTIME_VISIBILITY_DELAY_MS));
    }
  }
  return "0x";
}

function bufferedGas(estimate) {
  return (BigInt(estimate) * GAS_BUFFER_NUMERATOR + GAS_BUFFER_DENOMINATOR - 1n) /
    GAS_BUFFER_DENOMINATOR;
}

async function deploymentOverrides(provider, transactionRequest, signerAddress, limits) {
  const [estimate, fees] = await Promise.all([
    provider.estimateGas({ ...transactionRequest, from: signerAddress }),
    provider.getFeeData(),
  ]);
  const gasLimit = bufferedGas(estimate);
  assert(
    gasLimit <= limits.maximumGasPerDeployment,
    `buffered deployment gas ${gasLimit} exceeds reviewed ceiling ${limits.maximumGasPerDeployment}`
  );
  const feePerGas = BigInt(fees.maxFeePerGas || fees.gasPrice || 0n);
  assert(feePerGas > 0n, "RPC returned no deployable gas price");
  assert(
    feePerGas <= limits.maximumFeePerGasWei,
    `fee per gas ${feePerGas} exceeds reviewed ceiling ${limits.maximumFeePerGasWei}`
  );
  if (fees.maxFeePerGas != null) {
    const priorityFee = BigInt(fees.maxPriorityFeePerGas || 0n);
    assert(priorityFee <= feePerGas, "priority fee exceeds maximum fee per gas");
    return {
      gasLimit,
      maxFeePerGas: feePerGas,
      maxPriorityFeePerGas: priorityFee,
    };
  }
  return { gasLimit, gasPrice: feePerGas };
}

async function assertDeploymentVisible(providers, deployed, confirmations) {
  const evidence = [];
  for (const provider of providers) {
    const receipt = await provider.waitForTransaction(
      deployed.transactionHash,
      confirmations,
      120_000
    );
    const code = await waitForRuntimeCode(provider, deployed.address);
    assert(
      receipt && Number(receipt.status) === 1 && code !== "0x",
      "deployment is not confirmed and visible through every pinned RPC"
    );
    evidence.push({
      blockNumber: Number(receipt.blockNumber),
      runtimeCodeHash: keccak256(code),
    });
  }
  assert(
    evidence.every((item) =>
      item.blockNumber === evidence[0].blockNumber &&
      item.runtimeCodeHash === evidence[0].runtimeCodeHash
    ),
    "pinned RPCs disagree on deployment receipt or runtime code"
  );
  return evidence[0];
}

async function deployOrResume({
  providers,
  signer,
  build,
  args,
  key,
  journal,
  journalPath,
  limits,
  confirmations,
}) {
  const previous = journal.deployments[key];
  if (previous) {
    const observed = await assertDeploymentVisible(providers, previous, confirmations);
    assert(
      observed.runtimeCodeHash === previous.runtimeCodeHash &&
        observed.blockNumber === previous.deploymentBlock,
      `${key} journal does not match pinned RPC evidence`
    );
    return previous;
  }

  const primary = providers[0];
  const factory = new ContractFactory(build.abi, build.bytecode, signer);
  const transactionRequest = await factory.getDeployTransaction(...args);
  const simulations = [];
  for (const provider of providers) {
    simulations.push(await provider.call({
      ...transactionRequest,
      from: signer.address,
    }));
  }
  assert(
    simulations.every((result) => result !== "0x" && result === simulations[0]),
    `${key} creation simulation differs across pinned RPCs`
  );
  const overrides = await deploymentOverrides(
    primary,
    transactionRequest,
    signer.address,
    limits
  );
  const contract = await factory.deploy(...args, overrides);
  const transaction = contract.deploymentTransaction();
  const receipt = await transaction.wait(confirmations);
  assert(receipt && Number(receipt.status) === 1, `${key} deployment failed`);
  const address = (await contract.getAddress()).toLowerCase();
  const observed = await assertDeploymentVisible(providers, {
    address,
    transactionHash: receipt.hash.toLowerCase(),
  }, confirmations);
  const deployed = {
    address,
    transactionHash: receipt.hash.toLowerCase(),
    deploymentBlock: observed.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    runtimeCodeHash: observed.runtimeCodeHash,
  };
  journal.deployments[key] = deployed;
  writeJson(journalPath, journal, { privateFile: true });
  return deployed;
}

async function main() {
  const networkId = String(process.argv[2] || "");
  const contractsRoot = path.resolve(__dirname, "..", "..");
  const repositoryRoot = path.resolve(contractsRoot, "..");
  const market = readMarket(contractsRoot, "mainnet");
  const network = networkFor(market, networkId);
  assert(!network.deploymentAllowed, "mainnet deploy tooling rejects testnet networks");
  const limits = validateMainnetDeployAuthorization(
    process.env,
    network,
    market.marketId
  );
  const sourceCommit = reviewedSourceCommit(repositoryRoot);
  const outputPath = path.join(
    contractsRoot,
    "deployments",
    "fx",
    `${network.key}-${network.chainId}-market-v1-mainnet.json`
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

  await preflightMarketChainAcrossRpcs(network);
  const providers = rpcUrlsFor(network).map((url) => providerFor(network, url));
  const deployer = (await decryptMainnetDeployer()).connect(providers[0]);
  const balances = await Promise.all(
    providers.map((provider) => provider.getBalance(deployer.address))
  );
  assert(balances.every((balance) => balance > 0n), "mainnet deployer has no visible native gas");

  const journalPath = path.join(
    repositoryRoot,
    ".local",
    "fx-market-v1-mainnet",
    `${network.id}-deployment-journal.json`
  );
  const expectedJournal = {
    schema: "versus-fx-market-v1-private-mainnet-deployment-journal",
    schemaVersion: 1,
    sourceCommit,
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

  const common = {
    providers,
    signer: deployer,
    journal,
    journalPath,
    limits,
    confirmations: network.requiredConfirmations,
  };
  const native = await deployOrResume({
    ...common,
    build: nativeBuild,
    args: [MINIMUM_SECONDS, MAXIMUM_SECONDS],
    key: "native",
  });
  const erc20s = {};
  const exactFactories = {};
  for (const asset of network.assets.filter((item) => item.kind === "erc20")) {
    erc20s[asset.symbol] = await deployOrResume({
      ...common,
      build: erc20Build,
      args: [asset.token, asset.decimals, MINIMUM_SECONDS, MAXIMUM_SECONDS],
      key: `${asset.symbol.toLowerCase()}Adapter`,
    });
    exactFactories[asset.symbol] = await deployOrResume({
      ...common,
      build: factoryBuild,
      args: [asset.token, erc20s[asset.symbol].address],
      key: `${asset.symbol.toLowerCase()}ExactFactory`,
    });
  }
  const record = {
    schema: "versus-fx-market-v1-mainnet-chain",
    schemaVersion: 1,
    sourceCommit,
    marketId: market.marketId,
    chainId: network.chainId,
    name: network.name,
    builds: { v3: freeze.builds, exact: committedExact },
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
  await preflightMarketDeploymentAcrossRpcs(network, record);
  writeJson(outputPath, record, { exclusive: true });
  console.log(JSON.stringify({
    outputPath,
    sourceCommit,
    marketId: market.marketId,
    chainId: network.chainId,
    native,
    erc20s,
    exactFactories,
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  bufferedGas,
  deploymentOverrides,
};
