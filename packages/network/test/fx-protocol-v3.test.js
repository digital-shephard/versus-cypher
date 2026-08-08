const assert = require("node:assert/strict");
const test = require("node:test");
const { Wallet, keccak256 } = require("ethers");
const {
  advanceFxState,
  assembleFxEnvelope,
  canonicalFxMessage,
  normalizeFxMessage,
  verifyFxEnvelope,
} = require("../src/fx-protocol");

const DEPLOYMENT_ID = `0x${"72".repeat(32)}`;
const TRADE_ID = `0x${"73".repeat(32)}`;
const RFQ_ID = `0x${"74".repeat(32)}`;
const ACCEPT_ID = `0x${"75".repeat(32)}`;
const DESTINATION_LOCK_ID = `0x${"76".repeat(32)}`;
const SECRET = `0x${"77".repeat(32)}`;
const SECRET_HASH = keccak256(SECRET);
const BASE_USDC = "0x1111111111111111111111111111111111111111";
const ARB_USDC = "0x2222222222222222222222222222222222222222";

function quote(wallet, overrides = {}) {
  return {
    protocol: "versus-fx",
    version: 3,
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
      adapterId: "evm-htlc-v3",
      adapterVersion: 3,
      sourceAdapterId: "evm-htlc-v3",
      sourceAdapterVersion: 3,
      destinationAdapterId: "evm-htlc-v3",
      destinationAdapterVersion: 3,
      dealerPrincipalAtomic: "1000000",
      dealerSpreadAtomic: "2500",
      dealerOperatingCostAtomic: "12500",
      destinationExecutorAmountAtomic: "2000",
      destinationClaimGasEstimate: "85000",
      destinationMaxFeePerGas: "100000000",
      gasPriceSource: "rpc:arbitrum-sepolia",
      gasPriceTimestamp: 1_800_000_008,
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

test("V3 quote binds exact economics without giving the dealer a secret", async () => {
  const dealer = Wallet.createRandom();
  const verified = verifyFxEnvelope(await sign(quote(dealer), dealer), {
    temporal: false,
  });
  assert.equal(verified.version, 3);
  assert.equal(verified.payload.adapterVersion, 3);
  assert.equal(verified.payload.destinationExecutorAmountAtomic, "2000");
  assert.equal(Object.hasOwn(verified.payload, "secretHash"), false);
  assert.throws(
    () => normalizeFxMessage(quote(dealer, { destinationAdapterVersion: 2 })),
    { code: "ADAPTER_VERSION_MISMATCH" }
  );
});

test("V3 reveal binds the requester secret to the accepted destination lock", () => {
  const requester = Wallet.createRandom();
  const normalized = normalizeFxMessage({
    protocol: "versus-fx",
    version: 3,
    deploymentId: DEPLOYMENT_ID,
    type: "fx_reveal",
    tradeId: TRADE_ID,
    sender: requester.address,
    role: "requester",
    sequence: "7",
    createdAt: 1_800_000_020,
    expiresAt: 1_800_007_200,
    payload: {
      acceptId: ACCEPT_ID,
      destinationLockMessageId: DESTINATION_LOCK_ID,
      secret: SECRET,
      secretHash: SECRET_HASH,
    },
  });
  assert.equal(normalized.payload.secretHash, SECRET_HASH);
  assert.throws(
    () => normalizeFxMessage({
      ...normalized,
      payload: {
        ...normalized.payload,
        secret: `0x${"78".repeat(32)}`,
      },
    }),
    { code: "WRONG_SECRET" }
  );
});

test("V3 state machine reveals only after destination funding", () => {
  assert.equal(
    advanceFxState("quote_accepted", "confirm_source_lock", 3),
    "source_locked"
  );
  assert.equal(
    advanceFxState("source_locked", "confirm_destination_lock", 3),
    "destination_locked"
  );
  assert.equal(
    advanceFxState("destination_locked", "reveal_secret", 3),
    "secret_revealed"
  );
  assert.equal(
    advanceFxState("secret_revealed", "confirm_destination_claim", 3),
    "destination_claimed"
  );
  assert.equal(
    advanceFxState("destination_claimed", "confirm_source_claim", 3),
    "complete"
  );
  assert.throws(
    () => advanceFxState("source_locked", "reveal_secret", 3),
    { code: "INVALID_STATE_TRANSITION" }
  );
});
