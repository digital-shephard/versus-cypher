const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { keccak256 } = require("ethers");

const {
  FxPhase5Journal,
  FxPhase5JournalError,
} = require("../src/fx-phase5-journal");
const {
  FxPhase5RouteError,
  phase5LockId,
  validatePhase5Route,
} = require("../src/fx-phase5-route");

const HASH_A = `0x${"11".repeat(32)}`;
const HASH_B = `0x${"22".repeat(32)}`;
const HASH_C = `0x${"33".repeat(32)}`;
const SOURCE_ADAPTER = "0x1000000000000000000000000000000000000001";
const SOURCE_TOKEN = "0x2000000000000000000000000000000000000002";
const DESTINATION_ADAPTER = "0x3000000000000000000000000000000000000003";
const DESTINATION_TOKEN = "0x4000000000000000000000000000000000000004";
const REQUESTER = "0x5000000000000000000000000000000000000005";
const DEALER = "0x6000000000000000000000000000000000000006";
const RELAYER = "0x7000000000000000000000000000000000000007";
const JOURNAL_SECRET = "phase5-test-journal-secret";

function capability({
  chainId,
  adapterAddress,
  tokenAddress,
  symbol,
}) {
  return {
    chainId,
    adapterAddress,
    runtimeCodeHash: HASH_A,
    asset: {
      address: tokenAddress,
      runtimeCodeHash: HASH_B,
      symbol,
      decimals: 6,
      standard: "ERC20",
      features: {
        feeOnTransfer: false,
        rebasing: false,
        callbacks: false,
        issuerControls: "documented",
      },
    },
    confirmationPolicy: {
      requiredConfirmations: 2,
      reorgSafetyBlocks: 12,
    },
    timeoutPolicy: {
      minimumSeconds: 60,
      maximumSeconds: 604800,
      minimumCrossChainDeltaSeconds: 600,
    },
  };
}

function manifest() {
  return {
    schema: "versus-fx-adapter-capabilities",
    schemaVersion: 1,
    adapter: {
      id: "evm-htlc",
      version: 1,
      contract: "EvmHtlcV1",
      sourcePath: "versus/contracts/fx/EvmHtlcV1.sol",
    },
    build: {
      compiler: "0.8.26",
      evmVersion: "cancun",
      sourceTag: "agentic-fx-phase3-v1",
      optimizerRuns: 1,
      viaIR: true,
      sourceSha256: HASH_A,
      creationCodeHash: HASH_C,
    },
    capabilities: [
      capability({
        chainId: "84532",
        adapterAddress: SOURCE_ADAPTER,
        tokenAddress: SOURCE_TOKEN,
        symbol: "bUSD",
      }),
      capability({
        chainId: "421614",
        adapterAddress: DESTINATION_ADAPTER,
        tokenAddress: DESTINATION_TOKEN,
        symbol: "aUSD",
      }),
    ],
  };
}

function routeInput() {
  return {
    schema: "versus-fx-phase5-route",
    schemaVersion: 1,
    environment: "public-testnet",
    deploymentId: HASH_C,
    enabledByDefault: false,
    productionWaku: false,
    productionFunds: false,
    source: {
      chainId: "84532",
      name: "Base Sepolia",
      rpcEnvironmentVariable: "BASE_SEPOLIA_RPC_URL",
      explorerUrl: "https://sepolia-explorer.base.org",
      adapterAddress: SOURCE_ADAPTER,
      tokenAddress: SOURCE_TOKEN,
      decimals: 6,
    },
    destination: {
      chainId: "421614",
      name: "Arbitrum Sepolia",
      rpcEnvironmentVariable: "ARBITRUM_SEPOLIA_RPC_URL",
      explorerUrl: "https://sepolia.arbiscan.io",
      adapterAddress: DESTINATION_ADAPTER,
      tokenAddress: DESTINATION_TOKEN,
      decimals: 6,
    },
    requester: REQUESTER,
    dealer: DEALER,
    relayer: RELAYER,
    inputAmountAtomic: "10000",
    outputAmountAtomic: "10000",
    sourceLockSeconds: 1800,
    destinationLockSeconds: 600,
    minimumTimeoutDeltaSeconds: 600,
  };
}

test("Phase 5 freezes a tiny two-chain route outside production", () => {
  const route = validatePhase5Route(routeInput(), manifest(), {
    now: 1_800_000_000,
  });
  assert.match(route.routeId, /^0x[0-9a-f]{64}$/);
  assert.equal(route.source.chainId, "84532");
  assert.equal(route.destination.chainId, "421614");
  assert.equal(route.inputAmountAtomic, "10000");
  assert.equal(route.outputAmountAtomic, "10000");
  assert.equal(route.enabledByDefault, false);
  assert.equal(route.productionWaku, false);
  assert.equal(route.productionFunds, false);
});

test("Phase 5 labels local evidence without weakening production isolation", () => {
  const candidate = routeInput();
  candidate.environment = "local-lab";
  const route = validatePhase5Route(candidate, manifest(), {
    now: 1_800_000_000,
  });
  assert.equal(route.environment, "local-lab");
  assert.equal(route.enabledByDefault, false);
  assert.equal(route.productionWaku, false);
  assert.equal(route.productionFunds, false);
});

test("Phase 5 rejects production connectivity, one-chain routes, and unsafe timeouts", () => {
  for (const mutate of [
    (candidate) => { candidate.enabledByDefault = true; },
    (candidate) => { candidate.productionWaku = true; },
    (candidate) => { candidate.productionFunds = true; },
    (candidate) => {
      candidate.destination = structuredClone(candidate.source);
    },
    (candidate) => { candidate.sourceLockSeconds = 900; },
  ]) {
    const candidate = routeInput();
    mutate(candidate);
    assert.throws(
      () => validatePhase5Route(candidate, manifest(), { now: 1_800_000_000 }),
      FxPhase5RouteError
    );
  }
});

test("Phase 5 derives separate deterministic lock IDs per trade leg", () => {
  const source = phase5LockId(HASH_A, "source");
  const destination = phase5LockId(HASH_A, "destination");
  assert.notEqual(source, destination);
  assert.equal(source, phase5LockId(HASH_A, "source"));
  assert.notEqual(source, phase5LockId(HASH_B, "source"));
});

test("Phase 5 journal requires owner approval and stores signed bytes before execution", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-phase5-journal-"));
  const journal = new FxPhase5Journal({
    filePath: path.join(directory, "phase5.sqlite"),
    encryptionSecret: JOURNAL_SECRET,
    now: () => 1_800_000_000,
  });
  try {
    const route = validatePhase5Route(routeInput(), manifest(), {
      now: 1_800_000_000,
    });
    journal.prepareTrade({
      tradeId: HASH_A,
      route,
      recoveryFile: path.join(directory, "recovery.json"),
      secretHash: HASH_B,
    });
    assert.equal(journal.trade(HASH_A).state, "prepared");
    assert.throws(
      () =>
        journal.recordSignedAction({
          tradeId: HASH_A,
          slot: "source_fund",
          chainId: "84532",
          transactionHash: HASH_C,
          rawTransaction: "0x1234",
        }),
      (error) =>
        error instanceof FxPhase5JournalError &&
        error.code === "OWNER_REQUIRED"
    );
    journal.approveFromOwnerUi(HASH_A, true);
    const raw = "0x1234";
    const transactionHash = keccak256(raw);
    journal.recordSignedAction({
      tradeId: HASH_A,
      slot: "source_fund",
      chainId: "84532",
      transactionHash,
      rawTransaction: raw,
    });
    assert.equal(journal.trade(HASH_A).state, "owner_approved");
    journal.markAction(HASH_A, "source_fund", "uncertain");
    journal.markAction(HASH_A, "source_fund", "confirmed", {
      hash: transactionHash,
      blockNumber: 1,
    });
    assert.equal(journal.trade(HASH_A).state, "source_funded");
    const databaseBytes = fs.readFileSync(path.join(directory, "phase5.sqlite"));
    assert.equal(databaseBytes.includes(Buffer.from(raw)), false);
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Phase 5 action slots reject replacement bytes and terminal rewrites", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-phase5-conflict-"));
  const journal = new FxPhase5Journal({
    filePath: path.join(directory, "phase5.sqlite"),
    encryptionSecret: JOURNAL_SECRET,
  });
  try {
    const route = validatePhase5Route(routeInput(), manifest());
    journal.prepareTrade({
      tradeId: HASH_A,
      route,
      recoveryFile: path.join(directory, "recovery.json"),
      secretHash: HASH_B,
    });
    journal.approveFromOwnerUi(HASH_A, true);
    const firstRaw = "0x1234";
    journal.recordSignedAction({
      tradeId: HASH_A,
      slot: "source_fund",
      chainId: "84532",
      transactionHash: keccak256(firstRaw),
      rawTransaction: firstRaw,
    });
    assert.throws(
      () =>
        journal.recordSignedAction({
          tradeId: HASH_A,
          slot: "source_fund",
          chainId: "84532",
          transactionHash: keccak256("0x5678"),
          rawTransaction: "0x5678",
        }),
      (error) => error.code === "ACTION_CONFLICT"
    );
    journal.markAction(HASH_A, "source_fund", "confirmed", {
      hash: keccak256(firstRaw),
    });
    assert.throws(
      () => journal.markAction(HASH_A, "source_fund", "reverted"),
      (error) => error.code === "ACTION_TERMINAL"
    );
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Phase 5 journal fails closed when its durable database is corrupt", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-phase5-corrupt-"));
  const filePath = path.join(directory, "phase5.sqlite");
  fs.writeFileSync(filePath, "not a sqlite database");
  try {
    assert.throws(
      () =>
        new FxPhase5Journal({
          filePath,
          encryptionSecret: JOURNAL_SECRET,
        }),
      /database|sqlite|encrypted/i
    );
    assert.equal(fs.readFileSync(filePath, "utf8"), "not a sqlite database");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
