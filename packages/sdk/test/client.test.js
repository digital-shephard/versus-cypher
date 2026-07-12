import assert from "node:assert/strict";
import test from "node:test";
import { createVersusClient, parseReferralCode, referralCodeFor } from "../src/index.js";

const addresses = {
  usdc: "0x0000000000000000000000000000000000000001",
  arena: "0x0000000000000000000000000000000000000002",
  agents: "0x0000000000000000000000000000000000000003",
  treasury: "0x0000000000000000000000000000000000000004",
  syndicate: "0x0000000000000000000000000000000000000005",
  missionEscrow: "0x0000000000000000000000000000000000000006",
  referralPool: "0x0000000000000000000000000000000000000008",
};

function clients() {
  const writes = [];
  const publicClient = {
    async readContract({ functionName }) {
      if (functionName === "allowance") return 2n ** 256n - 1n;
      if (functionName === "escrows") {
        return [
          `0x${"1".repeat(64)}`,
          7n,
          11n,
          12n,
          5_000_000n,
          2_000_000_000n,
          0,
          "0x0000000000000000000000000000000000000007",
        ];
      }
      throw new Error(`unexpected read ${functionName}`);
    },
    async waitForTransactionReceipt({ hash }) {
      return { hash, status: "success" };
    },
  };
  const walletClient = {
    account: { address: "0x0000000000000000000000000000000000000007" },
    async writeContract(input) {
      writes.push(input);
      return `0x${String(writes.length).padStart(64, "0")}`;
    },
  };
  return { publicClient, walletClient, writes };
}

test("sdk submits durable signal batches to the Arena", async () => {
  const { publicClient, walletClient, writes } = clients();
  const client = createVersusClient({ publicClient, walletClient, addresses });
  await client.settleSignalBatchFromRunway(11, {
    launchId: "7",
    root: `0x${"2".repeat(64)}`,
    signalCount: 3,
    inkPennies: 7,
    typeCounts: [1, 0, 2, 0, 0, 0, 0, 0],
  });
  assert.equal(writes[0].functionName, "settleSignalBatchFromRunway");
  assert.deepEqual(writes[0].args, [11n, 7n, `0x${"2".repeat(64)}`, [1, 0, 2, 0, 0, 0, 0, 0]]);
});

test("sdk hatch submits runway and an optional referrer but cannot select a species", async () => {
  const { publicClient, walletClient, writes } = clients();
  const client = createVersusClient({ publicClient, walletClient, addresses });
  await client.hatch(7_000_000n, 42n);
  assert.equal(writes[0].functionName, "hatch");
  assert.deepEqual(writes[0].args, [7_000_000n, 42n]);
});

test("sdk referral codes detect typos and expose bounded funding methods", async () => {
  const { publicClient, walletClient, writes } = clients();
  const originalRead = publicClient.readContract;
  publicClient.readContract = async (input) => {
    if (input.functionName === "rewardPerReferral") return 1_000_000n;
    if (input.functionName === "availableRewards") return 12n;
    if (input.functionName === "referredBy") return 7n;
    return originalRead(input);
  };
  const client = createVersusClient({ publicClient, walletClient, addresses });
  const code = referralCodeFor(42n);
  assert.equal(parseReferralCode(code), 42n);
  assert.throws(() => parseReferralCode(`${code.slice(0, -1)}Z`), /checksum/);

  const proposalId = `0x${"3".repeat(64)}`;
  await client.fundReferralPoolFromRunway(11, proposalId);
  await client.fundReferralPool({ sponsorAgentId: 11, proposalId, amount: 5_000_000n });
  const state = await client.getReferralPool(12);
  assert.equal(writes[0].functionName, "fundReferralPoolFromRunway");
  assert.equal(writes[1].functionName, "fund");
  assert.deepEqual(state, { rewardPerReferral: 1_000_000n, availableRewards: 12n, referredBy: 7n });
});

test("sdk exposes each Cypher's on-chain rolling commit time", async () => {
  const { walletClient } = clients();
  const publicClient = {
    async readContract({ functionName }) {
      if (functionName === "getAgent") {
        return [3n, 7n, 4n, 22_222n, 0n, walletClient.account.address];
      }
      if (functionName === "runway") return 6_990_000n;
      if (functionName === "nextCommitAt") return 2_000_086_400n;
      throw new Error(`unexpected read ${functionName}`);
    },
  };
  const client = createVersusClient({ publicClient, walletClient, addresses });
  const agent = await client.getAgent(11);
  assert.equal(agent.nextCommitAt, 2_000_086_400n);
  assert.equal(agent.runway, 6_990_000n);
});

test("sdk sponsors releases refunds and reads ownerless mission escrows", async () => {
  const { publicClient, walletClient, writes } = clients();
  const client = createVersusClient({ publicClient, walletClient, addresses });
  await client.sponsorMission({
    missionId: `0x${"1".repeat(64)}`,
    launchId: 7,
    sponsorAgentId: 11,
    recipientAgentId: 12,
    amount: 5_000_000,
    deadline: 2_000_000_000,
  });
  await client.releaseMission(1);
  await client.refundMission(2);
  const escrow = await client.getMissionEscrow(1);

  assert.equal(writes[0].functionName, "sponsorMission");
  assert.equal(writes[1].functionName, "release");
  assert.equal(writes[2].functionName, "refund");
  assert.equal(escrow.missionId, `0x${"1".repeat(64)}`);
  assert.equal(escrow.amount, 5_000_000n);
});
