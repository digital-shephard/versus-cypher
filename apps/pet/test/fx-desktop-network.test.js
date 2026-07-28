const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Wallet } = require("ethers");
const {
  FxDesktopNetworkRuntime,
} = require("../src/fx-desktop-network");

function fixture(overrides = {}) {
  const requester = Wallet.createRandom();
  const dealer = Wallet.createRandom();
  const broker = Wallet.createRandom();
  const roles = { requester, dealer, broker };
  const calls = [];
  const evm = {
    async tokenBalance(chainId, token, owner) {
      calls.push(["balance", chainId, token, owner]);
      return "5000000";
    },
    async readLock(chainId) {
      return chainId === "84532"
        ? {
            state: 1,
            timeout: 900,
            lockId: `0x${"11".repeat(32)}`,
            amountAtomic: "1000000",
          }
        : {
            state: 0,
            timeout: 0,
            lockId: `0x${"22".repeat(32)}`,
            amountAtomic: "0",
          };
    },
    provider() {
      return {
        async getBlock() {
          return { timestamp: 1000 };
        },
      };
    },
    async refundLock(input) {
      calls.push(["refund", input.role]);
      return {
        lock: {
          timeout: 900,
          lockId: `0x${"11".repeat(32)}`,
        },
        receipt: {
          transactionHash: `0x${"33".repeat(32)}`,
        },
      };
    },
    ...overrides,
  };
  const runtime = new FxDesktopNetworkRuntime({
    dataDirectory: fs.mkdtempSync(path.join(os.tmpdir(), "versus-fx-runtime-")),
    walletProvider: (role) => ({
      address: roles[role].address,
      privateKey: roles[role].privateKey,
    }),
    evm,
    now: () => 1000,
  });
  return { runtime, roles, calls };
}

test("desktop FX inventory belongs only to the dealer role", async () => {
  const { runtime, roles, calls } = fixture();
  const positions = await runtime.inventorySnapshot([{
    id: "base-sepolia-usdc",
    enabled: true,
    chainId: "84532",
    assetAddress: "0xcba3d9354dd4c30bb6961abb4473a6340486e01b",
  }]);
  assert.equal(positions[0].address, roles.dealer.address.toLowerCase());
  assert.equal(positions[0].availableAtomic, "5000000");
  assert.equal(calls[0][3], roles.dealer.address.toLowerCase());
  assert.notEqual(roles.requester.address, roles.dealer.address);
});

test("requester recovery exposes refund only after chain time and uses requester role", async () => {
  const { runtime, calls } = fixture();
  const prepared = {
    tradeId: `0x${"44".repeat(32)}`,
    proposal: {
      route: {
        inputChainId: "84532",
        outputChainId: "421614",
      },
    },
  };
  const recovery = await runtime.reconcileRequester({ prepared });
  assert.equal(recovery.state, "refund_wait");
  assert.equal(recovery.refund.eligible, true);
  const refunded = await runtime.refundRequester({ prepared });
  assert.equal(refunded.state, "refunded");
  assert.deepEqual(calls.at(-1), ["refund", "requester"]);
});

test("expired acceptance with no lock resolves as stopped without rebroadcast", async () => {
  const { runtime } = fixture({
    async readLock() {
      return {
        state: 0,
        timeout: 0,
        lockId: `0x${"55".repeat(32)}`,
        amountAtomic: "0",
      };
    },
  });
  const recovery = await runtime.reconcileRequester({
    prepared: {
      tradeId: `0x${"66".repeat(32)}`,
      acceptance: { expiresAt: 999 },
      proposal: {
        route: {
          inputChainId: "84532",
          outputChainId: "421614",
        },
      },
    },
  });
  assert.equal(recovery.state, "failed");
  assert.equal(recovery.lastFailure.code, "QUOTE_EXPIRED_BEFORE_LOCK");
  assert.match(recovery.lastFailure.message, /local FX wallet/);
});

test("requester publishes acceptance immediately and waits for its dealer reserve", async () => {
  const { runtime } = fixture();
  const tradeId = `0x${"67".repeat(32)}`;
  const acceptance = {
    id: `0x${"68".repeat(32)}`,
    type: "fx_accept",
    tradeId,
    expiresAt: 1600,
    payload: {},
  };
  const reserve = {
    id: `0x${"69".repeat(32)}`,
    type: "fx_reserve",
    tradeId,
    payload: {
      acceptId: acceptance.id,
      reservationDeadline: 1600,
    },
  };
  const published = [];
  let storedReserve = null;
  const session = new EventEmitter();
  session.journal = {
    findType: () => storedReserve,
  };
  session.ingest = (envelope) => ({
    status: envelope === acceptance ? "accepted" : "rejected",
  });
  session.transport = {
    async publish(envelope) {
      published.push(envelope);
      setImmediate(() => {
        storedReserve = reserve;
        session.emit("accepted", reserve);
      });
    },
  };
  runtime.requesterSession = session;

  const received = await runtime.reserveRequester({ acceptance });

  assert.equal(published.length, 1);
  assert.equal(published[0], acceptance);
  assert.equal(received, reserve);
});

test("requester settlement cannot start without the signed dealer reserve", async () => {
  const { runtime } = fixture();
  runtime.requesterSession = new EventEmitter();
  const acceptance = {
    id: `0x${"6a".repeat(32)}`,
    type: "fx_accept",
    tradeId: `0x${"6b".repeat(32)}`,
    payload: {},
  };

  await assert.rejects(
    runtime.executeRequester({
      proposal: { route: {} },
      acceptance,
      reserve: null,
    }),
    (error) => error.code === "RESERVATION_MISMATCH"
  );
});

test("requester cancellation publishes a signed pre-lock release", async () => {
  const { runtime } = fixture();
  const tradeId = `0x${"6c".repeat(32)}`;
  const acceptance = {
    id: `0x${"6d".repeat(32)}`,
    type: "fx_accept",
    tradeId,
    expiresAt: 1600,
  };
  const reserve = {
    id: `0x${"6e".repeat(32)}`,
    type: "fx_reserve",
    tradeId,
    payload: { acceptId: acceptance.id },
  };
  let published = null;
  runtime.requesterSession = {
    async publish(message) {
      published = message;
      return {
        ...message,
        id: `0x${"6f".repeat(32)}`,
        payload: { ...message.payload },
      };
    },
  };

  const cancellation = await runtime.cancelRequester({ acceptance, reserve });

  assert.equal(published.type, "fx_cancel");
  assert.equal(published.payload.acceptId, acceptance.id);
  assert.equal(published.payload.reserveId, reserve.id);
  assert.equal(cancellation.payload.reason, "owner_cancelled");
});

test("dealer restart exposes an expired destination lock and refunds it once", async () => {
  const tradeId = `0x${"77".repeat(32)}`;
  const lockId = `0x${"88".repeat(32)}`;
  const destinationMessageId = `0x${"99".repeat(32)}`;
  const refundHash = `0x${"aa".repeat(32)}`;
  const published = [];
  let terminal = null;
  const { runtime, calls } = fixture({
    async readLock() {
      return {
        chainId: "421614",
        state: 1,
        timeout: 900,
        lockId,
        refundAddress: runtime.dealerAddress(),
      };
    },
    provider() {
      return {
        async getBlock() {
          return { timestamp: 1000 };
        },
      };
    },
    async refundLock(input) {
      calls.push(["refund", input.role]);
      return {
        lock: { lockId, timeout: 900 },
        receipt: {
          transactionHash: refundHash,
          blockNumber: 123,
        },
      };
    },
  });
  const trade = {
    tradeId,
    state: "destination_locked",
    destinationLockId: lockId,
    package: {
      quote: { payload: { outputChainId: "421614" } },
    },
  };
  runtime.exposureJournal = {
    activeTrades: () => terminal ? [] : [trade],
    trade: () => (terminal ? { ...trade, state: terminal } : trade),
    markTerminal: (_tradeId, state) => {
      terminal = state;
    },
    exposureSummary: () => ({ count: terminal ? 0 : 1 }),
  };
  runtime.dealerJournal = {
    findType: () => ({
      id: destinationMessageId,
      payload: { chainId: "421614" },
    }),
  };
  runtime.dealerSession = {
    async publish(message) {
      published.push(message);
      return message;
    },
  };

  const recoveries = await runtime.reconcileDealerExposure({ force: true });
  assert.equal(recoveries[0].refund.eligible, true);
  const result = await runtime.refundDealerTrade(tradeId);
  assert.equal(result.state, "refunded");
  assert.equal(terminal, "destination_refunded");
  assert.deepEqual(calls.at(-1), ["refund", "dealer"]);
  assert.equal(published[0].type, "fx_refund");
  assert.equal(published[0].payload.lockMessageId, destinationMessageId);
  assert.equal(published[0].payload.transactionHash, refundHash);
});
