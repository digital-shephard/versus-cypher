const fs = require("node:fs");
const path = require("node:path");
const { ContractFactory, keccak256 } = require("ethers");
const {
  MAXIMUM_SECONDS,
  MINIMUM_SECONDS,
  artifact,
  assert,
  committedBuilds,
  decryptDeployer,
  networkConfig,
  preflightDeployment,
  preflightToken,
  providerFor,
} = require("./exact-testnet-config");

function writeJson(filePath, value, { exclusive = false, privateFile = false } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: exclusive ? "wx" : "w",
    mode: privateFile ? 0o600 : 0o644,
  });
}

async function deployOrResume({ provider, signer, build, args, key, journal, journalPath }) {
  const previous = journal.deployments[key];
  if (previous) {
    const [receipt, code] = await Promise.all([
      provider.getTransactionReceipt(previous.transactionHash),
      provider.getCode(previous.address),
    ]);
    assert(
      receipt && Number(receipt.status) === 1 && code !== "0x" &&
        keccak256(code) === previous.runtimeCodeHash,
      `${key} journal does not match the chain`
    );
    return previous;
  }
  const factory = new ContractFactory(build.abi, build.bytecode, signer);
  const simulation = await provider.call(await factory.getDeployTransaction(...args));
  assert(simulation !== "0x", `${key} creation simulation failed`);
  const contract = await factory.deploy(...args);
  const receipt = await contract.deploymentTransaction().wait();
  assert(receipt && Number(receipt.status) === 1, `${key} deployment failed`);
  const address = (await contract.getAddress()).toLowerCase();
  const code = await provider.getCode(address);
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
  const networkId = String(process.argv[2] || "");
  const network = networkConfig(networkId);
  const contractsRoot = path.resolve(__dirname, "..", "..");
  const repositoryRoot = path.resolve(contractsRoot, "..");
  const outputPath = path.join(
    contractsRoot,
    "deployments",
    "fx",
    `${network.key}-${network.chainId}-x402-exact.json`
  );
  assert(!fs.existsSync(outputPath), `refusing to overwrite ${outputPath}`);
  const builds = committedBuilds(contractsRoot);
  const provider = providerFor(network);
  const deployer = (await decryptDeployer(repositoryRoot)).connect(provider);
  const [connected, balance, token] = await Promise.all([
    provider.getNetwork(),
    provider.getBalance(deployer.address),
    preflightToken(provider, network),
  ]);
  assert(String(connected.chainId) === network.chainId, "RPC chain mismatch");
  assert(balance > 1_000_000_000_000_000n, `${network.name} deployer gas is too low`);

  const erc20Build = artifact(contractsRoot, "EvmHtlcV3", "EvmHtlcV3");
  const factoryBuild = artifact(
    contractsRoot,
    "EvmExactHtlcFactory",
    "EvmExactHtlcFactory"
  );
  assert(
    keccak256(erc20Build.bytecode) === builds.v3.builds.erc20.creationCodeHash &&
      keccak256(factoryBuild.bytecode) ===
        builds.exact.builds.EvmExactHtlcFactory.creationCodeHash,
    "compiled creation code differs from the committed freeze"
  );

  const journalPath = path.join(
    repositoryRoot,
    ".local",
    "fx-x402-exact",
    `${networkId}-deployment-journal.json`
  );
  const expectedJournal = {
    schema: "versus-fx-x402-exact-private-journal",
    schemaVersion: 1,
    chainId: network.chainId,
    deployer: deployer.address.toLowerCase(),
    token: token.address,
    erc20CreationCodeHash: builds.v3.builds.erc20.creationCodeHash,
    factoryCreationCodeHash:
      builds.exact.builds.EvmExactHtlcFactory.creationCodeHash,
    deployments: {},
  };
  const journal = fs.existsSync(journalPath)
    ? JSON.parse(fs.readFileSync(journalPath, "utf8"))
    : expectedJournal;
  for (const key of [
    "schema",
    "schemaVersion",
    "chainId",
    "deployer",
    "token",
    "erc20CreationCodeHash",
    "factoryCreationCodeHash",
  ]) {
    assert(journal[key] === expectedJournal[key], `deployment journal ${key} mismatch`);
  }

  const erc20Args = [token.address, 6, MINIMUM_SECONDS, MAXIMUM_SECONDS];
  const erc20 = await deployOrResume({
    provider,
    signer: deployer,
    build: erc20Build,
    args: erc20Args,
    key: "erc20",
    journal,
    journalPath,
  });
  const factoryArgs = [token.address, erc20.address];
  const exactFactory = await deployOrResume({
    provider,
    signer: deployer,
    build: factoryBuild,
    args: factoryArgs,
    key: "exactFactory",
    journal,
    journalPath,
  });
  const record = {
    schema: "versus-fx-x402-exact-chain",
    schemaVersion: 1,
    chainId: network.chainId,
    token,
    erc20: {
      adapterAddress: erc20.address,
      runtimeCodeHash: erc20.runtimeCodeHash,
      deploymentBlock: erc20.deploymentBlock,
    },
    exactFactory,
    builds: { v3: builds.v3.builds, exact: builds.exact },
    evidence: {
      deployer: deployer.address.toLowerCase(),
      erc20: {
        transactionHash: erc20.transactionHash,
        gasUsed: erc20.gasUsed,
        constructorArguments: {
          asset: token.address,
          expectedDecimals: 6,
          minimumLockDuration: MINIMUM_SECONDS,
          maximumLockDuration: MAXIMUM_SECONDS,
        },
        explorerUrl: `${network.explorer}/${erc20.address}#code`,
        verification: { status: "pending", sourceVerified: false },
      },
      exactFactory: {
        transactionHash: exactFactory.transactionHash,
        gasUsed: exactFactory.gasUsed,
        constructorArguments: { asset: token.address, htlc: erc20.address },
        explorerUrl: `${network.explorer}/${exactFactory.address}#code`,
        verification: { status: "pending", sourceVerified: false },
      },
    },
  };
  record.evidence.preflight = await preflightDeployment(
    provider,
    network,
    record
  );
  writeJson(outputPath, record, { exclusive: true });
  console.log(JSON.stringify({ outputPath, chainId: network.chainId, erc20, exactFactory }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
