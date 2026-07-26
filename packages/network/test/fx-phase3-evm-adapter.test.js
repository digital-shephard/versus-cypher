const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  FxEvmAdapterError,
  estimateEvmActionFee,
  evaluateReceiptFinality,
  selectEvmCapability,
  validateEvmAdapterManifest,
  validateOrderedTimeouts,
  verifyObservedLock,
} = require("../src/fx-evm-adapter");

const manifest = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "..", "fixtures", "fx-phase3-adapter-manifest.json"),
    "utf8"
  )
);
const capability = validateEvmAdapterManifest(manifest).capabilities[0];

test("Phase 3 manifest admits only an exact chain, token, and decimals tuple", () => {
  assert.equal(
    selectEvmCapability(manifest, {
      chainId: 31337,
      token: capability.asset.address,
      decimals: 6,
    }).adapterAddress,
    capability.adapterAddress
  );
  for (const request of [
    { chainId: 31338, token: capability.asset.address, decimals: 6 },
    { chainId: 31337, token: "0x3000000000000000000000000000000000000003", decimals: 6 },
  ]) {
    assert.throws(
      () => selectEvmCapability(manifest, request),
      (error) => error instanceof FxEvmAdapterError && error.code === "UNSUPPORTED_ASSET"
    );
  }
  assert.throws(
    () =>
      selectEvmCapability(manifest, {
        chainId: 31337,
        token: capability.asset.address,
        decimals: 18,
      }),
    (error) => error instanceof FxEvmAdapterError && error.code === "DECIMAL_MISMATCH"
  );
});

test("Phase 3 rejects unsupported token behavior in the manifest", () => {
  for (const feature of ["feeOnTransfer", "rebasing", "callbacks"]) {
    const candidate = structuredClone(manifest);
    candidate.capabilities[0].asset.features[feature] = true;
    assert.throws(
      () => validateEvmAdapterManifest(candidate),
      (error) => error instanceof FxEvmAdapterError && error.code === "UNSUPPORTED_TOKEN"
    );
  }
});

test("Phase 3 enforces safe cross-chain timeout ordering", () => {
  const now = 1_800_000_000;
  assert.deepEqual(
    validateOrderedTimeouts({
      now,
      sourceRefundTimestamp: now + 600,
      destinationRefundTimestamp: now + 300,
      sourceCapability: capability,
      destinationCapability: capability,
    }),
    {
      sourceRefundTimestamp: now + 600,
      destinationRefundTimestamp: now + 300,
      deltaSeconds: 300,
    }
  );
  assert.throws(
    () =>
      validateOrderedTimeouts({
        now,
        sourceRefundTimestamp: now + 300,
        destinationRefundTimestamp: now + 240,
        sourceCapability: capability,
        destinationCapability: capability,
      }),
    (error) => error instanceof FxEvmAdapterError && error.code === "UNSAFE_TIMEOUT_ORDER"
  );
});

test("Phase 3 lock observation rejects every route-bound field mismatch", () => {
  const expected = {
    lockId: `0x${"44".repeat(32)}`,
    amountAtomic: "1000000",
    beneficiary: "0x4000000000000000000000000000000000000004",
    refundAddress: "0x5000000000000000000000000000000000000005",
    secretHash: `0x${"55".repeat(32)}`,
    refundTimestamp: 1_800_000_600,
  };
  const observed = {
    ...expected,
    chainId: capability.chainId,
    token: capability.asset.address,
    adapterAddress: capability.adapterAddress,
  };
  assert.equal(verifyObservedLock(observed, expected, capability), true);
  for (const [field, value] of [
    ["amountAtomic", "999999"],
    ["beneficiary", "0x6000000000000000000000000000000000000006"],
    ["refundAddress", "0x6000000000000000000000000000000000000006"],
    ["secretHash", `0x${"66".repeat(32)}`],
    ["refundTimestamp", expected.refundTimestamp + 1],
  ]) {
    assert.throws(
      () => verifyObservedLock({ ...observed, [field]: value }, expected, capability),
      (error) => error instanceof FxEvmAdapterError && error.code === "LOCK_MISMATCH"
    );
  }
});

test("Phase 3 confirmation policy detects replacement and reorganization safely", () => {
  const receipt = {
    status: 1,
    blockNumber: 100,
    blockHash: `0x${"77".repeat(32)}`,
    transactionHash: `0x${"88".repeat(32)}`,
  };
  assert.deepEqual(
    evaluateReceiptFinality({ receipt, latestBlock: 100, capability }),
    { state: "confirming", confirmations: 1 }
  );
  assert.deepEqual(
    evaluateReceiptFinality({ receipt, latestBlock: 101, capability }),
    { state: "confirmed", confirmations: 2, reorgSafe: false }
  );
  const replacement = {
    ...receipt,
    transactionHash: `0x${"99".repeat(32)}`,
  };
  assert.equal(
    evaluateReceiptFinality({ receipt: replacement, latestBlock: 101, capability }).state,
    "confirmed"
  );
  assert.deepEqual(
    evaluateReceiptFinality({
      previousReceipt: receipt,
      receipt: null,
      latestBlock: 102,
      capability,
    }),
    { state: "reorged", reason: "receipt_disappeared" }
  );
  assert.deepEqual(
    evaluateReceiptFinality({
      previousReceipt: receipt,
      receipt: { ...receipt, blockHash: `0x${"aa".repeat(32)}` },
      latestBlock: 102,
      capability,
    }),
    { state: "reorged", reason: "receipt_moved" }
  );
});

test("Phase 3 fee estimation uses an explicit worst-case native amount", () => {
  assert.deepEqual(
    estimateEvmActionFee({ gasEstimate: 100_000n, maxFeePerGas: 2_000_000n }),
    {
      gasEstimate: "100000",
      maxFeePerGas: "2000000",
      maximumNativeFee: "200000000000",
    }
  );
});

test("Phase 3 adapter remains disconnected from the production network export", () => {
  const productionSource = fs.readFileSync(
    path.join(__dirname, "..", "src", "index.js"),
    "utf8"
  );
  assert.equal(productionSource.includes("fx-evm-adapter"), false);
});
