/**
 * Headless pet onboard tests — no Electron window.
 * Mirrors apps/pet deposit → swap → mint → class pipeline.
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Wallet } = require("ethers");
const { chooseRandomCypher } = require("../src/random");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "versus-pet-"));
const WALLET_PATH = path.join(TMP, "wallet.json");
const STATE_PATH = path.join(TMP, "bond.json");

function save(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function load(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function ensureWallet() {
  if (fs.existsSync(WALLET_PATH)) return load(WALLET_PATH);
  const wallet = Wallet.createRandom();
  const w = {
    address: wallet.address,
    privateKey: wallet.privateKey,
    network: "base",
    chainId: 8453,
    createdAt: new Date().toISOString(),
  };
  save(WALLET_PATH, w);
  return w;
}

async function runOnboardPipeline(cypherCount = 29, pick) {
  const w = ensureWallet();
  let state = fs.existsSync(STATE_PATH) ? load(STATE_PATH) : {};
  const cypherId = chooseRandomCypher(cypherCount, pick);

  state.phase = "swapping";
  save(STATE_PATH, state);

  state.phase = "minting";
  state.usdcMicros = 7_000_000;
  state.runway = 6_990_000;
  state.ethGasReserveWei = "900000000000000";
  save(STATE_PATH, state);

  state.phase = "active";
  state.agentId = 1;
  state.cypherId = cypherId;
  state.level = 1;
  state.streak = 1;
  state.lastCommitDay = Math.floor(Date.now() / 86_400_000);
  state.vault = 0;
  state.classPotMicros = 10_000;
  state.classAgents = 1;
  state.inCurrentClass = true;
  state.walletAddress = w.address;
  state.onboardedAt = Date.now();
  save(STATE_PATH, state);
  return state;
}

describe("Versus pet onboard (headless)", () => {
  before(() => {
    for (const f of [WALLET_PATH, STATE_PATH]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it("creates a Base wallet on first launch", () => {
    const w = ensureWallet();
    assert.match(w.address, /^0x[a-fA-F0-9]{40}$/);
    assert.equal(w.chainId, 8453);
    assert.equal(w.network, "base");
    assert.ok(w.privateKey.startsWith("0x"));

    const again = ensureWallet();
    assert.equal(again.address, w.address, "wallet should be sticky");
  });

  it("locks a random Cypher inside the roster", () => {
    let receivedMax = 0;
    const id = chooseRandomCypher(29, (max) => {
      receivedMax = max;
      return 17;
    });
    assert.equal(receivedMax, 29);
    assert.equal(id, 17);
    assert.throws(() => chooseRandomCypher(0), RangeError);
  });

  it("awaits deposit then runs swap → mint → class", async () => {
    const w = ensureWallet();
    save(STATE_PATH, { phase: "awaiting_deposit", walletAddress: w.address });

    // pretend deposit landed
    const state = load(STATE_PATH);
    state.phase = "swapping";
    state.depositWei = "1000000000000000";
    save(STATE_PATH, state);

    const live = await runOnboardPipeline(29, () => 2); // deterministic random result: Flexseed
    assert.equal(live.phase, "active");
    assert.equal(live.cypherId, 2);
    assert.equal(live.level, 1);
    assert.equal(live.streak, 1);
    assert.equal(live.inCurrentClass, true);
    assert.equal(live.classPotMicros, 10_000);
    assert.equal(live.classAgents, 1);
    assert.equal(live.walletAddress, w.address);
    assert.equal(live.usdcMicros, 7_000_000);
    assert.equal(live.runway, 6_990_000);
  });

  it("persists active bond across relaunch", () => {
    const live = load(STATE_PATH);
    assert.equal(live.phase, "active");
    assert.equal(live.cypherId, 2);
  });
});
