const { Contract, JsonRpcProvider, getAddress } = require("ethers");
const CONSTANTS = require("./lib/constants");

const EXPECTED_WETH = "0x4200000000000000000000000000000000000006";
const DEFAULT_PROTOCOL_RECIPIENT = "0x93645ce5BCF0009026D8100aea5901cDd52217bF";

async function main() {
  const rpcUrl = process.env.BASE_RPC_URL || "https://mainnet.base.org";
  const protocolRecipient = getAddress(process.env.PROTOCOL_RECIPIENT || DEFAULT_PROTOCOL_RECIPIENT);
  const provider = new JsonRpcProvider(rpcUrl, CONSTANTS.base.chainId, {
    staticNetwork: true,
    cacheTimeout: -1,
  });
  const router = new Contract(
    CONSTANTS.base.uniswapV2Router,
    ["function factory() view returns (address)", "function WETH() view returns (address)"],
    provider
  );
  const safe = new Contract(
    protocolRecipient,
    ["function getOwners() view returns (address[])", "function getThreshold() view returns (uint256)"],
    provider
  );

  const [network, factory, weth, owners, threshold, usdcCode, factoryCode, routerCode, recipientCode] =
    await Promise.all([
      provider.getNetwork(),
      router.factory(),
      router.WETH(),
      safe.getOwners(),
      safe.getThreshold(),
      provider.getCode(CONSTANTS.base.usdc),
      provider.getCode(CONSTANTS.base.uniswapV2Factory),
      provider.getCode(CONSTANTS.base.uniswapV2Router),
      provider.getCode(protocolRecipient),
    ]);

  if (Number(network.chainId) !== CONSTANTS.base.chainId) throw new Error("Base RPC returned the wrong chain");
  if (getAddress(factory) !== getAddress(CONSTANTS.base.uniswapV2Factory)) {
    throw new Error(`router factory mismatch: ${factory}`);
  }
  if (getAddress(weth) !== getAddress(EXPECTED_WETH)) throw new Error(`router WETH mismatch: ${weth}`);
  for (const [label, code] of [
    ["USDC", usdcCode],
    ["Uniswap V2 factory", factoryCode],
    ["Uniswap V2 router", routerCode],
    ["protocol recipient", recipientCode],
  ]) {
    if (code === "0x") throw new Error(`${label} has no bytecode`);
  }

  const report = {
    chainId: Number(network.chainId),
    usdc: getAddress(CONSTANTS.base.usdc),
    factory: getAddress(factory),
    router: getAddress(CONSTANTS.base.uniswapV2Router),
    weth: getAddress(weth),
    protocolRecipient,
    safeOwners: owners.map(getAddress),
    safeThreshold: Number(threshold),
    checkedAt: new Date().toISOString(),
  };
  console.log(JSON.stringify(report, null, 2));
  if (owners.length < 3 || threshold < 2n) {
    throw new Error("protocol Safe is not ready: require at least three owners and threshold >= 2");
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
