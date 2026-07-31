const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  Wallet,
} = require("ethers");
const {
  createBrokerRouteProposal,
  FX_NATIVE_ETH_ADDRESS,
  signFxMessage,
} = require("@versus/network");
const {
  FX_DESKTOP_DEPLOYMENT_ID,
  FxDesktopService,
  shortAddress,
} = require("../src/fx-desktop-service");

const TOKEN = "0xcba3d9354dd4c30bb6961abb4473a6340486e01b";
const NOW = 1_785_200_000;

function fixture(overrides = {}) {
  const {
    reservationObserver,
    ...serviceOverrides
  } = overrides;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "versus-fx-desktop-"));
  const requester = Wallet.createRandom();
  const broker = Wallet.createRandom();
  const dealer = Wallet.createRandom();
  let sourceConfirmed = false;
  let currentNow = NOW;
  let service;
  service = new FxDesktopService({
    statePath: path.join(root, "state.json"),
    recoveryDirectory: path.join(root, "recovery"),
    walletProvider: () => ({
      address: requester.address,
      privateKey: requester.privateKey,
    }),
    recoveryPasswordProvider: async () => "desktop recovery password",
    brokerEndpoints: [],
    now: () => currentNow,
    async queryRoutes({ rfq }) {
      const outputAmountAtomic = BigInt(rfq.payload.outputAmountAtomic);
      const inputAmountAtomic =
        ((outputAmountAtomic * 10_025n + 9_999n) / 10_000n).toString();
      const quote = await signFxMessage({
        protocol: "versus-fx",
        version: 1,
        deploymentId: FX_DESKTOP_DEPLOYMENT_ID,
        type: "fx_quote",
        tradeId: rfq.tradeId,
        role: "dealer",
        sequence: "1",
        createdAt: NOW,
        expiresAt: NOW + 30,
        payload: {
          rfqId: rfq.id,
          inputChainId: "84532",
          inputToken: TOKEN,
          inputAmountAtomic,
          outputChainId: "421614",
          outputToken: TOKEN,
          outputAmountAtomic: outputAmountAtomic.toString(),
          quoteType: "fixed_exact_output",
          referenceSource: "desktop:test",
          referencePriceMicros: "1000000",
          referenceTimestamp: NOW,
          spreadBps: 25,
          dealerSettlementCostAtomic: "0",
          estimatedCompletionSeconds: 20,
          adapterId: "evm-htlc-v1",
          adapterVersion: 1,
        },
      }, dealer);
      const proposal = await createBrokerRouteProposal({
        signer: broker,
        rfq,
        quotes: [quote],
        brokerFeeAtomic: "0",
        now: NOW,
      });
      return {
        selected: proposal,
        attempts: [{
          endpoint: "https://broker.example",
          ok: true,
          latencyMs: 15,
          proposal,
        }],
      };
    },
    async sourceFundingVerifier({ prepared }) {
      return {
        confirmed: sourceConfirmed,
        amountAtomic: sourceConfirmed ? prepared.inputAmountAtomic : "0",
        confirmations: sourceConfirmed ? 2 : 0,
        transactionHash: sourceConfirmed ? `0x${"11".repeat(32)}` : null,
      };
    },
    async sourceFundingPlanner({ prepared }) {
      return {
        chainId: prepared.inputChainId,
        token: prepared.inputToken,
        address: prepared.sourceFundingAddress,
        requiredAtomic: prepared.inputAmountAtomic,
        baselineBlockNumber: 100,
        baselineBalanceAtomic: "0",
      };
    },
    async reservationExecutor({ proposal, acceptance }) {
      const reservation = await signFxMessage({
        protocol: "versus-fx",
        version: 1,
        deploymentId: FX_DESKTOP_DEPLOYMENT_ID,
        type: "fx_reserve",
        tradeId: acceptance.tradeId,
        role: "dealer",
        sequence: "2",
        createdAt: acceptance.createdAt,
        expiresAt: acceptance.expiresAt,
        payload: {
          acceptId: acceptance.id,
          quoteId: proposal.route.quoteId,
          dealerSourceClaimAddress: dealer.address,
          dealerDestinationRefundAddress: dealer.address,
          reservationDeadline: acceptance.expiresAt,
        },
      }, dealer);
      reservationObserver?.({ service, acceptance, reservation });
      return reservation;
    },
    async cancellationExecutor({ acceptance, reserve }) {
      return signFxMessage({
        protocol: "versus-fx",
        version: 1,
        deploymentId: FX_DESKTOP_DEPLOYMENT_ID,
        type: "fx_cancel",
        tradeId: acceptance.tradeId,
        role: "requester",
        sequence: "3",
        createdAt: acceptance.createdAt + 1,
        expiresAt: acceptance.createdAt + 61,
        payload: {
          acceptId: acceptance.id,
          reserveId: reserve.id,
          reason: "owner_cancelled",
        },
      }, requester);
    },
    async settlementExecutor({ recoveryFile }) {
      assert.equal(fs.existsSync(recoveryFile), true);
      return { transactionHash: `0x${"22".repeat(32)}` };
    },
    async destinationVerifier({ expected }) {
      return {
        confirmed: true,
        chainId: expected.outputChainId,
        token: expected.outputToken,
        amountAtomic: expected.outputAmountAtomic,
        beneficiary: expected.destinationAddress,
        transactionHash: `0x${"33".repeat(32)}`,
        blockNumber: "42",
        confirmations: 2,
      };
    },
    chainReadinessRequired: false,
    ...serviceOverrides,
  });
  service.store.setPositionEnabled("base-sepolia-usdc", true);
  service.store.setPositionEnabled("arbitrum-sepolia-usdc", true);
  return {
    root,
    service,
    requester,
    confirmSource: () => {
      sourceConfirmed = true;
    },
    advanceTime: (seconds) => {
      currentNow += Number(seconds);
    },
  };
}

test("desktop requester binds arbitrary recipient and completes only after verification", async () => {
  const { service, requester, confirmSource } = fixture();
  const recipient = Wallet.createRandom().address;
  service.setEnabled(true);
  const quoted = await service.requestQuote({
    sourcePositionId: "base-sepolia-usdc",
    destinationPositionId: "arbitrum-sepolia-usdc",
    outputAmount: "1",
    destinationAddress: recipient,
  });
  assert.equal(quoted.state, "quoted");
  assert.equal(quoted.destination.address, recipient.toLowerCase());
  const privateTrade = service.store.trade(quoted.tradeId);
  assert.equal(privateTrade.refundAddress, requester.address.toLowerCase());
  assert.equal(quoted.route.totalInputAtomic, "1002500");

  const accepted = await service.acceptQuote(quoted.tradeId);
  assert.equal(accepted.state, "awaiting_source_funds");
  assert.equal(accepted.funding.address, requester.address.toLowerCase());
  assert.equal(accepted.funding.expiresAt, NOW + 600);
  assert.equal(accepted.recoveryPersisted, true);
  assert.equal("quote" in accepted, false);
  assert.equal("prepared" in accepted, false);
  assert.equal(
    service.store.trade(quoted.tradeId).fundingBaseline.baselineBlockNumber,
    100
  );

  assert.deepEqual(await service.checkFunding(quoted.tradeId), {
    detected: false,
    requiredAtomic: "1002500",
    observedAtomic: "0",
  });
  confirmSource();
  const completed = await service.checkFunding(quoted.tradeId);
  assert.equal(completed.state, "funds_ready");
  assert.equal(completed.receipt.destinationAddress, recipient.toLowerCase());
  assert.equal(completed.endpointPaymentAuthorized, false);
  assert.equal(completed.endpointPaymentSubmitted, false);
});

test("requester reservation telemetry cannot interrupt accepted quote persistence", async () => {
  const { service } = fixture({
    reservationObserver({ service: observedService, acceptance, reservation }) {
      observedService.recordRuntimeTrade({
        tradeId: acceptance.tradeId,
        role: "requester",
        state: "accepted",
        fundingEligibleUntil: acceptance.expiresAt,
      });
      observedService.recordRuntimeTrade({
        tradeId: reservation.tradeId,
        role: "requester",
        state: "reserved",
        fundingEligibleUntil: reservation.payload.reservationDeadline,
      });
    },
  });
  const quoted = await service.requestQuote({
    sourcePositionId: "base-sepolia-usdc",
    destinationPositionId: "arbitrum-sepolia-usdc",
    outputAmount: "1",
  });

  const accepted = await service.acceptQuote(quoted.tradeId);

  assert.equal(accepted.state, "awaiting_source_funds");
  assert.equal(
    service.store.trade(quoted.tradeId).prepared.reservation.type,
    "fx_reserve"
  );
  assert.deepEqual(
    service.store
      .trade(quoted.tradeId)
      .timeline.slice(-3)
      .map((entry) => entry.state),
    ["accepted", "reserved", "awaiting_source_funds"]
  );
});

test("requester routes do not depend on this device's dealer inventory toggles", async () => {
  const { service } = fixture();
  service.store.setPositionEnabled("base-sepolia-usdc", false);
  service.store.setPositionEnabled("arbitrum-sepolia-usdc", false);
  service.setEnabled(true);

  const snapshot = service.snapshot();
  assert.equal(
    snapshot.positions.some((position) => position.enabled),
    false
  );
  assert.deepEqual(
    snapshot.supportedPositions.map((position) => position.id),
    [
      "base-sepolia-eth",
      "base-sepolia-usdc",
      "arbitrum-sepolia-eth",
      "arbitrum-sepolia-usdc",
    ]
  );

  const quoted = await service.requestQuote({
    sourcePositionId: "base-sepolia-usdc",
    destinationPositionId: "arbitrum-sepolia-usdc",
    outputAmount: "1",
    destinationAddress: Wallet.createRandom().address,
  });

  assert.equal(quoted.state, "quoted");
  assert.equal(quoted.sourcePositionId, "base-sepolia-usdc");
  assert.equal(quoted.destinationPositionId, "arbitrum-sepolia-usdc");
});

test("timely acceptance survives the original quote expiry", async () => {
  const { service, confirmSource, advanceTime } = fixture();
  service.setEnabled(true);
  const quoted = await service.requestQuote({
    sourcePositionId: "base-sepolia-usdc",
    destinationPositionId: "arbitrum-sepolia-usdc",
    outputAmount: "1",
    destinationAddress: Wallet.createRandom().address,
  });
  const accepted = await service.acceptQuote(quoted.tradeId);
  assert.equal(accepted.funding.expiresAt, NOW + 600);

  advanceTime(120);
  confirmSource();
  const completed = await service.checkFunding(quoted.tradeId);
  assert.equal(completed.state, "funds_ready");
});

test("an accepted quote stops cleanly after its dealer reservation expires", async () => {
  const { service, confirmSource, advanceTime } = fixture();
  service.setEnabled(true);
  const quoted = await service.requestQuote({
    sourcePositionId: "base-sepolia-usdc",
    destinationPositionId: "arbitrum-sepolia-usdc",
    outputAmount: "1",
    destinationAddress: Wallet.createRandom().address,
  });
  await service.acceptQuote(quoted.tradeId);

  advanceTime(601);
  confirmSource();
  const stopped = await service.checkFunding(quoted.tradeId);
  assert.equal(stopped.state, "failed");
  assert.equal(stopped.lastFailure.code, "FUNDING_WINDOW_EXPIRED");
  assert.match(stopped.lastFailure.message, /local FX wallet/);
});

test("an unfunded reserved swap can be cancelled and cannot settle afterward", async () => {
  let settlementCalls = 0;
  const { service } = fixture({
    async settlementExecutor() {
      settlementCalls += 1;
      throw new Error("settlement must not run");
    },
  });
  service.setEnabled(true);
  const quoted = await service.requestQuote({
    sourcePositionId: "base-sepolia-usdc",
    destinationPositionId: "arbitrum-sepolia-usdc",
    outputAmount: "1",
    destinationAddress: Wallet.createRandom().address,
  });
  await service.acceptQuote(quoted.tradeId);

  const cancelled = await service.cancelTrade(quoted.tradeId);

  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.cancellation.reason, "owner_cancelled");
  assert.equal(cancelled.timeline.at(-1).state, "cancelled");
  assert.equal(settlementCalls, 0);
  await assert.rejects(
    service.checkFunding(quoted.tradeId),
    (error) => error.code === "CANCELLATION_UNAVAILABLE" ||
      error.code === "RECONCILIATION_REQUIRED"
  );
});

test("cancel and funding verification cannot run concurrently", async () => {
  let releaseFundingCheck;
  const fundingCheck = new Promise((resolve) => {
    releaseFundingCheck = resolve;
  });
  const { service } = fixture({
    async sourceFundingVerifier() {
      await fundingCheck;
      return { confirmed: false, amountAtomic: "0", confirmations: 0 };
    },
  });
  service.setEnabled(true);
  const quoted = await service.requestQuote({
    sourcePositionId: "base-sepolia-usdc",
    destinationPositionId: "arbitrum-sepolia-usdc",
    outputAmount: "1",
    destinationAddress: Wallet.createRandom().address,
  });
  await service.acceptQuote(quoted.tradeId);

  const checking = service.checkFunding(quoted.tradeId);
  await assert.rejects(
    service.cancelTrade(quoted.tradeId),
    (error) => error.code === "TRADE_BUSY"
  );
  releaseFundingCheck();
  assert.equal((await checking).detected, false);
});

test("an uncertain settlement cannot be executed twice", async () => {
  let executions = 0;
  const { service, confirmSource } = fixture({
    async settlementExecutor() {
      executions += 1;
      const error = new Error("provider stopped after broadcast");
      error.code = "TX_STATUS_UNCERTAIN";
      throw error;
    },
  });
  service.setEnabled(true);
  const quoted = await service.requestQuote({
    sourcePositionId: "base-sepolia-usdc",
    destinationPositionId: "arbitrum-sepolia-usdc",
    outputAmount: "1",
    destinationAddress: Wallet.createRandom().address,
  });
  await service.acceptQuote(quoted.tradeId);
  confirmSource();
  await assert.rejects(
    service.checkFunding(quoted.tradeId),
    (error) => error.code === "TX_STATUS_UNCERTAIN"
  );
  assert.equal(executions, 1);
  assert.equal(service.trade(quoted.tradeId).state, "source_lock_pending");
  await assert.rejects(
    service.checkFunding(quoted.tradeId),
    (error) => error.code === "RECONCILIATION_REQUIRED"
  );
  assert.equal(executions, 1);
});

test("a missing native gas reserve returns the requester to a precise top-up", async () => {
  let fundingPlans = 0;
  const { service, confirmSource } = fixture({
    async sourceFundingPlanner({ prepared }) {
      fundingPlans += 1;
      return {
        chainId: prepared.inputChainId,
        token: prepared.inputToken,
        address: prepared.sourceFundingAddress,
        requiredAtomic: prepared.inputAmountAtomic,
        requiredFundingAtomic:
          fundingPlans === 1 ? prepared.inputAmountAtomic : "1234",
        sourceGasBufferAtomic: "1234",
        minimumWalletBalanceAtomic: (
          BigInt(prepared.inputAmountAtomic) + 1234n
        ).toString(),
        baselineBlockNumber: 100 + fundingPlans,
        baselineBalanceAtomic:
          fundingPlans === 1 ? "0" : prepared.inputAmountAtomic,
      };
    },
    async settlementExecutor() {
      const error = new Error(
        "native lock would consume the operating gas reserve"
      );
      error.code = "GAS_RESERVE_REQUIRED";
      throw error;
    },
  });
  service.setEnabled(true);
  const quoted = await service.requestQuote({
    sourcePositionId: "base-sepolia-usdc",
    destinationPositionId: "arbitrum-sepolia-usdc",
    outputAmount: "1",
    destinationAddress: Wallet.createRandom().address,
  });
  const accepted = await service.acceptQuote(quoted.tradeId);
  assert.equal(accepted.funding.amountAtomic, accepted.route.totalInputAtomic);

  confirmSource();
  await assert.rejects(
    service.checkFunding(quoted.tradeId),
    (error) => error.code === "GAS_RESERVE_REQUIRED"
  );
  const retry = service.trade(quoted.tradeId);
  assert.equal(retry.state, "awaiting_source_funds");
  assert.equal(retry.funding.amountAtomic, "1234");
  assert.equal(retry.funding.sourceGasBufferAtomic, "1234");
  assert.equal(retry.lastFailure.code, "GAS_RESERVE_REQUIRED");
  assert.match(retry.lastFailure.message, /displayed source gas buffer/);
  assert.equal(fundingPlans, 2);
});

test("requester quote discovery never arms local dealing", async () => {
  const { service } = fixture();
  assert.equal(service.snapshot().policy.armed, false);
  for (const [outputAmount, outputDisplay] of [
    ["0.01", "0.01 USDC"],
    ["51", "51.0 USDC"],
  ]) {
    const quoted = await service.requestQuote({
      sourcePositionId: "base-sepolia-usdc",
      destinationPositionId: "arbitrum-sepolia-usdc",
      outputAmount,
      destinationAddress: Wallet.createRandom().address,
    });
    assert.equal(quoted.state, "quoted");
    assert.equal(quoted.outputAmountDisplay, outputDisplay);
  }
  assert.equal(service.snapshot().policy.armed, false);
});

test("native requester quotes bind the native adapter and atomic ETH input", async () => {
  const dealer = Wallet.createRandom();
  let observedRfq = null;
  const { service } = fixture({
    nativeUsdPriceProvider: async () => "2000000000",
    async queryRoutes({ rfq }) {
      observedRfq = rfq;
      const quote = await signFxMessage({
        protocol: "versus-fx",
        version: 1,
        deploymentId: FX_DESKTOP_DEPLOYMENT_ID,
        type: "fx_quote",
        tradeId: rfq.tradeId,
        role: "dealer",
        sequence: "1",
        createdAt: NOW,
        expiresAt: NOW + 30,
        payload: {
          rfqId: rfq.id,
          inputChainId: "84532",
          inputToken: FX_NATIVE_ETH_ADDRESS,
          inputAmountAtomic: "501250000000000",
          outputChainId: "421614",
          outputToken: TOKEN,
          outputAmountAtomic: "1000000",
          quoteType: "fixed_exact_output",
          referenceSource: "desktop:test:eth-usd",
          referencePriceMicros: "2000000000",
          referenceTimestamp: NOW,
          spreadBps: 25,
          dealerSettlementCostAtomic: "0",
          estimatedCompletionSeconds: 20,
          adapterId: "evm-htlc-v1",
          adapterVersion: 1,
          sourceAdapterId: "evm-native-htlc-v1",
          sourceAdapterVersion: 1,
          destinationAdapterId: "evm-htlc-v1",
          destinationAdapterVersion: 1,
        },
      }, dealer);
      const proposal = await createBrokerRouteProposal({
        signer: Wallet.createRandom(),
        rfq,
        quotes: [quote],
        brokerFeeAtomic: "0",
        now: NOW,
      });
      return {
        selected: proposal,
        attempts: [{ endpoint: "local", ok: true, latencyMs: 1, proposal }],
      };
    },
  });
  service.store.setPositionEnabled("base-sepolia-eth", true);
  service.setEnabled(true);

  const quoted = await service.requestQuote({
    sourcePositionId: "base-sepolia-eth",
    destinationPositionId: "arbitrum-sepolia-usdc",
    outputAmount: "1",
    destinationAddress: Wallet.createRandom().address,
  });

  assert.equal(
    observedRfq.payload.inputOptions[0].token,
    FX_NATIVE_ETH_ADDRESS
  );
  assert.equal(
    observedRfq.payload.inputOptions[0].maxInputAtomic,
    ((1n << 256n) - 1n).toString()
  );
  assert.equal(quoted.route.inputToken, FX_NATIVE_ETH_ADDRESS);
  assert.equal(quoted.route.totalInputAtomic, "501250000000000");
});

test("native requester quote discovery does not require a local ETH/USD price", async () => {
  let routeCalls = 0;
  const { service } = fixture({
    nativeUsdPriceProvider: async () => {
      throw new Error("stale");
    },
    async queryRoutes() {
      routeCalls += 1;
      const error = new Error("broker unavailable");
      error.code = "BROKER_DOWN";
      throw error;
    },
  });
  service.store.setPositionEnabled("base-sepolia-eth", true);
  service.setEnabled(true);

  await assert.rejects(
    service.requestQuote({
      sourcePositionId: "base-sepolia-eth",
      destinationPositionId: "arbitrum-sepolia-usdc",
      outputAmount: "1",
      destinationAddress: Wallet.createRandom().address,
    }),
    (error) => error.code === "BROKER_DOWN"
  );
  assert.equal(routeCalls, 1);
});

test("requester quotes default the recipient to the local requester wallet", async () => {
  const { service, requester } = fixture();
  service.setEnabled(true);

  const quoted = await service.requestQuote({
    sourcePositionId: "base-sepolia-usdc",
    destinationPositionId: "arbitrum-sepolia-usdc",
    outputAmount: "1",
  });

  assert.equal(
    quoted.destination.address,
    requester.address.toLowerCase()
  );
  assert.equal(
    service.snapshot().requesterAddress,
    requester.address.toLowerCase()
  );
});

test("public state truncates addresses and evidence excludes private material", async () => {
  const { root, service } = fixture();
  service.setEnabled(true);
  const recipient = Wallet.createRandom().address;
  const quote = await service.requestQuote({
    sourcePositionId: "base-sepolia-usdc",
    destinationPositionId: "arbitrum-sepolia-usdc",
    outputAmount: "1",
    destinationAddress: recipient,
  });
  assert.equal(quote.destination.addressShort, shortAddress(recipient.toLowerCase()));
  const evidencePath = path.join(root, "export", "evidence.json");
  service.exportEvidence(evidencePath);
  const text = fs.readFileSync(evidencePath, "utf8");
  assert.equal(text.includes(recipient.toLowerCase()), false);
  assert.equal(text.includes("recovery password"), false);
  assert.match(text, /endpointPaymentSubmitted/);
});

test("scrubbed quote-rejection telemetry preserves reason codes without private state", async () => {
  const { root, service } = fixture();
  const privateInventory = "0xabcabcabcabcabcabcabcabcabcabcabcabcabca";
  const privateKeyHint = "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
  const cases = [
    {
      tradeId: `0x${"11".repeat(32)}`,
      code: "insufficient_destination_inventory",
      detail: `available below liability for ${privateInventory}`,
    },
    {
      tradeId: `0x${"22".repeat(32)}`,
      code: "trade_outside_limits",
      detail: "output exceeds maximumTradeUsd",
    },
    {
      tradeId: `0x${"33".repeat(32)}`,
      code: "unsupported_destination",
      detail: null,
    },
    {
      tradeId: `0x${"44".repeat(32)}`,
      code: "unsupported_source_route",
      detail: `secret=${privateKeyHint}`,
    },
    {
      tradeId: `0x${"55".repeat(32)}`,
      code: "requester_max_input_exceeded",
      detail: "requester max input too low",
    },
  ];

  for (const entry of cases) {
    service.recordRuntimeTrade({
      tradeId: entry.tradeId,
      role: "dealer",
      state: "quote_rejected",
      rejection: {
        code: entry.code,
        detail: entry.detail,
      },
    });
  }

  const evidencePath = path.join(root, "export", "quote-rejection-evidence.json");
  service.exportEvidence(evidencePath);
  const text = fs.readFileSync(evidencePath, "utf8");
  const evidence = JSON.parse(text);
  const rejections = evidence.observations.filter(
    (entry) => entry.category === "quote_rejected"
  );
  assert.equal(rejections.length, cases.length);
  assert.deepEqual(
    rejections.map((entry) => entry.value).sort(),
    cases.map((entry) => entry.code).sort()
  );
  assert.equal(
    rejections.some((entry) => entry.failure === "output exceeds maximumTradeUsd"),
    true
  );
  assert.equal(
    rejections.some((entry) => entry.failure === "requester max input too low"),
    true
  );
  assert.equal(
    rejections.some(
      (entry) => entry.failure === "available below liability for 0x[address]"
    ),
    true
  );
  assert.equal(
    rejections.some((entry) => entry.failure === "secret=0x[hash]"),
    true
  );
  assert.equal(text.includes(privateInventory), false);
  assert.equal(text.includes(privateKeyHint), false);
  assert.equal(text.includes("recovery password"), false);
  assert.deepEqual(evidence.excluded, [
    "private_keys",
    "htlc_secrets",
    "recovery_passwords",
    "recipient_addresses",
    "refund_addresses",
    "exact_private_inventory",
    "endpoint_credentials",
    "private_resource_details",
  ]);
});

test("dealer display follows the real runtime instead of a local armed flag", async () => {
  let active = false;
  const calls = [];
  const updates = [];
  const dealerController = {
    status() {
      return { dealer: { configured: true, active } };
    },
    async armDealer() {
      calls.push("arm");
      active = true;
    },
    async disarmDealer() {
      calls.push("disarm");
      active = false;
    },
    async updateDealer(input) {
      calls.push("update");
      updates.push(input);
    },
  };
  const { service } = fixture({ dealerController });
  assert.equal(service.snapshot().policy.armed, false);
  await service.setPolicy({ armed: true });
  assert.equal(service.snapshot().policy.armed, true);
  await service.setPolicy({ minimumSpreadBps: 40 });
  assert.deepEqual(calls, ["arm", "update"]);
  await service.setChainSettings("84532", { enabled: true });
  assert.deepEqual(calls, ["arm", "update", "update"]);
  assert.equal(
    updates[1].positions.some(
      (position) => position.id === "base-sepolia-eth"
    ),
    true
  );
  await service.setPolicy({ armed: false });
  assert.equal(service.snapshot().policy.armed, false);
  assert.deepEqual(calls, ["arm", "update", "update", "disarm"]);
});

test("dealer arming fails closed when no distributed dealer exists", async () => {
  const { service } = fixture();
  await assert.rejects(
    service.setPolicy({ armed: true }),
    (error) => error.code === "DEALER_UNAVAILABLE"
  );
  assert.equal(service.snapshot().policy.armed, false);
});

test("dealer native gas gates token support independently of personal swap gas", async () => {
  const rpcCalls = [];
  const withdrawals = [];
  const dealer = Wallet.createRandom().address.toLowerCase();
  const requesterRole = Wallet.createRandom().address.toLowerCase();
  const dealerController = {
    status: () => ({ dealer: { configured: true, active: false } }),
    setRpcUrl(chainId, rpcUrl) {
      rpcCalls.push({ chainId, rpcUrl });
    },
    async chainGasSnapshot(chains) {
      return chains.map((chain) => ({
        chainId: chain.chainId,
        dealer: {
          address: dealer,
          balanceAtomic: "1000000000000000",
        },
        requester: {
          address: requesterRole,
          balanceAtomic: "0",
        },
      }));
    },
    async inventorySnapshot(positions) {
      return positions.map((position) => ({
        id: position.id,
        address: dealer,
        availableAtomic: "5000000",
        reservedAtomic: "0",
        activeLocks: 0,
      }));
    },
    async withdrawInventory(input) {
      withdrawals.push(input);
      return { transactionHash: `0x${"77".repeat(32)}` };
    },
  };
  const { service } = fixture({
    dealerController,
    chainReadinessRequired: true,
    nativeUsdPriceProvider: async () => "2000000000",
  });
  service.store.setPositionEnabled("base-sepolia-usdc", false);
  service.store.setPositionEnabled("arbitrum-sepolia-usdc", false);
  await service.setEnabled(true);

  await assert.rejects(
    service.setPositionEnabled("base-sepolia-usdc", true),
    (error) => error.code === "CHAIN_GAS_REQUIRED"
  );
  const ready = await service.setChainSettings("84532", {
    enabled: true,
    rpcUrl: "https://rpc.example",
  });
  assert.equal(ready.chains[0].gasReady, false);
  assert.equal(ready.chains[0].dealerGasReady, true);
  assert.equal(ready.chains[0].requesterGasReady, false);
  assert.deepEqual(rpcCalls, [{
    chainId: "84532",
    rpcUrl: "https://rpc.example/",
  }]);

  await service.setPositionEnabled("base-sepolia-usdc", true);
  const result = await service.withdrawPosition({
    positionId: "base-sepolia-usdc",
    destination: Wallet.createRandom().address,
    amount: "1",
  });
  assert.equal(result.inventoryTransfer.amountAtomic, "1000000");
  assert.equal(withdrawals.length, 1);
  assert.equal(withdrawals[0].role, undefined);
  assert.equal(
    result.inventoryTransfer.transactionHash,
    `0x${"77".repeat(32)}`
  );
});

test("a funded native ETH position can arm without a USDC token bay", async () => {
  const dealer = Wallet.createRandom().address.toLowerCase();
  const requesterRole = Wallet.createRandom().address.toLowerCase();
  let active = false;
  let armedPositions = null;
  const dealerController = {
    status: () => ({ dealer: { configured: true, active } }),
    setRpcUrl() {},
    async chainGasSnapshot(chains) {
      return chains.map((chain) => ({
        chainId: chain.chainId,
        dealer: {
          address: dealer,
          balanceAtomic: "1000000000000000000",
        },
        requester: {
          address: requesterRole,
          balanceAtomic: "1000000000000000",
        },
      }));
    },
    async inventorySnapshot(positions) {
      return positions.map((position) => ({
        id: position.id,
        address: dealer,
        availableAtomic: "500000000000000000",
        reservedAtomic: "0",
        activeLocks: 0,
      }));
    },
    async armDealer({ positions }) {
      armedPositions = positions;
      active = true;
    },
  };
  const { service } = fixture({
    dealerController,
    chainReadinessRequired: true,
    nativeUsdPriceProvider: async () => "2000000000",
  });
  service.store.setPositionEnabled("base-sepolia-usdc", false);
  service.store.setPositionEnabled("arbitrum-sepolia-usdc", false);
  await service.setEnabled(true);
  await service.setChainSettings("84532", {
    enabled: true,
    rpcUrl: "https://rpc.example",
  });

  const armed = await service.setPolicy({ armed: true });

  assert.equal(armed.policy.armed, true);
  assert.equal(armedPositions.length, 1);
  assert.equal(armedPositions[0].id, "base-sepolia-eth");
  assert.equal(armedPositions[0].assetKind, "native");
});

test("dealer input support does not require duplicate output inventory", async () => {
  const dealer = Wallet.createRandom().address.toLowerCase();
  const requesterRole = Wallet.createRandom().address.toLowerCase();
  let active = false;
  let armedPositions = null;
  const dealerController = {
    status: () => ({ dealer: { configured: true, active } }),
    setRpcUrl() {},
    async chainGasSnapshot(chains) {
      return chains.map((chain) => ({
        chainId: chain.chainId,
        dealer: {
          address: dealer,
          balanceAtomic: "1000000000000000000",
        },
        requester: {
          address: requesterRole,
          balanceAtomic: "1000000000000000",
        },
      }));
    },
    async inventorySnapshot(positions) {
      return positions.map((position) => ({
        id: position.id,
        address: dealer,
        availableAtomic:
          position.id === "arbitrum-sepolia-eth"
            ? "500000000000000000"
            : "0",
        reservedAtomic: "0",
        activeLocks: 0,
      }));
    },
    async armDealer({ positions }) {
      armedPositions = positions;
      active = true;
    },
  };
  const { service } = fixture({
    dealerController,
    chainReadinessRequired: true,
    nativeUsdPriceProvider: async () => "2000000000",
  });
  service.store.setPositionEnabled("base-sepolia-usdc", false);
  service.store.setPositionEnabled("arbitrum-sepolia-usdc", false);
  await service.setEnabled(true);
  await service.setChainSettings("84532", { enabled: true });
  await service.setChainSettings("421614", { enabled: true });

  const armed = await service.setPolicy({ armed: true });

  assert.equal(armed.policy.armed, true);
  assert.deepEqual(
    armedPositions.map((position) => position.id),
    ["base-sepolia-eth", "arbitrum-sepolia-eth"]
  );
});

test("funding a newly usable chain hot-reloads dealer routes once", async () => {
  const dealer = Wallet.createRandom().address.toLowerCase();
  const requesterRole = Wallet.createRandom().address.toLowerCase();
  let active = false;
  let baseFunded = false;
  const armed = [];
  const updates = [];
  const dealerController = {
    status: () => ({ dealer: { configured: true, active } }),
    async chainGasSnapshot(chains) {
      return chains.map((chain) => ({
        chainId: chain.chainId,
        dealer: {
          address: dealer,
          balanceAtomic:
            chain.chainId === "84532" && !baseFunded
              ? "0"
              : "1000000000000000000",
        },
        requester: {
          address: requesterRole,
          balanceAtomic: "1000000000000000",
        },
      }));
    },
    async inventorySnapshot(positions) {
      return positions.map((position) => ({
        id: position.id,
        address: dealer,
        availableAtomic:
          position.id === "arbitrum-sepolia-eth"
            ? "500000000000000000"
            : "0",
        reservedAtomic: "0",
        activeLocks: 0,
      }));
    },
    async armDealer({ positions }) {
      armed.push(positions.map((position) => position.id));
      active = true;
    },
    async updateDealer({ positions }) {
      updates.push(positions.map((position) => position.id));
    },
  };
  const { service } = fixture({
    dealerController,
    chainReadinessRequired: true,
    nativeUsdPriceProvider: async () => "2000000000",
  });
  service.store.setPositionEnabled("base-sepolia-usdc", false);
  service.store.setPositionEnabled("arbitrum-sepolia-usdc", false);
  await service.setEnabled(true);
  await service.setChainSettings("84532", { enabled: true });
  await service.setChainSettings("421614", { enabled: true });
  await service.setPolicy({ armed: true });

  assert.deepEqual(armed, [["arbitrum-sepolia-eth"]]);

  baseFunded = true;
  await service.refresh({ force: true });
  assert.deepEqual(updates, [[
    "base-sepolia-eth",
    "arbitrum-sepolia-eth",
  ]]);

  await service.refresh({ force: true });
  assert.equal(updates.length, 1);
});

test("an explicitly armed dealer resumes after restart", async () => {
  let active = false;
  let arms = 0;
  const controller = {
    status: () => ({ dealer: { configured: true, active } }),
    async armDealer({ positions }) {
      assert.equal(positions.length, 2);
      active = true;
      arms += 1;
    },
  };
  const { service } = fixture({ dealerController: controller });
  service.store.setEnabled(true);
  service.store.setPolicy({ armed: true });
  const resumed = await service.resumeDealer();
  assert.equal(arms, 1);
  assert.equal(resumed.policy.armed, true);
});

test("source refunds require an eligible lock and explicit owner action", async () => {
  let refunds = 0;
  const { service } = fixture({
    async refundExecutor({ prepared }) {
      refunds += 1;
      return {
        state: "refunded",
        refund: {
          eligible: true,
          chainId: prepared.inputChainId,
          transactionHash: `0x${"44".repeat(32)}`,
        },
      };
    },
  });
  await service.setEnabled(true);
  const quoted = await service.requestQuote({
    sourcePositionId: "base-sepolia-usdc",
    destinationPositionId: "arbitrum-sepolia-usdc",
    outputAmount: "1",
    destinationAddress: Wallet.createRandom().address,
  });
  await service.acceptQuote(quoted.tradeId);
  await assert.rejects(
    service.refundTrade(quoted.tradeId),
    (error) => error.code === "REFUND_NOT_READY"
  );
  const stored = service.store.trade(quoted.tradeId);
  service.store.putTrade({
    ...stored,
    state: "refund_wait",
    refund: { eligible: true, eligibleAt: NOW - 1 },
  });
  const refunded = await service.refundTrade(quoted.tradeId);
  assert.equal(refunded.state, "refunded");
  assert.equal(refunds, 1);
  assert.equal(
    refunded.refund.transactionHash,
    `0x${"44".repeat(32)}`
  );
});

test("reconciliation preserves a terminal recovery explanation", async () => {
  const failure = {
    code: "QUOTE_EXPIRED_BEFORE_LOCK",
    message: "Funds remain in the local FX wallet",
    at: new Date(NOW * 1000).toISOString(),
  };
  const { service } = fixture({
    async settlementReconciler() {
      return { state: "failed", lastFailure: failure };
    },
  });
  await service.setEnabled(true);
  const quoted = await service.requestQuote({
    sourcePositionId: "base-sepolia-usdc",
    destinationPositionId: "arbitrum-sepolia-usdc",
    outputAmount: "1",
    destinationAddress: Wallet.createRandom().address,
  });
  await service.acceptQuote(quoted.tradeId);
  const stored = service.store.trade(quoted.tradeId);
  service.store.putTrade({ ...stored, state: "source_lock_pending" });
  const reconciled = await service.reconcileTrade(quoted.tradeId);
  assert.equal(reconciled.state, "failed");
  assert.deepEqual(reconciled.lastFailure, failure);
});

test("executor fallback telemetry does not replace the requester trade state", () => {
  const { service } = fixture();
  const tradeId = `0x${"e7".repeat(32)}`;
  service.store.putTrade({
    tradeId,
    role: "requester",
    state: "destination_lock_confirmed",
    timeline: [{
      state: "destination_lock_confirmed",
      at: new Date().toISOString(),
    }],
  });

  assert.doesNotThrow(() => service.recordRuntimeTrade({
    tradeId,
    role: "relayer",
    state: "executor_fallback_wait",
    delayMs: 7_500,
  }));

  const persisted = service.store.trade(tradeId);
  assert.equal(persisted.role, "requester");
  assert.equal(persisted.state, "destination_lock_confirmed");
  assert.equal(persisted.timeline.at(-1).state, "executor_fallback_wait");
});

test("dealer destination refunds are explicit owner actions", async () => {
  const tradeId = `0x${"55".repeat(32)}`;
  let calls = 0;
  const { service } = fixture({
    dealerController: {
      status: () => ({ dealer: { configured: true, active: true } }),
      async refundDealerTrade(id) {
        calls += 1;
        assert.equal(id, tradeId);
        return {
          tradeId,
          role: "dealer",
          state: "refunded",
          refund: {
            eligible: true,
            transactionHash: `0x${"66".repeat(32)}`,
          },
        };
      },
    },
  });
  const refunded = await service.refundDealerTrade(tradeId);
  assert.equal(refunded.trades[0].state, "refunded");
  assert.equal(refunded.trades[0].role, "dealer");
  assert.equal(calls, 1);
});
