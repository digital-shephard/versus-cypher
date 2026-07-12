/** Minimal ABIs for Versus hot path */

export const arenaAbi = [
  {
    type: "function",
    name: "hatch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "runwayAmount", type: "uint256" },
    ],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    type: "function",
    name: "hatch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "runwayAmount", type: "uint256" },
      { name: "referrerAgentId", type: "uint256" },
    ],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    type: "function",
    name: "commit",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "replenishRunway",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "rainFromRunway",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "pennies", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "settleSignalBatchFromRunway",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "classId", type: "uint256" },
      { name: "batchRoot", type: "bytes32" },
      { name: "typeCounts", type: "uint16[8]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "fundReferralPoolFromRunway",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "proposalId", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "runway",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "uint128" }],
  },
  {
    type: "function",
    name: "nextCommitAt",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    type: "function",
    name: "currentDay",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint32" }],
  },
  {
    type: "function",
    name: "PENNY",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
];

export const agentNftAbi = [
  {
    type: "function",
    name: "getAgent",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [
      { name: "cypherId", type: "uint8" },
      { name: "level", type: "uint32" },
      { name: "streak", type: "uint32" },
      { name: "lastCommitDay", type: "uint32" },
      { name: "vault", type: "uint128" },
      { name: "owner_", type: "address" },
    ],
  },
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
];

export const usdcAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
];

export const syndicateAbi = [
  {
    type: "function",
    name: "currentClassId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getClass",
    stateMutability: "view",
    inputs: [{ name: "classId", type: "uint256" }],
    outputs: [
      { name: "totalCommitted", type: "uint256" },
      { name: "participantCount", type: "uint32" },
      { name: "openedDay", type: "uint32" },
      { name: "graduated", type: "bool" },
    ],
  },
];

export const trancheTreasuryAbi = [
  {
    type: "function",
    name: "tickets",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalTickets",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "claimable",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "previewTranche",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [],
  },
];

export const missionEscrowAbi = [
  {
    type: "function",
    name: "sponsorMission",
    stateMutability: "nonpayable",
    inputs: [
      { name: "missionId", type: "bytes32" },
      { name: "launchId", type: "uint256" },
      { name: "sponsorAgentId", type: "uint256" },
      { name: "recipientAgentId", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "deadline", type: "uint64" },
    ],
    outputs: [{ name: "escrowId", type: "uint256" }],
  },
  {
    type: "function",
    name: "release",
    stateMutability: "nonpayable",
    inputs: [{ name: "escrowId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "refund",
    stateMutability: "nonpayable",
    inputs: [{ name: "escrowId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "escrows",
    stateMutability: "view",
    inputs: [{ name: "escrowId", type: "uint256" }],
    outputs: [
      { name: "missionId", type: "bytes32" },
      { name: "launchId", type: "uint256" },
      { name: "sponsorAgentId", type: "uint256" },
      { name: "recipientAgentId", type: "uint256" },
      { name: "amount", type: "uint128" },
      { name: "deadline", type: "uint64" },
      { name: "state", type: "uint8" },
      { name: "sponsor", type: "address" },
    ],
  },
];

export const referralPoolAbi = [
  {
    type: "function",
    name: "fund",
    stateMutability: "nonpayable",
    inputs: [
      { name: "sponsorAgentId", type: "uint256" },
      { name: "proposalId", type: "bytes32" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "rewardPerReferral",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "availableRewards",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "referredBy",
    stateMutability: "view",
    inputs: [{ name: "referredAgentId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
];

export const PENNY = 10_000n;
export const MIN_RUNWAY = 7_000_000n;

function referralChecksum(agentId) {
  return ((BigInt(agentId) * 97n + 23n) % 1296n).toString(36).padStart(2, "0").toUpperCase();
}

export function referralCodeFor(agentId) {
  const id = BigInt(agentId);
  if (id < 1n) throw new RangeError("referral agent id must be positive");
  return `VRS-${id}-${referralChecksum(id)}`;
}

export function parseReferralCode(value) {
  const match = /^VRS-([1-9][0-9]*)-([0-9A-Z]{2})$/.exec(String(value || "").trim().toUpperCase());
  if (!match) throw new TypeError("referral code is invalid");
  const agentId = BigInt(match[1]);
  if (match[2] !== referralChecksum(agentId)) throw new TypeError("referral code checksum is invalid");
  return agentId;
}

export const CYPHERS = [
  { id: 0, name: "CalFire", element: "fire" },
  { id: 1, name: "OhWail", element: "water" },
  { id: 2, name: "FlexSeed", element: "grass" },
];

/**
 * Create a thin Versus client around viem publicClient + walletClient.
 */
export function createVersusClient({ publicClient, walletClient, addresses }) {
  const account = walletClient.account;

  async function ensureAllowance(spender, amount) {
    const allowance = await publicClient.readContract({
      address: addresses.usdc,
      abi: usdcAbi,
      functionName: "allowance",
      args: [account.address, spender],
    });
    if (allowance >= amount) return;
    const hash = await walletClient.writeContract({
      address: addresses.usdc,
      abi: usdcAbi,
      functionName: "approve",
      args: [spender, 2n ** 256n - 1n],
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  return {
    async hatch(runwayAmount = MIN_RUNWAY, referrerAgentId = 0n) {
      runwayAmount = BigInt(runwayAmount);
      referrerAgentId = BigInt(referrerAgentId);
      if (runwayAmount < MIN_RUNWAY) throw new RangeError("hatch runway must be at least $7 USDC");
      if (referrerAgentId < 0n) throw new RangeError("referrer agent id cannot be negative");
      await ensureAllowance(addresses.arena, runwayAmount);
      const hash = await walletClient.writeContract({
        address: addresses.arena,
        abi: arenaAbi,
        functionName: "hatch",
        args: [runwayAmount, referrerAgentId],
      });
      return publicClient.waitForTransactionReceipt({ hash });
    },

    async commit(agentId) {
      const hash = await walletClient.writeContract({
        address: addresses.arena,
        abi: arenaAbi,
        functionName: "commit",
        args: [BigInt(agentId)],
      });
      return publicClient.waitForTransactionReceipt({ hash });
    },

    async replenishRunway(agentId, amount) {
      amount = BigInt(amount);
      if (amount < 1n) throw new RangeError("runway replenishment must be positive");
      await ensureAllowance(addresses.arena, amount);
      const hash = await walletClient.writeContract({
        address: addresses.arena,
        abi: arenaAbi,
        functionName: "replenishRunway",
        args: [BigInt(agentId), amount],
      });
      return publicClient.waitForTransactionReceipt({ hash });
    },

    async rainFromRunway(agentId, pennies) {
      const count = BigInt(pennies);
      if (count < 1n || count > 100n) throw new RangeError("rain batch must contain 1-100 pennies");
      const hash = await walletClient.writeContract({
        address: addresses.arena,
        abi: arenaAbi,
        functionName: "rainFromRunway",
        args: [BigInt(agentId), count],
      });
      return publicClient.waitForTransactionReceipt({ hash });
    },

    async settleSignalBatchFromRunway(agentId, batch) {
      const count = BigInt(batch.signalCount);
      if (count < 1n || count > 100n) throw new RangeError("signal batch must contain 1-100 postcards");
      if (!/^0x[0-9a-f]{64}$/.test(batch.root)) throw new TypeError("signal batch root is invalid");
      const hash = await walletClient.writeContract({
        address: addresses.arena,
        abi: arenaAbi,
        functionName: "settleSignalBatchFromRunway",
        args: [BigInt(agentId), BigInt(batch.launchId), batch.root, batch.typeCounts],
      });
      return publicClient.waitForTransactionReceipt({ hash });
    },

    async fundReferralPoolFromRunway(agentId, proposalId) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(proposalId)) throw new TypeError("proposal id is invalid");
      const hash = await walletClient.writeContract({
        address: addresses.arena,
        abi: arenaAbi,
        functionName: "fundReferralPoolFromRunway",
        args: [BigInt(agentId), proposalId],
      });
      return publicClient.waitForTransactionReceipt({ hash });
    },

    async fundReferralPool({ sponsorAgentId, proposalId = `0x${"0".repeat(64)}`, amount }) {
      if (!addresses.referralPool) throw new Error("referral pool address is not configured");
      amount = BigInt(amount);
      if (amount < 1n) throw new RangeError("referral pool funding must be positive");
      if (!/^0x[0-9a-fA-F]{64}$/.test(proposalId)) throw new TypeError("proposal id is invalid");
      await ensureAllowance(addresses.referralPool, amount);
      const hash = await walletClient.writeContract({
        address: addresses.referralPool,
        abi: referralPoolAbi,
        functionName: "fund",
        args: [BigInt(sponsorAgentId), proposalId, amount],
      });
      return publicClient.waitForTransactionReceipt({ hash });
    },

    async getReferralPool(referredAgentId = 0n) {
      if (!addresses.referralPool) throw new Error("referral pool address is not configured");
      const reads = [
        publicClient.readContract({
          address: addresses.referralPool,
          abi: referralPoolAbi,
          functionName: "rewardPerReferral",
        }),
        publicClient.readContract({
          address: addresses.referralPool,
          abi: referralPoolAbi,
          functionName: "availableRewards",
        }),
      ];
      if (BigInt(referredAgentId) > 0n) {
        reads.push(publicClient.readContract({
          address: addresses.referralPool,
          abi: referralPoolAbi,
          functionName: "referredBy",
          args: [BigInt(referredAgentId)],
        }));
      }
      const [rewardPerReferral, availableRewards, referredBy = 0n] = await Promise.all(reads);
      return { rewardPerReferral, availableRewards, referredBy };
    },

    async sponsorMission({ missionId, launchId, sponsorAgentId, recipientAgentId, amount, deadline }) {
      if (!addresses.missionEscrow) throw new Error("mission escrow address is not configured");
      amount = BigInt(amount);
      await ensureAllowance(addresses.missionEscrow, amount);
      const hash = await walletClient.writeContract({
        address: addresses.missionEscrow,
        abi: missionEscrowAbi,
        functionName: "sponsorMission",
        args: [
          missionId,
          BigInt(launchId),
          BigInt(sponsorAgentId),
          BigInt(recipientAgentId),
          amount,
          BigInt(deadline),
        ],
      });
      return publicClient.waitForTransactionReceipt({ hash });
    },

    async releaseMission(escrowId) {
      if (!addresses.missionEscrow) throw new Error("mission escrow address is not configured");
      const hash = await walletClient.writeContract({
        address: addresses.missionEscrow,
        abi: missionEscrowAbi,
        functionName: "release",
        args: [BigInt(escrowId)],
      });
      return publicClient.waitForTransactionReceipt({ hash });
    },

    async refundMission(escrowId) {
      if (!addresses.missionEscrow) throw new Error("mission escrow address is not configured");
      const hash = await walletClient.writeContract({
        address: addresses.missionEscrow,
        abi: missionEscrowAbi,
        functionName: "refund",
        args: [BigInt(escrowId)],
      });
      return publicClient.waitForTransactionReceipt({ hash });
    },

    async getMissionEscrow(escrowId) {
      if (!addresses.missionEscrow) throw new Error("mission escrow address is not configured");
      const [missionId, launchId, sponsorAgentId, recipientAgentId, amount, deadline, state, sponsor] =
        await publicClient.readContract({
          address: addresses.missionEscrow,
          abi: missionEscrowAbi,
          functionName: "escrows",
          args: [BigInt(escrowId)],
        });
      return { missionId, launchId, sponsorAgentId, recipientAgentId, amount, deadline, state, sponsor };
    },

    async withdraw(agentId, amount) {
      const hash = await walletClient.writeContract({
        address: addresses.agents,
        abi: agentNftAbi,
        functionName: "withdraw",
        args: [BigInt(agentId), BigInt(amount)],
      });
      return publicClient.waitForTransactionReceipt({ hash });
    },

    async getAgent(agentId) {
      const args = [BigInt(agentId)];
      const [agent, runway, nextCommitAt] = await Promise.all([
        publicClient.readContract({
          address: addresses.agents,
          abi: agentNftAbi,
          functionName: "getAgent",
          args,
        }),
        publicClient.readContract({
          address: addresses.arena,
          abi: arenaAbi,
          functionName: "runway",
          args,
        }),
        publicClient.readContract({
          address: addresses.arena,
          abi: arenaAbi,
          functionName: "nextCommitAt",
          args,
        }),
      ]);
      const [cypherId, level, streak, lastCommitDay, vault, owner] = agent;
      return { cypherId, level, streak, lastCommitDay, nextCommitAt, runway, rewardVault: vault, vault, owner };
    },

    async getVaultEconomy(agentId) {
      const args = [BigInt(agentId)];
      const [tickets, totalTickets, claimable] = await Promise.all([
        publicClient.readContract({
          address: addresses.treasury,
          abi: trancheTreasuryAbi,
          functionName: "tickets",
          args,
        }),
        publicClient.readContract({
          address: addresses.treasury,
          abi: trancheTreasuryAbi,
          functionName: "totalTickets",
        }),
        publicClient.readContract({
          address: addresses.treasury,
          abi: trancheTreasuryAbi,
          functionName: "claimable",
          args,
        }),
      ]);
      return { tickets, totalTickets, claimable, tranchePreview: claimable };
    },

    async claimTranche(agentId) {
      const hash = await walletClient.writeContract({
        address: addresses.treasury,
        abi: trancheTreasuryAbi,
        functionName: "claim",
        args: [BigInt(agentId)],
      });
      return publicClient.waitForTransactionReceipt({ hash });
    },

    async getTodayClass() {
      const day = await publicClient.readContract({
        address: addresses.arena,
        abi: arenaAbi,
        functionName: "currentDay",
      });
      const classId = await publicClient.readContract({
        address: addresses.syndicate,
        abi: syndicateAbi,
        functionName: "currentClassId",
      });
      const [totalCommitted, participantCount, openedDay, graduated] = await publicClient.readContract({
        address: addresses.syndicate,
        abi: syndicateAbi,
        functionName: "getClass",
        args: [classId],
      });
      return { day, classId, totalCommitted, participantCount, openedDay, graduated };
    },
  };
}
