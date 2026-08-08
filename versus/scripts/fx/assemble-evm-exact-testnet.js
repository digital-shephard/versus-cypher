const fs = require("node:fs");
const path = require("node:path");
const { keccak256, toUtf8Bytes } = require("ethers");
const { canonicalJson } = require("../../../packages/network/src/fx-protocol");
const { validateEvmV3Manifest } = require("../../../packages/network/src/fx-evm-v3-adapter");
const { assert } = require("./exact-testnet-config");

function writeExclusive(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

function main() {
  const contractsRoot = path.resolve(__dirname, "..", "..");
  const directory = path.join(contractsRoot, "deployments", "fx");
  const oldManifest = JSON.parse(
    fs.readFileSync(path.join(directory, "phase12-v3-public-testnet.json"), "utf8")
  );
  const records = [
    "baseSepolia-84532-x402-exact.json",
    "arbitrumSepolia-421614-x402-exact.json",
  ].map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")));
  for (const record of records) {
    assert(
      record.evidence.erc20.verification.sourceVerified === true &&
        record.evidence.exactFactory.verification.sourceVerified === true,
      `chain ${record.chainId} is not explorer verified`
    );
  }
  const capabilities = records.map((record) => {
    const previous = oldManifest.capabilities.find(
      (item) => item.chainId === record.chainId
    );
    assert(previous, `missing native capability for ${record.chainId}`);
    return {
      chainId: record.chainId,
      native: previous.native,
      erc20: {
        ...record.erc20,
        asset: {
          address: record.token.address,
          runtimeCodeHash: record.token.runtimeCodeHash,
          symbol: record.token.symbol,
          decimals: record.token.decimals,
          standard: "ERC20",
        },
      },
      confirmationPolicy: previous.confirmationPolicy,
      timeoutPolicy: previous.timeoutPolicy,
    };
  }).sort((a, b) => BigInt(a.chainId) < BigInt(b.chainId) ? -1 : 1);
  const unsigned = {
    schema: "versus-fx-evm-v3-capabilities",
    schemaVersion: 3,
    settlementMode: "requester-secret-source-first-compact",
    builds: oldManifest.builds,
    capabilities,
  };
  const deploymentId = keccak256(toUtf8Bytes(canonicalJson(unsigned)));
  const coordinationDomain = keccak256(
    toUtf8Bytes(`versus-fx-v3-coordination:${deploymentId}`)
  );
  assert(deploymentId !== oldManifest.deploymentId, "exact cohort reused V3 deployment ID");
  const manifest = validateEvmV3Manifest({
    ...unsigned,
    deploymentId,
    coordinationDomain,
  });
  const v3Output = {
    ...manifest,
    evidence: Object.fromEntries(records.map((record) => [record.chainId, record.evidence])),
  };
  const factories = {
    schema: "versus-fx-x402-exact-factories",
    schemaVersion: 1,
    deploymentId,
    settlementMode: "x402-exact-eip3009-to-v3",
    exactBuild: records[0].builds.exact,
    factories: records.map((record) => ({
      chainId: record.chainId,
      asset: record.token.address,
      factoryAddress: record.exactFactory.address,
      factoryRuntimeCodeHash: record.exactFactory.runtimeCodeHash,
      htlcAddress: record.erc20.adapterAddress,
      tokenName: record.token.name,
      tokenVersion: record.token.version,
    })),
  };
  const v3Path = path.join(directory, "phase13-v3-exact-public-testnet.json");
  const factoryPath = path.join(directory, "phase13-x402-exact-factories.json");
  writeExclusive(v3Path, v3Output);
  writeExclusive(factoryPath, factories);
  console.log(JSON.stringify({ v3Path, factoryPath, deploymentId, coordinationDomain }, null, 2));
}

main();
