#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const {
  CypherIdentity,
  StaticCypherVerifier,
  VersusNode,
  WakuPostcardTransport,
  buildSignalBatch,
} = require("../../packages/network/src");

const ARENA = "0x1111111111111111111111111111111111111111";
const AGENTS = "0x2222222222222222222222222222222222222222";

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function inBatches(values, size, operation) {
  for (let index = 0; index < values.length; index += size) {
    await Promise.all(values.slice(index, index + size).map(operation));
  }
}

async function main() {
  const count = Number(arg("count"));
  const output = path.resolve(arg("output"));
  const cluster = JSON.parse(fs.readFileSync(path.resolve(arg("cluster")), "utf8"));
  const topicScope = String(arg("topic-scope"));
  if (!Number.isInteger(count) || count < 2 || count > 500) throw new RangeError("count must be from 2 to 500");
  fs.mkdirSync(output, { recursive: true });
  const events = fs.createWriteStream(path.join(output, "events.jsonl"), { flags: "a" });
  const record = (type, detail = {}) => events.write(`${JSON.stringify({ at: Date.now(), type, detail })}\n`);
  const startedAt = Date.now();
  const cpuStart = process.cpuUsage();
  let peakRss = process.memoryUsage().rss;
  const sampleMemory = () => { peakRss = Math.max(peakRss, process.memoryUsage().rss); };
  const memoryTimer = setInterval(sampleMemory, 250);
  memoryTimer.unref?.();
  const nodes = [];
  let result = null;

  try {
    record("stage_started", { count, topicScope });
    const identities = Array.from({ length: count }, (_, index) => CypherIdentity.createRandom(index + 1));
    const registry = new StaticCypherVerifier(identities.map((identity, index) => ({
      address: identity.address,
      cypherId: index + 1,
    })));
    const economicVerifier = { async verifySignalSettlement() { return { verified: true }; } };
    for (let index = 0; index < count; index += 1) {
      const transport = new WakuPostcardTransport({
        chainId: 31337,
        contractAddress: AGENTS,
        launchId: 1,
        topicScope,
        bootstrapPeers: [cluster.nodes[index % cluster.nodes.length].websocketMultiaddr],
        defaultBootstrap: false,
        clusterId: cluster.clusterId,
        numShardsInCluster: cluster.numShardsInCluster,
        peerTimeoutMs: 60_000,
        minimumPeerCount: 1,
        enableStore: false,
        allowInsecureWebSockets: true,
      });
      const node = new VersusNode({
        identity: identities[index],
        transport,
        eligibilityVerifier: registry,
        economicVerifier,
      });
      nodes.push({ index, node, transport });
    }

    const connectStartedAt = Date.now();
    await inBatches(nodes, 12, async (entry) => {
      const listen = await entry.node.listen();
      sampleMemory();
      record("client_ready", { index: entry.index, peerCount: listen.peerCount, protocolCounts: listen.protocolCounts });
    });
    const connectDurationMs = Date.now() - connectStartedAt;

    const prepared = [];
    for (const entry of nodes) {
      const postcard = await entry.node.prepare({
        type: "observation",
        launchId: "1",
        body: `capacity signal ${String(entry.index + 1).padStart(4, "0")}`,
        lifetimeSeconds: 3600,
      });
      const batch = buildSignalBatch({
        postcards: [postcard],
        chainId: 31337,
        arena: ARENA,
        launchId: 1,
        agentId: entry.index + 1,
        author: entry.node.identity.address,
      });
      prepared.push({
        ...entry,
        postcard,
        paymentProof: {
          kind: "versus-signal-settlement",
          version: 1,
          batch,
          transactionHash: postcard.id,
          blockNumber: "1",
        },
      });
    }

    const publishTimes = new Map();
    const acceptedTimes = new Map();
    for (const entry of nodes) {
      entry.node.on("postcard", (postcard, meta) => {
        if (meta.source !== "peer") return;
        acceptedTimes.set(`${entry.index}:${postcard.id}`, Date.now());
      });
    }
    const publishStartedAt = Date.now();
    let publishErrors = 0;
    await inBatches(prepared, 8, async (entry) => {
      publishTimes.set(entry.postcard.id, Date.now());
      let lastError = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await entry.node.publishPaid(entry.postcard, entry.paymentProof);
          record("postcard_published", { index: entry.index, postcardId: entry.postcard.id, attempt });
          return;
        } catch (error) {
          lastError = error;
          await delay(150 * attempt);
        }
      }
      publishErrors += 1;
      record("postcard_publish_unacknowledged", { index: entry.index, postcardId: entry.postcard.id, message: lastError?.message || "unknown" });
    });
    const publishDurationMs = Date.now() - publishStartedAt;

    const convergenceStartedAt = Date.now();
    const convergenceDeadline = Date.now() + Math.max(60_000, count * 500);
    let counts = [];
    while (Date.now() < convergenceDeadline) {
      counts = nodes.map((entry) => entry.node.store.size);
      sampleMemory();
      if (counts.every((value) => value === count)) break;
      await delay(250);
    }
    counts = nodes.map((entry) => entry.node.store.size);
    const convergenceDurationMs = Date.now() - convergenceStartedAt;
    const actualAccepted = counts.reduce((sum, value) => sum + value, 0);
    const expectedAccepted = count * count;
    const latencies = [];
    for (const entry of prepared) {
      const publishedAt = publishTimes.get(entry.postcard.id);
      for (const receiver of nodes) {
        if (receiver.index === entry.index) continue;
        const acceptedAt = acceptedTimes.get(`${receiver.index}:${entry.postcard.id}`);
        if (acceptedAt) latencies.push(Math.max(0, acceptedAt - publishedAt));
      }
    }
    const cpu = process.cpuUsage(cpuStart);
    const deliveryRatio = expectedAccepted === 0 ? 1 : actualAccepted / expectedAccepted;
    const stagePassed = counts.every((value) => value === count) && publishErrors === 0;
    result = {
      version: 1,
      count,
      stagePassed,
      topicScope,
      connectDurationMs,
      publishDurationMs,
      convergenceDurationMs,
      expectedAccepted,
      actualAccepted,
      deliveryRatio,
      missingAccepted: expectedAccepted - actualAccepted,
      minRecords: Math.min(...counts),
      maxRecords: Math.max(...counts),
      publishErrors,
      latencyMs: {
        count: latencies.length,
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        max: latencies.length ? Math.max(...latencies) : null,
      },
      peakRssBytes: peakRss,
      cpuUserMicros: cpu.user,
      cpuSystemMicros: cpu.system,
      durationMs: Date.now() - startedAt,
    };
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
    record("stage_completed", result);
    if (!stagePassed) process.exitCode = 2;
  } catch (error) {
    result = { version: 1, count, stagePassed: false, failedAt: new Date().toISOString(), error: { message: error.message, stack: error.stack }, peakRssBytes: peakRss, durationMs: Date.now() - startedAt };
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
    record("stage_failed", result);
    process.exitCode = 1;
  } finally {
    clearInterval(memoryTimer);
    await Promise.allSettled(nodes.map((entry) => entry.node.close()));
    events.end();
  }
}

main();
