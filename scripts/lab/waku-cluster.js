#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const COMPOSE = path.join(__dirname, "waku-cluster.compose.yml");
const STATE_DIR = path.join(ROOT, "research", "waku-lab");
const STATE_PATH = path.join(STATE_DIR, "cluster.json");
const PROJECT = "versus-waku-lab";
const STORE_RETENTION_SECONDS = Number(process.env.VERSUS_WAKU_STORE_RETENTION_SECONDS || 3600);
const NODES = [
  { name: "node1", restPort: 18645, websocketPort: 18000, metricsPort: 18008 },
  { name: "node2", restPort: 18646, websocketPort: 18001, metricsPort: 18009 },
  { name: "node3", restPort: 18647, websocketPort: 18002, metricsPort: 18010 },
];

function runDocker(args, { env = process.env, quiet = false } = {}) {
  const result = spawnSync("docker", args, {
    cwd: ROOT,
    env,
    encoding: "utf8",
    windowsHide: true,
    stdio: quiet ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    const detail = quiet ? `${result.stdout || ""}${result.stderr || ""}`.trim() : "";
    throw new Error(`docker ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return quiet ? String(result.stdout || "").trim() : "";
}

function compose(args, options = {}) {
  return runDocker(["compose", "--project-name", PROJECT, "--file", COMPOSE, ...args], options);
}

function preflight() {
  const version = runDocker(["info", "--format", "{{.ServerVersion}}"], { quiet: true });
  if (!version) throw new Error("Docker Linux engine is unavailable");
  return version;
}

async function nodeInfo(node, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${node.restPort}/debug/v1/info`);
      if (response.ok) return response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${node.name} REST health timed out: ${lastError?.message || "unknown"}`);
}

async function nodePeers(node) {
  const response = await fetch(`http://127.0.0.1:${node.restPort}/admin/v1/peers`);
  if (!response.ok) throw new Error(`${node.name} admin peers returned HTTP ${response.status}`);
  const value = await response.json();
  return (Array.isArray(value) ? value : value ? [value] : []).map((peer) => ({
    multiaddr: String(peer.multiaddr || ""),
    connected: String(peer.connected || ""),
  }));
}

function connectedPeerIds(peers) {
  return peers
    .filter((peer) => peer.connected === "Connected")
    .map((peer) => peer.multiaddr.match(/\/p2p\/([^/]+)$/)?.[1])
    .filter(Boolean)
    .sort();
}

async function waitForClusterGraph(records, timeoutMs = 30_000) {
  const expected = new Map([
    ["node1", records.slice(1).map((node) => node.peerId).sort()],
    ["node2", [records[0].peerId]],
    ["node3", [records[0].peerId]],
  ]);
  const deadline = Date.now() + timeoutMs;
  let observed = {};
  while (Date.now() < deadline) {
    observed = {};
    let complete = true;
    for (const node of NODES) {
      try {
        observed[node.name] = connectedPeerIds(await nodePeers(node));
      } catch {
        observed[node.name] = [];
      }
      const wanted = expected.get(node.name);
      if (!wanted.every((peerId) => observed[node.name].includes(peerId))) complete = false;
    }
    if (complete) return observed;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Waku relay graph did not become healthy: ${JSON.stringify(observed)}`);
}

function peerIdFromInfo(info) {
  const candidates = [
    ...(info.listenAddresses || []),
    ...(info.listen_addresses || []),
  ];
  for (const address of candidates) {
    const match = String(address).match(/\/p2p\/([^/]+)$/);
    if (match) return match[1];
  }
  const peerId = info.peerId || info.peer_id;
  if (peerId) return String(peerId);
  throw new Error("nwaku info did not expose a peer ID");
}

function publicNodeRecord(node, info) {
  const peerId = peerIdFromInfo(info);
  return {
    ...node,
    peerId,
    websocketMultiaddr: `/ip4/127.0.0.1/tcp/${node.websocketPort}/ws/p2p/${peerId}`,
    restUrl: `http://127.0.0.1:${node.restPort}`,
    metricsUrl: `http://127.0.0.1:${node.metricsPort}/metrics`,
  };
}

function internalTcpMultiaddr(info) {
  const addresses = [
    ...(info.listenAddresses || []),
    ...(info.listen_addresses || []),
  ];
  const address = addresses.find((value) => /^\/ip4\/[^/]+\/tcp\/60000\/p2p\/[^/]+$/.test(String(value)));
  if (!address) throw new Error("nwaku info did not expose an internal TCP multiaddress");
  return String(address);
}

async function up() {
  const dockerVersion = preflight();
  if (!Number.isInteger(STORE_RETENTION_SECONDS) || STORE_RETENTION_SECONDS < 1 || STORE_RETENTION_SECONDS > 604800) {
    throw new Error("VERSUS_WAKU_STORE_RETENTION_SECONDS must be an integer from 1 to 604800");
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  compose(["up", "--detach", "node1"], { env: { ...process.env, VERSUS_WAKU_NODE1: "unused", VERSUS_WAKU_STORE_RETENTION_SECONDS: String(STORE_RETENTION_SECONDS) } });
  const node1Info = await nodeInfo(NODES[0]);
  const node1 = publicNodeRecord(NODES[0], node1Info);
  const staticNode = internalTcpMultiaddr(node1Info);
  compose(["up", "--detach", "node2", "node3"], {
    env: { ...process.env, VERSUS_WAKU_NODE1: staticNode, VERSUS_WAKU_STORE_RETENTION_SECONDS: String(STORE_RETENTION_SECONDS) },
  });
  const records = [node1];
  for (const node of NODES.slice(1)) records.push(publicNodeRecord(node, await nodeInfo(node)));
  const connectedPeers = await waitForClusterGraph(records);
  const state = {
    version: 1,
    image: "wakuorg/nwaku:v0.38.1",
    dockerVersion,
    startedAt: new Date().toISOString(),
    clusterId: 66,
    numShardsInCluster: 8,
    shard: 0,
    storeRetention: { seconds: STORE_RETENTION_SECONDS, capacity: 10000, size: "100MB" },
    node1StaticMultiaddr: staticNode,
    nodes: records,
    bootstrapPeers: records.map((node) => node.websocketMultiaddr),
    connectedPeers,
  };
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(state, null, 2));
}

async function status() {
  preflight();
  const state = fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) : null;
  const nodes = [];
  for (const node of NODES) {
    try {
      const info = await nodeInfo(node, 3000);
      const peerId = peerIdFromInfo(info);
      const peers = connectedPeerIds(await nodePeers(node));
      const expected = state
        ? node.name === "node1"
          ? state.nodes.slice(1).map((entry) => entry.peerId)
          : [state.nodes[0].peerId]
        : [];
      const graphHealthy = expected.every((expectedPeer) => peers.includes(expectedPeer));
      nodes.push({ name: node.name, healthy: peerId === state?.nodes?.find((entry) => entry.name === node.name)?.peerId && graphHealthy, peerId, connectedPeers: peers, graphHealthy });
    } catch (error) {
      nodes.push({ name: node.name, healthy: false, error: error.message });
    }
  }
  console.log(JSON.stringify({ statePath: STATE_PATH, configured: Boolean(state), nodes }, null, 2));
  if (nodes.some((node) => !node.healthy)) process.exitCode = 1;
}

function requireNode(name) {
  if (!NODES.some((node) => node.name === name)) throw new Error(`unknown Waku node ${name}`);
  return name;
}

async function main() {
  const [command = "status", nodeName] = process.argv.slice(2);
  if (command === "up") return up();
  if (command === "status") return status();
  if (command === "down") {
    preflight();
    compose(["down"]);
    return;
  }
  if (["stop", "start", "restart", "kill"].includes(command)) {
    preflight();
    compose([command, requireNode(nodeName)]);
    return status();
  }
  throw new Error("usage: waku-cluster.js up|status|down|stop NODE|start NODE|restart NODE|kill NODE");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
