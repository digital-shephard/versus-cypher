const fs = require("node:fs");
const path = require("node:path");
const {
  JsonRpcProvider,
  Wallet,
} = require("ethers");
const {
  FX_NATIVE_ETH_ADDRESS,
  FxX402RequesterClient,
  preflightEvmV3Capability,
} = require("../src");

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

async function main() {
  if (process.env.FX_X402_TESTNET_ONLY !== "1") {
    throw new Error("FX_X402_TESTNET_ONLY=1 is required");
  }
  const manifestPath = path.resolve(
    process.env.FX_X402_V3_MANIFEST ||
      path.join(
        __dirname,
        "../../../versus/deployments/fx/phase13-v3-exact-public-testnet.json"
      )
  );
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const chainIds = manifest.capabilities
    .map((item) => String(item.chainId))
    .sort();
  if (chainIds.join(",") !== "421614,84532") {
    throw new Error("requester script is restricted to the public testnets");
  }
  const signer = await Wallet.fromEncryptedJson(
    fs.readFileSync(
      path.resolve(required("FX_X402_REQUESTER_KEYSTORE")),
      "utf8"
    ),
    required("FX_X402_REQUESTER_KEYSTORE_PASSWORD")
  );
  const providers = {
    "84532": new JsonRpcProvider(
      required("FX_X402_BASE_SEPOLIA_RPC_URL"),
      84532,
      { staticNetwork: true }
    ),
    "421614": new JsonRpcProvider(
      required("FX_X402_ARBITRUM_SEPOLIA_RPC_URL"),
      421614,
      { staticNetwork: true }
    ),
  };
  const inputChainId = required("FX_X402_INPUT_CHAIN_ID");
  const outputChainId = required("FX_X402_OUTPUT_CHAIN_ID");
  const inputToken =
    process.env.FX_X402_INPUT_TOKEN || FX_NATIVE_ETH_ADDRESS;
  const outputToken =
    process.env.FX_X402_OUTPUT_TOKEN || FX_NATIVE_ETH_ADDRESS;
  await Promise.all([
    preflightEvmV3Capability(providers[inputChainId], manifest, {
      chainId: inputChainId,
      token: inputToken,
    }),
    preflightEvmV3Capability(providers[outputChainId], manifest, {
      chainId: outputChainId,
      token: outputToken,
    }),
  ]);
  const requester = signer.address.toLowerCase();
  const client = new FxX402RequesterClient({
    endpoint: required("FX_X402_ENDPOINT"),
    deploymentId: manifest.deploymentId,
    manifest,
    signer,
    providers,
    recoveryDirectory: path.resolve(required("FX_X402_RECOVERY_DIR")),
  });
  const result = await client.execute({
    inputChainId,
    inputToken,
    maxInputAtomic: required("FX_X402_MAX_INPUT_ATOMIC"),
    outputChainId,
    outputToken,
    outputAmountAtomic: required("FX_X402_OUTPUT_AMOUNT_ATOMIC"),
    destinationAddress:
      process.env.FX_X402_DESTINATION_ADDRESS || requester,
    sourceRefundAddress: requester,
    recoveryPassword: required("FX_X402_RECOVERY_PASSWORD"),
    statusPollMs: integer("FX_X402_STATUS_POLL_MS", 1_000),
    completionTimeoutMs: integer(
      "FX_X402_COMPLETION_TIMEOUT_MS",
      5 * 60 * 1000
    ),
  });
  process.stdout.write(`${JSON.stringify({
    event: "fx_x402_swap_complete",
    tradeId: result.tradeId,
    status: result.status,
    sourceTransactionHash: result.swap.sourceTransactionHash,
    sourceBlockNumber: result.swap.sourceBlockNumber,
    recoveryFile: result.recoveryFile,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.code || "FX_X402_REQUESTER_FAILED"}: ${error.message}\n`);
  process.exitCode = 1;
});
