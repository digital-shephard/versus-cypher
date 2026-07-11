const { WakuPostcardTransport } = require("../src");

async function main() {
  if (process.env.VERSUS_WAKU_LIVE !== "1") {
    console.log("set VERSUS_WAKU_LIVE=1 to run the public Waku connectivity smoke test");
    return;
  }
  const transport = new WakuPostcardTransport({
    chainId: process.env.VERSUS_WAKU_CHAIN_ID || "8453",
    contractAddress:
      process.env.VERSUS_WAKU_AGENT_NFT || "0x1111111111111111111111111111111111111111",
    launchId: process.env.VERSUS_WAKU_LAUNCH_ID || "0",
    peerTimeoutMs: Number(process.env.VERSUS_WAKU_TIMEOUT_MS || 30_000),
  });
  try {
    const status = await transport.listen();
    console.log(`waku connected peers ${status.peerCount}`);
    console.log(`content topic ${status.contentTopic}`);
    const history = await transport.storeCatchUp;
    console.log(
      history.error
        ? `waku store unavailable ${history.error.message}`
        : `waku store catchup ${history.attempted ? "attempted" : "skipped"} messages ${history.received}`
    );
  } finally {
    await transport.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
