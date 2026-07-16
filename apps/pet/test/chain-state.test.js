const assert = require("node:assert/strict");
const test = require("node:test");
const { Interface, Wallet } = require("ethers");
const { classStateMessage } = require("../src/base-rpc");
const { createChainRainService } = require("../src/chain");

const addresses = {
  arena: "0x1000000000000000000000000000000000000001",
  agents: "0x2000000000000000000000000000000000000002",
  treasury: "0x3000000000000000000000000000000000000003",
  syndicate: "0x4000000000000000000000000000000000000004",
  referralPool: "0x5000000000000000000000000000000000000005",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};
const owner = "0x6000000000000000000000000000000000000006";
const MULTICALL = new Interface([
  "function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns (tuple(bool success,bytes returnData)[] returnData)",
  "function getEthBalance(address account) view returns (uint256 balance)",
]);
const AGENT = new Interface([
  "function getAgent(uint256 agentId) view returns (uint8 cypherId,uint32 level,uint32 streak,uint32 lastCommitDay,uint128 vault,address owner)",
]);
const ARENA = new Interface([
  "function runway(uint256 agentId) view returns (uint128)",
  "function nextCommitAt(uint256 agentId) view returns (uint64)",
  "function referralFundedDays(uint256 agentId,uint32 day) view returns (bool)",
]);
const TREASURY = new Interface([
  "function tickets(uint256 agentId) view returns (uint256)",
  "function totalTickets() view returns (uint256)",
  "function claimable(uint256 agentId) view returns (uint256)",
  "function tranchePot() view returns (uint256)",
]);
const SYNDICATE = new Interface([
  "function commitOf(uint256 classId,uint256 agentId) view returns (uint256)",
  "function isGenesisAgent(uint256 agentId) view returns (bool)",
]);
const REFERRAL = new Interface([
  "function rewardPerReferral() view returns (uint256)",
  "function availableRewards() view returns (uint256)",
  "function referredBy(uint256 referredAgentId) view returns (uint256)",
]);
const USDC = new Interface(["function balanceOf(address owner) view returns (uint256)"]);

test("Base owner reconciliation uses one RPC call after the signed public snapshot", async () => {
  const attestor = new Wallet(`0x${"5".repeat(64)}`);
  const now = Math.floor(Date.now() / 1000);
  const snapshot = {
    version: 1,
    chainId: "8453",
    arena: addresses.arena,
    syndicate: addresses.syndicate,
    classId: "3",
    totalCommittedMicros: "80000",
    participantCount: 2,
    openedDay: 20600,
    chainDay: 20601,
    graduated: false,
    graduationFloorMicros: "1000000000",
    blockNumber: "48600000",
    observedAt: now,
    validUntil: now + 180,
    staleUntil: now + 900,
    signer: attestor.address,
  };
  snapshot.signature = await attestor.signMessage(classStateMessage(snapshot));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => snapshot });
  let rpcCalls = 0;
  const provider = {
    async call(request) {
      rpcCalls += 1;
      assert.equal(request.blockTag, 48_600_000);
      const [calls] = MULTICALL.decodeFunctionData("aggregate3", request.data);
      assert.equal(calls.length, 15);
      const returnData = [
        MULTICALL.encodeFunctionResult("getEthBalance", [2_000_000_000_000_000n]),
        USDC.encodeFunctionResult("balanceOf", [0n]),
        AGENT.encodeFunctionResult("getAgent", [4, 2, 2, 20600, 12_000n, owner]),
        ARENA.encodeFunctionResult("runway", [6_900_000n]),
        ARENA.encodeFunctionResult("nextCommitAt", [1_784_300_000]),
        TREASURY.encodeFunctionResult("tickets", [2n]),
        TREASURY.encodeFunctionResult("totalTickets", [8n]),
        TREASURY.encodeFunctionResult("claimable", [100n]),
        TREASURY.encodeFunctionResult("tranchePot", [500n]),
        SYNDICATE.encodeFunctionResult("commitOf", [10_000n]),
        SYNDICATE.encodeFunctionResult("isGenesisAgent", [true]),
        REFERRAL.encodeFunctionResult("rewardPerReferral", [1_000_000n]),
        REFERRAL.encodeFunctionResult("availableRewards", [3n]),
        REFERRAL.encodeFunctionResult("referredBy", [0n]),
        ARENA.encodeFunctionResult("referralFundedDays", [false]),
      ].map((data) => ({ success: true, returnData: data }));
      return MULTICALL.encodeFunctionResult("aggregate3", [returnData]);
    },
  };
  try {
    const service = createChainRainService({
      deployment: { chainId: 8453, contracts: addresses, rainAttestors: [attestor.address] },
      env: { VERSUS_CLASS_STATE_ENDPOINTS: "https://relay.test/v1/class-state" },
    }, { provider });
    const state = await service.readState({ address: owner, agentId: 7 });
    assert.equal(rpcCalls, 1);
    assert.equal(state.classPotMicros, 80_000n);
    assert.equal(state.classAgents, 2);
    assert.equal(state.runway, 6_900_000n);
    assert.equal(state.owner, owner);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
