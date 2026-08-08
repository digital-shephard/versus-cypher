const fs = require("node:fs");
const path = require("node:path");
const { Contract, Wallet, getAddress, keccak256 } = require("ethers");
const { FxEvmCohort } = require("../src/fx-evm-cohort");
const { loadFxMarketRuntime } = require("../src/fx-market-runtime");
const {
  fetchNodeFxPriceReference,
  fxPriceReferenceEndpointsFromEnv,
} = require("../src/fx-price-reference");

const MAXIMUM_BLOCK_AGE_SECONDS = 120;
const EXACT_FACTORY_ABI = Object.freeze([
  "function asset() view returns (address)",
  "function htlc() view returns (address)",
]);
const PUBLIC_TESTNET_RPCS = Object.freeze({
  BASE_SEPOLIA_RPC_URL: "https://sepolia.base.org",
  AVALANCHE_FUJI_RPC_URL: "https://api.avax-test.network/ext/bc/C/rpc",
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizedAddress(value) {
  return getAddress(value).toLowerCase();
}

async function verifyDeploymentReceipt({
  provider,
  chain,
  deployer,
  label,
  deployment,
}) {
  const receipt = await provider.getTransactionReceipt(deployment.transactionHash);
  assert(receipt, `${chain} ${label} deployment receipt is missing`);
  assert(receipt.status === 1, `${chain} ${label} deployment reverted`);
  assert(
    Number(receipt.blockNumber) === Number(deployment.deploymentBlock),
    `${chain} ${label} deployment block differs`
  );
  assert(
    normalizedAddress(receipt.contractAddress) === normalizedAddress(deployment.address),
    `${chain} ${label} deployment address differs`
  );
  assert(
    normalizedAddress(receipt.from) === normalizedAddress(deployer),
    `${chain} ${label} deployer differs`
  );
  assert(
    receipt.gasUsed === BigInt(deployment.gasUsed),
    `${chain} ${label} deployment gas differs`
  );
}

async function main() {
  const repositoryRoot = path.resolve(__dirname, "..", "..", "..");
  const runtime = loadFxMarketRuntime(process.env);
  assert(runtime, "VERSUS_FX_MARKET_DEPLOYMENT is required");
  assert(
    runtime.releaseStage === "public-testnet-v1-candidate",
    "runtime preflight is restricted to the public-testnet candidate"
  );

  const wallets = Object.fromEntries(
    ["requester", "dealer", "broker", "relayer"].map((role) => [
      role,
      Wallet.createRandom(),
    ])
  );
  const environment = {
    ...process.env,
    BASE_SEPOLIA_RPC_URL:
      process.env.BASE_SEPOLIA_RPC_URL ||
      PUBLIC_TESTNET_RPCS.BASE_SEPOLIA_RPC_URL,
    AVALANCHE_FUJI_RPC_URL:
      process.env.AVALANCHE_FUJI_RPC_URL ||
      PUBLIC_TESTNET_RPCS.AVALANCHE_FUJI_RPC_URL,
  };
  const cohort = new FxEvmCohort({
    walletProvider: (role) => wallets[role] || wallets.requester,
    configurations: runtime.configurations,
    environment,
    settlementVersion: 3,
  });
  const deploymentRoot = path.join(
    repositoryRoot,
    "versus",
    "deployments",
    "fx"
  );
  const chainRecords = new Map([
    "avalancheFuji-43113-market-v1-testnet.json",
    "baseSepolia-84532-market-v1-testnet.json",
  ].map((fileName) => {
    const record = JSON.parse(fs.readFileSync(path.join(deploymentRoot, fileName), "utf8"));
    return [String(record.chainId), record];
  }));

  const chains = [];
  for (const chain of runtime.chains) {
    await cohort.preflight(chain.chainId);
    const provider = cohort.provider(chain.chainId);
    const latest = await provider.getBlock("latest");
    const blockAgeSeconds = Math.floor(Date.now() / 1_000) - Number(latest.timestamp);
    assert(
      blockAgeSeconds >= -30 && blockAgeSeconds <= MAXIMUM_BLOCK_AGE_SECONDS,
      `${chain.chain} RPC head is stale`
    );
    const chainRecord = chainRecords.get(chain.chainId);
    assert(chainRecord, `${chain.chain} frozen chain record is missing`);
    assert(
      chainRecord.marketId === runtime.marketId,
      `${chain.chain} frozen market ID differs`
    );
    assert(
      chainRecord.evidence?.verificationStatus === "verified",
      `${chain.chain} explorer verification is not frozen as verified`
    );
    await verifyDeploymentReceipt({
      provider,
      chain: chain.chain,
      deployer: chainRecord.evidence.deployer,
      label: "native V3 adapter",
      deployment: chainRecord.native,
    });
    for (const deployed of chainRecord.erc20s) {
      await verifyDeploymentReceipt({
        provider,
        chain: chain.chain,
        deployer: chainRecord.evidence.deployer,
        label: `${deployed.symbol} V3 adapter`,
        deployment: deployed.adapter,
      });
      await verifyDeploymentReceipt({
        provider,
        chain: chain.chain,
        deployer: chainRecord.evidence.deployer,
        label: `${deployed.symbol} exact factory`,
        deployment: deployed.exactFactory,
      });
    }
    const factories = runtime.exactFactories.filter(
      (factory) => factory.chainId === chain.chainId
    );
    for (const factory of factories) {
      const code = await provider.getCode(factory.address);
      assert(code !== "0x", `${chain.chain} ${factory.symbol} factory is missing`);
      assert(
        keccak256(code).toLowerCase() === factory.runtimeCodeHash.toLowerCase(),
        `${chain.chain} ${factory.symbol} factory runtime differs`
      );
      const contract = new Contract(factory.address, EXACT_FACTORY_ABI, provider);
      const [asset, htlc] = await Promise.all([contract.asset(), contract.htlc()]);
      assert(
        normalizedAddress(asset) === normalizedAddress(factory.token),
        `${chain.chain} ${factory.symbol} factory asset differs`
      );
      assert(
        normalizedAddress(htlc) === normalizedAddress(factory.htlc),
        `${chain.chain} ${factory.symbol} factory HTLC differs`
      );
    }
    chains.push({
      chainId: chain.chainId,
      blockNumber: Number(latest.number),
      blockAgeSeconds,
      deploymentReceipts: 1 + (chainRecord.erc20s.length * 2),
      exactFactories: factories.length,
    });
  }

  const baseDeployment = require(path.join(
    repositoryRoot,
    "versus",
    "deployments",
    "base.json"
  ));
  const prices = await fetchNodeFxPriceReference({
    endpoints: fxPriceReferenceEndpointsFromEnv(environment),
    trustedSigners: baseDeployment.rainAttestors,
    timeoutMs: 10_000,
  });
  assert(prices.freshness === "fresh", "signed FX price quorum is stale");
  for (const symbol of runtime.nativePriceSymbols.concat("EURC")) {
    assert(prices.prices.get(symbol) > 0n, `${symbol}/USD quorum is unavailable`);
  }

  process.stdout.write(`${JSON.stringify({
    schema: "versus-fx-public-testnet-runtime-preflight",
    schemaVersion: 1,
    deploymentId: runtime.deploymentId,
    coordinationDomain: runtime.coordinationDomain,
    positions: runtime.positions.length,
    routes: runtime.routes.length,
    exactFactories: runtime.exactFactories.length,
    chains,
    priceQuorum: {
      signerCount: prices.signerCount,
      freshness: prices.freshness,
      validUntil: prices.validUntil,
      symbols: [...prices.prices.keys()].sort(),
    },
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
