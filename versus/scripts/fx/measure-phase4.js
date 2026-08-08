const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");

async function main() {
  const { ethers } = hre;
  const [deployer, buyer, dealer, broker, endpoint, relayer] =
    await ethers.getSigners();
  const Token = await ethers.getContractFactory("FxDecimalToken");
  const input = await Token.deploy(6);
  const output = await Token.deploy(6);
  const Settlement = await ethers.getContractFactory("SameChainSettlementV1");
  const settlement = await Settlement.deploy(
    await input.getAddress(),
    await output.getAddress(),
    6,
    6,
    100_000,
    1_000_000,
    2_000_000,
    20
  );
  const deploymentReceipt = await settlement.deploymentTransaction().wait();
  await input.mint(buyer.address, 2_000_000);
  await output.mint(dealer.address, 1_000_000);
  await input.connect(buyer).approve(await settlement.getAddress(), ethers.MaxUint256);
  await output.connect(dealer).approve(await settlement.getAddress(), ethers.MaxUint256);

  const now = Number((await ethers.provider.getBlock("latest")).timestamp);
  const domain = {
    name: "Versus Same Chain Settlement",
    version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await settlement.getAddress(),
  };
  const quoteTypes = {
    DealerQuote: [
      { name: "quoteId", type: "bytes32" },
      { name: "dealer", type: "address" },
      { name: "buyer", type: "address" },
      { name: "inputAmount", type: "uint256" },
      { name: "outputAmount", type: "uint256" },
      { name: "outputRecipient", type: "address" },
      { name: "issuedAt", type: "uint64" },
      { name: "expiresAt", type: "uint64" },
      { name: "nonce", type: "uint256" },
      { name: "paymentCommitment", type: "bytes32" },
    ],
  };
  const acceptanceTypes = {
    BuyerAcceptance: [
      { name: "quoteDigest", type: "bytes32" },
      { name: "buyer", type: "address" },
      { name: "maxInputAmount", type: "uint256" },
      { name: "broker", type: "address" },
      { name: "brokerFee", type: "uint256" },
      { name: "expiresAt", type: "uint64" },
      { name: "nonce", type: "uint256" },
    ],
  };
  const quote = {
    quoteId: ethers.keccak256(ethers.toUtf8Bytes("phase4-measurement")),
    dealer: dealer.address,
    buyer: buyer.address,
    inputAmount: 510_000n,
    outputAmount: 500_000n,
    outputRecipient: endpoint.address,
    issuedAt: now,
    expiresAt: now + 20,
    nonce: 1n,
    paymentCommitment: ethers.keccak256(ethers.toUtf8Bytes("controlled-x402")),
  };
  const dealerSignature = await dealer.signTypedData(domain, quoteTypes, quote);
  const quoteDigest = ethers.TypedDataEncoder.hash(domain, quoteTypes, quote);
  const acceptance = {
    quoteDigest,
    buyer: buyer.address,
    maxInputAmount: 515_000n,
    broker: broker.address,
    brokerFee: 5_000n,
    expiresAt: quote.expiresAt,
    nonce: 1n,
  };
  const buyerSignature = await buyer.signTypedData(
    domain,
    acceptanceTypes,
    acceptance
  );
  const transaction = await settlement
    .connect(relayer)
    .settle(quote, dealerSignature, acceptance, buyerSignature);
  const receipt = await transaction.wait();
  const result = {
    schema: "versus-fx-phase4-measurement",
    schemaVersion: 1,
    environment: {
      chain: "Hardhat local",
      chainId: "31337",
      productionFunds: false,
      productionWaku: false,
    },
    route: {
      input: "0.515000 EURC maximum and charged",
      dealerCompensation: "0.510000 EURC",
      brokerFee: "0.005000 EURC",
      exactOutput: "0.500000 USDC",
      fixtureDealerPremiumBps: 200,
      fixtureBrokerFeeBps: 100,
      fixtureAllInPremiumBps: 300,
      note: "Illustrative stablecoin fixture pricing, not a live market quote."
    },
    gas: {
      settlementGasUnits: receipt.gasUsed.toString(),
      deploymentGasUnits: deploymentReceipt.gasUsed.toString(),
      payer: "execution relayer or requester, selected before submission",
      note: "Gas units are reproducible locally; fiat cost depends on Base fee and ETH price."
    },
    custody: {
      settlementInputBalance: (
        await input.balanceOf(await settlement.getAddress())
      ).toString(),
      settlementOutputBalance: (
        await output.balanceOf(await settlement.getAddress())
      ).toString(),
    },
  };
  const outputPath = path.resolve(
    __dirname,
    "..",
    "..",
    "deployments",
    "fx",
    "phase4-local-measurement.json"
  );
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ outputPath, ...result }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
