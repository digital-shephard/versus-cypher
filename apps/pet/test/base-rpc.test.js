const assert = require("node:assert/strict");
const test = require("node:test");
const { Wallet } = require("ethers");
const {
  BASE_CLASS_STATE_ENDPOINTS,
  BASE_HATCH_QUOTE_ENDPOINTS,
  BASE_PUBLIC_RPCS,
  BASE_RPC_PROVIDER_OPTIONS,
  classStateEndpointsFromEnv,
  classStateMessage,
  fetchNodeClassState,
  fetchNodeHatchQuote,
  hatchQuoteEndpointsFromEnv,
  hatchQuoteMessage,
  rpcUrlsFromEnv,
  runwaySafeTargetMicros,
  splitDepositWei,
  validateNodeHatchQuote,
  validateNodeClassState,
} = require("../src/base-rpc");

test("Base RPC reads stay below restrictive public-provider batch caps", () => {
  assert.equal(BASE_RPC_PROVIDER_OPTIONS.batchMaxCount, 1);
  assert.equal(BASE_RPC_PROVIDER_OPTIONS.staticNetwork, true);
});

test("deposit split keeps thirty percent ETH and assigns seventy percent to runway", () => {
  const plan = splitDepositWei(10_000_000_000_000_000n);
  assert.equal(plan.swapWei, 7_000_000_000_000_000n);
  assert.equal(plan.gasReserveWei, 3_000_000_000_000_000n);
  assert.equal(plan.swapWei + plan.gasReserveWei, plan.depositWei);
});

test("hatch target keeps the slippage-adjusted runway above the contract floor", () => {
  const target = runwaySafeTargetMicros(10_000_000n, { requiredRunwayMicros: 7_000_000n });
  const quotedRunway = (target * 7_000n) / 10_000n;
  const minimumRunway = (quotedRunway * 9_900n) / 10_000n;
  assert.equal(target, 10_101_012n);
  assert.ok(minimumRunway >= 7_000_000n);
});

test("Base RPC pool needs no signup and accepts an explicit operator override", () => {
  assert.deepEqual(rpcUrlsFromEnv({}), [...BASE_PUBLIC_RPCS]);
  assert.deepEqual(rpcUrlsFromEnv({ VERSUS_RPC_URLS: "https://one.test, https://two.test" }), [
    "https://one.test",
    "https://two.test",
  ]);
  assert.deepEqual(rpcUrlsFromEnv({ VERSUS_RPC_URL: "https://private.test" }), [
    "https://private.test",
  ]);
});

test("unhatched devices accept only fresh deployment-scoped signed node quotes", async () => {
  const wallet = new Wallet(`0x${"2".repeat(64)}`);
  const now = 1_780_000_000_000;
  const quote = {
    version: 1,
    chainId: "8453",
    arena: "0x1000000000000000000000000000000000000001",
    targetUsdMicros: "10000000",
    requiredRunwayMicros: "7000000",
    runwayBps: 7000,
    bufferBps: 300,
    feeTier: 500,
    depositWei: "1471428571428572",
    swapWei: "1030000000000000",
    gasReserveWei: "441428571428572",
    quotedAt: 1_780_000_000,
    validUntil: 1_780_000_180,
    staleUntil: 1_780_000_900,
  };
  quote.signer = wallet.address;
  quote.signature = await wallet.signMessage(hatchQuoteMessage(quote));
  const result = await fetchNodeHatchQuote({
    endpoints: ["https://relay.test/v1/hatch-quote"],
    trustedSigners: [wallet.address],
    chainId: 8453,
    arena: quote.arena,
    now,
    fetchImpl: async () => ({ ok: true, json: async () => quote }),
  });
  assert.equal(result.nodeQuote, true);
  assert.equal(result.depositWei, 1_471_428_571_428_572n);
  assert.equal(result.minimumRunwayMicros, 7_000_000n);
  assert.equal(result.freshness, "fresh");
  assert.equal(result.sourceEndpoint, "https://relay.test/v1/hatch-quote");

  assert.throws(() => validateNodeHatchQuote(quote, {
    trustedSigners: [Wallet.createRandom().address],
    chainId: 8453,
    arena: quote.arena,
    now,
  }), /not trusted/);
  assert.throws(() => validateNodeHatchQuote(quote, {
    trustedSigners: [wallet.address],
    chainId: 8453,
    arena: quote.arena,
    now: (quote.staleUntil + 1) * 1000,
  }), /expired/);
  assert.throws(() => validateNodeHatchQuote({ ...quote, version: 2 }, {
    trustedSigners: [wallet.address],
    chainId: 8453,
    arena: quote.arena,
    now,
  }), /version/);
});

test("node quote endpoints are public defaults with an operator override", () => {
  assert.deepEqual(hatchQuoteEndpointsFromEnv({}), [...BASE_HATCH_QUOTE_ENDPOINTS]);
  assert.deepEqual(hatchQuoteEndpointsFromEnv({ VERSUS_HATCH_QUOTE_ENDPOINTS: "https://one.test/v1/hatch-quote" }), [
    "https://one.test/v1/hatch-quote",
  ]);
});

test("clients accept the newest deployment-scoped signed class cache", async () => {
  const older = new Wallet(`0x${"3".repeat(64)}`);
  const newer = new Wallet(`0x${"4".repeat(64)}`);
  const now = 1_780_000_000_000;
  const base = {
    version: 1,
    chainId: "8453",
    arena: "0x1000000000000000000000000000000000000001",
    syndicate: "0x2000000000000000000000000000000000000002",
    classId: "2",
    totalCommittedMicros: "80000",
    participantCount: 5,
    openedDay: 20600,
    chainDay: 20601,
    graduated: false,
    graduationFloorMicros: "1000000000",
    observedAt: 1_780_000_000,
    validUntil: 1_780_000_180,
    staleUntil: 1_780_000_900,
  };
  const values = [
    { ...base, blockNumber: "100", signer: older.address },
    { ...base, blockNumber: "105", totalCommittedMicros: "90000", signer: newer.address },
  ];
  values[0].signature = await older.signMessage(classStateMessage(values[0]));
  values[1].signature = await newer.signMessage(classStateMessage(values[1]));
  const result = await fetchNodeClassState({
    endpoints: ["https://older.test", "https://newer.test"],
    trustedSigners: [older.address, newer.address],
    chainId: 8453,
    arena: base.arena,
    syndicate: base.syndicate,
    now,
    fetchImpl: async (url) => ({ ok: true, json: async () => values[url.includes("newer") ? 1 : 0] }),
  });
  assert.equal(result.blockNumber, 105n);
  assert.equal(result.totalCommittedMicros, 90_000n);
  assert.equal(result.sourceEndpoint, "https://newer.test");
  assert.throws(() => validateNodeClassState(values[1], {
    trustedSigners: [Wallet.createRandom().address],
    chainId: 8453,
    arena: base.arena,
    syndicate: base.syndicate,
    now,
  }), /not trusted/);
});

test("two agreeing relay clocks correct a badly skewed device clock", async () => {
  const walletA = new Wallet(`0x${"5".repeat(64)}`);
  const walletB = new Wallet(`0x${"6".repeat(64)}`);
  const deviceNow = Date.UTC(2026, 6, 16, 12, 0, 0);
  const networkNow = Date.UTC(2026, 6, 16, 15, 0, 0);
  const base = {
    version: 1,
    chainId: "8453",
    arena: "0x1000000000000000000000000000000000000001",
    syndicate: "0x2000000000000000000000000000000000000002",
    classId: "3",
    totalCommittedMicros: "120000",
    participantCount: 7,
    openedDay: 20600,
    chainDay: 20601,
    graduated: false,
    graduationFloorMicros: "1000000000",
    blockNumber: "200",
    observedAt: Math.floor(networkNow / 1000),
    validUntil: Math.floor(networkNow / 1000) + 180,
    staleUntil: Math.floor(networkNow / 1000) + 900,
  };
  const values = [
    { ...base, signer: walletA.address },
    { ...base, blockNumber: "201", signer: walletB.address },
  ];
  values[0].signature = await walletA.signMessage(classStateMessage(values[0]));
  values[1].signature = await walletB.signMessage(classStateMessage(values[1]));
  const originalNow = Date.now;
  Date.now = () => deviceNow;
  try {
    const result = await fetchNodeClassState({
      endpoints: ["https://relay-a.test", "https://relay-b.test"],
      trustedSigners: [walletA.address, walletB.address],
      chainId: 8453,
      arena: base.arena,
      syndicate: base.syndicate,
      now: deviceNow,
      fetchImpl: async (url) => ({
        ok: true,
        headers: { get: (name) => name.toLowerCase() === "date" ? new Date(networkNow).toUTCString() : null },
        json: async () => values[url.includes("relay-b") ? 1 : 0],
      }),
    });
    assert.equal(result.blockNumber, 201n);
    assert.equal(result.clockOffsetMs, 3 * 60 * 60 * 1000);
    assert.equal(result.clockQuorum, 2);
  } finally {
    Date.now = originalNow;
  }
});

test("one class-state relay cannot move the device clock by itself", async () => {
  const wallet = new Wallet(`0x${"7".repeat(64)}`);
  const deviceNow = Date.UTC(2026, 6, 16, 12, 0, 0);
  const networkNow = Date.UTC(2026, 6, 16, 15, 0, 0);
  const value = {
    version: 1,
    chainId: "8453",
    arena: "0x1000000000000000000000000000000000000001",
    syndicate: "0x2000000000000000000000000000000000000002",
    classId: "3",
    totalCommittedMicros: "120000",
    participantCount: 7,
    openedDay: 20600,
    chainDay: 20601,
    graduated: false,
    graduationFloorMicros: "1000000000",
    blockNumber: "201",
    observedAt: Math.floor(networkNow / 1000),
    validUntil: Math.floor(networkNow / 1000) + 180,
    staleUntil: Math.floor(networkNow / 1000) + 900,
    signer: wallet.address,
  };
  value.signature = await wallet.signMessage(classStateMessage(value));
  const originalNow = Date.now;
  Date.now = () => deviceNow;
  try {
    const result = await fetchNodeClassState({
      endpoints: ["https://relay-a.test"],
      trustedSigners: [wallet.address],
      chainId: 8453,
      arena: value.arena,
      syndicate: value.syndicate,
      now: deviceNow,
      fetchImpl: async () => ({
        ok: true,
        headers: { get: () => new Date(networkNow).toUTCString() },
        json: async () => value,
      }),
    });
    assert.equal(result.clockOffsetMs, null);
    assert.equal(result.clockQuorum, 0);
  } finally {
    Date.now = originalNow;
  }
});

test("class state endpoints are public defaults with an operator override", () => {
  assert.deepEqual(classStateEndpointsFromEnv({}), [...BASE_CLASS_STATE_ENDPOINTS]);
  assert.deepEqual(classStateEndpointsFromEnv({ VERSUS_CLASS_STATE_ENDPOINTS: "https://one.test/v1/class-state" }), [
    "https://one.test/v1/class-state",
  ]);
});
