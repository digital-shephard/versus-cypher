const {
  TypedDataEncoder,
  getAddress,
  isAddress,
  keccak256,
  verifyTypedData,
} = require("ethers");
const { canonicalJson } = require("./fx-protocol");

const FX_PHASE4_CHAIN_ID = 8453n;
const FX_PHASE4_INPUT_TOKEN = "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42";
const FX_PHASE4_OUTPUT_TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const FX_PHASE4_MIN_OUTPUT = 100_000n;
const FX_PHASE4_MAX_OUTPUT = 1_000_000n;
const FX_PHASE4_MAX_INPUT = 2_000_000n;
const FX_PHASE4_MAX_QUOTE_LIFETIME_SECONDS = 20;
const FX_PHASE4_SCHEME = "versus-atomic-exact";

const DEALER_QUOTE_TYPES = Object.freeze({
  DealerQuote: Object.freeze([
    Object.freeze({ name: "quoteId", type: "bytes32" }),
    Object.freeze({ name: "dealer", type: "address" }),
    Object.freeze({ name: "buyer", type: "address" }),
    Object.freeze({ name: "inputAmount", type: "uint256" }),
    Object.freeze({ name: "outputAmount", type: "uint256" }),
    Object.freeze({ name: "outputRecipient", type: "address" }),
    Object.freeze({ name: "issuedAt", type: "uint64" }),
    Object.freeze({ name: "expiresAt", type: "uint64" }),
    Object.freeze({ name: "nonce", type: "uint256" }),
    Object.freeze({ name: "paymentCommitment", type: "bytes32" }),
  ]),
});
const BUYER_ACCEPTANCE_TYPES = Object.freeze({
  BuyerAcceptance: Object.freeze([
    Object.freeze({ name: "quoteDigest", type: "bytes32" }),
    Object.freeze({ name: "buyer", type: "address" }),
    Object.freeze({ name: "maxInputAmount", type: "uint256" }),
    Object.freeze({ name: "broker", type: "address" }),
    Object.freeze({ name: "brokerFee", type: "uint256" }),
    Object.freeze({ name: "expiresAt", type: "uint64" }),
    Object.freeze({ name: "nonce", type: "uint256" }),
  ]),
});

class FxPhase4Error extends Error {
  constructor(message, code = "FX_PHASE4_ERROR") {
    super(message);
    this.name = "FxPhase4Error";
    this.code = code;
  }
}

function address(value, label) {
  if (!isAddress(value)) throw new FxPhase4Error(`${label} is not an EVM address`);
  return getAddress(value).toLowerCase();
}

function uint(value, label, { minimum = 0n, maximum = (1n << 256n) - 1n } = {}) {
  let normalized;
  try {
    normalized = BigInt(value);
  } catch {
    throw new FxPhase4Error(`${label} is not an unsigned integer`);
  }
  if (normalized < minimum || normalized > maximum) {
    throw new FxPhase4Error(`${label} is outside its fixed limit`);
  }
  return normalized;
}

function seconds(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new FxPhase4Error(`${label} is not a timestamp`);
  }
  return normalized;
}

function bytes32(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new FxPhase4Error(`${label} is not bytes32`);
  }
  return normalized;
}

function settlementDomain({ settlementAddress, chainId = FX_PHASE4_CHAIN_ID }) {
  return {
    name: "Versus Same Chain Settlement",
    version: "1",
    chainId: uint(chainId, "chainId", { minimum: 1n }),
    verifyingContract: address(settlementAddress, "settlementAddress"),
  };
}

function normalizeDealerQuote(input, {
  buyer,
  now = Math.floor(Date.now() / 1000),
} = {}) {
  if (!input || typeof input !== "object") {
    throw new FxPhase4Error("dealer quote is required");
  }
  const quote = {
    quoteId: bytes32(input.quoteId, "quoteId"),
    dealer: address(input.dealer, "dealer"),
    buyer: address(input.buyer, "buyer"),
    inputAmount: uint(input.inputAmount, "inputAmount", {
      minimum: 1n,
      maximum: FX_PHASE4_MAX_INPUT,
    }),
    outputAmount: uint(input.outputAmount, "outputAmount", {
      minimum: FX_PHASE4_MIN_OUTPUT,
      maximum: FX_PHASE4_MAX_OUTPUT,
    }),
    outputRecipient: address(input.outputRecipient, "outputRecipient"),
    issuedAt: seconds(input.issuedAt, "issuedAt"),
    expiresAt: seconds(input.expiresAt, "expiresAt"),
    nonce: uint(input.nonce, "nonce"),
    paymentCommitment: bytes32(input.paymentCommitment, "paymentCommitment"),
  };
  if (buyer && quote.buyer !== address(buyer, "expected buyer")) {
    throw new FxPhase4Error("quote is bound to another buyer", "WRONG_BUYER");
  }
  if (
    quote.dealer === quote.buyer ||
    quote.issuedAt > now ||
    quote.expiresAt <= now ||
    quote.expiresAt <= quote.issuedAt ||
    quote.expiresAt - quote.issuedAt > FX_PHASE4_MAX_QUOTE_LIFETIME_SECONDS
  ) {
    throw new FxPhase4Error("quote parties or lifetime are invalid", "INVALID_QUOTE");
  }
  return quote;
}

function dealerQuoteDigest(domain, quote) {
  return TypedDataEncoder.hash(domain, DEALER_QUOTE_TYPES, quote);
}

function normalizeSignedDealerQuote(candidate, options = {}) {
  const domain = settlementDomain(candidate.domain || {});
  const quote = normalizeDealerQuote(candidate.quote, options);
  if (
    options.settlementAddress &&
    domain.verifyingContract !==
      address(options.settlementAddress, "expected settlement address")
  ) {
    throw new FxPhase4Error("quote targets another settlement contract");
  }
  if (
    options.chainId !== undefined &&
    domain.chainId !== uint(options.chainId, "expected chainId", { minimum: 1n })
  ) {
    throw new FxPhase4Error("quote targets another chain");
  }
  if (
    options.paymentCommitment &&
    quote.paymentCommitment !==
      bytes32(options.paymentCommitment, "expected payment commitment")
  ) {
    throw new FxPhase4Error("quote targets another payment requirement");
  }
  const signer = verifyTypedData(
    domain,
    DEALER_QUOTE_TYPES,
    quote,
    String(candidate.signature || "")
  ).toLowerCase();
  if (signer !== quote.dealer) {
    throw new FxPhase4Error("dealer signature is invalid", "BAD_DEALER_SIGNATURE");
  }
  return {
    domain,
    quote,
    signature: candidate.signature,
    quoteDigest: dealerQuoteDigest(domain, quote),
  };
}

function buildBuyerAcceptance({
  signedQuote,
  buyer,
  maxInputAmount,
  broker = "0x0000000000000000000000000000000000000000",
  brokerFee = 0n,
  expiresAt,
  nonce,
}) {
  const quote = signedQuote.quote;
  const normalizedBuyer = address(buyer, "buyer");
  const normalizedBroker = address(broker, "broker");
  const normalizedFee = uint(brokerFee, "brokerFee", {
    maximum: FX_PHASE4_MAX_INPUT,
  });
  const maximum = uint(maxInputAmount, "maxInputAmount", {
    minimum: 1n,
    maximum: FX_PHASE4_MAX_INPUT,
  });
  if (address(quote.buyer, "quote buyer") !== normalizedBuyer) {
    throw new FxPhase4Error("buyer does not own this quote", "WRONG_BUYER");
  }
  if (quote.inputAmount + normalizedFee > maximum) {
    throw new FxPhase4Error("route exceeds buyer maximum", "MAX_INPUT_EXCEEDED");
  }
  if (
    (normalizedFee === 0n) !==
    (normalizedBroker === "0x0000000000000000000000000000000000000000")
  ) {
    throw new FxPhase4Error("broker and broker fee do not match");
  }
  const normalizedExpiry = seconds(expiresAt, "acceptance expiresAt");
  if (normalizedExpiry > quote.expiresAt) {
    throw new FxPhase4Error("acceptance cannot outlive quote");
  }
  return {
    quoteDigest: signedQuote.quoteDigest,
    buyer: normalizedBuyer,
    maxInputAmount: maximum,
    broker: normalizedBroker,
    brokerFee: normalizedFee,
    expiresAt: normalizedExpiry,
    nonce: uint(nonce, "acceptance nonce"),
  };
}

function selectDirectDealerQuote(candidates, options = {}) {
  const valid = [];
  for (const candidate of candidates || []) {
    try {
      valid.push(normalizeSignedDealerQuote(candidate, options));
    } catch {
      // Direct discovery treats malformed or stale dealer responses as absent.
    }
  }
  if (valid.length === 0) {
    throw new FxPhase4Error("no valid direct dealer quote", "NO_VALID_QUOTE");
  }
  valid.sort((left, right) => {
    if (left.quote.inputAmount !== right.quote.inputAmount) {
      return left.quote.inputAmount < right.quote.inputAmount ? -1 : 1;
    }
    if (left.quote.expiresAt !== right.quote.expiresAt) {
      return left.quote.expiresAt - right.quote.expiresAt;
    }
    return left.quoteDigest.localeCompare(right.quoteDigest);
  });
  return valid[0];
}

function routeCost({ signedQuote, acceptance }) {
  const dealerInput = uint(signedQuote.quote.inputAmount, "dealer input");
  const brokerFee = uint(acceptance.brokerFee, "broker fee");
  const allInInput = dealerInput + brokerFee;
  if (allInInput > uint(acceptance.maxInputAmount, "buyer maximum")) {
    throw new FxPhase4Error("route exceeds signed maximum", "MAX_INPUT_EXCEEDED");
  }
  return {
    inputToken: FX_PHASE4_INPUT_TOKEN,
    outputToken: FX_PHASE4_OUTPUT_TOKEN,
    dealerInputAtomic: dealerInput.toString(),
    brokerFeeAtomic: brokerFee.toString(),
    allInInputAtomic: allInInput.toString(),
    exactOutputAtomic: signedQuote.quote.outputAmount.toString(),
    maximumInputAtomic: BigInt(acceptance.maxInputAmount).toString(),
  };
}

function routeHash({ signedQuote, acceptance }) {
  const stable = JSON.parse(JSON.stringify({
    chainId: signedQuote.domain.chainId.toString(),
    settlementAddress: signedQuote.domain.verifyingContract,
    quoteDigest: signedQuote.quoteDigest,
    acceptance,
    cost: routeCost({ signedQuote, acceptance }),
  }, (_key, value) => (typeof value === "bigint" ? value.toString() : value)));
  return keccak256(Buffer.from(canonicalJson(stable)));
}

class FxPhase4Controller {
  constructor({ available, journal, executor }) {
    this.available = available === true;
    this.enabled = false;
    this.journal = journal;
    this.executor = executor;
  }

  enableFromOwnerUi(confirmed) {
    if (!this.available) {
      throw new FxPhase4Error("FX laboratory is not available in this build", "FX_DISABLED");
    }
    if (confirmed !== true) {
      throw new FxPhase4Error("owner confirmation is required", "OWNER_REQUIRED");
    }
    this.enabled = true;
  }

  disable() {
    this.enabled = false;
  }

  prepare(route) {
    if (!this.enabled) throw new FxPhase4Error("FX laboratory is disabled", "FX_DISABLED");
    const cost = routeCost(route);
    const intentId = routeHash(route);
    this.journal.prepare({ intentId, route, cost });
    return { intentId, cost, state: "prepared" };
  }

  approveFromOwnerUi(intentId, confirmed) {
    if (!this.enabled) throw new FxPhase4Error("FX laboratory is disabled", "FX_DISABLED");
    if (confirmed !== true) {
      throw new FxPhase4Error("owner confirmation is required", "OWNER_REQUIRED");
    }
    return this.journal.approve(intentId, "owner_ui");
  }

  async execute(intentId) {
    if (!this.enabled) throw new FxPhase4Error("FX laboratory is disabled", "FX_DISABLED");
    const intent = this.journal.requireExecutable(intentId);
    const prepared = await this.executor.prepareSignedTransaction(intent.route);
    this.journal.recordSignedTransaction(
      intentId,
      prepared.transactionHash,
      prepared.rawTransaction
    );
    try {
      await this.executor.broadcastSignedTransaction(prepared.rawTransaction);
      const receipt = await this.executor.waitForReceipt(prepared.transactionHash);
      if (Number(receipt.status) !== 1) {
        this.journal.markReverted(intentId, prepared.transactionHash);
        throw new FxPhase4Error("settlement transaction reverted", "TX_REVERTED");
      }
      return this.journal.markConfirmed(
        intentId,
        prepared.transactionHash,
        Number(receipt.blockNumber)
      );
    } catch (error) {
      const current = this.journal.get(intentId);
      if (current?.state !== "reverted") {
        this.journal.markUncertain(intentId, prepared.transactionHash);
      }
      throw error;
    }
  }

  async reconcile(intentId) {
    const intent = this.journal.get(intentId);
    if (!intent?.transactionHash) return intent;
    const receipt = await this.executor.getReceipt(intent.transactionHash);
    if (!receipt) return this.journal.markUncertain(intentId, intent.transactionHash);
    return Number(receipt.status) === 1
      ? this.journal.markConfirmed(
          intentId,
          intent.transactionHash,
          Number(receipt.blockNumber)
        )
      : this.journal.markReverted(intentId, intent.transactionHash);
  }

  async rebroadcastRecordedFromOwnerUi(intentId, confirmed) {
    if (!this.enabled) throw new FxPhase4Error("FX laboratory is disabled", "FX_DISABLED");
    if (confirmed !== true) {
      throw new FxPhase4Error("owner confirmation is required", "OWNER_REQUIRED");
    }
    const intent = this.journal.requireRecoverable(intentId);
    await this.executor.broadcastSignedTransaction(intent.rawTransaction);
    const receipt = await this.executor.waitForReceipt(intent.transactionHash);
    return Number(receipt.status) === 1
      ? this.journal.markConfirmed(
          intentId,
          intent.transactionHash,
          Number(receipt.blockNumber)
        )
      : this.journal.markReverted(intentId, intent.transactionHash);
  }
}

module.exports = {
  BUYER_ACCEPTANCE_TYPES,
  DEALER_QUOTE_TYPES,
  FX_PHASE4_CHAIN_ID,
  FX_PHASE4_INPUT_TOKEN,
  FX_PHASE4_MAX_INPUT,
  FX_PHASE4_MAX_OUTPUT,
  FX_PHASE4_MAX_QUOTE_LIFETIME_SECONDS,
  FX_PHASE4_MIN_OUTPUT,
  FX_PHASE4_OUTPUT_TOKEN,
  FX_PHASE4_SCHEME,
  FxPhase4Controller,
  FxPhase4Error,
  buildBuyerAcceptance,
  dealerQuoteDigest,
  normalizeDealerQuote,
  normalizeSignedDealerQuote,
  routeCost,
  routeHash,
  selectDirectDealerQuote,
  settlementDomain,
};
