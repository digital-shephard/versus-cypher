const { ethers } = require("hardhat");
const {
  AbiCoder,
  Interface,
  JsonRpcProvider,
  Transaction,
  Wallet,
  getBytes,
  keccak256,
  toBeHex,
  toQuantity,
  zeroPadValue,
} = ethers;

const MINIMUM_DURATION = 60;
const MAXIMUM_DURATION = 7 * 24 * 60 * 60;
const SOURCE_AMOUNT = ethers.parseEther("0.000898750299839876");
const DESTINATION_AMOUNT = ethers.parseEther("0.00085");
const EXECUTOR_AMOUNT = ethers.parseEther("0.000003");
const REFERENCE_ETH_USD = Number(process.env.ETH_USD_REFERENCE || 1902);
const STATE_SLOT = 0n;
const FUNDED = 1n;
const OVERRIDE_BALANCE = ethers.parseEther("10");
const DUMMY_SOURCE = "0x1000000000000000000000000000000000000001";
const DUMMY_DESTINATION = "0x1000000000000000000000000000000000000002";
const GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000F";

const NETWORKS = Object.freeze({
  baseSepolia: Object.freeze({
    chainId: 84532,
    rpc:
      process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
    feeModel: "op-stack",
  }),
  arbitrumSepolia: Object.freeze({
    chainId: 421614,
    rpc:
      process.env.ARBITRUM_SEPOLIA_RPC_URL ||
      "https://sepolia-rollup.arbitrum.io/rpc",
    feeModel: "nitro-estimate",
  }),
});

const gasPriceOracleInterface = new Interface([
  "function getL1Fee(bytes transaction) view returns (uint256)",
  "function getOperatorFee(uint256 gasUsed) view returns (uint256)",
]);

function quantity(value) {
  return toQuantity(BigInt(value));
}

function stateValue(value) {
  return zeroPadValue(toBeHex(BigInt(value)), 32);
}

function calldataStats(data) {
  const bytes = getBytes(data);
  let zeroBytes = 0;
  for (const value of bytes) {
    if (value === 0) zeroBytes += 1;
  }
  return {
    bytes: bytes.length,
    zeroBytes,
    nonzeroBytes: bytes.length - zeroBytes,
  };
}

function packSettlement(terms) {
  return (
    (BigInt(terms.refundTimestamp) << 192n) |
    (BigInt(terms.beneficiaryAmount) << 96n) |
    BigInt(terms.executorAmount)
  );
}

function mappingKey(lockDigest) {
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256"],
      [lockDigest, STATE_SLOT]
    )
  );
}

async function deployLocalPair() {
  const Factory = await ethers.getContractFactory("EvmNativeHtlcV3");
  const source = await Factory.deploy(MINIMUM_DURATION, MAXIMUM_DURATION);
  const destination = await Factory.deploy(
    MINIMUM_DURATION,
    MAXIMUM_DURATION
  );
  await Promise.all([
    source.waitForDeployment(),
    destination.waitForDeployment(),
  ]);
  const [sourceCode, destinationCode] = await Promise.all([
    ethers.provider.getCode(await source.getAddress()),
    ethers.provider.getCode(await destination.getAddress()),
  ]);
  return { source, destination, sourceCode, destinationCode };
}

async function estimateWithOverrides(provider, transaction, overrides) {
  const result = await provider.send("eth_estimateGas", [
    transaction,
    "latest",
    overrides,
  ]);
  return BigInt(result);
}

async function callSucceedsWithGas(
  provider,
  transaction,
  overrides,
  gasLimit
) {
  try {
    await provider.send("eth_call", [
      { ...transaction, gas: quantity(gasLimit) },
      "latest",
      overrides,
    ]);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error:
        error?.info?.error?.message ||
        error?.shortMessage ||
        error?.message ||
        String(error),
    };
  }
}

async function binarySearchCallGas(provider, transaction, overrides) {
  let low = 21_000n;
  let high = 5_000_000n;
  const upperBound = await callSucceedsWithGas(
    provider,
    transaction,
    overrides,
    high
  );
  if (!upperBound.success) {
    throw new Error(
      `state-overridden eth_call still reverted at 5,000,000 gas: ${upperBound.error}`
    );
  }
  while (low + 1n < high) {
    const middle = (low + high) / 2n;
    const result = await callSucceedsWithGas(
      provider,
      transaction,
      overrides,
      middle
    );
    if (result.success) {
      high = middle;
    } else {
      low = middle;
    }
  }
  return high;
}

async function exactOpStackFees({
  provider,
  chainId,
  wallet,
  transaction,
  gasEstimate,
  gasPrice,
}) {
  const signed = await wallet.signTransaction({
    chainId,
    nonce: 0,
    gasLimit: gasEstimate,
    gasPrice,
    to: transaction.to,
    value: BigInt(transaction.value || "0x0"),
    data: transaction.data,
  });
  // Parse locally to ensure the bytes passed to the oracle are a valid signed
  // transaction. This transaction is never submitted.
  Transaction.from(signed);

  const [l1Result, operatorResult] = await Promise.all([
    provider.call({
      to: GAS_PRICE_ORACLE,
      data: gasPriceOracleInterface.encodeFunctionData("getL1Fee", [signed]),
    }),
    provider.call({
      to: GAS_PRICE_ORACLE,
      data: gasPriceOracleInterface.encodeFunctionData("getOperatorFee", [
        gasEstimate,
      ]),
    }),
  ]);
  return {
    l1DataFeeWei: gasPriceOracleInterface.decodeFunctionResult(
      "getL1Fee",
      l1Result
    )[0],
    operatorFeeWei: gasPriceOracleInterface.decodeFunctionResult(
      "getOperatorFee",
      operatorResult
    )[0],
  };
}

async function estimateLeg({
  label,
  provider,
  network,
  wallet,
  transaction,
  overrides,
}) {
  let gasEstimate;
  let estimateMethod = "eth_estimateGas-state-override";
  try {
    gasEstimate = await estimateWithOverrides(
      provider,
      transaction,
      overrides
    );
  } catch (error) {
    try {
      gasEstimate = await binarySearchCallGas(
        provider,
        transaction,
        overrides
      );
      estimateMethod = "eth_call-state-override-binary-search";
    } catch (fallbackError) {
      throw new Error(
        `${label} gas estimation failed: ${
          fallbackError?.shortMessage ||
          fallbackError?.message ||
          fallbackError
        }; initial error: ${error?.shortMessage || error?.message || error}`
      );
    }
  }
  const gasPrice = await provider.send("eth_gasPrice", []).then(BigInt);
  let l1DataFeeWei = 0n;
  let operatorFeeWei = 0n;
  if (network.feeModel === "op-stack") {
    try {
      ({ l1DataFeeWei, operatorFeeWei } = await exactOpStackFees({
        provider,
        chainId: network.chainId,
        wallet,
        transaction,
        gasEstimate,
        gasPrice,
      }));
    } catch (error) {
      throw new Error(
        `${label} OP Stack fee query failed: ${
          error?.shortMessage || error?.message || error
        }`
      );
    }
  }
  const executionFeeWei = gasEstimate * gasPrice;
  return {
    estimateMethod,
    gasEstimate: gasEstimate.toString(),
    gasPriceWei: gasPrice.toString(),
    executionFeeWei: executionFeeWei.toString(),
    l1DataFeeWei: l1DataFeeWei.toString(),
    operatorFeeWei: operatorFeeWei.toString(),
    totalFeeWei: (
      executionFeeWei +
      l1DataFeeWei +
      operatorFeeWei
    ).toString(),
    calldata: calldataStats(transaction.data),
  };
}

async function estimateNetwork(name, local) {
  const network = NETWORKS[name];
  const provider = new JsonRpcProvider(network.rpc, network.chainId, {
    staticNetwork: true,
    cacheTimeout: -1,
  });
  const connected = await provider.getNetwork();
  if (Number(connected.chainId) !== network.chainId) {
    throw new Error(
      `${name} RPC returned chain ${connected.chainId}, expected ${network.chainId}`
    );
  }
  const block = await provider.getBlock("latest");
  const now = Number(block.timestamp);

  // These wallets exist only in memory to produce realistic sender addresses
  // and signed transaction bytes. No private key or settlement secret is
  // printed, stored, or submitted.
  const requester = Wallet.createRandom();
  const dealer = Wallet.createRandom();
  const recipient = Wallet.createRandom();
  const relayer = Wallet.createRandom();
  const secret = keccak256(ethers.randomBytes(32));
  const secretHash = keccak256(
    ethers.solidityPacked(["bytes32"], [secret])
  );

  const sourceTerms = {
    tradeId: keccak256(ethers.randomBytes(32)),
    funder: requester.address,
    beneficiary: dealer.address,
    secretHash,
    refundTimestamp: now + 3600,
    beneficiaryAmount: SOURCE_AMOUNT,
    executorAmount: 0,
  };
  const destinationTerms = {
    tradeId: keccak256(ethers.randomBytes(32)),
    funder: dealer.address,
    beneficiary: recipient.address,
    secretHash,
    refundTimestamp: now + 1800,
    beneficiaryAmount: DESTINATION_AMOUNT,
    executorAmount: EXECUTOR_AMOUNT,
  };

  const sourceFundData = local.source.interface.encodeFunctionData(
    "fund(bytes32,address,bytes32,uint256)",
    [
      sourceTerms.tradeId,
      sourceTerms.beneficiary,
      sourceTerms.secretHash,
      packSettlement(sourceTerms),
    ]
  );
  const sourceClaimData = local.source.interface.encodeFunctionData(
    "claim(bytes32,address,address,uint256,bytes32)",
    [
      sourceTerms.tradeId,
      sourceTerms.funder,
      sourceTerms.beneficiary,
      packSettlement(sourceTerms),
      secret,
    ]
  );
  const destinationFundData = local.destination.interface.encodeFunctionData(
    "fund(bytes32,address,bytes32,uint256)",
    [
      destinationTerms.tradeId,
      destinationTerms.beneficiary,
      destinationTerms.secretHash,
      packSettlement(destinationTerms),
    ]
  );
  const destinationClaimData =
    local.destination.interface.encodeFunctionData(
      "claim(bytes32,address,address,uint256,bytes32)",
      [
        destinationTerms.tradeId,
        destinationTerms.funder,
        destinationTerms.beneficiary,
        packSettlement(destinationTerms),
        secret,
      ]
    );

  const [sourceDigest, destinationDigest] = await Promise.all([
    local.source.lockDigest(sourceTerms),
    local.destination.lockDigest(destinationTerms),
  ]);
  const fundedValue = stateValue(FUNDED);
  const fundedSource = { [mappingKey(sourceDigest)]: fundedValue };
  const fundedDestination = {
    [mappingKey(destinationDigest)]: fundedValue,
  };

  const sourceFund = await estimateLeg({
    label: `${name} source fund`,
    provider,
    network,
    wallet: requester,
    transaction: {
      from: requester.address,
      to: DUMMY_SOURCE,
      value: quantity(SOURCE_AMOUNT),
      data: sourceFundData,
    },
    overrides: {
      [requester.address]: { balance: quantity(OVERRIDE_BALANCE) },
      [DUMMY_SOURCE]: { code: local.sourceCode },
    },
  });
  const sourceClaim = await estimateLeg({
    label: `${name} source claim`,
    provider,
    network,
    wallet: dealer,
    transaction: {
      from: dealer.address,
      to: DUMMY_SOURCE,
      value: "0x0",
      data: sourceClaimData,
    },
    overrides: {
      [dealer.address]: { balance: quantity(OVERRIDE_BALANCE) },
      [DUMMY_SOURCE]: {
        code: local.sourceCode,
        balance: quantity(SOURCE_AMOUNT),
        stateDiff: fundedSource,
      },
    },
  });
  const destinationFund = await estimateLeg({
    label: `${name} destination fund`,
    provider,
    network,
    wallet: dealer,
    transaction: {
      from: dealer.address,
      to: DUMMY_DESTINATION,
      value: quantity(DESTINATION_AMOUNT + EXECUTOR_AMOUNT),
      data: destinationFundData,
    },
    overrides: {
      [dealer.address]: { balance: quantity(OVERRIDE_BALANCE) },
      [DUMMY_DESTINATION]: { code: local.destinationCode },
    },
  });
  const destinationClaim = await estimateLeg({
    label: `${name} destination claim`,
    provider,
    network,
    wallet: relayer,
    transaction: {
      from: relayer.address,
      to: DUMMY_DESTINATION,
      value: "0x0",
      data: destinationClaimData,
    },
    overrides: {
      [relayer.address]: { balance: quantity(OVERRIDE_BALANCE) },
      [DUMMY_DESTINATION]: {
        code: local.destinationCode,
        balance: quantity(DESTINATION_AMOUNT + EXECUTOR_AMOUNT),
        stateDiff: fundedDestination,
      },
    },
  });

  return {
    chainId: network.chainId,
    blockNumber: block.number,
    blockTimestamp: now,
    feeModel: network.feeModel,
    sourceFund,
    sourceClaim,
    destinationFund,
    destinationClaim,
  };
}

function routeSummary(source, destination) {
  const legNames = [
    [source, "sourceFund"],
    [source, "sourceClaim"],
    [destination, "destinationFund"],
    [destination, "destinationClaim"],
  ];
  const totalFeeWei = legNames.reduce(
    (total, [network, leg]) => total + BigInt(network[leg].totalFeeWei),
    0n
  );
  const gasEth = Number(ethers.formatEther(totalFeeWei));
  const outputEth = Number(ethers.formatEther(DESTINATION_AMOUNT));
  const gasUsd = gasEth * REFERENCE_ETH_USD;
  const atSpread = {};
  for (const spreadBps of [25, 18, 12]) {
    const spreadEth = (outputEth * spreadBps) / 10_000;
    atSpread[`${spreadBps}Bps`] = {
      spreadUsd: spreadEth * REFERENCE_ETH_USD,
      allInUsd: (gasEth + spreadEth) * REFERENCE_ETH_USD,
    };
  }
  const availableSpreadEth = Math.max(
    0,
    0.01 / REFERENCE_ETH_USD - gasEth
  );
  return {
    totalFeeWei: totalFeeWei.toString(),
    gasEth,
    gasUsd,
    maximumWholeSpreadBpsUnderOneCent: Math.floor(
      (availableSpreadEth * 10_000) / outputEth
    ),
    atSpread,
  };
}

async function main() {
  const local = await deployLocalPair();
  const [baseSepolia, arbitrumSepolia] = await Promise.all([
    estimateNetwork("baseSepolia", local),
    estimateNetwork("arbitrumSepolia", local),
  ]);
  console.log(
    JSON.stringify(
      {
        schema: "versus-fx-v3-live-native-estimate",
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        warning:
          "Read-only state-override estimates using current public-testnet fee state; no transaction was broadcast.",
        amounts: {
          sourceAmountWei: SOURCE_AMOUNT.toString(),
          destinationAmountWei: DESTINATION_AMOUNT.toString(),
          executorAmountWei: EXECUTOR_AMOUNT.toString(),
        },
        usdReference: {
          ethUsd: REFERENCE_ETH_USD,
          source:
            "Explicit reproducibility input, not a contract or price-oracle read.",
        },
        baseSepolia,
        arbitrumSepolia,
        routeCosts: {
          baseSepoliaToArbitrumSepolia: routeSummary(
            baseSepolia,
            arbitrumSepolia
          ),
          arbitrumSepoliaToBaseSepolia: routeSummary(
            arbitrumSepolia,
            baseSepolia
          ),
        },
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  const message = String(error?.shortMessage || error?.message || error);
  console.error(message.replace(/0x[0-9a-fA-F]{64}/g, "<redacted-32-bytes>"));
  process.exitCode = 1;
});
