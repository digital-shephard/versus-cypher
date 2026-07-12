import assert from "node:assert/strict";
import test from "node:test";
import { createVersusClient } from "../src/index.js";

const addresses = {
  usdc: "0x0000000000000000000000000000000000000001",
  arena: "0x0000000000000000000000000000000000000002",
  agents: "0x0000000000000000000000000000000000000003",
  treasury: "0x0000000000000000000000000000000000000004",
  syndicate: "0x0000000000000000000000000000000000000005",
  missionEscrow: "0x0000000000000000000000000000000000000006",
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
