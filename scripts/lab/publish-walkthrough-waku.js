#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { Contract, JsonRpcProvider, NonceManager, Wallet } = require("../../apps/pet/node_modules/ethers");
const { createChainRainService } = require("../../apps/pet/src/chain");
const { createPetNetworkService } = require("../../apps/pet/src/network");

const ROOT = path.resolve(__dirname, "..", "..");
const LAB_ROOT = path.join(ROOT, "research", "pet-walkthrough-harness");
const CURRENT_PATH = path.join(LAB_ROOT, "current.json");
const DEV_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const USDC_ABI = ["function mint(address to,uint256 amount)"];
const SYNDICATE_ABI = ["function currentClassId() view returns (uint256)"];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (!fs.existsSync(CURRENT_PATH)) throw new Error("No pet walkthrough harness is active");
  const state = JSON.parse(fs.readFileSync(CURRENT_PATH, "utf8"));
  if (state.status !== "ready") throw new Error(`Walkthrough harness is ${state.status}`);
  const runDir = path.join(LAB_ROOT, state.runId);
  const eventsPath = path.join(runDir, "events.jsonl");
  const recordEvent = (type, detail = {}) => {
    fs.appendFileSync(eventsPath, `${JSON.stringify({ at: Date.now(), type, detail })}\n`);
  };
  const deployment = JSON.parse(fs.readFileSync(state.deploymentPath, "utf8"));
  const provider = new JsonRpcProvider(state.rpcUrl, state.chainId, { staticNetwork: true, cacheTimeout: -1 });
  const latestBlock = await provider.getBlock("latest");
  const chainVoiceDay = Math.floor(Number(latestBlock.timestamp) / 86_400);
  const hostVoiceDay = Math.floor(Date.now() / 1000 / 86_400);
  if (chainVoiceDay !== hostVoiceDay) {
    throw new Error(
      `walkthrough chain day ${chainVoiceDay} does not match host day ${hostVoiceDay}; ` +
      "start a fresh harness before the time-accelerated tranche-claim fixture"
    );
  }
  recordEvent("waku_ui_clock_verified", {
    blockNumber: latestBlock.number,
    blockTimestamp: Number(latestBlock.timestamp),
    voiceDay: chainVoiceDay,
  });
  const deployerWallet = new Wallet(DEV_PRIVATE_KEY, provider);
  const deployer = new NonceManager(deployerWallet);
  const peerWallet = Wallet.createRandom().connect(provider);
  const usdc = new Contract(deployment.contracts.usdc, USDC_ABI, deployer);
  const gasFunding = await (await deployer.sendTransaction({
    to: peerWallet.address,
    value: 100_000_000_000_000_000n,
  })).wait();
  recordEvent("waku_ui_peer_gas_funded", {
    address: peerWallet.address,
    amountWei: "100000000000000000",
    transactionHash: gasFunding.hash,
    blockNumber: gasFunding.blockNumber,
    gasUsed: gasFunding.gasUsed.toString(),
  });
  const runwayFunding = await (await usdc.mint(peerWallet.address, 7_000_000n)).wait();
  recordEvent("waku_ui_peer_runway_funded", {
    address: peerWallet.address,
    amountMicros: "7000000",
    transactionHash: runwayFunding.hash,
    blockNumber: runwayFunding.blockNumber,
    gasUsed: runwayFunding.gasUsed.toString(),
  });

  const chain = createChainRainService({
    rpcUrl: state.rpcUrl,
    deployment,
    env: { VERSUS_RPC_URL: state.rpcUrl },
  });
  const hatch = await chain.hatchWithRunway({
    privateKey: peerWallet.privateKey,
    cypherId: 6,
    runwayAmount: 7_000_000n,
  });
  recordEvent("waku_ui_peer_hatched", {
    address: peerWallet.address,
    agentId: Number(hatch.agentId),
    cypherId: 6,
    runwayMicros: hatch.runway.toString(),
    approvalHash: hatch.approvalHash,
    transactionHash: hatch.hatchHash,
    blockNumber: hatch.blockNumber,
    gasUsed: hatch.gasUsed.toString(),
  });
  const dailyCommit = await chain.commitDaily({ privateKey: peerWallet.privateKey, agentId: hatch.agentId });
  recordEvent("waku_ui_peer_voice_earned", {
    agentId: Number(hatch.agentId),
    voiceDay: chainVoiceDay,
    transactionHash: dailyCommit.hash,
    blockNumber: dailyCommit.blockNumber,
    gasUsed: dailyCommit.gasUsed.toString(),
  });
  const syndicate = new Contract(deployment.contracts.syndicate, SYNDICATE_ABI, provider);
  const launchId = (await syndicate.currentClassId()).toString();
  const dataDir = path.join(LAB_ROOT, state.runId, "waku-ui-peer");
  const service = await createPetNetworkService({
    privateKey: peerWallet.privateKey,
    agentId: Number(hatch.agentId),
    dataDir,
    env: {
      VERSUS_RPC_URL: state.rpcUrl,
      VERSUS_DEPLOYMENT: state.deploymentPath,
      VERSUS_P2P_TRANSPORT: "waku",
      VERSUS_WAKU_LAUNCH_ID: launchId,
      VERSUS_AGENT_AUTOSTART: "0",
      VERSUS_WAKU_TIMEOUT_MS: "30000",
    },
  });

  try {
    await service.start();
    const postcard = await service.prepare({
      type: "observation",
      launchId,
      body: "a second cypher sees the shared tide rising",
    });
    recordEvent("waku_ui_postcard_prepared", {
      id: postcard.id,
      author: postcard.author,
      agentId: Number(hatch.agentId),
      type: postcard.type,
      launchId,
      voiceDay: postcard.voiceDay,
      createdAt: postcard.createdAt,
    });
    let record = service.prepareSignalPostcards([postcard], launchId);
    const receipt = await chain.settleSignalBatchFromRunway({
      privateKey: peerWallet.privateKey,
      agentId: hatch.agentId,
      batch: record.batch,
      onSubmitted: async (hash) => service.markSignalBatchSubmitted(record.batch.root, hash),
    });
    record = service.confirmSignalBatch(record.batch.root, {
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
    });
    recordEvent("waku_ui_signal_settled", {
      postcardId: postcard.id,
      batchRoot: record.batch.root,
      amountMicros: record.batch.amountMicros,
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed?.toString?.() || null,
    });
    const published = await service.publishPaidBatch(record);
    recordEvent("waku_ui_postcard_published", {
      postcardId: postcard.id,
      publishedCount: published.length,
      peerCount: service.status().peerCount,
    });
    await delay(12_000);
    const result = {
      version: 1,
      runId: state.runId,
      passed: published.length === 1,
      launchId,
      peer: { address: peerWallet.address, agentId: Number(hatch.agentId), cypherId: 6 },
      postcard: { id: postcard.id, type: postcard.type, body: postcard.body },
      settlement: { transactionHash: receipt.hash, blockNumber: receipt.blockNumber },
      chainClock: {
        blockNumber: latestBlock.number,
        blockTimestamp: Number(latestBlock.timestamp),
        voiceDay: chainVoiceDay,
      },
      waku: service.status(),
      secretsRecorded: false,
    };
    fs.writeFileSync(path.join(runDir, "waku-ui-publish.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) throw new Error("Waku postcard did not publish");
  } finally {
    await service.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
