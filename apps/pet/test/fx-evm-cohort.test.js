const assert = require("node:assert/strict");
const test = require("node:test");
const {
  Interface,
  Wallet,
  keccak256,
} = require("ethers");
const {
  FX_TESTNET_CHAINS,
  FX_TOKEN_ABI,
  FxEvmCohort,
} = require("../src/fx-evm-cohort");
const { FX_NATIVE_ETH_ADDRESS } = require("@versus/network");

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

test("native ETH funding is verified from a post-baseline balance increase", async () => {
  let blockNumber = 100;
  let balance = 5n * 10n ** 18n;
  const nativeAdapterAddress = Wallet.createRandom().address.toLowerCase();
  const configuration = {
    ...FX_TESTNET_CHAINS["84532"],
    nativeAdapterAddress,
    nativeAdapterDeploymentBlock: 90,
    nativeGasReserveWei: "1000",
  };
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
    async getBalance() {
      return balance;
    },
  };
  const cohort = new FxEvmCohort({
    walletProvider: () => ({
      address: RECIPIENT,
      privateKey: Wallet.createRandom().privateKey,
    }),
    configurations: { "84532": configuration },
    providerFactory: () => provider,
  });
  const baseline = await cohort.captureFunding({
    chainId: "84532",
    token: FX_NATIVE_ETH_ADDRESS,
    address: RECIPIENT,
    requiredAtomic: "100000000000000000",
  });

  balance += 100000000000000000n;
  blockNumber += 2;
  const observation = await cohort.verifyFunding({
    baseline,
    requiredAtomic: "100000000000000000",
  });

  assert.equal(observation.confirmed, true);
  assert.equal(observation.amountAtomic, "100000000000000000");
  assert.equal(observation.transactionHash, null);
  assert.equal(observation.confirmations, 2);
});

test("native ETH funding plans enough inbound value for the lock, gas, and refund reserve", async () => {
  let blockNumber = 100;
  let balance = 0n;
  const nativeAdapterAddress = Wallet.createRandom().address.toLowerCase();
  const configuration = {
    ...FX_TESTNET_CHAINS["84532"],
    nativeAdapterAddress,
    nativeAdapterDeploymentBlock: 90,
    nativeGasReserveWei: "1000",
  };
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
    async getBalance() {
      return balance;
    },
    async getFeeData() {
      return { maxFeePerGas: 10n };
    },
  };
  const cohort = new FxEvmCohort({
    walletProvider: () => ({
      address: RECIPIENT,
      privateKey: Wallet.createRandom().privateKey,
    }),
    configurations: { "84532": configuration },
    providerFactory: () => provider,
  });
  const baseline = await cohort.captureFunding({
    chainId: "84532",
    token: FX_NATIVE_ETH_ADDRESS,
    address: RECIPIENT,
    requiredAtomic: "1000000",
  });

  assert.equal(baseline.sourceGasBufferAtomic, "3126000");
  assert.equal(baseline.minimumWalletBalanceAtomic, "4126000");
  assert.equal(baseline.requiredFundingAtomic, "4126000");

  balance = 4_126_000n;
  blockNumber += 2;
  const observation = await cohort.verifyFunding({ baseline });
  assert.equal(observation.confirmed, true);
  assert.equal(observation.amountAtomic, "4126000");
});

test("native ETH locks use exact payable value and retain the gas reserve", async () => {
  const nativeAdapterAddress = Wallet.createRandom().address.toLowerCase();
  const configuration = {
    ...FX_TESTNET_CHAINS["84532"],
    nativeAdapterAddress,
    nativeAdapterDeploymentBlock: 90,
    nativeGasReserveWei: "1000",
  };
  const emptyAddress = "0x0000000000000000000000000000000000000000";
  const transactionHash = `0x${"ab".repeat(32)}`;
  const blockHash = `0x${"cd".repeat(32)}`;
  let walletBalance = 2_000_000n;
  let funded = null;
  const provider = {
    async getNetwork() {
      return { chainId: 84532n };
    },
    async getCode() {
      return "0x01";
    },
    async getBalance() {
      return walletBalance;
    },
    async getFeeData() {
      return { maxFeePerGas: 2n };
    },
    async waitForTransaction() {
      return {
        hash: transactionHash,
        blockHash,
        blockNumber: 101,
        status: 1,
        gasUsed: 100000n,
        gasPrice: 2n,
      };
    },
  };
  const adapter = {
    async getLock() {
      return funded || {
        funder: emptyAddress,
        beneficiary: emptyAddress,
        refundAddress: emptyAddress,
        secretHash: `0x${"00".repeat(32)}`,
        refundTimestamp: 0,
        state: 0,
        amount: 0n,
      };
    },
    async fund(
      lockId,
      beneficiary,
      refundAddress,
      secretHash,
      refundTimestamp,
      options
    ) {
      funded = {
        funder: RECIPIENT,
        beneficiary,
        refundAddress,
        secretHash,
        refundTimestamp,
        state: 1,
        amount: options.value,
      };
      return { hash: transactionHash, lockId };
    },
  };
  const cohort = new FxEvmCohort({
    walletProvider: () => ({
      address: RECIPIENT,
      privateKey: Wallet.createRandom().privateKey,
    }),
    configurations: { "84532": configuration },
    providerFactory: () => provider,
    walletFactory: () => ({
      async getAddress() {
        return RECIPIENT;
      },
    }),
    contractFactory: (address) => {
      if (address.toLowerCase() === nativeAdapterAddress) return adapter;
      return {};
    },
  });
  const input = {
    chainId: "84532",
    tradeId: `0x${"12".repeat(32)}`,
    side: "source",
    amountAtomic: "1000000",
    beneficiary: Wallet.createRandom().address,
    refundAddress: RECIPIENT,
    secretHash: `0x${"34".repeat(32)}`,
    refundTimestamp: 2000,
    token: FX_NATIVE_ETH_ADDRESS,
  };
  const result = await cohort.fundLock(input);

  assert.equal(result.lock.token, FX_NATIVE_ETH_ADDRESS);
  assert.equal(result.lock.adapterAddress, nativeAdapterAddress);
  assert.equal(result.lock.amountAtomic, "1000000");
  assert.equal(funded.amount, 1000000n);

  funded = null;
  walletBalance = 1_360_999n;
  await assert.rejects(
    cohort.fundLock({
      ...input,
      tradeId: `0x${"56".repeat(32)}`,
    }),
    (error) => error.code === "GAS_RESERVE_REQUIRED"
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

test("V3 preflight binds runtime code, adapter version, durations, token, and decimals", async () => {
  const erc20Code = "0x6001";
  const nativeCode = "0x6002";
  const tokenCode = "0x6003";
  const tokenAddress = Wallet.createRandom().address.toLowerCase();
  const erc20AdapterAddress = Wallet.createRandom().address.toLowerCase();
  const nativeAdapterAddress = Wallet.createRandom().address.toLowerCase();
  const configuration = {
    ...FX_TESTNET_CHAINS["84532"],
    tokenAddress,
    adapterV3Address: erc20AdapterAddress,
    adapterV3RuntimeCodeHash: keccak256(erc20Code),
    nativeAdapterV3Address: nativeAdapterAddress,
    nativeAdapterV3RuntimeCodeHash: keccak256(nativeCode),
  };
  const provider = {
    async getNetwork() {
      return { chainId: 84532n };
    },
    async getCode(address) {
      const normalized = address.toLowerCase();
      if (normalized === erc20AdapterAddress) return erc20Code;
      if (normalized === nativeAdapterAddress) return nativeCode;
      if (normalized === tokenAddress) return tokenCode;
      return "0x";
    },
  };
  const commonAdapter = {
    async ADAPTER_VERSION() {
      return 3n;
    },
    async minimumLockDuration() {
      return 60n;
    },
    async maximumLockDuration() {
      return 604800n;
    },
  };
  const cohort = new FxEvmCohort({
    walletProvider: () => ({
      address: RECIPIENT,
      privateKey: Wallet.createRandom().privateKey,
    }),
    configurations: { "84532": configuration },
    settlementVersion: 3,
    providerFactory: () => provider,
    contractFactory: (address) => {
      const normalized = address.toLowerCase();
      if (normalized === erc20AdapterAddress) {
        return {
          ...commonAdapter,
          async asset() {
            return tokenAddress;
          },
          async assetDecimals() {
            return 6n;
          },
        };
      }
      if (normalized === nativeAdapterAddress) return commonAdapter;
      if (normalized === tokenAddress) {
        return {
          async decimals() {
            return 6n;
          },
        };
      }
      throw new Error("unexpected contract");
    },
  });

  assert.equal((await cohort.preflight("84532")).chainId, "84532");
});

test("V3 preflight fails closed when deployed immutables drift", async () => {
  const adapterCode = "0x6001";
  const tokenCode = "0x6002";
  const tokenAddress = Wallet.createRandom().address.toLowerCase();
  const erc20AdapterAddress = Wallet.createRandom().address.toLowerCase();
  const nativeAdapterAddress = Wallet.createRandom().address.toLowerCase();
  const configuration = {
    ...FX_TESTNET_CHAINS["84532"],
    tokenAddress,
    adapterV3Address: erc20AdapterAddress,
    adapterV3RuntimeCodeHash: keccak256(adapterCode),
    nativeAdapterV3Address: nativeAdapterAddress,
    nativeAdapterV3RuntimeCodeHash: keccak256(adapterCode),
  };
  const provider = {
    async getNetwork() {
      return { chainId: 84532n };
    },
    async getCode(address) {
      return address.toLowerCase() === tokenAddress ? tokenCode : adapterCode;
    },
  };
  const cohort = new FxEvmCohort({
    walletProvider: () => ({
      address: RECIPIENT,
      privateKey: Wallet.createRandom().privateKey,
    }),
    configurations: { "84532": configuration },
    settlementVersion: 3,
    providerFactory: () => provider,
    contractFactory: (address) => {
      if (address.toLowerCase() === tokenAddress) {
        return { decimals: async () => 6n };
      }
      return {
        ADAPTER_VERSION: async () => 3n,
        minimumLockDuration: async () => 61n,
        maximumLockDuration: async () => 604800n,
        asset: async () => tokenAddress,
        assetDecimals: async () => 6n,
      };
    },
  });

  await assert.rejects(
    cohort.preflight("84532"),
    (error) => error.code === "IMMUTABLE_MISMATCH"
  );
});

test("V3 recovery filters events by the exact funded digest", async () => {
  const adapterCode = "0x6001";
  const tokenCode = "0x6002";
  const tokenAddress = Wallet.createRandom().address.toLowerCase();
  const erc20AdapterAddress = Wallet.createRandom().address.toLowerCase();
  const nativeAdapterAddress = Wallet.createRandom().address.toLowerCase();
  const expectedLockDigest = `0x${"77".repeat(32)}`;
  let logsFilter = null;
  const configuration = {
    ...FX_TESTNET_CHAINS["84532"],
    tokenAddress,
    adapterV3Address: erc20AdapterAddress,
    adapterV3RuntimeCodeHash: keccak256(adapterCode),
    nativeAdapterV3Address: nativeAdapterAddress,
    nativeAdapterV3RuntimeCodeHash: keccak256(adapterCode),
  };
  const provider = {
    async getNetwork() {
      return { chainId: 84532n };
    },
    async getCode(address) {
      return address.toLowerCase() === tokenAddress ? tokenCode : adapterCode;
    },
    async getLogs(filter) {
      logsFilter = filter;
      return [];
    },
  };
  const commonAdapter = {
    async ADAPTER_VERSION() {
      return 3n;
    },
    async minimumLockDuration() {
      return 60n;
    },
    async maximumLockDuration() {
      return 604800n;
    },
  };
  const cohort = new FxEvmCohort({
    walletProvider: () => ({
      address: RECIPIENT,
      privateKey: Wallet.createRandom().privateKey,
    }),
    configurations: { "84532": configuration },
    settlementVersion: 3,
    providerFactory: () => provider,
    contractFactory: (address) => {
      const normalized = address.toLowerCase();
      if (normalized === erc20AdapterAddress) {
        return {
          ...commonAdapter,
          async asset() {
            return tokenAddress;
          },
          async assetDecimals() {
            return 6n;
          },
        };
      }
      if (normalized === nativeAdapterAddress) return commonAdapter;
      if (normalized === tokenAddress) {
        return {
          async decimals() {
            return 6n;
          },
        };
      }
      throw new Error("unexpected contract");
    },
  });

  await assert.rejects(
    cohort.findLockEvent({
      chainId: "84532",
      tradeId: `0x${"78".repeat(32)}`,
      side: "destination",
      eventName: "LockClaimed",
      token: FX_NATIVE_ETH_ADDRESS,
      expectedLockDigest,
    }),
    (error) => error.code === "MISSING_CHAIN_EVENT"
  );
  assert.equal(logsFilter.topics[1], expectedLockDigest);

  await assert.rejects(
    cohort.claimLock({
      chainId: "84532",
      tradeId: `0x${"79".repeat(32)}`,
      side: "destination",
      secret: `0x${"80".repeat(32)}`,
      token: FX_NATIVE_ETH_ADDRESS,
    }),
    (error) => error.code === "MISSING_LOCK_PROVENANCE"
  );
});
