const http = require("node:http");
const { isAddress } = require("ethers");
const {
  FxPhase4Error,
  selectDirectDealerQuote,
} = require("./fx-phase4");

function safeEndpoint(value) {
  const url = new URL(value);
  const local =
    ["127.0.0.1", "localhost", "::1"].includes(url.hostname) &&
    url.protocol === "http:";
  if (url.protocol !== "https:" && !local) {
    throw new FxPhase4Error(
      "direct dealer endpoints require HTTPS outside localhost",
      "UNSAFE_DEALER_ENDPOINT"
    );
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  return url;
}

async function discoverDirectDealerQuote({
  endpoints,
  buyer,
  paymentCommitment,
  settlementAddress,
  now,
  fetchImpl = fetch,
  timeoutMs = 2_000,
}) {
  if (!Array.isArray(endpoints) || endpoints.length < 1 || endpoints.length > 8) {
    throw new FxPhase4Error("direct discovery requires one to eight endpoints");
  }
  if (!isAddress(settlementAddress)) {
    throw new FxPhase4Error("direct discovery requires the frozen settlement address");
  }
  const candidates = await Promise.all(
    endpoints.map(async (endpoint) => {
      try {
        const url = safeEndpoint(endpoint);
        url.searchParams.set("buyer", buyer);
        url.searchParams.set("paymentCommitment", paymentCommitment);
        const response = await fetchImpl(url, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) return null;
        return await response.json();
      } catch {
        return null;
      }
    })
  );
  return selectDirectDealerQuote(candidates.filter(Boolean), {
    buyer,
    now,
    paymentCommitment,
    settlementAddress,
    chainId: 8453n,
  });
}

function createDirectDealerFixture({ buildCandidate }) {
  if (typeof buildCandidate !== "function") {
    throw new TypeError("buildCandidate is required");
  }
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method !== "GET" || url.pathname !== "/v1/fx/quote") {
        response.writeHead(404).end();
        return;
      }
      const candidate = await buildCandidate({
        buyer: url.searchParams.get("buyer"),
        paymentCommitment: url.searchParams.get("paymentCommitment"),
      });
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(
        JSON.stringify(candidate, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value
        )
      );
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "invalid_quote_request" }));
    }
  });
  return {
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      return `http://127.0.0.1:${server.address().port}/v1/fx/quote`;
    },
    async close() {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    },
  };
}

module.exports = {
  createDirectDealerFixture,
  discoverDirectDealerQuote,
  safeEndpoint,
};
