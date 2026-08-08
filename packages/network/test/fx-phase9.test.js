const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  Wallet,
  keccak256,
  toUtf8Bytes,
} = require("ethers");
const {
  FxRequesterFundingSdk,
  FxRequesterSdkError,
  createBrokerRouteProposal,
  parseManualFundingRequirement,
  parseX402PaymentRequiredHeader,
  parseX402FundingRequirement,
  signFxMessage,
} = require("../src");
const {
  restoreFxRecoveryPacket,
} = require("../src/fx-recovery");
const {
  buildControlledRequirement,
} = require("../src/fx-x402-fixture");

const DEPLOYMENT_ID = `0x${"91".repeat(32)}`;
const SOURCE_CHAIN = "84532";
const DESTINATION_CHAIN = "421614";
const SOURCE_TOKEN = `0x${"11".repeat(20)}`;
const DESTINATION_TOKEN = `0x${"22".repeat(20)}`;
const NOW = 1_800_000_000;
const PASSWORD = "correct horse phase nine";

function requirement(endpoint = Wallet.createRandom().address) {
  return {
    x402Version: 2,
    scheme: "exact",
    network: `eip155:${DESTINATION_CHAIN}`,
    asset: DESTINATION_TOKEN,
    amount: "100000",
    payTo: endpoint,
    resource: "https://private.example/agent/report?id=secret",
    description: "private resource",
  };
}

async function brokerProposal(rfq, {
  broker = Wallet.createRandom(),
  dealer = Wallet.createRandom(),
} = {}) {
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
      inputChainId: SOURCE_CHAIN,
      inputToken: SOURCE_TOKEN,
      inputAmountAtomic: "101000",
      outputChainId: DESTINATION_CHAIN,
      outputToken: DESTINATION_TOKEN,
      outputAmountAtomic: "100000",
      quoteType: "fixed_exact_output",
      referenceSource: "chainlink:usdc-usd",
      referencePriceMicros: "1000000",
      referenceTimestamp: NOW,
      spreadBps: 25,
      dealerSettlementCostAtomic: "500",
      estimatedCompletionSeconds: 30,
      adapterId: "evm-htlc-v1",
      adapterVersion: 1,
    },
  }, dealer);
  return createBrokerRouteProposal({
    signer: broker,
    rfq,
    quotes: [quote],
    brokerFeeAtomic: "500",
    now: NOW,
  });
}

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-fx-phase9-"));
  return {
    directory,
    cleanup() {
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("Phase 9 turns an x402 challenge into a local-only exact funding requirement", () => {
  const endpoint = Wallet.createRandom().address;
  const parsed = parseX402FundingRequirement({
    x402Version: 2,
    accepts: [requirement(endpoint)],
  });
  assert.equal(parsed.outputChainId, DESTINATION_CHAIN);
  assert.equal(parsed.outputToken, DESTINATION_TOKEN.toLowerCase());
  assert.equal(parsed.outputAmountAtomic, "100000");
  assert.match(parsed.localRequirementDigest, /^0x[0-9a-f]{64}$/);
  assert.equal("payTo" in parsed, false);
  assert.equal("resource" in parsed, false);
  assert.equal("description" in parsed, false);
  const fromHeader = parseX402PaymentRequiredHeader(
    Buffer.from(JSON.stringify({
      x402Version: 2,
      accepts: [requirement(endpoint)],
    })).toString("base64")
  );
  assert.deepEqual(fromHeader, parsed);
  assert.throws(
    () => parseX402FundingRequirement({
      ...requirement(endpoint),
      network: "solana:mainnet",
    }),
    (error) =>
      error instanceof FxRequesterSdkError &&
      error.code === "UNSUPPORTED_NETWORK"
  );
});

test("Phase 9 normalizes manual exact-output funding without endpoint data", () => {
  const parsed = parseManualFundingRequirement({
    outputChainId: DESTINATION_CHAIN,
    outputToken: DESTINATION_TOKEN,
    outputAmountAtomic: "250000",
  });
  assert.equal(parsed.source, "manual");
  assert.equal(parsed.outputChainId, DESTINATION_CHAIN);
  assert.equal(parsed.outputToken, DESTINATION_TOKEN.toLowerCase());
  assert.equal(parsed.outputAmountAtomic, "250000");
  assert.match(parsed.localRequirementDigest, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(parsed).sort(), [
    "localRequirementDigest",
    "outputAmountAtomic",
    "outputChainId",
    "outputToken",
    "schema",
    "schemaVersion",
    "source",
  ]);
});

test("Phase 9 funds the requester wallet, persists recovery first, and stops before payment", async () => {
  const run = temporaryDirectory();
  const requester = Wallet.createRandom();
  const endpoint = Wallet.createRandom().address.toLowerCase();
  let settlementInput;
  let endpointPaymentCalls = 0;
  try {
    const sdk = new FxRequesterFundingSdk({
      deploymentId: DEPLOYMENT_ID,
      signer: requester,
      brokerEndpoints: ["https://broker.example"],
      recoveryDirectory: run.directory,
      now: () => NOW,
      randomSecret: () => Buffer.alloc(32, 9),
      async queryRoutes({ rfq }) {
        const serialized = JSON.stringify(rfq);
        assert.equal(rfq.payload.x402Commitment, null);
        assert.doesNotMatch(serialized, /private\.example/);
        assert.doesNotMatch(serialized, new RegExp(endpoint.slice(2), "i"));
        const proposal = await brokerProposal(rfq);
        return {
          selected: proposal,
          attempts: [{
            endpoint: "https://broker.example",
            ok: true,
            latencyMs: 12,
            proposal,
          }],
        };
      },
      async settlementExecutor(input) {
        settlementInput = input;
        assert.equal(fs.existsSync(input.recoveryFile), true);
        assert.equal(input.destinationAddress, requester.address.toLowerCase());
        assert.equal(input.requester, requester.address.toLowerCase());
        assert.equal(
          input.acceptance.payload.destinationClaimAddress,
          requester.address.toLowerCase()
        );
        assert.equal(
          input.acceptance.payload.sourceRefundAddress,
          requester.address.toLowerCase()
        );
        assert.equal(input.acceptance.payload.secretHash, input.secretHash);
        assert.equal("requirement" in input, false);
        assert.equal("payTo" in input, false);
        assert.equal("resource" in input, false);
        return {
          destinationTransactionHash: `0x${"55".repeat(32)}`,
        };
      },
      async destinationVerifier({ settlement, expected }) {
        assert.equal(
          settlement.destinationTransactionHash,
          `0x${"55".repeat(32)}`
        );
        return {
          confirmed: true,
          chainId: expected.outputChainId,
          token: expected.outputToken,
          amountAtomic: expected.outputAmountAtomic,
          beneficiary: expected.destinationAddress,
          transactionHash: settlement.destinationTransactionHash,
          blockNumber: "12345",
          confirmations: 2,
        };
      },
    });
    const quote = await sdk.quoteFunding({
      requirement: requirement(endpoint),
      destinationAddress: requester.address,
      inputOptions: [{
        chainId: SOURCE_CHAIN,
        token: SOURCE_TOKEN,
        maxInputAtomic: "110000",
      }],
      tradeId: keccak256(toUtf8Bytes("phase-9-funding")),
    });
    assert.equal(quote.endpointPaymentAuthorized, false);
    assert.equal(quote.destinationAddress, requester.address.toLowerCase());
    assert.equal("payTo" in quote, false);
    assert.equal("resource" in quote, false);

    const result = await sdk.executeFunding({
      quote,
      recoveryPassword: PASSWORD,
      ownerApproved: true,
    });
    assert.equal(result.fundsReady, true);
    assert.equal(result.endpointPaymentAuthorized, false);
    assert.equal(result.receipt.status, "funds_ready");
    assert.equal(result.receipt.destinationAddress, requester.address.toLowerCase());
    assert.equal(result.receipt.endpointPaymentAuthorized, false);
    assert.equal(result.receipt.endpointPaymentSubmitted, false);
    assert.match(result.receipt.receiptId, /^0x[0-9a-f]{64}$/);
    assert.equal(endpointPaymentCalls, 0);
    assert.ok(settlementInput.secret instanceof Buffer);

    const recoveryBytes = fs.readFileSync(result.recoveryFile, "utf8");
    assert.doesNotMatch(recoveryBytes, new RegExp(settlementInput.secret.toString("base64")));
    const restored = restoreFxRecoveryPacket({
      filePath: result.recoveryFile,
      password: PASSWORD,
      deploymentId: DEPLOYMENT_ID,
      tradeId: quote.tradeId,
    });
    assert.equal(restored.secretHash, settlementInput.secretHash);

    const recovered = await sdk.recoverFunding({
      quote,
      recoveryPassword: PASSWORD,
      settlement: {
        destinationTransactionHash: `0x${"55".repeat(32)}`,
      },
    });
    assert.equal(recovered.fundsReady, true);
    assert.equal(recovered.receipt.destinationTransactionHash, `0x${"55".repeat(32)}`);
    const tamperedRecoveryQuote = structuredClone(quote);
    tamperedRecoveryQuote.outputToken = SOURCE_TOKEN;
    await assert.rejects(
      () => sdk.recoverFunding({
        quote: tamperedRecoveryQuote,
        recoveryPassword: PASSWORD,
        settlement: {
          destinationTransactionHash: `0x${"55".repeat(32)}`,
        },
      }),
      (error) => error.code === "OUTPUT_MISMATCH"
    );

    // The consuming agent owns this next call. It is deliberately outside the SDK.
    const requesterOwnedPayment = async () => {
      endpointPaymentCalls += 1;
    };
    await requesterOwnedPayment();
    assert.equal(endpointPaymentCalls, 1);
  } finally {
    run.cleanup();
  }
});

test("Phase 9 binds an arbitrary recipient and refund address without wallet connection", async () => {
  const run = temporaryDirectory();
  const requester = Wallet.createRandom();
  const recipient = Wallet.createRandom();
  const refund = Wallet.createRandom();
  try {
    const sdk = new FxRequesterFundingSdk({
      deploymentId: DEPLOYMENT_ID,
      signer: requester,
      brokerEndpoints: ["https://broker.example"],
      recoveryDirectory: run.directory,
      async queryRoutes({ rfq }) {
        const proposal = await brokerProposal(rfq);
        return {
          selected: proposal,
          attempts: [{
            endpoint: "https://broker.example",
            ok: true,
            latencyMs: 1,
            proposal,
          }],
        };
      },
      async settlementExecutor() {
        throw new Error("unreachable");
      },
      async destinationVerifier() {
        throw new Error("unreachable");
      },
      now: () => NOW,
    });
    const quote = await sdk.quoteFunding({
      requirement: {
        source: "manual",
        outputChainId: DESTINATION_CHAIN,
        outputToken: DESTINATION_TOKEN,
        outputAmountAtomic: "100000",
      },
      destinationAddress: recipient.address,
      sourceRefundAddress: refund.address,
      inputOptions: [{
        chainId: SOURCE_CHAIN,
        token: SOURCE_TOKEN,
        maxInputAtomic: "110000",
      }],
    });
    assert.equal(quote.requester, requester.address.toLowerCase());
    assert.equal(quote.sourceFundingAddress, requester.address.toLowerCase());
    assert.equal(quote.destinationAddress, recipient.address.toLowerCase());
    assert.equal(quote.sourceRefundAddress, refund.address.toLowerCase());

    const prepared = await sdk.prepareExternalFunding({
      quote,
      recoveryPassword: PASSWORD,
      ownerApproved: true,
    });
    assert.equal(prepared.sourceFundingAddress, requester.address.toLowerCase());
    assert.equal(prepared.destinationAddress, recipient.address.toLowerCase());
    assert.equal(prepared.sourceRefundAddress, refund.address.toLowerCase());
    assert.equal(
      prepared.acceptance.payload.destinationClaimAddress,
      recipient.address.toLowerCase()
    );
    assert.equal(
      prepared.acceptance.payload.sourceRefundAddress,
      refund.address.toLowerCase()
    );
    assert.equal(fs.existsSync(prepared.recoveryFile), true);
  } finally {
    run.cleanup();
  }
});

test("Phase 9 never emits fundsReady for a redirected or underfunded observation", async () => {
  const run = temporaryDirectory();
  const requester = Wallet.createRandom();
  try {
    let mismatch = "beneficiary";
    const sdk = new FxRequesterFundingSdk({
      deploymentId: DEPLOYMENT_ID,
      signer: requester,
      brokerEndpoints: ["https://broker.example"],
      recoveryDirectory: run.directory,
      now: () => NOW,
      async queryRoutes({ rfq }) {
        const proposal = await brokerProposal(rfq);
        return {
          selected: proposal,
          attempts: [{ endpoint: "https://broker.example", ok: true, latencyMs: 1, proposal }],
        };
      },
      async settlementExecutor() {
        return { transactionHash: `0x${"66".repeat(32)}` };
      },
      async destinationVerifier({ expected, settlement }) {
        return {
          confirmed: true,
          chainId: expected.outputChainId,
          token: expected.outputToken,
          amountAtomic:
            mismatch === "amount"
              ? (BigInt(expected.outputAmountAtomic) - 1n).toString()
              : expected.outputAmountAtomic,
          beneficiary:
            mismatch === "beneficiary"
              ? Wallet.createRandom().address
              : expected.destinationAddress,
          transactionHash: settlement.transactionHash,
          blockNumber: "12345",
          confirmations: 2,
        };
      },
    });
    const quote = await sdk.quoteFunding({
      requirement: requirement(),
      destinationAddress: requester.address,
      inputOptions: [{
        chainId: SOURCE_CHAIN,
        token: SOURCE_TOKEN,
        maxInputAtomic: "110000",
      }],
      tradeId: keccak256(toUtf8Bytes("phase-9-mismatch")),
    });
    await assert.rejects(
      () => sdk.executeFunding({
        quote,
        recoveryPassword: PASSWORD,
        ownerApproved: true,
      }),
      (error) => error.code === "DESTINATION_MISMATCH"
    );
    mismatch = "amount";
    await assert.rejects(
      () => sdk.recoverFunding({
        quote,
        recoveryPassword: PASSWORD,
        settlement: { transactionHash: `0x${"66".repeat(32)}` },
      }),
      (error) => error.code === "DESTINATION_MISMATCH"
    );
  } finally {
    run.cleanup();
  }
});

test("existing controlled x402 fixtures remain payment endpoints, not SDK destinations", () => {
  const endpoint = Wallet.createRandom().address;
  const { requirement: controlled } = buildControlledRequirement({
    outputAmountAtomic: 100_000n,
    outputRecipient: endpoint,
    paymentId: keccak256(toUtf8Bytes("phase-9-controlled-requirement")),
  });
  const funding = parseX402FundingRequirement(controlled);
  assert.equal(funding.outputChainId, "8453");
  assert.equal(funding.outputAmountAtomic, "100000");
  assert.equal("payTo" in funding, false);
});
