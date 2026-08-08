const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  assertPublicRelayRedundancy,
  forcePublicRelayReconnect,
  identityDirectory,
} = require("../scripts/run-fx-public-testnet-acceptance");

function fakeTransport() {
  let connected = true;
  const status = () => ({
    state: connected ? "caught_up" : "offline",
    peerCount: connected ? 2 : 0,
    protocolCounts: connected
      ? { lightPush: 2, filter: 2, store: 2, relay: 2 }
      : { lightPush: 0, filter: 0, store: 0, relay: 0 },
    historySync: connected ? { attempted: true, completedAt: 1 } : null,
    reconnect: { active: connected, failures: 0, nextAttemptAt: null },
  });
  return {
    historyCatchUp: Promise.resolve(),
    status,
    async refreshPeerDiagnostics() {
      return status();
    },
    async close() {
      connected = false;
    },
    async ensureConnected({ force }) {
      assert.equal(force, true);
      connected = true;
      this.historyCatchUp = Promise.resolve();
      return { restarted: true, status: status() };
    },
  };
}

test("physical identity directory can live outside the repository", () => {
  const secureDirectory = path.join(path.parse(process.cwd()).root, "secure", "device-identities");
  const resolved = identityDirectory("/repo", {
    VERSUS_FX_TEST_IDENTITY_DIR: secureDirectory,
  });
  assert.equal(resolved, path.resolve(secureDirectory));
});

test("public relay evidence requires two LightPush and Filter peers", () => {
  assert.throws(
    () => assertPublicRelayRedundancy({
      dealer: {
        protocolCounts: { lightPush: 2, filter: 1, store: 2, relay: 2 },
      },
    }, "dealer"),
    /two Filter peers/
  );
});

test("physical reconnect closes every transport and restores redundant peers", async () => {
  const broker = fakeTransport();
  const requester = fakeTransport();
  const relayer = fakeTransport();
  const runtime = {
    broker: { session: { transport: broker } },
    requesterSession: { transport: requester },
    relayerSession: { transport: relayer },
    async warmRequester() {},
  };

  const evidence = await forcePublicRelayReconnect(runtime);
  for (const status of Object.values(evidence.disconnected)) {
    assert.equal(status.state, "offline");
    assert.equal(status.peerCount, 0);
  }
  for (const status of Object.values(evidence.after)) {
    assert.equal(status.protocolCounts.lightPush, 2);
    assert.equal(status.protocolCounts.filter, 2);
  }
});
