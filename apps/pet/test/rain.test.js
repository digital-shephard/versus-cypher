const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  PENNY_MICROS,
  normalizeRainPennies,
  applyConfirmedRain,
} = require("../src/rain");
const {
  addGasMargin,
  canonicalRainEvent,
  loadChainConfig,
  createChainRainService,
  waitForAllowance,
  waitForChainState,
} = require("../src/chain");

describe("confirmed rain accounting", () => {
  it("uses the same canonical proof ID for local receipts and later Waku delivery", () => {
    const transactionHash = `0x${"ab".repeat(32)}`;
    const event = canonicalRainEvent({
      chainId: 8453,
      arenaAddress: "0x7cC994E8b37E7570cCd1aEa22C389f834c98f8a5",
      type: "rain",
      receipt: { hash: transactionHash, blockNumber: 123 },
      event: { args: { agentId: 7n, classId: 2n } },
      log: { index: 4 },
      pennies: 8n,
      classTotalMicros: 80_000n,
    });

    assert.equal(event.eventId, `8453:0x7cc994e8b37e7570ccd1aea22c389f834c98f8a5:${transactionHash}:4`);
    assert.equal(event.pennies, 8);
    assert.equal(event.classTotalMicros, "80000");
  });

  it("moves runway, class, tickets, and rained counters atomically", () => {
    const now = Date.UTC(2026, 6, 9, 12);
    const day = Math.floor(now / 86_400_000);
    const state = {
      runway: 1_000_000,
      tickets: 4,
      totalTickets: 20,
      classPotMicros: 90_000,
      rainPenniesToday: 2,
      todayRainDay: day,
      lifetimeRainPennies: 11,
    };

    const result = applyConfirmedRain(state, 7, now);
    assert.equal(result.amount, 7 * PENNY_MICROS);
    assert.equal(state.runway, 930_000);
    assert.equal(state.tickets, 11);
    assert.equal(state.totalTickets, 27);
    assert.equal(state.classPotMicros, 160_000);
    assert.equal(state.rainPenniesToday, 9);
    assert.equal(state.lifetimeRainPennies, 18);
  });

  it("resets the today counter on a new UTC contract day", () => {
    const now = Date.UTC(2026, 6, 10, 1);
    const state = { runway: 100_000, rainPenniesToday: 8, todayRainDay: 1 };
    applyConfirmedRain(state, 3, now);
    assert.equal(state.rainPenniesToday, 3);
  });

  it("rejects invalid or unfunded batches without mutating state", () => {
    assert.throws(() => normalizeRainPennies(0), RangeError);
    assert.throws(() => normalizeRainPennies(101), RangeError);
    const state = { runway: 9_999, tickets: 2 };
    assert.throws(() => applyConfirmedRain(state, 1), /insufficient/);
    assert.deepEqual(state, { runway: 9_999, tickets: 2 });
  });
});

it("renderer precipitation is sourced only from verified penny queues", () => {
  const renderer = fs.readFileSync(path.join(__dirname, "..", "renderer", "pet.js"), "utf8");
  assert.doesNotMatch(renderer, /nextAmbientAt[\s\S]{0,180}spawnDrop/);
  assert.doesNotMatch(renderer, /accFar[\s\S]{0,300}spawnDrop/);
  assert.doesNotMatch(renderer, /visibilitychange[\s\S]{0,500}whiteQueue\s*\+=/);
  assert.doesNotMatch(renderer, /function potEvent\(/);
  assert.match(renderer, /function verifiedRainDrop\(kind, classPotMicros\)/);
  assert.match(renderer, /function spawnMicroburst\(kind, pressure = W\.rainPressure\)/);
  assert.match(renderer, /function noteVerifiedRain\(now\)/);
  assert.match(renderer, /const MAX_PENDING_RAIN_BURSTS = 24/);
  assert.match(renderer, /drawRainDrops\(fctx, ts, true\)/);
  assert.match(renderer, /const nextFill = Math\.max\(prevFill, absoluteFill\)/);
  assert.match(renderer, /updateReadout\(\{ preserveFill: true \}\)/);
  assert.match(renderer, /BASE OK · WAITING ×\$\{pennies\}/);
  assert.match(renderer, /nextVerifiedRain/);
});

describe("chain rain configuration", () => {
  it("adds a bounded ceiling margin to gas estimates", () => {
    assert.equal(addGasMargin(295_411n), 369_264n);
    assert.equal(addGasMargin(100n, 0n), 100n);
    assert.throws(() => addGasMargin(0n), /positive/);
    assert.throws(() => addGasMargin(100n, -1n), /negative/);
  });

  it("uses the simulator only when no chain settings are present", () => {
    assert.equal(loadChainConfig({}), null);
    assert.equal(loadChainConfig({ VERSUS_RPC_URL: "http://127.0.0.1:8545" }), null);
  });

  it("loads a deployment-backed receipt service", () => {
    const file = path.join(os.tmpdir(), `versus-deployment-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify({
      chainId: 84532,
      contracts: {
        arena: "0x0000000000000000000000000000000000000001",
        agents: "0x0000000000000000000000000000000000000002",
        treasury: "0x0000000000000000000000000000000000000003",
        syndicate: "0x0000000000000000000000000000000000000004",
        usdc: "0x0000000000000000000000000000000000000005",
        missionEscrow: "0x0000000000000000000000000000000000000006",
        referralPool: "0x0000000000000000000000000000000000000007",
      },
    }));
    try {
      const config = loadChainConfig({
        VERSUS_RPC_URL: "http://127.0.0.1:8545",
        VERSUS_DEPLOYMENT: file,
      });
      assert.equal(config.deployment.chainId, 84532);
      const service = createChainRainService(config);
      assert.equal(typeof service.rainFromRunway, "function");
      assert.equal(typeof service.settleSignalBatchFromRunway, "function");
      assert.equal(typeof service.quoteHatchTarget, "function");
      assert.equal(typeof service.reconcileSignalBatch, "function");
      assert.equal(typeof service.sponsorMission, "function");
      assert.equal(typeof service.readState, "function");
      assert.equal(typeof service.replenishRunway, "function");
      assert.equal(typeof service.claimTranche, "function");
      assert.equal(typeof service.withdrawVault, "function");
      assert.equal(typeof service.referralStatus, "function");
      assert.equal(typeof service.fundReferralPoolFromRunway, "function");
    } finally {
      fs.unlinkSync(file);
    }
  });

  it("quotes the same 70/30 runway split for a local mock deployment", async () => {
    const service = createChainRainService({
      rpcUrl: "http://127.0.0.1:8545",
      deployment: {
        chainId: 31337,
        usedMockUsdc: true,
        usedMockRouter: true,
        contracts: {
          arena: "0x0000000000000000000000000000000000000001",
          agents: "0x0000000000000000000000000000000000000002",
          treasury: "0x0000000000000000000000000000000000000003",
          syndicate: "0x0000000000000000000000000000000000000004",
          usdc: "0x0000000000000000000000000000000000000005",
        },
      },
      env: {},
    }, { provider: {} });

    const target = await service.quoteHatchTarget();
    assert.equal(target.depositWei, 3_030_303_600_000_000n);
    assert.equal(target.quotedRunwayMicros, 7_070_708n);
    assert.equal(target.minimumRunwayMicros, 7_000_000n);
    assert.equal(target.gasReserveWei, 909_091_080_000_000n);
    assert.equal(target.localFixture, true);
  });

  it("requires an explicit RPC for every non-Base deployment", () => {
    const file = path.join(os.tmpdir(), `versus-local-deployment-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify({
      chainId: 31337,
      contracts: {
        arena: "0x0000000000000000000000000000000000000001",
        agents: "0x0000000000000000000000000000000000000002",
        treasury: "0x0000000000000000000000000000000000000003",
        syndicate: "0x0000000000000000000000000000000000000004",
        referralPool: "0x0000000000000000000000000000000000000005",
      },
    }));
    try {
      assert.throws(() => loadChainConfig({ VERSUS_DEPLOYMENT: file }), /VERSUS_RPC_URL/);
    } finally {
      fs.unlinkSync(file);
    }
  });
});

it("waits for a confirmed approval to become visible through a lagging RPC", async () => {
  const observed = [0n, 0n, 7n];
  const token = {
    async allowance() {
      return observed.shift() ?? 7n;
    },
  };
  assert.equal(
    await waitForAllowance(token, "owner", "spender", 7n, { timeoutMs: 100, pollMs: 0 }),
    7n
  );
});

it("waits for confirmed contract state before exposing an economic proof", async () => {
  const observed = [false, false, true];
  assert.equal(
    await waitForChainState(
      async () => observed.shift() ?? true,
      Boolean,
      { timeoutMs: 100, pollMs: 0, label: "test root" }
    ),
    true
  );
});
