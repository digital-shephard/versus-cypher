const {
  Contract,
  getAddress,
  isAddress,
  keccak256,
  toUtf8Bytes,
} = require("ethers");
const {
  canonicalJson,
  FX_V3_VERSION,
  verifyFxEnvelope,
} = require("./fx-protocol");
const { verifyBrokerRouteProposal } = require("./fx-broker-protocol");
const { signFxMessage } = require("./fx-coordination");
const { phase5LockId } = require("./fx-phase5-route");
const {
  selectEvmV3Capability,
  validateEvmV3Manifest,
} = require("./fx-evm-v3-adapter");
const {
  EXACT_FACTORY_ABI,
  FxX402ExactCoordinator,
  FxX402ExactError,
  FxX402ExactStore,
  createEvmExactSettlementExecutor,
} = require("./fx-x402-exact");

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FxX402ExactError(`${label} must be an object`, "INVALID_REQUEST");
  }
  return value;
}

function address(value, label) {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new FxX402ExactError(`${label} must be an EVM address`, "INVALID_REQUEST");
  }
  const normalized = getAddress(value).toLowerCase();
  if (normalized === ZERO_ADDRESS) {
    throw new FxX402ExactError(`${label} must not be zero`, "INVALID_REQUEST");
  }
  return normalized;
}

function token(value, label) {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new FxX402ExactError(`${label} must be an ERC-20 address`, "INVALID_REQUEST");
  }
  return getAddress(value).toLowerCase();
}

function hash(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new FxX402ExactError(`${label} must be bytes32`, "INVALID_REQUEST");
  }
  return normalized;
}

function uint(value, label) {
  const text = String(value || "");
  if (!/^[0-9]+$/.test(text) || BigInt(text) <= 0n) {
    throw new FxX402ExactError(`${label} must be a positive integer`, "INVALID_REQUEST");
  }
  return BigInt(text).toString();
}

function uintOrZero(value, label) {
  const text = String(value ?? "0");
  if (!/^[0-9]+$/.test(text)) {
    throw new FxX402ExactError(`${label} must be an unsigned integer`, "INVALID_REQUEST");
  }
  return BigInt(text).toString();
}

function chainIdFromNetwork(value, label) {
  const match = /^eip155:([1-9][0-9]*)$/.exec(String(value || ""));
  if (!match) {
    throw new FxX402ExactError(`${label} must be an EVM CAIP-2 network`, "INVALID_REQUEST");
  }
  return BigInt(match[1]).toString();
}

function normalizeGenericIntent(body) {
  object(body, "generic exact request");
  const input = object(body.input, "input");
  const output = object(body.output, "output");
  const normalized = {
    requestId: hash(body.requestId, "requestId"),
    payer: address(body.payer, "payer"),
    inputChainId: chainIdFromNetwork(input.network, "input.network"),
    inputToken: token(input.asset, "input.asset"),
    maximumInputAtomic: uint(body.maximumInputAtomic, "maximumInputAtomic"),
    outputChainId: chainIdFromNetwork(output.network, "output.network"),
    outputToken: String(output.asset || "").toLowerCase(),
    outputAmountAtomic: uint(output.amountAtomic, "output.amountAtomic"),
    destinationAddress: address(body.destinationAddress, "destinationAddress"),
    secretHash: hash(body.secretHash, "secretHash"),
  };
  if (!isAddress(normalized.outputToken)) {
    throw new FxX402ExactError("output.asset must be an EVM asset address", "INVALID_REQUEST");
  }
  normalized.outputToken = getAddress(normalized.outputToken).toLowerCase();
  return normalized;
}

function packSettlement(refundTimestamp, beneficiaryAmountAtomic) {
  const amount = BigInt(beneficiaryAmountAtomic);
  if (amount <= 0n || amount >= (1n << 96n)) {
    throw new FxX402ExactError("source amount exceeds compact V3 encoding", "INVALID_ROUTE");
  }
  return ((BigInt(refundTimestamp) << 192n) | (amount << 96n)).toString();
}

function providerMap(value) {
  return value instanceof Map
    ? value
    : new Map(Object.entries(value || {}).map(([key, provider]) => [String(key), provider]));
}

function factoryMap(value) {
  const entries = value instanceof Map ? value.entries() : Object.entries(value || {});
  const result = new Map();
  for (const [key, item] of entries) {
    const config = object(item, `factory ${key}`);
    const facilitatorFeeAtomic = uintOrZero(
      config.facilitatorFeeAtomic,
      "facilitatorFeeAtomic"
    );
    const facilitatorRecipient = facilitatorFeeAtomic === "0"
      ? ZERO_ADDRESS
      : address(config.facilitatorRecipient, "facilitatorRecipient");
    result.set(String(key).toLowerCase(), {
      factoryAddress: address(config.factoryAddress, "factoryAddress"),
      tokenName: String(config.tokenName || "").trim(),
      tokenVersion: String(config.tokenVersion || "").trim(),
      facilitatorRecipient,
      facilitatorFeeAtomic,
    });
  }
  return result;
}

class FxX402ExactBrokerBridge {
  constructor({
    broker,
    session,
    manifest,
    providers,
    factories,
    signerForNetwork,
    factoryReader = null,
    settleOnchain = null,
    store = new FxX402ExactStore(),
    now = () => Math.floor(Date.now() / 1_000),
    quoteLifetimeSeconds = 120,
    settlementLifetimeSeconds = 7_200,
    reservationTimeoutMs = 30_000,
    confirmations = 1,
  } = {}) {
    if (!broker || typeof broker.requestRoute !== "function") {
      throw new TypeError("generic exact bridge requires a public broker");
    }
    if (!session?.signer || !session?.transport || typeof session.ingest !== "function") {
      throw new TypeError("generic exact bridge requires a coordination session");
    }
    this.broker = broker;
    this.session = session;
    this.manifest = validateEvmV3Manifest(manifest);
    this.providers = providerMap(providers);
    this.factories = factoryMap(factories);
    this.now = now;
    this.quoteLifetimeSeconds = Number(quoteLifetimeSeconds);
    this.settlementLifetimeSeconds = Number(settlementLifetimeSeconds);
    this.reservationTimeoutMs = Number(reservationTimeoutMs);
    this.factoryReader = factoryReader;
    this.settleOnchain = settleOnchain || createEvmExactSettlementExecutor({
      signerForNetwork,
      confirmations,
    });
    this.coordinator = new FxX402ExactCoordinator({
      store,
      now,
      prepare: (body) => this.prepare(body),
      settle: (input) => this.settle(input),
      reveal: (input) => this.reveal(input),
      status: (state) => this.status(state),
    });
  }

  provider(chainId) {
    const provider = this.providers.get(String(chainId));
    if (!provider) {
      throw new FxX402ExactError(
        `no provider is configured for chain ${chainId}`,
        "PROVIDER_UNAVAILABLE"
      );
    }
    return provider;
  }

  factory(chainId, asset) {
    const item = this.factories.get(`${chainId}:${String(asset).toLowerCase()}`);
    if (!item || !item.tokenName || !item.tokenVersion) {
      throw new FxX402ExactError(
        "input asset has no frozen EIP-3009 exact factory",
        "EXACT_ASSET_UNSUPPORTED"
      );
    }
    return item;
  }

  async readFactory(config, provider, lockTerms) {
    if (this.factoryReader) {
      return this.factoryReader({ config, provider, lockTerms });
    }
    const factory = new Contract(
      config.factoryAddress,
      EXACT_FACTORY_ABI,
      provider
    );
    const [payTo, amount] = await Promise.all([
      factory.predictEscrow(lockTerms),
      factory.amountFor(lockTerms),
    ]);
    return { payTo, amount };
  }

  async publish(envelope) {
    const local = this.session.ingest(envelope, { x402ExactIngress: true });
    if (!["accepted", "duplicate"].includes(local.status)) {
      throw new FxX402ExactError(
        `coordination rejected ${envelope.type}`,
        local.error || "COORDINATION_REJECTED"
      );
    }
    await this.session.transport.publish(envelope);
    return envelope;
  }

  waitForReservation(tradeId, acceptance, quote) {
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (error, reserve) => {
        this.session.off("accepted", onAccepted);
        if (timer) clearTimeout(timer);
        if (error) reject(error);
        else resolve(reserve);
      };
      const onAccepted = (message) => {
        if (
          message.type !== "fx_reserve" ||
          message.tradeId !== tradeId ||
          message.payload?.acceptId !== acceptance.id
        ) return;
        try {
          const verified = verifyFxEnvelope(message, {
            now: this.now(),
            clockSkewSeconds: 0,
          });
          if (
            verified.sender !== quote.sender ||
            verified.payload.quoteId !== quote.id ||
            verified.payload.dealerSourceClaimAddress !==
              quote.payload.dealerSourceClaimAddress
          ) {
            throw new FxX402ExactError(
              "dealer reservation changed the precommitted source claimant",
              "RESERVATION_MISMATCH"
            );
          }
          finish(null, verified);
        } catch (error) {
          finish(error);
        }
      };
      this.session.on("accepted", onAccepted);
      timer = setTimeout(
        () => finish(new FxX402ExactError(
          "selected dealer did not reserve the generic route",
          "RESERVATION_TIMEOUT"
        )),
        this.reservationTimeoutMs
      );
      timer.unref?.();
    });
  }

  async prepare(body) {
    const intent = normalizeGenericIntent(body);
    const createdAt = this.now();
    const exactFactory = this.factory(intent.inputChainId, intent.inputToken);
    const maximumInput = BigInt(intent.maximumInputAtomic);
    const facilitatorFee = BigInt(exactFactory.facilitatorFeeAtomic);
    if (facilitatorFee >= maximumInput) {
      throw new FxX402ExactError(
        "maximum input does not cover the disclosed facilitator fee",
        "MAXIMUM_INPUT_TOO_LOW"
      );
    }
    const dealerMaximumInputAtomic = (maximumInput - facilitatorFee).toString();
    const rfq = await signFxMessage({
      protocol: "versus-fx",
      version: FX_V3_VERSION,
      deploymentId: this.manifest.deploymentId,
      type: "fx_rfq",
      tradeId: intent.requestId,
      role: "requester",
      sequence: "1",
      createdAt,
      expiresAt: createdAt + this.quoteLifetimeSeconds,
      payload: {
        outputChainId: intent.outputChainId,
        outputToken: intent.outputToken,
        outputAmountAtomic: intent.outputAmountAtomic,
        inputOptions: [{
          chainId: intent.inputChainId,
          token: intent.inputToken,
          maxInputAtomic: dealerMaximumInputAtomic,
        }],
        quoteDeadline: createdAt + this.quoteLifetimeSeconds - 5,
        settlementDeadline: createdAt + this.settlementLifetimeSeconds,
        quotePolicy: "lowest_all_in",
        x402Commitment: keccak256(toUtf8Bytes(canonicalJson(intent))),
      },
    }, this.session.signer);
    const proposal = verifyBrokerRouteProposal(
      await this.broker.requestRoute(rfq),
      {
        now: this.now(),
        deploymentId: this.manifest.deploymentId,
        rfqId: rfq.id,
      }
    );
    const quote = proposal.quotes.find(
      (candidate) => candidate.id === proposal.route.quoteId
    );
    if (
      !quote ||
      quote.version !== FX_V3_VERSION ||
      !quote.payload.dealerSourceClaimAddress ||
      proposal.route.brokerFeeAtomic !== "0" ||
      BigInt(proposal.route.totalInputAtomic) > BigInt(dealerMaximumInputAtomic)
    ) {
      throw new FxX402ExactError(
        "broker returned a route that cannot support generic exact settlement",
        "UNSUPPORTED_ROUTE"
      );
    }
    const sourceCapability = selectEvmV3Capability(this.manifest, {
      chainId: proposal.route.inputChainId,
      token: proposal.route.inputToken,
    });
    const destinationCapability = selectEvmV3Capability(this.manifest, {
      chainId: proposal.route.outputChainId,
      token: proposal.route.outputToken,
    });
    if (sourceCapability.kind !== "erc20") {
      throw new FxX402ExactError(
        "generic EVM exact currently requires an EIP-3009 ERC-20 input",
        "EXACT_ASSET_UNSUPPORTED"
      );
    }
    if (
      quote.payload.sourceAdapterId !== this.manifest.builds.erc20.adapterId ||
      Number(quote.payload.sourceAdapterVersion) !== FX_V3_VERSION ||
      quote.payload.destinationAdapterId !==
        this.manifest.builds[destinationCapability.kind].adapterId ||
      Number(quote.payload.destinationAdapterVersion) !== FX_V3_VERSION
    ) {
      throw new FxX402ExactError(
        "dealer quote is not bound to the frozen V3 adapters",
        "ADAPTER_MISMATCH"
      );
    }
    const allInInputAtomic = (
      BigInt(proposal.route.totalInputAtomic) + facilitatorFee
    ).toString();
    const latest = await this.provider(proposal.route.inputChainId).getBlock("latest");
    const refundTimestamp = Number(latest.timestamp) + this.settlementLifetimeSeconds;
    const settlement = packSettlement(
      refundTimestamp,
      proposal.route.totalInputAtomic
    );
    const lockTerms = {
      payer: intent.payer,
      tradeId: phase5LockId(intent.requestId, "source"),
      beneficiary: quote.payload.dealerSourceClaimAddress,
      facilitator: exactFactory.facilitatorRecipient,
      facilitatorAmount: exactFactory.facilitatorFeeAtomic,
      secretHash: intent.secretHash,
      settlement,
    };
    const { payTo, amount } = await this.readFactory(
      exactFactory,
      this.provider(proposal.route.inputChainId),
      lockTerms
    );
    if (BigInt(amount) !== BigInt(allInInputAtomic)) {
      throw new FxX402ExactError(
        "factory amount differs from the signed dealer route",
        "FACTORY_PREFLIGHT_MISMATCH"
      );
    }
    const acceptanceCreatedAt = this.now();
    const acceptance = await signFxMessage({
      protocol: "versus-fx",
      version: FX_V3_VERSION,
      deploymentId: this.manifest.deploymentId,
      type: "fx_accept",
      tradeId: intent.requestId,
      role: "requester",
      sequence: "2",
      createdAt: acceptanceCreatedAt,
      expiresAt: Math.min(rfq.payload.settlementDeadline, acceptanceCreatedAt + 600),
      payload: {
        rfqId: rfq.id,
        quoteId: quote.id,
        routeId: proposal.route.routeId,
        dealerInputAmountAtomic: quote.payload.inputAmountAtomic,
        brokerFeeAtomic: proposal.route.brokerFeeAtomic,
        totalInputAtomic: proposal.route.totalInputAtomic,
        outputAmountAtomic: proposal.route.outputAmountAtomic,
        secretHash: intent.secretHash,
        sourceRefundAddress: String(payTo).toLowerCase(),
        destinationClaimAddress: intent.destinationAddress,
        sourceAdapterId: quote.payload.sourceAdapterId,
        sourceAdapterVersion: quote.payload.sourceAdapterVersion,
        destinationAdapterId: quote.payload.destinationAdapterId,
        destinationAdapterVersion: quote.payload.destinationAdapterVersion,
      },
    }, this.session.signer);
    const reservationPromise = this.waitForReservation(
      intent.requestId,
      acceptance,
      quote
    );
    await this.publish(acceptance);
    const reservation = await reservationPromise;

    return {
      tradeId: intent.requestId,
      network: `eip155:${proposal.route.inputChainId}`,
      asset: proposal.route.inputToken,
      amount: allInInputAtomic,
      payTo,
      payer: intent.payer,
      maxTimeoutSeconds: Math.max(
        15,
        Math.min(600, reservation.payload.reservationDeadline - this.now())
      ),
      tokenName: exactFactory.tokenName,
      tokenVersion: exactFactory.tokenVersion,
      publicState: {
        input: {
          network: `eip155:${proposal.route.inputChainId}`,
          asset: proposal.route.inputToken,
          amountAtomic: allInInputAtomic,
          dealerAmountAtomic: proposal.route.totalInputAtomic,
          facilitatorFeeAtomic: exactFactory.facilitatorFeeAtomic,
          facilitatorRecipient: exactFactory.facilitatorRecipient,
        },
        output: {
          network: `eip155:${proposal.route.outputChainId}`,
          asset: proposal.route.outputToken,
          amountAtomic: proposal.route.outputAmountAtomic,
        },
        destinationAddress: intent.destinationAddress,
        secretHash: intent.secretHash,
        quoteId: quote.id,
        reservationId: reservation.id,
      },
      privateState: {
        factoryAddress: exactFactory.factoryAddress,
        sourceAdapterAddress: sourceCapability.adapterAddress,
        refundTimestamp,
        dealerInputAmountAtomic: proposal.route.totalInputAtomic,
        lockTerms,
        rfq,
        proposal,
        quote,
        acceptance,
        reservation,
      },
    };
  }

  async settle(input) {
    const result = await this.settleOnchain(input);
    const state = input.state;
    const privateState = state.privateState;
    const createdAt = this.now();
    const sourceLock = await signFxMessage({
      protocol: "versus-fx",
      version: FX_V3_VERSION,
      deploymentId: this.manifest.deploymentId,
      type: "fx_lock_source",
      tradeId: state.tradeId,
      role: "requester",
      sequence: "3",
      createdAt,
      expiresAt: privateState.refundTimestamp,
      payload: {
        acceptId: privateState.acceptance.id,
        chainId: privateState.proposal.route.inputChainId,
        token: privateState.proposal.route.inputToken,
        amountAtomic: privateState.dealerInputAmountAtomic,
        beneficiaryAmountAtomic: privateState.dealerInputAmountAtomic,
        executorAmountAtomic: "0",
        lockAddress: privateState.sourceAdapterAddress,
        beneficiary: privateState.quote.payload.dealerSourceClaimAddress,
        refundAddress: state.payTo,
        secretHash: state.publicState.secretHash,
        timeout: privateState.refundTimestamp,
        transactionHash: result.transaction,
        blockNumber: String(result.publicState.sourceBlockNumber),
      },
    }, this.session.signer);
    await this.publish(sourceLock);
    return {
      ...result,
      publicState: {
        ...result.publicState,
        sourceLockMessageId: sourceLock.id,
      },
    };
  }

  async status(state) {
    const journal = this.session.journal;
    if (!journal || typeof journal.findType !== "function") return {};
    const complete = journal.findType(state.tradeId, "fx_complete");
    const refund = journal.findType(state.tradeId, "fx_refund");
    const defaulted = journal.findType(state.tradeId, "fx_default");
    const destinationLock = journal.findType(state.tradeId, "fx_lock_destination");
    const reveal = journal.findType(state.tradeId, "fx_reveal");
    if (complete) return { status: "complete", publicState: { ...state.publicState, completionId: complete.id } };
    if (refund) return { status: "refunded", publicState: { ...state.publicState, refundId: refund.id } };
    if (defaulted) return { status: "defaulted", publicState: { ...state.publicState, defaultId: defaulted.id } };
    if (reveal) return { status: "secret_revealed", publicState: { ...state.publicState, revealId: reveal.id } };
    if (destinationLock) {
      return {
        status: "destination_locked",
        publicState: {
          ...state.publicState,
          destinationLockMessageId: destinationLock.id,
          destinationTransactionHash: destinationLock.payload.transactionHash,
        },
      };
    }
    return {};
  }

  async reveal({ state, secret }) {
    const destinationLock = this.session.journal?.findType(
      state.tradeId,
      "fx_lock_destination"
    );
    if (!destinationLock || destinationLock.payload.secretHash !== state.publicState.secretHash) {
      throw new FxX402ExactError(
        "destination lock must be confirmed before reveal",
        "DESTINATION_LOCK_REQUIRED"
      );
    }
    if (keccak256(secret) !== state.publicState.secretHash) {
      throw new FxX402ExactError("secret does not match the intent", "WRONG_SECRET");
    }
    const createdAt = this.now();
    const reveal = await signFxMessage({
      protocol: "versus-fx",
      version: FX_V3_VERSION,
      deploymentId: this.manifest.deploymentId,
      type: "fx_reveal",
      tradeId: state.tradeId,
      role: "requester",
      sequence: "4",
      createdAt,
      expiresAt: state.privateState.refundTimestamp,
      payload: {
        acceptId: state.privateState.acceptance.id,
        destinationLockMessageId: destinationLock.id,
        secret,
        secretHash: state.publicState.secretHash,
      },
    }, this.session.signer);
    await this.publish(reveal);
    return {
      status: "secret_revealed",
      publicState: { ...state.publicState, revealId: reveal.id },
    };
  }
}

module.exports = {
  FxX402ExactBrokerBridge,
  normalizeGenericIntent,
  packSettlement,
};
