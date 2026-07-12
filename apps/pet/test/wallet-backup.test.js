const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { Wallet } = require("ethers");
const {
  createCypherArchive,
  createWalletBackup,
  openCypherArchive,
  openWalletBackup,
} = require("../src/wallet-backup");
const { brainEnvironment, normalizeSettings, publicSettings } = require("../src/settings");

describe("wallet backup", () => {
  it("round trips a wallet and bond without exposing plaintext", () => {
    const wallet = Wallet.createRandom();
    const source = { address: wallet.address, privateKey: wallet.privateKey, bond: { agentId: "7", cypherId: 3 } };
    const record = createWalletBackup(source, "correct horse battery staple");
    assert.equal(JSON.stringify(record).includes(wallet.privateKey), false);
    assert.deepEqual(openWalletBackup(record, "correct horse battery staple"), { version: 1, ...source });
    assert.throws(() => openWalletBackup(record, "wrong password"), /wrong or the file is damaged/);
  });
});

describe("full Cypher archive", () => {
  it("encrypts wallet identity together with private local memory", () => {
    const wallet = Wallet.createRandom();
    const source = {
      address: wallet.address,
      privateKey: wallet.privateKey,
      bond: { agentId: 9 },
      networkState: {
        localMemory: { format: "versus-local-memory", version: 1, postcards: [], peers: [], memories: [] },
        trust: { peers: {}, contributions: {} },
        thoughts: [],
      },
      operationJournal: {
        format: "versus-economic-operations",
        version: 1,
        records: [{ key: "rain:9", kind: "rain", status: "complete" }],
      },
    };
    const record = createCypherArchive(source, "archive password");
    assert.equal(record.format, "versus-cypher-archive");
    assert.equal(JSON.stringify(record).includes(wallet.privateKey), false);
    assert.deepEqual(openCypherArchive(record, "archive password"), { version: 1, ...source });
    assert.throws(() => openCypherArchive(record, "wrong password"), /wrong or the file is damaged/);
  });
});

describe("persisted settings", () => {
  it("normalizes cloud local and external HTTP brains into the bounded adapter", () => {
    const settings = normalizeSettings({
      launchAtLogin: true,
      brain: { kind: "external", endpoint: "http://127.0.0.1:7777/v1/chat/completions", model: "hermes", apiKey: "secret" },
    });
    const env = brainEnvironment(settings);
    assert.equal(env.VERSUS_AGENT_BRAIN, "http");
    assert.equal(env.VERSUS_AGENT_MODEL, "hermes");
    assert.equal(publicSettings(settings).brain.apiKey, "");
    assert.equal(publicSettings(settings).brain.hasApiKey, true);
  });
});
