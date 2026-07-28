const assert = require("node:assert/strict");
const test = require("node:test");
const {
  Interface,
  Wallet,
} = require("ethers");
const {
  FX_TESTNET_CHAINS,
  FX_TOKEN_ABI,
  FxEvmCohort,
} = require("../src/fx-evm-cohort");

const TOKEN = FX_TESTNET_CHAINS["84532"].tokenAddress;
const RECIPIENT = Wallet.createRandom().address.toLowerCase();
const SENDER = Wallet.createRandom().address.toLowerCase();
const TRANSFER = new Interface(FX_TOKEN_ABI);

function fixture() {
  let blockNumber = 100;
  let balance = 5_000_000n;
  let logs = [];
  let logsFilter = null;
  const provider = {
    async getNetwork() {
      return { chainId: 84532n };
    },
    async getCode() {
      return "0x01";
    },
    async getBlockNumber() {
      return blockNumber;
    },
    async getLogs(filter) {
      logsFilter = filter;
      return logs;
    },
  };
  const cohort = new FxEvmCohort({
    walletProvider: () => ({
      address: RECIPIENT,
      privateKey: Wallet.createRandom().privateKey,
    }),
    configurations: {
      "84532": FX_TESTNET_CHAINS["84532"],
    },
    providerFactory: () => provider,
    contractFactory: () => ({
      async balanceOf() {
        return balance;
      },
    }),
  });
  return {
    cohort,
    async baseline(requiredAtomic = "1000000") {
      return cohort.captureFunding({
        chainId: "84532",
        token: TOKEN,
        address: RECIPIENT,
        requiredAtomic,
      });
    },
    receive({ amountAtomic, atBlock = 101 }) {
      const encoded = TRANSFER.encodeEventLog(
        TRANSFER.getEvent("Transfer"),
        [SENDER, RECIPIENT, BigInt(amountAtomic)]
      );
      balance += BigInt(amountAtomic);
      blockNumber = atBlock + 1;
      logs.push({
        address: TOKEN,
        topics: encoded.topics,
        data: encoded.data,
        blockNumber: atBlock,
        transactionHash: `0x${String(logs.length + 1).padStart(64, "0")}`,
      });
    },
    moveBalanceWithoutTransfer(amountAtomic) {
      balance += BigInt(amountAtomic);
      blockNumber += 2;
      logs = [];
    },
    logsFilter() {
      return logsFilter;
    },
  };
}

test("FX funding verification requires a post-baseline transfer and confirmations", async () => {
  const sample = fixture();
  const baseline = await sample.baseline();
  sample.moveBalanceWithoutTransfer("1000000");
  assert.equal(
    (await sample.cohort.verifyFunding({
      baseline,
      requiredAtomic: "1000000",
    })).confirmed,
    false
  );

  const confirmedSample = fixture();
  const confirmedBaseline = await confirmedSample.baseline();
  confirmedSample.receive({ amountAtomic: "1000000" });
  const observation = await confirmedSample.cohort.verifyFunding({
    baseline: confirmedBaseline,
    requiredAtomic: "1000000",
  });
  assert.equal(observation.confirmed, true);
  assert.equal(observation.amountAtomic, "1000000");
  assert.equal(observation.inboundAtomic, "1000000");
  assert.equal(observation.confirmations, 2);
});

test("FX funding verification accepts cumulative top-ups to the same address", async () => {
  const sample = fixture();
  const baseline = await sample.baseline("1000000");
  sample.receive({ amountAtomic: "400000", atBlock: 101 });
  assert.equal(
    (await sample.cohort.verifyFunding({
      baseline,
      requiredAtomic: "1000000",
    })).confirmed,
    false
  );

  sample.receive({ amountAtomic: "600000", atBlock: 102 });
  const observation = await sample.cohort.verifyFunding({
    baseline,
    requiredAtomic: "1000000",
  });
  assert.equal(observation.confirmed, true);
  assert.equal(observation.amountAtomic, "1000000");
  assert.equal(observation.inboundAtomic, "1000000");
});

test("FX funding baseline rejects assets outside the frozen cohort", async () => {
  const sample = fixture();
  await assert.rejects(
    sample.cohort.captureFunding({
      chainId: "84532",
      token: Wallet.createRandom().address,
      address: RECIPIENT,
      requiredAtomic: "1",
    }),
    (error) => error.code === "UNSUPPORTED_ASSET"
  );
});

test("HTLC event recovery starts at the frozen adapter deployment block", async () => {
  const sample = fixture();
  await assert.rejects(
    sample.cohort.findLockEvent({
      chainId: "84532",
      tradeId: `0x${"44".repeat(32)}`,
      side: "source",
      eventName: "LockFunded",
    }),
    (error) => error.code === "MISSING_CHAIN_EVENT"
  );
  assert.equal(
    sample.logsFilter().fromBlock,
    FX_TESTNET_CHAINS["84532"].adapterDeploymentBlock
  );
});
