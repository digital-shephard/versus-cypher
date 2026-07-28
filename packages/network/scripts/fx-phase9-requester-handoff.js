const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  Wallet,
  keccak256,
  toUtf8Bytes,
} = require("ethers");
const {
  FxRequesterFundingSdk,
  createBrokerRouteProposal,
  signFxMessage,
} = require("../src");

const NOW = Math.floor(Date.now() / 1000);
const DEPLOYMENT_ID = keccak256(toUtf8Bytes("versus-phase9-controlled-handoff"));
const SOURCE_TOKEN = `0x${"11".repeat(20)}`;
const DESTINATION_TOKEN = `0x${"22".repeat(20)}`;

async function main() {
  const requester = Wallet.createRandom();
  const broker = Wallet.createRandom();
  const dealer = Wallet.createRandom();
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "versus-phase9-controlled-")
  );
  const password = "controlled phase nine recovery";
  const sdk = new FxRequesterFundingSdk({
    deploymentId: DEPLOYMENT_ID,
    signer: requester,
    brokerEndpoints: ["http://127.0.0.1"],
    recoveryDirectory: directory,
    now: () => NOW,
    async queryRoutes({ rfq }) {
      const quote = await signFxMessage({
        protocol: "versus-fx",
        version: 1,
        deploymentId: DEPLOYMENT_ID,
        type: "fx_quote",
        tradeId: rfq.tradeId,
        role: "dealer",
        sequence: "1",
        createdAt: NOW,
        expiresAt: NOW + 45,
        payload: {
          rfqId: rfq.id,
          inputChainId: "84532",
          inputToken: SOURCE_TOKEN,
          inputAmountAtomic: "101000",
          outputChainId: "421614",
          outputToken: DESTINATION_TOKEN,
          outputAmountAtomic: "100000",
          quoteType: "fixed_exact_output",
          referenceSource: "controlled:phase9",
          referencePriceMicros: "1000000",
          referenceTimestamp: NOW,
          spreadBps: 25,
          dealerSettlementCostAtomic: "500",
          estimatedCompletionSeconds: 30,
          adapterId: "evm-htlc-v1",
          adapterVersion: 1,
        },
      }, dealer);
      const proposal = await createBrokerRouteProposal({
        signer: broker,
        rfq,
        quotes: [quote],
        brokerFeeAtomic: "500",
        now: NOW,
      });
      return {
        selected: proposal,
        attempts: [{
          endpoint: "http://127.0.0.1",
          ok: true,
          latencyMs: 1,
          proposal,
        }],
      };
    },
    async settlementExecutor({ recoveryFile }) {
      if (!fs.existsSync(recoveryFile)) {
        throw new Error("recovery was not persisted before settlement");
      }
      return { transactionHash: `0x${"77".repeat(32)}` };
    },
    async destinationVerifier({ expected, settlement }) {
      return {
        confirmed: true,
        chainId: expected.outputChainId,
        token: expected.outputToken,
        amountAtomic: expected.outputAmountAtomic,
        beneficiary: expected.destinationAddress,
        transactionHash: settlement.transactionHash,
        blockNumber: "9001",
        confirmations: 2,
      };
    },
  });
  const fundingQuote = await sdk.quoteFunding({
    requirement: {
      x402Version: 2,
      scheme: "exact",
      network: "eip155:421614",
      asset: DESTINATION_TOKEN,
      amount: "100000",
      payTo: Wallet.createRandom().address,
      resource: "https://private.example/resource",
    },
    destinationAddress: requester.address,
    inputOptions: [{
      chainId: "84532",
      token: SOURCE_TOKEN,
      maxInputAtomic: "110000",
    }],
  });
  const result = await sdk.executeFunding({
    quote: fundingQuote,
    recoveryPassword: password,
    ownerApproved: true,
  });
  process.stdout.write(`${JSON.stringify({
    phase: 9,
    controlled: true,
    productionFunds: false,
    requester: requester.address.toLowerCase(),
    fundsReady: result.fundsReady,
    receipt: result.receipt,
    endpointPaymentAuthorized: result.endpointPaymentAuthorized,
    recoveryPersisted: fs.existsSync(result.recoveryFile),
    boundary:
      "Versus delivered requester-owned funds; the requester must perform any later x402 payment.",
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
