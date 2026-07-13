const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const { WakuPostcardTransport } = require("@versus/network");
const { DEFAULT_WAKU_BOOTSTRAP_PEERS } = require("../src/network");

const MANIFEST_PATH = path.resolve(__dirname, "../../../versus/deployments/base.json");
const TIMEOUT_MS = 45_000;

function summarizeBatch(batch, metadata) {
  return {
    batchId: batch.batchId,
    attestor: batch.attestor,
    fromBlock: batch.fromBlock,
    toBlock: batch.toBlock,
    eventCount: batch.events.length,
    pennies: batch.events.reduce((sum, event) => sum + event.pennies, 0),
    history: Boolean(metadata?.history),
  };
}

app.whenReady().then(async () => {
  let transport;
  let timeout;
  try {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    const received = [];
    let resolveLiveBatch;
    const liveBatch = new Promise((resolve) => {
      resolveLiveBatch = resolve;
    });
    transport = new WakuPostcardTransport({
      chainId: manifest.chainId,
      contractAddress: manifest.contracts.agents,
      arenaAddress: manifest.contracts.arena,
      trustedRainAttestors: manifest.rainAttestors,
      launchId: "1",
      bootstrapPeers: DEFAULT_WAKU_BOOTSTRAP_PEERS,
      defaultBootstrap: false,
      enableStore: true,
      storeHistoryMs: 24 * 60 * 60 * 1000,
      minimumPeerCount: 1,
      peerTimeoutMs: 20_000,
    });

    transport.on("rainBatch", (batch, metadata) => {
      const summary = summarizeBatch(batch, metadata);
      received.push(summary);
      if (!summary.history) resolveLiveBatch(summary);
      console.log(`verified rain ${JSON.stringify(summary)}`);
    });
    transport.on("rainRejected", (error) => {
      console.error(`rejected rain: ${error.message}`);
    });

    const failAfter = (label) => new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label} timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
    });
    await Promise.race([transport.start(), failAfter("Public Waku connection")]);
    clearTimeout(timeout);
    timeout = null;
    const history = await Promise.race([transport.rainStoreCatchUp, failAfter("Public rain Store replay")]);
    clearTimeout(timeout);
    timeout = null;
    console.log(`rain history ${JSON.stringify(history)}`);
    console.log(`waku status ${JSON.stringify(transport.status())}`);
    if (history?.error) throw new Error(`Rain Store replay failed: ${history.error}`);
    if (received.length === 0) throw new Error("Public Waku Store returned no verified rain batches");

    if (process.argv.includes("--live")) {
      console.log("waiting for live verified rain");
      const live = await Promise.race([liveBatch, failAfter("Live public rain")]);
      clearTimeout(timeout);
      timeout = null;
      console.log(`live public rain passed ${JSON.stringify(live)}`);
    }

    console.log(`public rain smoke passed with ${received.length} verified batch(es)`);
    await transport.close();
    app.exit(0);
  } catch (error) {
    if (timeout) clearTimeout(timeout);
    console.error(error);
    await transport?.close().catch(() => {});
    app.exit(1);
  }
});
