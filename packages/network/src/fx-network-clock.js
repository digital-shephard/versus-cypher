const DEFAULT_FX_CLOCK_RPCS = [
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
];

async function calibrateFxNetworkClock({
  rpcUrls = DEFAULT_FX_CLOCK_RPCS,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5_000,
  localNowMs = Date.now(),
  maximumSourceDisagreementSeconds = 30,
  maximumOffsetSeconds = 24 * 60 * 60,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("FX network clock calibration requires fetch");
  }
  if (!Array.isArray(rpcUrls) || rpcUrls.length < 2) {
    throw new Error("FX network clock requires at least two RPC sources");
  }
  const settled = await Promise.allSettled(rpcUrls.map(async (url) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getBlockByNumber",
        params: ["latest", false],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`FX clock RPC returned HTTP ${response.status}`);
    }
    const body = await response.json();
    const timestampHex = body?.result?.timestamp;
    if (
      typeof timestampHex !== "string" ||
      !/^0x[0-9a-f]+$/i.test(timestampHex)
    ) {
      throw new Error("FX clock RPC returned an invalid block timestamp");
    }
    const timestamp = Number(BigInt(timestampHex));
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
      throw new Error("FX clock RPC block timestamp is out of range");
    }
    return { url, timestamp };
  }));
  const valid = settled
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value)
    .sort((left, right) => left.timestamp - right.timestamp);
  if (valid.length < 2) {
    throw new AggregateError(
      settled
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason),
      "FX network clock requires two valid RPC observations"
    );
  }
  if (
    valid.at(-1).timestamp - valid[0].timestamp >
    maximumSourceDisagreementSeconds
  ) {
    throw new Error("FX clock RPC sources disagree beyond the safety bound");
  }
  const timestamp = valid[Math.floor(valid.length / 2)].timestamp;
  const localSeconds = Math.floor(localNowMs / 1000);
  const offsetSeconds = timestamp - localSeconds;
  if (Math.abs(offsetSeconds) > maximumOffsetSeconds) {
    throw new Error("FX network clock offset exceeds the safety bound");
  }
  return {
    timestamp,
    offsetSeconds,
    sources: valid,
  };
}

function createFxNetworkNow(clock, {
  localNowMs = () => Date.now(),
} = {}) {
  if (!Number.isSafeInteger(clock?.offsetSeconds)) {
    throw new TypeError("FX network clock offset is required");
  }
  return () =>
    Math.floor(localNowMs() / 1000) + clock.offsetSeconds;
}

module.exports = {
  DEFAULT_FX_CLOCK_RPCS,
  calibrateFxNetworkClock,
  createFxNetworkNow,
};
