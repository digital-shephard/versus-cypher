const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { Wallet, keccak256, toUtf8Bytes } = require("ethers");
const {
  FxX402ExactBrokerBridge,
  canonicalJson,
  createBrokerRouteProposal,
  phase5LockId,
  signFxMessage,
} = require("../src");

const MANIFEST = require("../../../versus/deployments/fx/phase12-v3-public-testnet.json");
const SOURCE_CHAIN = "84532";
const DESTINATION_CHAIN = "421614";
const SOURCE_TOKEN = MANIFEST.capabilities.find(
  (item) => item.chainId === SOURCE_CHAIN
).erc20.asset.address;
const DESTINATION_TOKEN = MANIFEST.capabilities.find(
  (item) => item.chainId === DESTINATION_CHAIN
).erc20.asset.address;
const SOURCE_ADAPTER_ID = MANIFEST.builds.erc20.adapterId;
const DESTINATION_ADAPTER_ID = MANIFEST.builds.erc20.adapterId;
const NOW = 1_800_000_000;
const REQUEST_ID = `0x${"41".repeat(32)}`;
const SECRET_HASH = `0x${"42".repeat(32)}`;
const PAY_TO = `0x${"43".repeat(20)}`;
const FACTORY = `0x${"44".repeat(20)}`;
const FACILITATOR_FEE = "1000";

class FakeJournal {
  constructor() {
    this.messages = [];
  }

  add(message) {
    this.messages.push(message);
  }

  findType(tradeId, type) {
    return this.messages.findLast(
      (message) => message.tradeId === tradeId && message.type === type
    );
  }
}

class FakeSession extends EventEmitter {
  constructor({ signer, dealer, reserveClaimAddress = dealer.address }) {
    super();
    this.signer = signer;
    this.dealer = dealer;
    this.reserveClaimAddress = reserveClaimAddress.toLowerCase();
    this.journal = new FakeJournal();
    this.transport = {
      publish: async (message) => {
        if (message.type !== "fx_accept") return;
        const reserve = await signFxMessage({
          protocol: "versus-fx",
          version: 3,
          deploymentId: MANIFEST.deploymentId,
          type: "fx_reserve",
          tradeId: message.tradeId,
          role: "dealer",
          sequence: "2",
          createdAt: NOW,
          expiresAt: NOW + 600,
          payload: {
            acceptId: message.id,
            quoteId: message.payload.quoteId,
            dealerSourceClaimAddress: this.reserveClaimAddress,
            dealerDestinationRefundAddress: this.dealer.address,
            reservationDeadline: NOW + 300,
          },
        }, this.dealer);
        this.journal.add(reserve);
        setImmediate(() => this.emit("accepted", reserve));
      },
    };
  }

  ingest(message) {
    this.journal.add(message);
    return { status: "accepted" };
  }
}

function requestBody(payer) {
  return {
    requestId: REQUEST_ID,
    payer: payer.address,
    input: {
      network: `eip155:${SOURCE_CHAIN}`,
      asset: SOURCE_TOKEN,
    },
    maximumInputAtomic: "1100000",
    output: {
      network: `eip155:${DESTINATION_CHAIN}`,
      asset: DESTINATION_TOKEN,
      amountAtomic: "1000000",
    },
    destinationAddress: payer.address,
    secretHash: SECRET_HASH,
  };
}

function bridgeFixture({
  sourceAdapterId = SOURCE_ADAPTER_ID,
  reserveClaimAddress,
  facilitatorFeeAtomic = FACILITATOR_FEE,
} = {}) {
  const relay = Wallet.createRandom();
  const dealer = Wallet.createRandom();
  const payer = Wallet.createRandom();
  const session = new FakeSession({
    signer: relay,
    dealer,
    reserveClaimAddress,
  });
  let observedRfq;
  const broker = {
    async requestRoute(rfq) {
      observedRfq = rfq;
      const quote = await signFxMessage({
        protocol: "versus-fx",
        version: 3,
        deploymentId: MANIFEST.deploymentId,
        type: "fx_quote",
        tradeId: rfq.tradeId,
        role: "dealer",
        sequence: "1",
        createdAt: NOW,
        expiresAt: NOW + 100,
        payload: {
          rfqId: rfq.id,
          inputChainId: SOURCE_CHAIN,
          inputToken: SOURCE_TOKEN,
          inputAmountAtomic: "1000500",
          outputChainId: DESTINATION_CHAIN,
          outputToken: DESTINATION_TOKEN,
          outputAmountAtomic: "1000000",
          quoteType: "fixed_exact_output",
          referenceSource: "relay:usdc-usd",
          referencePriceMicros: "1000000",
          referenceTimestamp: NOW,
          spreadBps: 5,
          dealerSettlementCostAtomic: "0",
          estimatedCompletionSeconds: 20,
          adapterId: sourceAdapterId,
          adapterVersion: 3,
          sourceAdapterId,
          sourceAdapterVersion: 3,
          destinationAdapterId: DESTINATION_ADAPTER_ID,
          destinationAdapterVersion: 3,
          dealerPrincipalAtomic: "1000000",
          dealerSpreadAtomic: "500",
          dealerOperatingCostAtomic: "0",
          destinationExecutorAmountAtomic: "1",
          destinationClaimGasEstimate: "85000",
          destinationMaxFeePerGas: "100000000",
          gasPriceSource: "rpc:arbitrum-sepolia",
          gasPriceTimestamp: NOW,
          dealerSourceClaimAddress: dealer.address,
        },
      }, dealer);
      return createBrokerRouteProposal({
        signer: relay,
        rfq,
        quotes: [quote],
        brokerFeeAtomic: "0",
        now: NOW,
        lifetimeSeconds: 60,
      });
    },
  };
  let observedFactoryRead;
  const bridge = new FxX402ExactBrokerBridge({
    broker,
    session,
    manifest: MANIFEST,
    providers: {
      [SOURCE_CHAIN]: { getBlock: async () => ({ timestamp: NOW }) },
    },
    factories: {
      [`${SOURCE_CHAIN}:${SOURCE_TOKEN.toLowerCase()}`]: {
        factoryAddress: FACTORY,
        tokenName: "Mock EIP3009 USDC",
        tokenVersion: "2",
        facilitatorRecipient: relay.address,
        facilitatorFeeAtomic,
      },
    },
    factoryReader: async (input) => {
      observedFactoryRead = input;
      return {
        payTo: PAY_TO,
        amount: (1000500n + BigInt(facilitatorFeeAtomic)).toString(),
      };
    },
    settleOnchain: async () => {
      throw new Error("not used in preparation tests");
    },
    now: () => NOW,
  });
  return {
    bridge,
    dealer,
    payer,
    session,
    get observedFactoryRead() { return observedFactoryRead; },
    get observedRfq() { return observedRfq; },
  };
}

test("generic exact bridge binds a stock payment to the signed V3 route", async () => {
  const fixture = bridgeFixture();
  const prepared = await fixture.bridge.prepare(requestBody(fixture.payer));

  assert.equal(prepared.payTo.toLowerCase(), PAY_TO);
  assert.equal(prepared.amount, "1001500");
  assert.equal(prepared.payer, fixture.payer.address.toLowerCase());
  assert.equal(prepared.privateState.lockTerms.tradeId, phase5LockId(REQUEST_ID, "source"));
  assert.equal(prepared.privateState.lockTerms.payer, fixture.payer.address.toLowerCase());
  assert.equal(prepared.privateState.lockTerms.beneficiary, fixture.dealer.address.toLowerCase());
  assert.equal(
    prepared.privateState.lockTerms.facilitator,
    fixture.observedFactoryRead.config.facilitatorRecipient
  );
  assert.equal(prepared.privateState.lockTerms.facilitatorAmount, FACILITATOR_FEE);
  assert.equal(prepared.publicState.input.dealerAmountAtomic, "1000500");
  assert.equal(prepared.publicState.input.facilitatorFeeAtomic, FACILITATOR_FEE);
  assert.equal(fixture.observedRfq.payload.inputOptions[0].maxInputAtomic, "1099000");
  assert.equal(prepared.privateState.acceptance.payload.sourceRefundAddress, PAY_TO);
  assert.equal(prepared.privateState.reservation.payload.dealerSourceClaimAddress,
    fixture.dealer.address.toLowerCase());
  assert.equal(fixture.observedFactoryRead.config.factoryAddress, FACTORY);
  assert.equal(fixture.observedRfq.payload.x402Commitment,
    keccak256(toUtf8Bytes(canonicalJson({
      requestId: REQUEST_ID,
      payer: fixture.payer.address.toLowerCase(),
      inputChainId: SOURCE_CHAIN,
      inputToken: SOURCE_TOKEN.toLowerCase(),
      maximumInputAtomic: "1100000",
      outputChainId: DESTINATION_CHAIN,
      outputToken: DESTINATION_TOKEN.toLowerCase(),
      outputAmountAtomic: "1000000",
      destinationAddress: fixture.payer.address.toLowerCase(),
      secretHash: SECRET_HASH,
    }))));
});

test("generic exact bridge rejects a request whose maximum cannot cover the relay fee", async () => {
  const fixture = bridgeFixture();
  const body = requestBody(fixture.payer);
  body.maximumInputAtomic = FACILITATOR_FEE;
  await assert.rejects(
    fixture.bridge.prepare(body),
    (error) => error.code === "MAXIMUM_INPUT_TOO_LOW"
  );
});

test("generic exact bridge rejects a quote bound to an unfrozen adapter", async () => {
  const fixture = bridgeFixture({ sourceAdapterId: "evm-htlc-v2" });
  await assert.rejects(
    fixture.bridge.prepare(requestBody(fixture.payer)),
    (error) => error.code === "ADAPTER_MISMATCH"
  );
});

test("generic exact bridge rejects reservation claimant substitution", async () => {
  const attacker = Wallet.createRandom();
  const fixture = bridgeFixture({ reserveClaimAddress: attacker.address });
  await assert.rejects(
    fixture.bridge.prepare(requestBody(fixture.payer)),
    (error) => error.code === "RESERVATION_MISMATCH"
  );
});
