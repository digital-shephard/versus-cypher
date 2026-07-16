const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CypherIdentity,
  StaticCypherVerifier,
  VersusNode,
  WakuPostcardTransport,
  artifactReference,
  createVersusContentTopic,
  normalizeMissionManifest,
} = require("../src");

const CONTRACT = "0x1111111111111111111111111111111111111111";

function createFakeWaku({ history = [], storeError = null, send = null } = {}) {
  const sent = [];
  const fake = {
    sent,
    history,
    peers: [
      { id: "relay-one", protocols: ["/vac/waku/lightpush/3.0.0", "/vac/waku/filter-subscribe/2.0.0-beta1"] },
      { id: "relay-two", protocols: ["/vac/waku/store-query/3.0.0"] },
    ],
    storeQueries: [],
    callbacks: new Map(),
    unsubscribed: [],
    stopped: false,
    callback: null,
    async waitForPeers() {},
    async getConnectedPeers() {
      return fake.peers;
    },
    createEncoder({ contentTopic, ephemeral }) {
      return { contentTopic, ephemeral };
    },
    createDecoder({ contentTopic }) {
      return { contentTopic };
    },
    filter: {
      async subscribe(decoder, callback) {
        fake.callback = callback;
        fake.decoder = decoder;
        fake.callbacks.set(decoder.contentTopic, callback);
        return true;
      },
      async unsubscribe(decoder) {
        fake.unsubscribed.push(decoder.contentTopic);
        fake.callbacks.delete(decoder.contentTopic);
        return true;
      },
    },
    store: {
      async queryWithOrderedCallback(decoders, callback, options) {
        if (storeError) throw new Error(storeError);
        fake.storeQueries.push({ decoders, options });
        const contentTopic = decoders[0].contentTopic;
        for (const entry of fake.history) {
          if (entry.contentTopic && entry.contentTopic !== contentTopic) continue;
          if (await callback(entry.message || entry)) break;
        }
      },
    },
    lightPush: {
      async send(encoder, message, options = {}) {
        sent.push({ encoder, message, options });
        if (send) return send(encoder, message, options, sent.length);
        return { successes: ["relay-one"], failures: [] };
      },
    },
    async dial() {},
    async stop() {
      fake.stopped = true;
    },
  };
  return fake;
}

function waitFor(node, predicate, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      node.off("postcard", onPostcard);
      reject(new Error("timed out waiting for Waku postcard"));
    }, timeoutMs);
    const onPostcard = (postcard) => {
      if (!predicate(postcard)) return;
      clearTimeout(timer);
      node.off("postcard", onPostcard);
      resolve(postcard);
    };
    node.on("postcard", onPostcard);
  });
}

async function waitUntil(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for Waku state");
}

test("Versus Waku content topics are deployment and launch scoped", () => {
  assert.equal(
    createVersusContentTopic({ chainId: 8453, contractAddress: CONTRACT, launchId: 27 }),
    "/versus/1/postcards-8453-1111111111111111111111111111111111111111-27/json"
  );
  assert.throws(
    () => createVersusContentTopic({ chainId: 8453, contractAddress: "bad", launchId: 27 }),
    TypeError
  );
  assert.equal(
    createVersusContentTopic({ chainId: 8453, contractAddress: CONTRACT, launchId: 27, topicScope: "run-a1" }),
    "/versus/1/postcards-8453-1111111111111111111111111111111111111111-27-run-a1/json"
  );
});

test("Waku transport exposes reconnecting, caught-up, degraded Store, and offline states", async () => {
  const fakeWaku = createFakeWaku();
  const transport = new WakuPostcardTransport({
    chainId: 8453,
    contractAddress: CONTRACT,
    launchId: 27,
    sdkLoader: async () => ({ Protocols: { LightPush: "lightpush", Filter: "filter" } }),
    nodeFactory: async () => fakeWaku,
  });

  assert.equal(transport.status().state, "offline");
  const states = [];
  transport.on("state", (status) => states.push(status.state));
  await transport.start();
  await transport.storeCatchUp;
  assert.equal(transport.status().state, "caught_up");
  assert.deepEqual(states.slice(0, 2), ["reconnecting", "caught_up"]);

  fakeWaku.peers = [
    { id: "store-only", protocols: ["/vac/waku/store-query/3.0.0"] },
  ];
  await transport.refreshPeerDiagnostics();
  assert.equal(transport.status().state, "reconnecting");

  fakeWaku.peers = [
    { id: "live-no-store", protocols: ["/vac/waku/lightpush/3.0.0", "/vac/waku/filter-subscribe/2.0.0-beta1"] },
  ];
  await transport.refreshPeerDiagnostics();
  assert.equal(transport.status().state, "degraded_store");

  await transport.close();
  assert.equal(transport.status().state, "offline");
});

test("Waku Store failure preserves live transport as degraded", async () => {
  const fakeWaku = createFakeWaku({ storeError: "store peer unavailable" });
  const transport = new WakuPostcardTransport({
    chainId: 8453,
    contractAddress: CONTRACT,
    launchId: 27,
    sdkLoader: async () => ({ Protocols: { LightPush: "lightpush", Filter: "filter" } }),
    nodeFactory: async () => fakeWaku,
  });

  await transport.start();
  const sync = await transport.storeCatchUp;
  assert.equal(sync.error, "store peer unavailable");
  assert.equal(transport.status().state, "degraded_store");
  assert.equal(transport.status().error, "store peer unavailable");
  await transport.close();
});

test("Waku transport publishes and receives only through local Cypher policy", async (t) => {
  const registry = new StaticCypherVerifier();
  const localIdentity = CypherIdentity.createRandom(61);
  const remoteIdentity = CypherIdentity.createRandom(62);
  const unregisteredIdentity = CypherIdentity.createRandom(63);
  registry.register(localIdentity.address, 61);
  registry.register(remoteIdentity.address, 62);
  const fakeWaku = createFakeWaku();
  const transport = new WakuPostcardTransport({
    chainId: 8453,
    contractAddress: CONTRACT,
    launchId: 27,
    sdkLoader: async () => ({ Protocols: { LightPush: "lightpush", Filter: "filter" } }),
    nodeFactory: async () => fakeWaku,
  });
  const node = new VersusNode({
    identity: localIdentity,
    eligibilityVerifier: registry,
    transport,
  });
  t.after(async () => node.close());

  const status = await node.listen();
  assert.equal(status.transport, "waku");
  assert.equal(node.peerCount, 2);
  assert.equal(status.protocolCounts.lightPush, 1);
  assert.equal(status.protocolCounts.filter, 1);
  assert.equal(status.protocolCounts.store, 1);
  const local = await node.publish({
    type: "proposal",
    launchId: "27",
    body: "build a lighthouse mission over the public relay",
  });
  assert.equal(fakeWaku.sent.length, 1);
  assert.equal(JSON.parse(new TextDecoder().decode(fakeWaku.sent[0].message.payload)).id, local.id);

  const createdAt = Math.floor(Date.now() / 1000);
  const remote = await remoteIdentity.signPostcard({
    type: "endorsement",
    launchId: "27",
    sequence: 0,
    createdAt,
    expiresAt: createdAt + 3600,
    body: "endorse the public lighthouse mission",
    replyTo: local.id,
  });
  const received = waitFor(node, (postcard) => postcard.id === remote.id);
  await fakeWaku.callback({
    payload: new TextEncoder().encode(JSON.stringify(remote)),
    hashStr: "waku-hash",
  });
  assert.equal((await received).author, remoteIdentity.address);
  assert.equal(node.store.size, 2);
  assert.equal(fakeWaku.sent.length, 1, "received Waku messages are not republished");

  const unregistered = await unregisteredIdentity.signPostcard({
    type: "proposal",
    launchId: "27",
    sequence: 0,
    createdAt,
    expiresAt: createdAt + 3600,
    body: "a wallet signature alone cannot enter the cypher network",
  });
  const rejected = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for Waku rejection")), 1000);
    node.once("rejected", (error, postcard) => {
      clearTimeout(timer);
      resolve({ error, postcard });
    });
  });
  await fakeWaku.callback({
    payload: new TextEncoder().encode(JSON.stringify(unregistered)),
    hashStr: "unregistered-waku-hash",
  });
  const denial = await rejected;
  assert.equal(denial.error.code, "INELIGIBLE_CYPHER");
  assert.equal(denial.postcard.id, unregistered.id);
  assert.equal(node.store.has(unregistered.id), false);
  assert.equal(node.store.size, 2);
});

test("a locally accepted paid postcard can be rebroadcast with the same stable id", async (t) => {
  const registry = new StaticCypherVerifier();
  const identity = CypherIdentity.createRandom(67);
  registry.register(identity.address, 67);
  const fakeWaku = createFakeWaku();
  const transport = new WakuPostcardTransport({
    chainId: 8453,
    contractAddress: CONTRACT,
    launchId: 27,
    sdkLoader: async () => ({ Protocols: { LightPush: "lightpush", Filter: "filter" } }),
    nodeFactory: async () => fakeWaku,
  });
  const node = new VersusNode({ identity, eligibilityVerifier: registry, transport });
  t.after(async () => node.close());
  await node.listen();
  const postcard = await node.prepare({
    type: "observation",
    launchId: "27",
    body: "stable retries keep one postcard identity",
  });
  const proof = { kind: "test-proof" };
  await node.publishPaid(postcard, proof);
  await node.publishPaid(postcard, proof);

  assert.equal(node.store.size, 1);
  assert.equal(fakeWaku.sent.length, 2);
  const ids = fakeWaku.sent.map((entry) => {
    const value = JSON.parse(new TextDecoder().decode(entry.message.payload));
    return value.postcard?.id || value.id;
  });
  assert.deepEqual(ids, [postcard.id, postcard.id]);
});

test("Waku falls back to advertised LightPush v2 after every v3 peer rejects", async (t) => {
  const fakeWaku = createFakeWaku({
    send: (_encoder, _message, options) => options.useLegacy
      ? { successes: ["relay-one"], failures: [] }
      : { successes: [], failures: [{ error: "Remote peer rejected" }] },
  });
  fakeWaku.peers[0].protocols.push("/vac/waku/lightpush/2.0.0-beta1");
  const transport = new WakuPostcardTransport({
    chainId: 8453,
    contractAddress: CONTRACT,
    launchId: 27,
    sdkLoader: async () => ({ Protocols: { LightPush: "lightpush", Filter: "filter" } }),
    nodeFactory: async () => fakeWaku,
  });
  t.after(async () => transport.close());
  await transport.listen();
  const fallback = new Promise((resolve) => transport.once("protocolFallback", resolve));
  await transport.broadcast({ launchId: "27", id: `0x${"b".repeat(64)}` });

  assert.equal(fakeWaku.sent.length, 2);
  assert.equal(fakeWaku.sent[0].options.autoRetry, false);
  assert.equal(fakeWaku.sent[0].options.useLegacy, undefined);
  assert.equal(fakeWaku.sent[1].options.useLegacy, true);
  assert.deepEqual(await fallback, {
    from: "v3",
    to: "v2",
    v3FailureCount: 1,
    v2SuccessCount: 1,
    v2FailureCount: 0,
  });
});

test("Waku Store catch-up replays bounded history through Cypher verification", async (t) => {
  const registry = new StaticCypherVerifier();
  const localIdentity = CypherIdentity.createRandom(71);
  const remoteIdentity = CypherIdentity.createRandom(72);
  registry.register(localIdentity.address, 71);
  registry.register(remoteIdentity.address, 72);
  const createdAt = Math.floor(Date.now() / 1000);
  const historical = await remoteIdentity.signPostcard({
    type: "observation",
    launchId: "44",
    sequence: 0,
    createdAt,
    expiresAt: createdAt + 3600,
    body: "late cyphers should recover the active launch conversation",
  });
  const contentTopic = createVersusContentTopic({
    chainId: 8453,
    contractAddress: CONTRACT,
    launchId: 44,
  });
  const fakeWaku = createFakeWaku({
    history: [
      {
        contentTopic,
        message: {
          payload: new TextEncoder().encode(JSON.stringify(historical)),
          hashStr: "historical-waku-hash",
        },
      },
    ],
  });
  const transport = new WakuPostcardTransport({
    chainId: 8453,
    contractAddress: CONTRACT,
    launchId: 44,
    storeHistoryMs: 60_000,
    storeMessageLimit: 8,
    storePageSize: 4,
    sdkLoader: async () => ({ Protocols: { LightPush: "lightpush", Filter: "filter" } }),
    nodeFactory: async () => fakeWaku,
  });
  const node = new VersusNode({ identity: localIdentity, eligibilityVerifier: registry, transport });
  t.after(async () => node.close());

  const received = new Promise((resolve) => {
    node.on("postcard", (postcard, metadata) => {
      if (postcard.id === historical.id) resolve({ postcard, metadata });
    });
  });
  await node.listen();
  const syncResult = await transport.storeCatchUp;
  const replay = await received;

  assert.equal(syncResult.attempted, true);
  assert.equal(syncResult.received, 1);
  assert.equal(replay.metadata.source, "sync");
  assert.equal(node.store.has(historical.id), true);
  assert.equal(fakeWaku.storeQueries.length, 1);
  assert.equal(fakeWaku.storeQueries[0].options.paginationLimit, 4);
  assert.equal(fakeWaku.storeQueries[0].options.paginationForward, true);
});

test("Waku Store history windows use calibrated network time", async (t) => {
  const correctedNow = Date.UTC(2026, 6, 16, 15, 0, 0);
  const fakeWaku = createFakeWaku();
  const transport = new WakuPostcardTransport({
    chainId: 8453,
    contractAddress: CONTRACT,
    launchId: 44,
    storeHistoryMs: 90_000,
    now: () => correctedNow,
    sdkLoader: async () => ({ Protocols: { LightPush: "lightpush", Filter: "filter" } }),
    nodeFactory: async () => fakeWaku,
  });
  t.after(async () => transport.close());

  await transport.listen();
  await transport.storeCatchUp;

  assert.equal(fakeWaku.storeQueries.length, 1);
  assert.equal(fakeWaku.storeQueries[0].options.timeEnd.getTime(), correctedNow);
  assert.equal(fakeWaku.storeQueries[0].options.timeStart.getTime(), correctedNow - 90_000);
  await transport.broadcast({ launchId: "44", id: `0x${"c".repeat(64)}` });
  assert.equal(fakeWaku.sent[0].message.timestamp.getTime(), correctedNow);
});

test("Waku launch rollover replaces the topic and rejects stale launch traffic", async (t) => {
  const fakeWaku = createFakeWaku();
  const transport = new WakuPostcardTransport({
    chainId: 8453,
    contractAddress: CONTRACT,
    launchId: 27,
    sdkLoader: async () => ({ Protocols: { LightPush: "lightpush", Filter: "filter" } }),
    nodeFactory: async () => fakeWaku,
  });
  t.after(async () => transport.close());
  await transport.listen();
  await transport.storeCatchUp;
  const oldTopic = transport.contentTopic;
  const oldCallback = fakeWaku.callbacks.get(oldTopic);

  const changed = await transport.switchLaunch(28);
  await transport.storeCatchUp;
  const newTopic = transport.contentTopic;

  assert.equal(changed.changed, true);
  assert.equal(transport.launchId, "28");
  assert.notEqual(newTopic, oldTopic);
  assert.equal(fakeWaku.unsubscribed.includes(oldTopic), true);
  assert.equal(fakeWaku.callbacks.has(newTopic), true);
  assert.equal(fakeWaku.storeQueries.at(-1).decoders[0].contentTopic, newTopic);
  await assert.rejects(() => transport.broadcast({ launchId: "27" }), {
    code: "WRONG_LAUNCH_TOPIC",
  });

  let staleAccepted = false;
  transport.once("postcard", () => {
    staleAccepted = true;
  });
  oldCallback({
    payload: new TextEncoder().encode(JSON.stringify({ launchId: "27" })),
    hashStr: "stale-topic-hash",
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(staleAccepted, false);
});

test("Waku carries a postcard and its Base payment proof in one envelope", async (t) => {
  const fakeWaku = createFakeWaku();
  const transport = new WakuPostcardTransport({
    chainId: 8453,
    contractAddress: CONTRACT,
    launchId: 27,
    sdkLoader: async () => ({ Protocols: { LightPush: "lightpush", Filter: "filter" } }),
    nodeFactory: async () => fakeWaku,
  });
  t.after(async () => transport.close());
  await transport.listen();
  await transport.storeCatchUp;
  const postcard = { launchId: "27", id: `0x${"a".repeat(64)}` };
  const paymentProof = { kind: "versus-signal-settlement", version: 1, marker: "paid" };
  await transport.broadcast(postcard, { paymentProof });
  const encoded = JSON.parse(new TextDecoder().decode(fakeWaku.sent[0].message.payload));
  assert.equal(encoded.kind, "versus-paid-postcard");
  assert.deepEqual(encoded.postcard, postcard);
  assert.deepEqual(encoded.paymentProof, paymentProof);

  const received = new Promise((resolve) => {
    transport.once("postcard", (value, _metadata, proof) => resolve({ value, proof }));
  });
  await fakeWaku.callback({ payload: fakeWaku.sent[0].message.payload, hashStr: "paid-envelope" });
  assert.deepEqual(await received, { value: postcard, proof: paymentProof });
});

test("Waku publishes a mission postcard before its wanted content addressed manifest", async (t) => {
  const registry = new StaticCypherVerifier();
  const identity = CypherIdentity.createRandom(81);
  registry.register(identity.address, 81);
  const fakeWaku = createFakeWaku();
  const transport = new WakuPostcardTransport({
    chainId: 8453,
    contractAddress: CONTRACT,
    launchId: 55,
    sdkLoader: async () => ({ Protocols: { LightPush: "lightpush", Filter: "filter" } }),
    nodeFactory: async () => fakeWaku,
  });
  const node = new VersusNode({ identity, eligibilityVerifier: registry, transport });
  t.after(async () => node.close());
  await node.listen();
  const proposal = await node.publish({
    type: "proposal",
    launchId: "55",
    body: "build a daily garden signal for the launch",
  });
  const mission = await node.publishMission({
    launchId: "55",
    body: "publish one garden clue each day",
    replyTo: proposal.id,
    manifest: {
      title: "The Garden Signal",
      objective: "Create a small public ritual around the daily launch.",
      steps: ["Publish one clue each day."],
      successConditions: ["Ten humans solve one clue."],
      evidenceRequirements: ["Preserve the clue and answer hashes."],
      budgetMicros: "0",
    },
  });

  assert.equal(fakeWaku.sent.length, 3);
  const missionPayload = JSON.parse(new TextDecoder().decode(fakeWaku.sent[1].message.payload));
  const artifactPayload = JSON.parse(new TextDecoder().decode(fakeWaku.sent[2].message.payload));
  assert.equal(missionPayload.id, mission.id);
  assert.equal(artifactPayload.kind, "versus-artifact");
  assert.equal(artifactPayload.reference, mission.artifact);
  assert.equal(artifactPayload.value.author, identity.address);
  assert.equal(artifactPayload.value.launchId, "55");
});

test("ordered Waku Store replay retains only artifacts referenced by accepted postcards", async (t) => {
  const registry = new StaticCypherVerifier();
  const local = CypherIdentity.createRandom(91);
  const remote = CypherIdentity.createRandom(92);
  registry.register(local.address, 91);
  registry.register(remote.address, 92);
  const createdAt = Math.floor(Date.now() / 1000);
  const proposal = await remote.signPostcard({
    type: "proposal",
    launchId: "66",
    sequence: 0,
    createdAt,
    expiresAt: createdAt + 3600,
    body: "build a daily radio signal around the launch",
  });
  const manifest = normalizeMissionManifest({
    kind: "versus-mission",
    version: 1,
    launchId: "66",
    author: remote.address,
    title: "The Daily Signal",
    objective: "Give humans one shared riddle around the launch.",
    steps: ["Publish one riddle each day."],
    successConditions: ["Ten humans submit an answer."],
    evidenceRequirements: ["Preserve the riddle and answer hashes."],
    createdAt,
    expiresAt: createdAt + 3600,
    budgetMicros: "0",
  });
  const reference = artifactReference(manifest);
  const mission = await remote.signPostcard({
    type: "mission",
    launchId: "66",
    sequence: 1,
    createdAt: createdAt + 1,
    expiresAt: createdAt + 3601,
    body: "publish one radio riddle each day",
    replyTo: proposal.id,
    artifact: reference,
  });
  const contentTopic = createVersusContentTopic({
    chainId: 8453,
    contractAddress: CONTRACT,
    launchId: 66,
  });
  const encoded = (value) => ({
    contentTopic,
    message: { payload: new TextEncoder().encode(JSON.stringify(value)) },
  });
  const fakeWaku = createFakeWaku({
    history: [
      encoded(proposal),
      encoded(mission),
      encoded({
        kind: "versus-artifact",
        version: 1,
        launchId: "66",
        reference,
        value: manifest,
      }),
      encoded({
        kind: "versus-artifact",
        version: 1,
        launchId: "66",
        reference: `versus:sha256:${"0".repeat(64)}`,
        value: { junk: true },
      }),
    ],
  });
  const transport = new WakuPostcardTransport({
    chainId: 8453,
    contractAddress: CONTRACT,
    launchId: 66,
    sdkLoader: async () => ({ Protocols: { LightPush: "lightpush", Filter: "filter" } }),
    nodeFactory: async () => fakeWaku,
  });
  const node = new VersusNode({ identity: local, eligibilityVerifier: registry, transport });
  t.after(async () => node.close());

  await node.listen();
  await transport.storeCatchUp;
  await waitUntil(() => node.artifactStore.has(reference));
  assert.equal(node.store.has(proposal.id), true);
  assert.equal(node.store.has(mission.id), true);
  assert.equal(node.artifactStore.get(reference).title, "The Daily Signal");
  assert.equal(node.artifactStore.size, 1, "unreferenced Waku artifacts are ignored");
});
