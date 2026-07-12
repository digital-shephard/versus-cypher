const { Wallet, getBytes } = require("../../packages/network/node_modules/ethers");
const {
  WakuPostcardTransport,
  rainBatchDigest,
  unsignedRainBatch,
} = require("../../packages/network/src");

const REST = process.env.VERSUS_RAIN_WAKU_REST || "http://127.0.0.1:18645";
const WS_PORT = Number(process.env.VERSUS_RAIN_WAKU_WS_PORT || 18000);
const ARENA = "0x1000000000000000000000000000000000000001";
const AGENTS = "0x1111111111111111111111111111111111111111";

async function main() {
  const info = await fetch(`${REST}/debug/v1/info`).then((response) => response.json());
  const peerId = String(info.listenAddresses[0]).split("/p2p/")[1];
  const signer = Wallet.createRandom();
  const transport = new WakuPostcardTransport({
    chainId: 31337,
    contractAddress: AGENTS,
    launchId: 1,
    arenaAddress: ARENA,
    trustedRainAttestors: [signer.address],
    bootstrapPeers: [`/ip4/127.0.0.1/tcp/${WS_PORT}/ws/p2p/${peerId}`],
    defaultBootstrap: false,
    enableStore: true,
    allowInsecureWebSockets: true,
  });

  const received = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("verified rain did not cross Waku Filter")), 20_000);
    transport.once("rainBatch", (batch, metadata) => {
      clearTimeout(timeout);
      resolve({ batch, metadata });
    });
  });
  await transport.start();

  const transactionHash = `0x${"ab".repeat(32)}`;
  const event = {
    eventId: `31337:${ARENA.toLowerCase()}:${transactionHash}:0`,
    type: "rain",
    transactionHash,
    logIndex: 0,
    blockNumber: "42",
    agentId: "7",
    classId: "1",
    classTotalMicros: "50000",
    pennies: 5,
  };
  const unsigned = unsignedRainBatch({
    kind: "versus-verified-rain",
    version: 1,
    chainId: 31337,
    arena: ARENA,
    fromBlock: 42,
    toBlock: 42,
    issuedAt: Date.now(),
    distributionWindowMs: 5_000,
    events: [event],
  });
  const batchId = rainBatchDigest(unsigned);
  const envelope = {
    ...unsigned,
    batchId,
    attestor: signer.address,
    signature: await signer.signMessage(getBytes(batchId)),
  };
  const payload = Buffer.from(JSON.stringify(envelope)).toString("base64");
  const pubsubTopic = "/waku/2/rs/66/2";
  const response = await fetch(`${REST}/relay/v1/messages/${encodeURIComponent(pubsubTopic)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      payload,
      contentTopic: transport.rainContentTopic,
      timestamp: Math.floor(Date.now() / 1_000),
      ephemeral: false,
    }),
  });
  if (!response.ok) throw new Error(`nwaku REST publish failed with HTTP ${response.status}`);

  const result = await received;
  if (result.batch.events[0].pennies !== 5) throw new Error("verified rain penny count changed in transport");
  console.log(JSON.stringify({
    ok: true,
    peerId,
    contentTopic: transport.rainContentTopic,
    batchId: result.batch.batchId,
    pennies: result.batch.events[0].pennies,
  }, null, 2));
  await transport.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
