const { ethers } = require("hardhat");

const MIN_DURATION = 60;
const MAX_DURATION = 7 * 24 * 60 * 60;

const SOURCE_AMOUNT = ethers.parseEther("0.000898750299839876");
const DESTINATION_AMOUNT = ethers.parseEther("0.00085");
const EXECUTOR_AMOUNT = ethers.parseEther("0.000003");

const RECORDED = Object.freeze({
  ethUsd: 1902,
  spreadEth: 0.000002124999750213,
  sourceFund: Object.freeze({
    gasUsed: 188195,
    effectiveGasPriceWei: 6000000,
    l1FeeWei: 10241256147,
  }),
  sourceClaim: Object.freeze({
    gasUsed: 48828,
    effectiveGasPriceWei: 6000000,
    l1FeeWei: 6446788673,
  }),
  destinationFund: Object.freeze({
    gasUsed: 191055,
    effectiveGasPriceWei: 22242000,
  }),
  destinationClaim: Object.freeze({
    gasUsed: 88396,
    effectiveGasPriceWei: 22238000,
  }),
});

function secretPair(label) {
  const secret = ethers.keccak256(ethers.toUtf8Bytes(label));
  return {
    secret,
    secretHash: ethers.keccak256(ethers.solidityPacked(["bytes32"], [secret])),
  };
}

function calldataStats(data) {
  const bytes = ethers.getBytes(data);
  let zeroBytes = 0;
  for (const value of bytes) {
    if (value === 0) zeroBytes += 1;
  }
  const nonzeroBytes = bytes.length - zeroBytes;
  return {
    bytes: bytes.length,
    zeroBytes,
    nonzeroBytes,
    ethereumDataGas: zeroBytes * 4 + nonzeroBytes * 16,
  };
}

function packSettlement(terms) {
  return (
    (BigInt(terms.refundTimestamp) << 192n) |
    (BigInt(terms.beneficiaryAmount) << 96n) |
    BigInt(terms.executorAmount)
  );
}

async function measured(transactionPromise) {
  const transaction = await transactionPromise;
  const receipt = await transaction.wait();
  return {
    gasUsed: Number(receipt.gasUsed),
    calldata: calldataStats(transaction.data),
  };
}

async function deployPair(name, constructorArgs) {
  const Factory = await ethers.getContractFactory(name);
  const source = await Factory.deploy(...constructorArgs);
  const destination = await Factory.deploy(...constructorArgs);
  await Promise.all([
    source.waitForDeployment(),
    destination.waitForDeployment(),
  ]);
  return { source, destination };
}

async function measureV2(roles, now) {
  const pair = await deployPair("EvmNativeHtlcV2", [
    MIN_DURATION,
    MAX_DURATION,
  ]);
  const { secret, secretHash } = secretPair("v2-measurement-secret");
  const sourceLockId = ethers.id("v2-measurement-source");
  const destinationLockId = ethers.id("v2-measurement-destination");
  const sourceRefund = now + 3600;
  const destinationRefund = now + 1800;

  const sourceFund = await measured(
    pair.source.connect(roles.requester).fund(
      sourceLockId,
      roles.dealer.address,
      roles.requester.address,
      secretHash,
      sourceRefund,
      SOURCE_AMOUNT,
      0,
      { value: SOURCE_AMOUNT }
    )
  );
  const destinationFund = await measured(
    pair.destination.connect(roles.dealer).fund(
      destinationLockId,
      roles.recipient.address,
      roles.dealer.address,
      secretHash,
      destinationRefund,
      DESTINATION_AMOUNT,
      EXECUTOR_AMOUNT,
      { value: DESTINATION_AMOUNT + EXECUTOR_AMOUNT }
    )
  );
  const destinationClaim = await measured(
    pair.destination
      .connect(roles.relayer)
      .claim(destinationLockId, secret)
  );
  const sourceClaim = await measured(
    pair.source.connect(roles.dealer).claim(sourceLockId, secret)
  );

  return { sourceFund, sourceClaim, destinationFund, destinationClaim };
}

async function measureV3(roles, now) {
  const pair = await deployPair("EvmNativeHtlcV3", [
    MIN_DURATION,
    MAX_DURATION,
  ]);
  const { secret, secretHash } = secretPair("v3-measurement-secret");
  const sourceTerms = {
    tradeId: ethers.id("v3-measurement-source"),
    funder: roles.requester.address,
    beneficiary: roles.dealer.address,
    secretHash,
    refundTimestamp: now + 3600,
    beneficiaryAmount: SOURCE_AMOUNT,
    executorAmount: 0,
  };
  const destinationTerms = {
    tradeId: ethers.id("v3-measurement-destination"),
    funder: roles.dealer.address,
    beneficiary: roles.recipient.address,
    secretHash,
    refundTimestamp: now + 1800,
    beneficiaryAmount: DESTINATION_AMOUNT,
    executorAmount: EXECUTOR_AMOUNT,
  };

  const sourceFund = await measured(
    pair.source
      .connect(roles.requester)
      ["fund(bytes32,address,bytes32,uint256)"](
        sourceTerms.tradeId,
        sourceTerms.beneficiary,
        sourceTerms.secretHash,
        packSettlement(sourceTerms),
        { value: SOURCE_AMOUNT }
      )
  );
  const destinationFund = await measured(
    pair.destination
      .connect(roles.dealer)
      ["fund(bytes32,address,bytes32,uint256)"](
        destinationTerms.tradeId,
        destinationTerms.beneficiary,
        destinationTerms.secretHash,
        packSettlement(destinationTerms),
        { value: DESTINATION_AMOUNT + EXECUTOR_AMOUNT }
      )
  );
  const destinationClaim = await measured(
    pair.destination
      .connect(roles.relayer)
      ["claim(bytes32,address,address,uint256,bytes32)"](
        destinationTerms.tradeId,
        destinationTerms.funder,
        destinationTerms.beneficiary,
        packSettlement(destinationTerms),
        secret
      )
  );
  const sourceClaim = await measured(
    pair.source
      .connect(roles.dealer)
      ["claim(bytes32,address,address,uint256,bytes32)"](
        sourceTerms.tradeId,
        sourceTerms.funder,
        sourceTerms.beneficiary,
        packSettlement(sourceTerms),
        secret
      )
  );

  return { sourceFund, sourceClaim, destinationFund, destinationClaim };
}

function projectRecordedCost(v2, v3) {
  const sourceFundL1Ratio =
    v3.sourceFund.calldata.ethereumDataGas /
    v2.sourceFund.calldata.ethereumDataGas;
  const sourceClaimL1Ratio =
    v3.sourceClaim.calldata.ethereumDataGas /
    v2.sourceClaim.calldata.ethereumDataGas;

  const sourceFundWei =
    BigInt(v3.sourceFund.gasUsed) *
      BigInt(RECORDED.sourceFund.effectiveGasPriceWei) +
    BigInt(
      Math.ceil(RECORDED.sourceFund.l1FeeWei * sourceFundL1Ratio)
    );
  const sourceClaimWei =
    BigInt(v3.sourceClaim.gasUsed) *
      BigInt(RECORDED.sourceClaim.effectiveGasPriceWei) +
    BigInt(
      Math.ceil(RECORDED.sourceClaim.l1FeeWei * sourceClaimL1Ratio)
    );
  const destinationFundWei =
    BigInt(v3.destinationFund.gasUsed) *
    BigInt(RECORDED.destinationFund.effectiveGasPriceWei);
  const destinationClaimWei =
    BigInt(v3.destinationClaim.gasUsed) *
    BigInt(RECORDED.destinationClaim.effectiveGasPriceWei);
  const totalWei =
    sourceFundWei +
    sourceClaimWei +
    destinationFundWei +
    destinationClaimWei;
  const gasEth = Number(ethers.formatEther(totalWei));
  const gasUsd = gasEth * RECORDED.ethUsd;
  const spread25BpsUsd = RECORDED.spreadEth * RECORDED.ethUsd;
  const spread125BpsUsd = spread25BpsUsd / 2;

  return {
    model: "V3 local gas units repriced at the recorded V2 chain fee schedule",
    caveat:
      "Base L1 data fees are scaled by calldata data-gas ratio; Arbitrum uses the recorded effective gas prices. A live-chain estimate is still required before deployment.",
    sourceFundWei: sourceFundWei.toString(),
    sourceClaimWei: sourceClaimWei.toString(),
    destinationFundWei: destinationFundWei.toString(),
    destinationClaimWei: destinationClaimWei.toString(),
    totalWei: totalWei.toString(),
    gasEth,
    gasUsd,
    spread25BpsUsd,
    allIn25BpsUsd: gasUsd + spread25BpsUsd,
    spread125BpsUsd,
    allIn125BpsUsd: gasUsd + spread125BpsUsd,
  };
}

async function main() {
  const [requester, dealer, recipient, relayer] = await ethers.getSigners();
  const now = Number((await ethers.provider.getBlock("latest")).timestamp);
  const roles = { requester, dealer, recipient, relayer };

  const v2 = await measureV2(roles, now);
  const v3 = await measureV3(roles, now);
  const reductions = {};
  for (const key of [
    "sourceFund",
    "sourceClaim",
    "destinationFund",
    "destinationClaim",
  ]) {
    reductions[key] = {
      gas: 1 - v3[key].gasUsed / v2[key].gasUsed,
      calldata:
        1 -
        v3[key].calldata.ethereumDataGas /
          v2[key].calldata.ethereumDataGas,
    };
  }

  console.log(
    JSON.stringify(
      {
        schema: "versus-fx-v3-gas-measurement",
        schemaVersion: 1,
        amounts: {
          sourceAmountWei: SOURCE_AMOUNT.toString(),
          destinationAmountWei: DESTINATION_AMOUNT.toString(),
          executorAmountWei: EXECUTOR_AMOUNT.toString(),
        },
        v2,
        v3,
        reductions,
        recordedCostProjection: projectRecordedCost(v2, v3),
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
