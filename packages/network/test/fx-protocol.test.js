const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { Wallet } = require("ethers");
const {
  FX_NATIVE_ETH_ADDRESS,
  FxValidationError,
  advanceFxCaseState,
  advanceFxState,
  assembleFxEnvelope,
  canonicalFxMessage,
  computeFxMessageId,
  normalizeFxMessage,
  selectSingleDealerRoute,
  verifyFxEnvelope,
} = require("../src/fx-protocol");

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "fixtures", "fx-phase1-v1.json"), "utf8")
);

async function signMessage(input, wallet) {
  const normalized = normalizeFxMessage({ ...input, sender: wallet.address });
  return assembleFxEnvelope(normalized, await wallet.signMessage(canonicalFxMessage(normalized)));
}

function baseRfq(requester, now = 1_800_000_000, policy = "lowest_all_in") {
  return {
    protocol: "versus-fx",
    version: 1,
    deploymentId: fixture.deploymentId,
    type: "fx_rfq",
    tradeId: fixture.tradeId,
    sender: requester.address,
    role: "requester",
    sequence: "1",
    createdAt: now,
    expiresAt: now + 50,
    payload: {
      outputChainId: "42161",
      outputToken: fixture.addresses.arbitrumUsdc,
      outputAmountAtomic: "100000",
      inputOptions: [{
        chainId: "8453",
        token: fixture.addresses.baseUsdc,
        maxInputAtomic: "105000",
      }],
      quoteDeadline: now + 40,
      settlementDeadline: now + 3600,
      quotePolicy: policy,
      x402Commitment: null,
    },
  };
}

function quoteFor(dealer, rfq, {
  sequence,
  amount,
  duration,
  now = rfq.createdAt + 5,
  referenceTimestamp = rfq.createdAt + 4,
}) {
  return {
    protocol: "versus-fx",
    version: 1,
    deploymentId: rfq.deploymentId,
    type: "fx_quote",
    tradeId: rfq.tradeId,
    sender: dealer.address,
    role: "dealer",
    sequence: String(sequence),
    createdAt: now,
    expiresAt: now + 35,
    payload: {
      rfqId: rfq.id,
      inputChainId: "8453",
      inputToken: fixture.addresses.baseUsdc,
      inputAmountAtomic: String(amount),
      outputChainId: "42161",
      outputToken: fixture.addresses.arbitrumUsdc,
      outputAmountAtomic: "100000",
      quoteType: "fixed_exact_output",
      referenceSource: "chainlink:usdc-usd",
      referencePriceMicros: "1000000",
      referenceTimestamp,
      spreadBps: 25,
      dealerSettlementCostAtomic: "750",
      estimatedCompletionSeconds: duration,
      adapterId: "evm-htlc-v1",
      adapterVersion: 1,
    },
  };
}

test("validates every Phase 1 message fixture and canonicalizes input ordering", () => {
  assert.equal(fixture.messages.length, 11);
  for (const message of fixture.messages) {
    const normalized = normalizeFxMessage(message);
    assert.equal(normalized.type, message.type);
    assert.equal(normalizeFxMessage(normalized).type, message.type);
  }

  const rfq = fixture.messages[0];
  const reversed = {
    ...rfq,
    payload: {
      ...rfq.payload,
      inputOptions: [...rfq.payload.inputOptions].reverse(),
    },
  };
  assert.equal(canonicalFxMessage(rfq), canonicalFxMessage(reversed));
  assert.equal(computeFxMessageId(rfq), computeFxMessageId(reversed));
});

test("matches the frozen cross-repository canonical hash vector", () => {
  const message = fixture.messages[fixture.interop.messageIndex];
  assert.equal(canonicalFxMessage(message), fixture.interop.canonical);
  assert.equal(computeFxMessageId(message), fixture.interop.id);
});

test("fails closed on unsupported versions and domain-separates message ids", () => {
  const message = fixture.messages[fixture.interop.messageIndex];
  assert.throws(() => normalizeFxMessage({ ...message, protocol: "versus-fx-preview" }));
  assert.throws(() => normalizeFxMessage({ ...message, version: 2 }));

  const baseId = computeFxMessageId(message);
  assert.notEqual(
    computeFxMessageId({ ...message, deploymentId: "0x" + "ab".repeat(32) }),
    baseId
  );
  assert.notEqual(
    computeFxMessageId({ ...message, tradeId: "0x" + "cd".repeat(32) }),
    baseId
  );
  assert.notEqual(
    computeFxMessageId({
      ...fixture.messages.find((candidate) => candidate.type === "fx_quote"),
      deploymentId: message.deploymentId,
      tradeId: message.tradeId,
      sender: message.sender,
    }),
    baseId
  );
});

test("signs and verifies every role-appropriate message type", async () => {
  const wallets = {
    requester: Wallet.createRandom(),
    dealer: Wallet.createRandom(),
    relayer: Wallet.createRandom(),
    broker: Wallet.createRandom(),
  };
  for (const message of fixture.messages) {
    const envelope = await signMessage(message, wallets[message.role]);
    assert.equal(verifyFxEnvelope(envelope, { temporal: false }).id, envelope.id);
  }
  const quote = await signMessage(
    fixture.messages.find((message) => message.type === "fx_quote"),
    wallets.dealer
  );
  assert.throws(
    () => verifyFxEnvelope({
      ...quote,
      payload: { ...quote.payload, spreadBps: 26 },
    }, { temporal: false }),
    { code: "BAD_ID" }
  );
});

test("rejects unknown fields, role confusion, secret disclosure, and unsafe lifetime", () => {
  const rfq = fixture.messages[0];
  const accept = fixture.messages.find((message) => message.type === "fx_accept");
  assert.throws(() => normalizeFxMessage({ ...rfq, surprise: true }), {
    code: "UNKNOWN_FIELD",
  });
  assert.throws(() => normalizeFxMessage({ ...rfq, role: "dealer" }), {
    code: "ROLE_MISMATCH",
  });
  assert.throws(
    () => normalizeFxMessage({ ...rfq, expiresAt: rfq.createdAt + 61 }),
    /invalid lifetime/
  );
  const claim = fixture.messages.find((message) => message.type === "fx_claim");
  assert.throws(
    () => normalizeFxMessage({
      ...claim,
      payload: { ...claim.payload, secret: "do not publish this" },
    }),
    { code: "UNKNOWN_FIELD" }
  );
  assert.throws(
    () => normalizeFxMessage({
      ...accept,
      payload: { ...accept.payload, totalInputAtomic: "101251" },
    }),
    { code: "INVALID_ECONOMICS" }
  );
});

test("binds native and ERC-20 adapter families without changing legacy quotes", () => {
  const legacy = fixture.messages.find(
    (message) => message.type === "fx_quote"
  );
  const normalizedLegacy = normalizeFxMessage(legacy);
  assert.equal("sourceAdapterId" in normalizedLegacy.payload, false);

  const native = normalizeFxMessage({
    ...legacy,
    payload: {
      ...legacy.payload,
      inputToken: FX_NATIVE_ETH_ADDRESS,
      sourceAdapterId: "evm-native-htlc-v1",
      sourceAdapterVersion: 1,
      destinationAdapterId: "evm-htlc-v1",
      destinationAdapterVersion: 1,
    },
  });
  assert.equal(native.payload.inputToken, FX_NATIVE_ETH_ADDRESS);
  assert.equal(native.payload.sourceAdapterId, "evm-native-htlc-v1");
  assert.equal(native.payload.destinationAdapterId, "evm-htlc-v1");
  assert.notEqual(computeFxMessageId(native), computeFxMessageId(legacy));

  assert.throws(
    () => normalizeFxMessage({
      ...legacy,
      payload: {
        ...legacy.payload,
        sourceAdapterId: "evm-native-htlc-v1",
      },
    }),
    /must include both sides and versions/
  );
});

test("settlement and dispute state machines are deterministic and separate", () => {
  for (const [from, event, expected] of fixture.stateTransitions.happyPath) {
    assert.equal(advanceFxState(from, event), expected);
  }
  for (const [from, event, expected] of fixture.stateTransitions.refundPath) {
    assert.equal(advanceFxState(from, event), expected);
  }
  for (const [from, event, expected] of fixture.stateTransitions.casePath) {
    assert.equal(advanceFxCaseState(from, event), expected);
  }
  assert.throws(() => advanceFxState("rfq_open", "confirm_source_claim"), {
    code: "INVALID_STATE_TRANSITION",
  });
  assert.throws(() => advanceFxCaseState("none", "resolve_upheld"), {
    code: "INVALID_CASE_TRANSITION",
  });
});

test("selects a signed deterministic route and rejects stale or manipulated quotes", async () => {
  const requester = Wallet.createRandom();
  const dealerA = Wallet.createRandom();
  const dealerB = Wallet.createRandom();
  const now = 1_800_000_010;
  const signedRfq = await signMessage(baseRfq(requester), requester);

  const quoteA = await signMessage(
    quoteFor(dealerA, signedRfq, { sequence: 1, amount: 101000, duration: 45 }),
    dealerA
  );
  const quoteB = await signMessage(
    quoteFor(dealerB, signedRfq, { sequence: 1, amount: 100800, duration: 20 }),
    dealerB
  );

  const cheapest = selectSingleDealerRoute(signedRfq, [
    { quote: quoteA, brokerFeeAtomic: "0" },
    { quote: quoteB, brokerFeeAtomic: "500" },
  ], { now });
  assert.equal(cheapest.quoteId, quoteA.id);
  assert.equal(cheapest.totalInputAtomic, "101000");

  const fastest = selectSingleDealerRoute(signedRfq, [
    { quote: quoteA, brokerFeeAtomic: "0" },
    { quote: quoteB, brokerFeeAtomic: "500" },
  ], { now, policy: "fastest" });
  assert.equal(fastest.quoteId, quoteB.id);

  assert.throws(
    () => selectSingleDealerRoute(
      signedRfq,
      [{ quote: quoteA, brokerFeeAtomic: "5000" }],
      { now }
    ),
    { code: "NO_VALID_ROUTE" }
  );

  const tampered = {
    ...quoteA,
    payload: { ...quoteA.payload, inputAmountAtomic: "1" },
  };
  assert.throws(
    () => selectSingleDealerRoute(signedRfq, [{ quote: tampered, brokerFeeAtomic: "0" }], { now }),
    { code: "NO_VALID_ROUTE" }
  );

  const stale = await signMessage(
    quoteFor(dealerA, signedRfq, {
      sequence: 2,
      amount: 100000,
      duration: 1,
      referenceTimestamp: now - 61,
    }),
    dealerA
  );
  assert.throws(
    () => selectSingleDealerRoute(signedRfq, [{ quote: stale, brokerFeeAtomic: "0" }], { now }),
    { code: "NO_VALID_ROUTE" }
  );
});

test("rejects a signature from a different sender", async () => {
  const expected = Wallet.createRandom();
  const attacker = Wallet.createRandom();
  const message = normalizeFxMessage({ ...fixture.messages[0], sender: expected.address });
  const envelope = assembleFxEnvelope(
    message,
    await attacker.signMessage(canonicalFxMessage(message))
  );
  assert.throws(() => verifyFxEnvelope(envelope, { temporal: false }), (error) => {
    assert.ok(error instanceof FxValidationError);
    return error.code === "BAD_SIGNATURE";
  });
});
