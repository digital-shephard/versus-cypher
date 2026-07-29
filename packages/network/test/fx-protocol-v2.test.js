const assert = require("node:assert/strict");
const test = require("node:test");
const { Wallet } = require("ethers");
const {
  advanceFxState,
  assembleFxEnvelope,
  canonicalFxMessage,
  normalizeFxMessage,
  verifyFxEnvelope,
} = require("../src/fx-protocol");

const DEPLOYMENT_ID = `0x${"22".repeat(32)}`;
const TRADE_ID = `0x${"33".repeat(32)}`;
const RFQ_ID = `0x${"44".repeat(32)}`;
const SECRET_HASH = `0x${"55".repeat(32)}`;
const BASE_USDC = "0x1111111111111111111111111111111111111111";
const ARB_USDC = "0x2222222222222222222222222222222222222222";

function quote(wallet, overrides = {}) {
  return {
    protocol: "versus-fx",
    version: 2,
    deploymentId: DEPLOYMENT_ID,
    type: "fx_quote",
    tradeId: TRADE_ID,
    sender: wallet.address,
    role: "dealer",
    sequence: "2",
    createdAt: 1_800_000_010,
    expiresAt: 1_800_000_130,
    payload: {
      rfqId: RFQ_ID,
      inputChainId: "84532",
      inputToken: BASE_USDC,
      inputAmountAtomic: "1015000",
      outputChainId: "421614",
      outputToken: ARB_USDC,
      outputAmountAtomic: "1000000",
      quoteType: "fixed_exact_output",
      referenceSource: "relay:eth-usd",
      referencePriceMicros: "3000000000",
      referenceTimestamp: 1_800_000_009,
      spreadBps: 25,
      dealerSettlementCostAtomic: "12500",
      estimatedCompletionSeconds: 45,
      adapterId: "evm-htlc-v2",
      adapterVersion: 2,
      sourceAdapterId: "evm-htlc-v2",
      sourceAdapterVersion: 2,
      destinationAdapterId: "evm-htlc-v2",
      destinationAdapterVersion: 2,
      dealerPrincipalAtomic: "1000000",
      dealerSpreadAtomic: "2500",
      dealerOperatingCostAtomic: "12500",
      destinationExecutorAmountAtomic: "2000",
      destinationClaimGasEstimate: "85000",
      destinationMaxFeePerGas: "100000000",
      gasPriceSource: "rpc:arbitrum-sepolia",
      gasPriceTimestamp: 1_800_000_008,
      secretHash: SECRET_HASH,
      ...overrides,
    },
  };
}

async function sign(input, wallet) {
  const normalized = normalizeFxMessage(input);
  return assembleFxEnvelope(
    normalized,
    await wallet.signMessage(canonicalFxMessage(normalized))
  );
}

test("V2 quote binds dealer secret, exact economics, gas reference, and adapters", async () => {
  const dealer = Wallet.createRandom();
  const envelope = await sign(quote(dealer), dealer);
  const verified = verifyFxEnvelope(envelope, { temporal: false });
  assert.equal(verified.version, 2);
  assert.equal(verified.payload.secretHash, SECRET_HASH);
  assert.equal(verified.payload.destinationExecutorAmountAtomic, "2000");
  assert.equal(verified.payload.destinationAdapterVersion, 2);
});

test("V2 rejects hidden input costs and version-one adapters", () => {
  const dealer = Wallet.createRandom();
  assert.throws(
    () => normalizeFxMessage(quote(dealer, { dealerOperatingCostAtomic: "12000" })),
    { code: "INVALID_ECONOMICS" }
  );
  assert.throws(
    () => normalizeFxMessage(quote(dealer, { destinationAdapterVersion: 1 })),
    { code: "ADAPTER_VERSION_MISMATCH" }
  );
});

test("V2 lock binds exact recipient and executor liabilities", () => {
  const requester = Wallet.createRandom();
  const message = {
    protocol: "versus-fx",
    version: 2,
    deploymentId: DEPLOYMENT_ID,
    type: "fx_lock_destination",
    tradeId: TRADE_ID,
    sender: requester.address,
    role: "dealer",
    sequence: "5",
    createdAt: 1_800_000_020,
    expiresAt: 1_800_007_200,
    payload: {
      acceptId: RFQ_ID,
      chainId: "421614",
      token: ARB_USDC,
      amountAtomic: "1002000",
      beneficiaryAmountAtomic: "1000000",
      executorAmountAtomic: "2000",
      lockAddress: "0x3333333333333333333333333333333333333333",
      beneficiary: "0x4444444444444444444444444444444444444444",
      refundAddress: "0x5555555555555555555555555555555555555555",
      secretHash: SECRET_HASH,
      timeout: 1_800_007_000,
      transactionHash: `0x${"66".repeat(32)}`,
      blockNumber: "123",
    },
  };
  assert.equal(normalizeFxMessage(message).payload.amountAtomic, "1002000");
  assert.throws(
    () => normalizeFxMessage({
      ...message,
      payload: { ...message.payload, executorAmountAtomic: "1999" },
    }),
    { code: "INVALID_ECONOMICS" }
  );
});

test("V2 state machine is destination-first and source-claim-first", () => {
  assert.equal(advanceFxState("quote_accepted", "confirm_destination_lock", 2), "destination_locked");
  assert.equal(advanceFxState("destination_locked", "confirm_source_lock", 2), "source_locked");
  assert.equal(advanceFxState("source_locked", "confirm_source_claim", 2), "source_claimed");
  assert.equal(advanceFxState("source_claimed", "confirm_destination_claim", 2), "complete");
  assert.throws(
    () => advanceFxState("quote_accepted", "confirm_source_lock", 2),
    { code: "INVALID_STATE_TRANSITION" }
  );
  assert.throws(
    () => advanceFxState("source_locked", "confirm_destination_claim", 2),
    { code: "INVALID_STATE_TRANSITION" }
  );
});

test("V2 cancellation preserves a funded destination lock until its refund", () => {
  assert.equal(
    advanceFxState("destination_locked", "cancel_before_source_lock", 2),
    "destination_cancelled"
  );
  assert.equal(
    advanceFxState("destination_cancelled", "confirm_destination_refund", 2),
    "refunded"
  );
  assert.throws(
    () => advanceFxState("destination_cancelled", "confirm_source_lock", 2),
    { code: "INVALID_STATE_TRANSITION" }
  );
});
