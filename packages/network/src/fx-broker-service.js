const http = require("node:http");
const { EventEmitter } = require("node:events");
const { getAddress, isAddress, verifyMessage } = require("ethers");
const { canonicalJson, verifyFxEnvelope } = require("./fx-protocol");
const {
  FX_BROKER_METRICS_SCHEMA,
  FX_BROKER_VERSION,
  FxBrokerError,
  compareBrokerRouteProposals,
  createBrokerRouteProposal,
  verifyBrokerRouteProposal,
} = require("./fx-broker-protocol");
const {
  PAYMENT_REQUIRED,
  PAYMENT_RESPONSE,
  PAYMENT_SIGNATURE,
  base64Json,
  parseBase64Json,
} = require("./fx-x402-fixture");

const FX_BROKER_MAX_BODY_BYTES = 128 * 1024;
const FX_BROKER_MAX_ENDPOINTS = 8;

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function address(value, label) {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new FxBrokerError(`${label} must be an EVM address`);
  }
  return getAddress(value).toLowerCase();
}

class FxBrokerMetrics {
  constructor({
    broker,
    now = () => Math.floor(Date.now() / 1000),
    maxLatencySamples = 512,
  }) {
    this.broker = address(broker, "broker");
    this.now = now;
    this.maxLatencySamples = Number(maxLatencySamples);
    if (!Number.isSafeInteger(this.maxLatencySamples) || this.maxLatencySamples < 1) {
      throw new TypeError("maxLatencySamples must be a positive integer");
    }
    this.windowStartedAt = this.now();
    this.activeRequests = 0;
    this.dealers = new Set();
    this.latencySamples = [];
    this.counters = {
      requests: 0,
      routesCompiled: 0,
      noRoute: 0,
      validQuotes: 0,
      rejectedQuotes: 0,
      verifiedCompletions: 0,
      rejectedCompletionProofs: 0,
      x402DataResponses: 0,
    };
  }

  beginRequest() {
    this.counters.requests += 1;
    this.activeRequests += 1;
    return Date.now();
  }

  finishRequest(startedAt, { proposal = null, quotes = [], error = null } = {}) {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    const latency = Math.max(0, Date.now() - Number(startedAt));
    this.latencySamples.push(latency);
    if (this.latencySamples.length > this.maxLatencySamples) {
      this.latencySamples.splice(0, this.latencySamples.length - this.maxLatencySamples);
    }
    for (const quote of quotes) this.dealers.add(quote.sender);
    this.counters.validQuotes += quotes.length;
    if (proposal) this.counters.routesCompiled += 1;
    if (error) this.counters.noRoute += 1;
  }

  rejectedQuote() {
    this.counters.rejectedQuotes += 1;
  }

  completion(verified) {
    this.counters[verified ? "verifiedCompletions" : "rejectedCompletionProofs"] += 1;
  }

  x402Response() {
    this.counters.x402DataResponses += 1;
  }

  snapshot() {
    const completionAttempts =
      this.counters.verifiedCompletions + this.counters.rejectedCompletionProofs;
    return {
      schema: FX_BROKER_METRICS_SCHEMA,
      schemaVersion: FX_BROKER_VERSION,
      broker: this.broker,
      windowStartedAt: this.windowStartedAt,
      observedAt: this.now(),
      counters: { ...this.counters },
      gauges: {
        activeRequests: this.activeRequests,
        reachableDealers: this.dealers.size,
      },
      latencyMs: {
        p50: percentile(this.latencySamples, 0.5),
        p95: percentile(this.latencySamples, 0.95),
        samples: this.latencySamples.length,
      },
      settlementAccuracyBps: completionAttempts === 0
        ? 0
        : Math.floor(this.counters.verifiedCompletions * 10_000 / completionAttempts),
    };
  }

  async signedSnapshot(signer) {
    const snapshot = this.snapshot();
    const signerAddress = address(await signer.getAddress(), "metrics signer");
    if (signerAddress !== this.broker) {
      throw new FxBrokerError("metrics signer does not match broker");
    }
    return {
      ...snapshot,
      signature: await signer.signMessage(canonicalJson(snapshot)),
    };
  }
}

function verifyBrokerMetricsSnapshot(input) {
  if (!input || input.schema !== FX_BROKER_METRICS_SCHEMA) {
    throw new FxBrokerError("broker metrics schema is unsupported");
  }
  const metricKeys = [
    "schema",
    "schemaVersion",
    "broker",
    "windowStartedAt",
    "observedAt",
    "counters",
    "gauges",
    "latencyMs",
    "settlementAccuracyBps",
    "signature",
  ];
  if (
    Object.keys(input).length !== metricKeys.length ||
    metricKeys.some((key) => !(key in input))
  ) {
    throw new FxBrokerError("broker metrics shape is invalid");
  }
  const { signature, ...snapshot } = input;
  const broker = address(snapshot.broker, "metrics broker");
  if (
    snapshot.schemaVersion !== FX_BROKER_VERSION ||
    !Number.isSafeInteger(snapshot.windowStartedAt) ||
    !Number.isSafeInteger(snapshot.observedAt) ||
    snapshot.observedAt < snapshot.windowStartedAt
  ) {
    throw new FxBrokerError("broker metrics fields are invalid");
  }
  const numericGroups = [
    [snapshot.counters, [
      "requests",
      "routesCompiled",
      "noRoute",
      "validQuotes",
      "rejectedQuotes",
      "verifiedCompletions",
      "rejectedCompletionProofs",
      "x402DataResponses",
    ]],
    [snapshot.gauges, ["activeRequests", "reachableDealers"]],
    [snapshot.latencyMs, ["p50", "p95", "samples"]],
  ];
  for (const [group, keys] of numericGroups) {
    if (
      !group ||
      Object.keys(group).length !== keys.length ||
      keys.some((key) => !Number.isSafeInteger(group[key]) || group[key] < 0)
    ) {
      throw new FxBrokerError("broker metrics counters are invalid");
    }
  }
  if (
    !Number.isSafeInteger(snapshot.settlementAccuracyBps) ||
    snapshot.settlementAccuracyBps < 0 ||
    snapshot.settlementAccuracyBps > 10_000
  ) {
    throw new FxBrokerError("broker settlement accuracy is invalid");
  }
  let recovered;
  try {
    recovered = verifyMessage(canonicalJson(snapshot), signature).toLowerCase();
  } catch {
    throw new FxBrokerError("broker metrics signature is invalid", "BAD_SIGNATURE");
  }
  if (recovered !== broker) {
    throw new FxBrokerError("broker metrics signature does not match broker", "BAD_SIGNATURE");
  }
  return { ...snapshot, broker, signature };
}

class FxPublicBroker extends EventEmitter {
  constructor({
    session,
    signer,
    brokerFeeAtomic = "0",
    observationWindowMs = 15_000,
    maxReferenceAgeSeconds,
    maxTrackedTradeSets = 256,
    now = () => Math.floor(Date.now() / 1000),
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {}) {
    super();
    if (!session || session.role !== "broker") {
      throw new TypeError("public broker requires a broker coordination session");
    }
    if (!signer || typeof signer.signMessage !== "function") {
      throw new TypeError("public broker requires a service signer");
    }
    this.session = session;
    this.signer = signer;
    this.brokerFeeAtomic = String(brokerFeeAtomic);
    this.observationWindowMs = Number(observationWindowMs);
    this.maxReferenceAgeSeconds = maxReferenceAgeSeconds;
    this.maxTrackedTradeSets = Number(maxTrackedTradeSets);
    if (!/^\d+$/.test(this.brokerFeeAtomic)) {
      throw new TypeError("brokerFeeAtomic must be an unsigned integer");
    }
    if (
      !Number.isSafeInteger(this.observationWindowMs) ||
      this.observationWindowMs < 0 ||
      !Number.isSafeInteger(this.maxTrackedTradeSets) ||
      this.maxTrackedTradeSets < 1
    ) {
      throw new TypeError("broker service bounds are invalid");
    }
    this.now = now;
    this.sleep = sleep;
    this.quotes = new Map();
    this.activeRfqs = new Map();
    this.started = false;
    this.metrics = null;
    this.boundAccepted = (envelope, metadata) => this.onEnvelope(envelope, metadata);
    this.boundRejected = () => this.metrics?.rejectedQuote();
  }

  async start() {
    const broker = address(await this.signer.getAddress(), "broker");
    const sessionAddress = address(
      this.session.address || await this.session.signer.getAddress(),
      "session broker"
    );
    if (broker !== sessionAddress) {
      throw new FxBrokerError("broker service signer and Waku identity must match");
    }
    this.metrics = new FxBrokerMetrics({ broker, now: this.now });
    this.session.on("accepted", this.boundAccepted);
    this.session.on("rejected", this.boundRejected);
    await this.session.start();
    this.started = true;
    return this.status();
  }

  onEnvelope(envelope, metadata = {}) {
    if (envelope.type !== "fx_quote") return;
    const expectedRfqId = this.activeRfqs.get(envelope.tradeId);
    if (!expectedRfqId || envelope.payload.rfqId !== expectedRfqId) {
      this.metrics?.rejectedQuote();
      return;
    }
    const entries = this.quotes.get(envelope.tradeId) || [];
    if (entries.length >= 128) {
      this.metrics?.rejectedQuote();
      return;
    }
    if (!entries.some((candidate) => candidate.id === envelope.id)) {
      if (!this.quotes.has(envelope.tradeId)) {
        while (this.quotes.size >= this.maxTrackedTradeSets) {
          this.quotes.delete(this.quotes.keys().next().value);
        }
      }
      entries.push(envelope);
      entries.sort((left, right) => left.id.localeCompare(right.id));
      this.quotes.set(envelope.tradeId, entries);
      this.emit("quote", envelope, metadata);
    }
  }

  status() {
    return {
      active: this.started && this.session.started,
      broker: this.metrics?.broker || null,
      observationWindowMs: this.observationWindowMs,
      openTradeSets: this.quotes.size,
      transport: this.session.transport.status?.() || null,
    };
  }

  async requestRoute(rfq) {
    if (!this.started) {
      throw new FxBrokerError("broker service is not started", "BROKER_OFFLINE");
    }
    const now = this.now();
    const verifiedRfq = verifyFxEnvelope(rfq, { now, clockSkewSeconds: 0 });
    if (verifiedRfq.type !== "fx_rfq") {
      throw new FxBrokerError("broker query requires an fx_rfq");
    }
    const startedAt = this.metrics.beginRequest();
    let proposal;
    let quotes = [];
    let failure;
    try {
      const activeRfqId = this.activeRfqs.get(verifiedRfq.tradeId);
      if (activeRfqId) {
        throw new FxBrokerError(
          "another RFQ is already active for this trade",
          "RFQ_CONFLICT"
        );
      }
      this.activeRfqs.set(verifiedRfq.tradeId, verifiedRfq.id);
      const local = this.session.ingest(verifiedRfq, { brokerIngress: true });
      if (!["accepted", "duplicate"].includes(local.status)) {
        throw new FxBrokerError(
          `broker rejected RFQ ingress: ${local.error || local.status}`,
          local.error || "RFQ_REJECTED"
        );
      }
      await this.session.transport.publish(verifiedRfq);
      const remainingMs = Math.max(
        0,
        (verifiedRfq.payload.quoteDeadline - this.now()) * 1000
      );
      await this.sleep(Math.min(this.observationWindowMs, remainingMs));
      quotes = [...(this.quotes.get(verifiedRfq.tradeId) || [])];
      proposal = await createBrokerRouteProposal({
        signer: this.signer,
        rfq: verifiedRfq,
        quotes,
        brokerFeeAtomic: this.brokerFeeAtomic,
        policy: verifiedRfq.payload.quotePolicy,
        now: this.now(),
        maxReferenceAgeSeconds: this.maxReferenceAgeSeconds,
      });
      return proposal;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      if (this.activeRfqs.get(verifiedRfq.tradeId) === verifiedRfq.id) {
        this.activeRfqs.delete(verifiedRfq.tradeId);
        this.quotes.delete(verifiedRfq.tradeId);
      }
      this.metrics.finishRequest(startedAt, {
        proposal,
        quotes,
        error: failure,
      });
    }
  }

  async metricsSnapshot() {
    return this.metrics.signedSnapshot(this.signer);
  }

  async close() {
    this.started = false;
    this.session.off("accepted", this.boundAccepted);
    this.session.off("rejected", this.boundRejected);
    await this.session.close();
  }
}

function safeBrokerEndpoint(value) {
  const url = new URL(value);
  const local =
    ["127.0.0.1", "localhost", "::1"].includes(url.hostname) &&
    url.protocol === "http:";
  if (url.protocol !== "https:" && !local) {
    throw new FxBrokerError(
      "broker endpoints require HTTPS outside localhost",
      "UNSAFE_BROKER_ENDPOINT"
    );
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  return url;
}

async function queryBrokerRoutes({
  endpoints,
  rfq,
  fetchImpl = fetch,
  timeoutMs = 20_000,
  now = Math.floor(Date.now() / 1000),
  maxReferenceAgeSeconds,
  inputChainId,
  inputToken,
}) {
  if (
    !Array.isArray(endpoints) ||
    endpoints.length < 1 ||
    endpoints.length > FX_BROKER_MAX_ENDPOINTS
  ) {
    throw new FxBrokerError(`broker query requires 1 to ${FX_BROKER_MAX_ENDPOINTS} endpoints`);
  }
  const verifiedRfq = verifyFxEnvelope(rfq, { now, clockSkewSeconds: 0 });
  const attempts = await Promise.all(endpoints.map(async (endpoint) => {
    const startedAt = Date.now();
    let url;
    try {
      url = safeBrokerEndpoint(endpoint);
      url.pathname = "/v1/fx/routes";
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ rfq: verifiedRfq }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        return {
          endpoint: url.origin,
          ok: false,
          status: response.status,
          latencyMs: Date.now() - startedAt,
        };
      }
      const body = await response.json();
      const proposal = verifyBrokerRouteProposal(body.proposal, {
        now,
        deploymentId: verifiedRfq.deploymentId,
        rfqId: verifiedRfq.id,
        maxReferenceAgeSeconds,
      });
      return {
        endpoint: url.origin,
        ok: true,
        latencyMs: Date.now() - startedAt,
        proposal,
      };
    } catch (error) {
      return {
        endpoint: url?.origin || String(endpoint),
        ok: false,
        error: error.code || error.name || "BROKER_QUERY_FAILED",
        latencyMs: Date.now() - startedAt,
      };
    }
  }));
  const valid = attempts.filter((attempt) => attempt.ok).map((attempt) => attempt.proposal);
  if (valid.length === 0) {
    throw new FxBrokerError("no broker returned a valid route", "NO_VALID_BROKER");
  }
  const comparison = compareBrokerRouteProposals(valid, {
    now,
    deploymentId: verifiedRfq.deploymentId,
    rfqId: verifiedRfq.id,
    maxReferenceAgeSeconds,
    inputChainId,
    inputToken,
  });
  return {
    ...comparison,
    attempts,
  };
}

async function readJsonBody(request, limit = FX_BROKER_MAX_BODY_BYTES) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) {
      throw new FxBrokerError("request body is too large", "BODY_TOO_LARGE");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new FxBrokerError("request body is not valid JSON", "BAD_JSON");
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

function createFxBrokerHttpService({
  broker,
  x402DataGate = null,
  host = "127.0.0.1",
  port = 0,
  maxRequestsPerMinutePerIp = 12,
  maxConcurrentRouteRequests = 32,
}) {
  if (!broker || typeof broker.requestRoute !== "function") {
    throw new TypeError("HTTP broker service requires a broker");
  }
  if (
    !Number.isSafeInteger(maxRequestsPerMinutePerIp) ||
    maxRequestsPerMinutePerIp < 1 ||
    !Number.isSafeInteger(maxConcurrentRouteRequests) ||
    maxConcurrentRouteRequests < 1
  ) {
    throw new TypeError("HTTP broker limits must be positive integers");
  }
  const requestWindows = new Map();
  let activeRouteRequests = 0;
  function admitRouteRequest(request) {
    const now = Date.now();
    const key = String(request.socket.remoteAddress || "unknown");
    let window = requestWindows.get(key);
    if (!window || now - window.startedAt >= 60_000) {
      window = { startedAt: now, count: 0 };
      requestWindows.set(key, window);
    }
    window.count += 1;
    if (requestWindows.size > 1024) {
      for (const [candidate, entry] of requestWindows) {
        if (now - entry.startedAt >= 60_000) requestWindows.delete(candidate);
      }
      while (requestWindows.size > 1024) {
        requestWindows.delete(requestWindows.keys().next().value);
      }
    }
    return window.count <= maxRequestsPerMinutePerIp;
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": `content-type,${PAYMENT_SIGNATURE}`,
        }).end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/health") {
        json(response, broker.status().active ? 200 : 503, {
          ok: broker.status().active,
          service: "versus-fx-broker",
          ...broker.status(),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/metrics") {
        json(response, 200, await broker.metricsSnapshot());
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/fx/routes") {
        if (!admitRouteRequest(request)) {
          json(response, 429, { error: "rate_limited" }, { "retry-after": "60" });
          return;
        }
        if (activeRouteRequests >= maxConcurrentRouteRequests) {
          json(response, 503, { error: "broker_overloaded" }, { "retry-after": "5" });
          return;
        }
        activeRouteRequests += 1;
        try {
          const body = await readJsonBody(request);
          const proposal = await broker.requestRoute(body.rfq);
          json(response, 200, { proposal });
        } finally {
          activeRouteRequests -= 1;
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/fx/data/metrics") {
        if (!x402DataGate) {
          json(response, 404, { error: "x402_data_api_disabled" });
          return;
        }
        const encodedProof = request.headers[PAYMENT_SIGNATURE.toLowerCase()];
        if (!encodedProof) {
          json(response, 402, { error: "payment_required" }, {
            [PAYMENT_REQUIRED]: base64Json({
              x402Version: 2,
              accepts: [x402DataGate.requirement],
            }),
          });
          return;
        }
        const proof = parseBase64Json(encodedProof, PAYMENT_SIGNATURE);
        const settlement = await x402DataGate.verify(proof);
        if (settlement?.confirmed !== true) {
          throw new FxBrokerError("x402 data payment is not confirmed", "INVALID_PAYMENT");
        }
        broker.metrics.x402Response();
        json(response, 200, await broker.metricsSnapshot(), {
          [PAYMENT_RESPONSE]: base64Json({
            success: true,
            network: x402DataGate.requirement.network,
            transaction: settlement.transactionHash || proof.transactionHash,
          }),
        });
        return;
      }
      json(response, 404, { error: "not_found" });
    } catch (error) {
      const status = error.code === "BODY_TOO_LARGE" ? 413 : 400;
      json(response, status, { error: error.code || "broker_request_failed" });
    }
  });
  return {
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      const bound = server.address();
      return `http://${host}:${bound.port}`;
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    },
  };
}

module.exports = {
  FX_BROKER_MAX_BODY_BYTES,
  FX_BROKER_MAX_ENDPOINTS,
  FxBrokerMetrics,
  FxPublicBroker,
  createFxBrokerHttpService,
  queryBrokerRoutes,
  safeBrokerEndpoint,
  verifyBrokerMetricsSnapshot,
};
