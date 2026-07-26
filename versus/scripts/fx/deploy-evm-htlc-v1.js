const fs = require("node:fs");
const path = require("node:path");

const hre = require("hardhat");
const { keccak256 } = require("ethers");

const { buildFreezeRecord } = require("./build-freeze");

function envUint(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (!/^\d+$/.test(String(value))) throw new Error(`${name} must be an unsigned integer`);
  return Number(value);
}

async function main() {
  const network = await hre.ethers.provider.getNetwork();
  const chainId = network.chainId.toString();
  const expectedDecimals = envUint("FX_TOKEN_DECIMALS", 6);
  const minimumSeconds = envUint("FX_MIN_LOCK_SECONDS", 60);
  const maximumSeconds = envUint("FX_MAX_LOCK_SECONDS", 7 * 24 * 60 * 60);
  const minimumCrossChainDeltaSeconds = envUint("FX_MIN_TIMEOUT_DELTA_SECONDS", 120);
  const requiredConfirmations = envUint("FX_REQUIRED_CONFIRMATIONS", 2);
  const reorgSafetyBlocks = envUint("FX_REORG_SAFETY_BLOCKS", 6);

  let tokenAddress = process.env.FX_TOKEN_ADDRESS;
  let tokenSymbol = process.env.FX_TOKEN_SYMBOL || "USDC";
  if (!tokenAddress) {
    if (!["hardhat", "localhost"].includes(hre.network.name)) {
      throw new Error("FX_TOKEN_ADDRESS is required outside a local Hardhat network");
    }
    const Token = await hre.ethers.getContractFactory("MockUSDC");
    const token = await Token.deploy();
    await token.waitForDeployment();
    tokenAddress = await token.getAddress();
    tokenSymbol = "USDC";
  }

  const Adapter = await hre.ethers.getContractFactory("EvmHtlcV1");
  const adapter = await Adapter.deploy(
    tokenAddress,
    expectedDecimals,
    minimumSeconds,
    maximumSeconds
  );
  await adapter.waitForDeployment();
  const adapterAddress = await adapter.getAddress();
  const runtimeCode = await hre.ethers.provider.getCode(adapterAddress);
  const tokenRuntimeCode = await hre.ethers.provider.getCode(tokenAddress);
  const freeze = buildFreezeRecord(path.resolve(__dirname, "..", ".."));

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
    capabilities: [
      {
        chainId,
        adapterAddress,
        runtimeCodeHash: keccak256(runtimeCode),
        asset: {
          address: tokenAddress,
          runtimeCodeHash: keccak256(tokenRuntimeCode),
          symbol: tokenSymbol,
          decimals: expectedDecimals,
          standard: "ERC20",
          features: {
            feeOnTransfer: false,
            rebasing: false,
            callbacks: false,
            issuerControls: process.env.FX_ISSUER_CONTROLS || "none",
          },
        },
        confirmationPolicy: {
          requiredConfirmations,
          reorgSafetyBlocks,
        },
        timeoutPolicy: {
          minimumSeconds,
          maximumSeconds,
          minimumCrossChainDeltaSeconds,
        },
      },
    ],
  };

  const outputPath = process.env.FX_ADAPTER_MANIFEST_OUTPUT
    ? path.resolve(process.env.FX_ADAPTER_MANIFEST_OUTPUT)
    : path.join(
      __dirname,
      "..",
      "..",
      "deployments",
      "fx",
      `${hre.network.name}-${chainId}-evm-htlc-v1.json`
    );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ outputPath, manifest }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
