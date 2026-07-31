const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  Contract,
  getAddress,
  isAddress,
  verifyTypedData,
} = require("ethers");
const {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} = require("@x402/core/http");

const FX_X402_EXACT_SCHEMA = "versus-x402-exact-swap";
const FX_X402_EXACT_VERSION = 1;
const FX_X402_EXACT_RESOURCE = "/v1/fx/exact";
const FX_X402_MAX_BODY_BYTES = 256 * 1024;
const PAYMENT_REQUIRED = "PAYMENT-REQUIRED";
const PAYMENT_RESPONSE = "PAYMENT-RESPONSE";
const PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";

const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

const EXACT_FACTORY_ABI = [
  "function asset() view returns (address)",
  "function amountFor((address payer,bytes32 tradeId,address beneficiary,address facilitator,uint256 facilitatorAmount,bytes32 secretHash,uint256 settlement) terms) view returns (uint256)",
  "function predictEscrow((address payer,bytes32 tradeId,address beneficiary,address facilitator,uint256 facilitatorAmount,bytes32 secretHash,uint256 settlement) terms) view returns (address)",
  "function settleEip3009((address payer,bytes32 tradeId,address beneficiary,address facilitator,uint256 facilitatorAmount,bytes32 secretHash,uint256 settlement) terms,(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce) authorization,bytes signature) returns (address escrow)",
];

class FxX402ExactError extends Error {
  constructor(message, code = "FX_X402_EXACT_ERROR") {
    super(message);
    this.name = "FxX402ExactError";
    this.code = code;
  }
}

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
  return getAddress(value).toLowerCase();
}

function hash(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new FxX402ExactError(`${label} must be bytes32`, "INVALID_REQUEST");
  }
  return normalized;
}

function uint(value, label, { allowZero = false } = {}) {
  let normalized;
  try {
    normalized = BigInt(value);
  } catch {
    throw new FxX402ExactError(`${label} must be an unsigned integer`, "INVALID_REQUEST");
  }
  if (normalized < 0n || (!allowZero && normalized === 0n)) {
    throw new FxX402ExactError(`${label} is outside its supported range`, "INVALID_REQUEST");
  }
  return normalized.toString();
}

function network(value, label = "network") {
  const normalized = String(value || "");
  if (!/^eip155:[1-9][0-9]*$/.test(normalized)) {
    throw new FxX402ExactError(`${label} must be an EVM CAIP-2 network`, "INVALID_REQUEST");
  }
  return normalized;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requestKey(body) {
  return `0x${crypto.createHash("sha256").update(canonical(body)).digest("hex")}`;
}

function normalizePreparedIntent(value, body, now) {
  object(value, "prepared exact intent");
  const maximum = Number(value.maxTimeoutSeconds ?? 300);
  if (!Number.isSafeInteger(maximum) || maximum < 15 || maximum > 3_600) {
    throw new FxX402ExactError("maxTimeoutSeconds is unsafe", "INVALID_INTENT");
  }
  const createdAt = Number(value.createdAt ?? now);
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) {
    throw new FxX402ExactError("prepared intent timestamp is invalid", "INVALID_INTENT");
  }
  const payer = value.payer ? address(value.payer, "payer") : null;
  const normalized = {
    schema: FX_X402_EXACT_SCHEMA,
    schemaVersion: FX_X402_EXACT_VERSION,
    requestKey: requestKey(body),
    tradeId: hash(value.tradeId, "tradeId"),
    status: "payment_required",
    createdAt,
    expiresAt: createdAt + maximum,
    network: network(value.network),
    asset: address(value.asset, "asset"),
    amount: uint(value.amount, "amount"),
    payTo: address(value.payTo, "payTo"),
    payer,
    maxTimeoutSeconds: maximum,
    tokenName: String(value.tokenName || "").trim(),
    tokenVersion: String(value.tokenVersion || "").trim(),
    publicState: value.publicState && typeof value.publicState === "object"
      ? value.publicState
      : {},
    privateState: value.privateState && typeof value.privateState === "object"
      ? value.privateState
      : {},
  };
  if (!normalized.tokenName || !normalized.tokenVersion) {
    throw new FxX402ExactError(
      "EIP-3009 token name and version are required",
      "INVALID_INTENT"
    );
  }
  return normalized;
}

function exactRequirement(state) {
  return {
    scheme: "exact",
    network: state.network,
    asset: state.asset,
    amount: state.amount,
    payTo: state.payTo,
    maxTimeoutSeconds: state.maxTimeoutSeconds,
    extra: {
      name: state.tokenName,
      version: state.tokenVersion,
      assetTransferMethod: "eip3009",
    },
  };
}

function paymentRequired(state, resourceUrl) {
  return {
    x402Version: 2,
    error: "A signed exact EIP-3009 payment is required to fund the atomic source lock",
    resource: {
      url: resourceUrl,
      description: "Fund an exact-output Versus atomic FX source lock",
      mimeType: "application/json",
    },
    accepts: [exactRequirement(state)],
    extensions: {
      versus: {
        schema: FX_X402_EXACT_SCHEMA,
        schemaVersion: FX_X402_EXACT_VERSION,
        tradeId: state.tradeId,
        state: state.publicState,
      },
    },
  };
}

function normalizeAuthorization(value) {
  object(value, "payment authorization");
  return {
    from: address(value.from, "authorization.from"),
    to: address(value.to, "authorization.to"),
    value: uint(value.value, "authorization.value"),
    validAfter: uint(value.validAfter, "authorization.validAfter", { allowZero: true }),
    validBefore: uint(value.validBefore, "authorization.validBefore"),
    nonce: hash(value.nonce, "authorization.nonce"),
  };
}

function sameRequirement(actual, expected) {
  return actual?.scheme === expected.scheme &&
    actual?.network === expected.network &&
    String(actual?.asset || "").toLowerCase() === expected.asset &&
    String(actual?.amount || "") === expected.amount &&
    String(actual?.payTo || "").toLowerCase() === expected.payTo &&
    Number(actual?.maxTimeoutSeconds) === expected.maxTimeoutSeconds &&
    actual?.extra?.assetTransferMethod === "eip3009" &&
    actual?.extra?.name === expected.extra.name &&
    actual?.extra?.version === expected.extra.version;
}

function verifyExactPayment({ payment, state, now }) {
  object(payment, "payment payload");
  if (Number(payment.x402Version) !== 2) {
    throw new FxX402ExactError("x402 version is unsupported", "BAD_PAYMENT");
  }
  const expected = exactRequirement(state);
  if (!sameRequirement(payment.accepted, expected)) {
    throw new FxX402ExactError(
      "payment requirements do not match this atomic swap",
      "REQUIREMENT_MISMATCH"
    );
  }
  const payload = object(payment.payload, "payment payload body");
  const authorization = normalizeAuthorization(payload.authorization);
  if (
    authorization.to !== state.payTo ||
    authorization.value !== state.amount ||
    (state.payer && authorization.from !== state.payer)
  ) {
    throw new FxX402ExactError(
      "authorization does not match the committed payer, payTo, and amount",
      "AUTHORIZATION_MISMATCH"
    );
  }
  const validAfter = BigInt(authorization.validAfter);
  const validBefore = BigInt(authorization.validBefore);
  const current = BigInt(now);
  if (current <= validAfter || current >= validBefore) {
    throw new FxX402ExactError("payment authorization is not currently valid", "PAYMENT_EXPIRED");
  }
  if (validBefore > BigInt(state.expiresAt)) {
    throw new FxX402ExactError(
      "payment authorization outlives the prepared atomic intent",
      "PAYMENT_WINDOW_TOO_LONG"
    );
  }
  if (typeof payload.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(payload.signature)) {
    throw new FxX402ExactError("payment signature is malformed", "BAD_PAYMENT");
  }
  const chainId = BigInt(state.network.slice("eip155:".length));
  let recovered;
  try {
    recovered = verifyTypedData(
      {
        name: state.tokenName,
        version: state.tokenVersion,
        chainId,
        verifyingContract: state.asset,
      },
      AUTHORIZATION_TYPES,
      authorization,
      payload.signature
    ).toLowerCase();
  } catch {
    throw new FxX402ExactError("payment signature is invalid", "BAD_SIGNATURE");
  }
  if (recovered !== authorization.from) {
    throw new FxX402ExactError("payment signer does not match authorization", "BAD_SIGNATURE");
  }
  return { authorization, signature: payload.signature, payer: recovered };
}

function createEvmExactSettlementExecutor({
  signerForNetwork,
  confirmations = 1,
} = {}) {
  if (typeof signerForNetwork !== "function") {
    throw new TypeError("exact settlement executor requires signerForNetwork");
  }
  if (!Number.isSafeInteger(confirmations) || confirmations < 1 || confirmations > 64) {
    throw new TypeError("exact settlement confirmations are unsafe");
  }
  return async function settleExact({ state, authorization, signature }) {
    const privateState = object(state.privateState, "exact private state");
    const factoryAddress = address(privateState.factoryAddress, "factoryAddress");
    const lockTerms = object(privateState.lockTerms, "lockTerms");
    const signer = await signerForNetwork(state.network);
    if (!signer || typeof signer.sendTransaction !== "function") {
      throw new FxX402ExactError(
        `no settlement signer is configured for ${state.network}`,
        "SETTLER_UNAVAILABLE"
      );
    }
    const factory = new Contract(factoryAddress, EXACT_FACTORY_ABI, signer);
    const [factoryAsset, predicted, requiredAmount] = await Promise.all([
      factory.asset(),
      factory.predictEscrow(lockTerms),
      factory.amountFor(lockTerms),
    ]);
    if (
      address(factoryAsset, "factory asset") !== state.asset ||
      address(predicted, "predicted escrow") !== state.payTo ||
      BigInt(requiredAmount) !== BigInt(state.amount)
    ) {
      throw new FxX402ExactError(
        "factory preflight does not match the signed exact requirement",
        "FACTORY_PREFLIGHT_MISMATCH"
      );
    }
    const transaction = await factory.settleEip3009(
      lockTerms,
      authorization,
      signature
    );
    const receipt = await transaction.wait(confirmations);
    if (!receipt || Number(receipt.status) !== 1) {
      throw new FxX402ExactError(
        "exact settlement transaction failed",
        "SETTLEMENT_FAILED"
      );
    }
    return {
      transaction: String(transaction.hash).toLowerCase(),
      publicState: {
        sourceEscrow: state.payTo,
        sourceBlockNumber: Number(receipt.blockNumber),
      },
    };
  };
}

class FxX402ExactStore {
  constructor({ directory = null } = {}) {
    this.directory = directory ? path.resolve(directory) : null;
    this.byRequest = new Map();
    this.byTrade = new Map();
    if (this.directory) {
      fs.mkdirSync(this.directory, { recursive: true });
      for (const entry of fs.readdirSync(this.directory)) {
        if (!/^[0-9a-f]{64}\.json$/.test(entry)) continue;
        const state = JSON.parse(
          fs.readFileSync(path.join(this.directory, entry), "utf8")
        );
        this._remember(state);
      }
    }
  }

  _remember(state) {
    this.byRequest.set(state.requestKey, state);
    this.byTrade.set(state.tradeId, state);
  }

  getByRequest(key) {
    const state = this.byRequest.get(key);
    return state ? structuredClone(state) : null;
  }

  get(tradeId) {
    const state = this.byTrade.get(String(tradeId).toLowerCase());
    return state ? structuredClone(state) : null;
  }

  put(state) {
    const existing = this.get(state.tradeId);
    if (existing && existing.requestKey !== state.requestKey) {
      throw new FxX402ExactError(
        "trade ID is already bound to another exact request",
        "TRADE_CONFLICT"
      );
    }
    const serializable = JSON.parse(JSON.stringify(state));
    const serialized = JSON.stringify(serializable, null, 2);
    if (/privateKey|rawTransaction|"secret"\s*:/i.test(serialized)) {
      throw new FxX402ExactError(
        "exact store refuses credentials, signed transactions, and secrets",
        "UNSAFE_PERSISTENCE"
      );
    }
    this._remember(serializable);
    if (this.directory) {
      const target = path.join(this.directory, `${serializable.tradeId.slice(2)}.json`);
      const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
      fs.writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporary, target);
    }
    return structuredClone(serializable);
  }

  update(tradeId, patch) {
    const state = this.get(tradeId);
    if (!state) throw new FxX402ExactError("exact swap is unknown", "TRADE_NOT_FOUND");
    return this.put({ ...state, ...patch });
  }
}

class FxX402ExactCoordinator {
  constructor({
    prepare,
    settle,
    reveal,
    status,
    store = new FxX402ExactStore(),
    now = () => Math.floor(Date.now() / 1_000),
  } = {}) {
    if (typeof prepare !== "function" || typeof settle !== "function") {
      throw new TypeError("generic exact coordinator requires prepare and settle functions");
    }
    this.prepareIntent = prepare;
    this.settleIntent = settle;
    this.revealIntent = reveal;
    this.statusIntent = status;
    this.store = store;
    this.now = now;
    this.preparing = new Map();
    this.preparingTrades = new Map();
    this.settling = new Map();
    this.revealing = new Map();
  }

  async prepare(body) {
    object(body, "exact swap request");
    const key = requestKey(body);
    const existing = this.store.getByRequest(key);
    if (existing) return existing;
    const requestedTradeId = /^0x[0-9a-fA-F]{64}$/.test(String(body.requestId || ""))
      ? String(body.requestId).toLowerCase()
      : null;
    if (requestedTradeId) {
      const existingTrade = this.store.get(requestedTradeId);
      if (existingTrade && existingTrade.requestKey !== key) {
        throw new FxX402ExactError(
          "trade ID is already bound to another exact request",
          "TRADE_CONFLICT"
        );
      }
      const preparingKey = this.preparingTrades.get(requestedTradeId);
      if (preparingKey && preparingKey !== key) {
        throw new FxX402ExactError(
          "trade ID is already being prepared for another exact request",
          "TRADE_CONFLICT"
        );
      }
    }
    if (this.preparing.has(key)) return this.preparing.get(key);
    const pending = (async () => {
      const prepared = normalizePreparedIntent(
        await this.prepareIntent(body),
        body,
        this.now()
      );
      return this.store.put(prepared);
    })();
    this.preparing.set(key, pending);
    if (requestedTradeId) this.preparingTrades.set(requestedTradeId, key);
    try {
      return await pending;
    } finally {
      this.preparing.delete(key);
      if (requestedTradeId && this.preparingTrades.get(requestedTradeId) === key) {
        this.preparingTrades.delete(requestedTradeId);
      }
    }
  }

  async settle(body, payment) {
    const state = await this.prepare(body);
    if (state.status === "source_confirmed") return state;
    if (this.settling.has(state.tradeId)) return this.settling.get(state.tradeId);
    const pending = this._settle(state, payment);
    this.settling.set(state.tradeId, pending);
    try {
      return await pending;
    } finally {
      this.settling.delete(state.tradeId);
    }
  }

  async _settle(state, payment) {
    if (this.now() >= state.expiresAt) {
      throw new FxX402ExactError("prepared exact swap expired", "INTENT_EXPIRED");
    }
    const verified = verifyExactPayment({ payment, state, now: this.now() });
    const result = object(
      await this.settleIntent({ state, payment, ...verified }),
      "exact settlement result"
    );
    const transaction = hash(result.transaction, "settlement transaction");
    return this.store.update(state.tradeId, {
      status: "source_confirmed",
      payer: verified.payer,
      transaction,
      settledAt: this.now(),
      publicState: {
        ...state.publicState,
        ...(result.publicState || {}),
      },
    });
  }

  async status(tradeId) {
    let state = this.store.get(hash(tradeId, "tradeId"));
    if (!state) throw new FxX402ExactError("exact swap is unknown", "TRADE_NOT_FOUND");
    if (typeof this.statusIntent === "function") {
      const result = await this.statusIntent(state);
      if (result && typeof result === "object") {
        state = this.store.update(state.tradeId, result);
      }
    }
    return this.publicState(state);
  }

  async reveal(tradeId, secret) {
    const state = this.store.get(hash(tradeId, "tradeId"));
    if (!state) throw new FxX402ExactError("exact swap is unknown", "TRADE_NOT_FOUND");
    if (["secret_revealed", "complete"].includes(state.status)) {
      return this.publicState(state);
    }
    if (state.status === "payment_required") {
      throw new FxX402ExactError("source lock is not funded", "SOURCE_NOT_FUNDED");
    }
    const normalizedSecret = hash(secret, "secret");
    if (typeof this.revealIntent !== "function") {
      throw new FxX402ExactError("reveal is unavailable", "REVEAL_UNAVAILABLE");
    }
    if (this.revealing.has(state.tradeId)) return this.revealing.get(state.tradeId);
    const pending = (async () => {
      const result = await this.revealIntent({ state, secret: normalizedSecret });
      const next = result && typeof result === "object" ? result : {};
      return this.publicState(this.store.update(state.tradeId, {
        ...next,
        status: next.status || "secret_revealed",
        revealedAt: this.now(),
      }));
    })();
    this.revealing.set(state.tradeId, pending);
    try {
      return await pending;
    } finally {
      this.revealing.delete(state.tradeId);
    }
  }

  publicState(state) {
    return {
      schema: state.schema,
      schemaVersion: state.schemaVersion,
      tradeId: state.tradeId,
      status: state.status,
      network: state.network,
      asset: state.asset,
      amount: state.amount,
      payer: state.payer,
      transaction: state.transaction || null,
      createdAt: state.createdAt,
      expiresAt: state.expiresAt,
      ...state.publicState,
    };
  }
}

async function readJsonBody(request, limit = FX_X402_MAX_BODY_BYTES) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) {
      throw new FxX402ExactError("request body is too large", "BODY_TOO_LARGE");
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new FxX402ExactError("request body is not valid JSON", "BAD_JSON");
  }
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function createFxX402ExactHttpHandler({
  coordinator,
  resource = FX_X402_EXACT_RESOURCE,
  publicUrl,
} = {}) {
  if (!coordinator || typeof coordinator.prepare !== "function") {
    throw new TypeError("generic exact HTTP handler requires a coordinator");
  }
  return async function handle(request, response) {
    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": `content-type,${PAYMENT_SIGNATURE}`,
        }).end();
        return true;
      }
      const statusMatch = new RegExp(
        `^${resource.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(0x[0-9a-fA-F]{64})$`
      ).exec(url.pathname);
      if (request.method === "GET" && statusMatch) {
        json(response, 200, { swap: await coordinator.status(statusMatch[1]) });
        return true;
      }
      const revealMatch = new RegExp(
        `^${resource.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(0x[0-9a-fA-F]{64})/reveal$`
      ).exec(url.pathname);
      if (request.method === "POST" && revealMatch) {
        const body = await readJsonBody(request);
        json(response, 202, {
          swap: await coordinator.reveal(revealMatch[1], body.secret),
        });
        return true;
      }
      if (request.method !== "POST" || url.pathname !== resource) return false;
      const body = await readJsonBody(request);
      const encodedPayment = request.headers[PAYMENT_SIGNATURE.toLowerCase()];
      const resourceUrl = publicUrl || `http://${request.headers.host || "localhost"}${resource}`;
      if (!encodedPayment) {
        const state = await coordinator.prepare(body);
        const required = paymentRequired(state, resourceUrl);
        json(response, 402, {
          error: "payment_required",
          tradeId: state.tradeId,
          swap: coordinator.publicState(state),
        }, {
          [PAYMENT_REQUIRED]: encodePaymentRequiredHeader(required),
        });
        return true;
      }
      const payment = decodePaymentSignatureHeader(encodedPayment);
      const state = await coordinator.settle(body, payment);
      const settlement = {
        success: true,
        transaction: state.transaction,
        network: state.network,
        payer: state.payer,
        amount: state.amount,
        extensions: {
          versus: {
            tradeId: state.tradeId,
            status: state.status,
          },
        },
      };
      json(response, 202, { swap: coordinator.publicState(state) }, {
        [PAYMENT_RESPONSE]: encodePaymentResponseHeader(settlement),
        "access-control-expose-headers": PAYMENT_RESPONSE,
      });
      return true;
    } catch (error) {
      const status = {
        BODY_TOO_LARGE: 413,
        TRADE_NOT_FOUND: 404,
        TRADE_CONFLICT: 409,
        INTENT_EXPIRED: 410,
        PAYMENT_EXPIRED: 402,
        BAD_PAYMENT: 402,
        BAD_SIGNATURE: 402,
        REQUIREMENT_MISMATCH: 402,
        AUTHORIZATION_MISMATCH: 402,
        PAYMENT_WINDOW_TOO_LONG: 402,
      }[error.code] || 400;
      json(response, status, {
        error: error.code || "fx_x402_exact_failed",
        message: error.message,
      });
      return true;
    }
  };
}

module.exports = {
  AUTHORIZATION_TYPES,
  EXACT_FACTORY_ABI,
  FX_X402_EXACT_RESOURCE,
  FX_X402_EXACT_SCHEMA,
  FX_X402_EXACT_VERSION,
  FxX402ExactCoordinator,
  FxX402ExactError,
  FxX402ExactStore,
  createFxX402ExactHttpHandler,
  createEvmExactSettlementExecutor,
  exactRequirement,
  paymentRequired,
  verifyExactPayment,
};
