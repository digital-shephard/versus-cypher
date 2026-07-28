const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  FxDesktopStore,
} = require("../src/fx-desktop-store");

function temporaryStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-fx-desktop-"));
  const filePath = path.join(directory, "state.json");
  return {
    filePath,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

test("FX desktop state is disabled, disarmed, and restart durable", () => {
  const temporary = temporaryStore();
  try {
    const store = new FxDesktopStore({ filePath: temporary.filePath });
    assert.equal(store.snapshot().enabled, false);
    assert.equal(store.snapshot().policy.armed, false);
    assert.throws(
      () => store.setPolicy({ armed: true }),
      /enabled before dealing/
    );
    store.setEnabled(true);
    store.setPolicy({
      minimumTradeUsd: 1,
      maximumTradeUsd: 25,
      maximumExposureUsd: 100,
      maximumRequesterExposureUsd: 20,
      maximumAssetExposureUsd: 50,
      armed: true,
    });
    const restored = new FxDesktopStore({ filePath: temporary.filePath });
    assert.equal(restored.snapshot().enabled, true);
    assert.equal(restored.snapshot().policy.armed, true);
    assert.equal(restored.snapshot().policy.maximumTradeUsd, 25);
  } finally {
    temporary.cleanup();
  }
});

test("FX desktop inventory cannot disable a funded or reserved position", () => {
  const temporary = temporaryStore();
  try {
    const store = new FxDesktopStore({ filePath: temporary.filePath });
    store.recordPosition("base-sepolia-usdc", {
      address: "0x1111111111111111111111111111111111111111",
      availableAtomic: "1000000",
      reservedAtomic: "0",
      activeLocks: 0,
    });
    assert.throws(
      () => store.setPositionEnabled("base-sepolia-usdc", false),
      /cannot be disabled/
    );
    store.recordPosition("base-sepolia-usdc", {
      availableAtomic: "0",
    });
    store.setPositionEnabled("base-sepolia-usdc", false);
    assert.equal(
      store.snapshot().positions.find(
        (position) => position.id === "base-sepolia-usdc"
      ).enabled,
      false
    );
  } finally {
    temporary.cleanup();
  }
});

test("FX chains persist role gas readiness and protect enabled token positions", () => {
  const temporary = temporaryStore();
  try {
    const store = new FxDesktopStore({ filePath: temporary.filePath });
    store.setChainSettings("84532", {
      enabled: true,
      rpcUrl: "https://rpc.example/private-key",
    });
    store.recordChain("84532", {
      dealerAddress: "0x1111111111111111111111111111111111111111",
      requesterAddress: "0x2222222222222222222222222222222222222222",
      dealerBalanceAtomic: "1000000000000000",
      dealerBalanceUsdMicros: "2000000",
      requesterBalanceAtomic: "1000000000000000",
      requesterBalanceUsdMicros: "2000000",
      dealerGasReady: true,
      requesterGasReady: true,
      gasReady: true,
    });
    store.setPositionEnabled("base-sepolia-usdc", true);
    assert.throws(
      () => store.setChainSettings("84532", { enabled: false }),
      /token positions first/
    );

    const restored = new FxDesktopStore({ filePath: temporary.filePath });
    const chain = restored.snapshot().chains.find(
      (candidate) => candidate.chainId === "84532"
    );
    assert.equal(chain.gasReady, true);
    assert.equal(chain.dealerGasReady, true);
    assert.equal(chain.requesterGasReady, true);
    assert.equal(chain.rpcUrl, "https://rpc.example/private-key");
    assert.doesNotMatch(
      JSON.stringify(restored.scrubbedEvidence()),
      /rpc\.example|private-key|1111111111|2222222222/
    );
  } finally {
    temporary.cleanup();
  }
});

test("FX desktop trade history persists and scrubbed evidence excludes private state", () => {
  const temporary = temporaryStore();
  const tradeId = `0x${"ab".repeat(32)}`;
  try {
    const store = new FxDesktopStore({
      filePath: temporary.filePath,
      now: () => "2026-07-28T00:00:00.000Z",
    });
    store.putTrade({
      tradeId,
      state: "awaiting_source_funds",
      destinationAddress: "0x2222222222222222222222222222222222222222",
      refundAddress: "0x3333333333333333333333333333333333333333",
    });
    store.putTrade({ tradeId, state: "funds_ready" });
    const restored = new FxDesktopStore({ filePath: temporary.filePath });
    assert.equal(restored.trade(tradeId).state, "funds_ready");
    assert.equal(restored.trade(tradeId).destinationAddress.startsWith("0x22"), true);

    const evidence = restored.scrubbedEvidence();
    const serialized = JSON.stringify(evidence);
    assert.equal(evidence.terminalCounts.funds_ready, 1);
    assert.doesNotMatch(serialized, /2222222222/);
    assert.doesNotMatch(serialized, /3333333333/);
    assert.equal(evidence.endpointPaymentSubmitted, false);
  } finally {
    temporary.cleanup();
  }
});
