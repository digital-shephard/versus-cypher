/**
 * Stateful invariant campaign for Versus custody rules.
 * Seeded PRNG so failures reproduce with VERSUS_INVARIANT_SEED.
 */
const { expect } = require("chai");

const PENNY = 10_000n;
const MIN_RUNWAY = 7_000_000n;

function mulberry32(seed) {
  let t = seed >>> 0;
  return function next() {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function parseSeed(value) {
  if (value == null || value === "") return (Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0;
  const asNum = Number(value);
  if (Number.isFinite(asNum)) return asNum >>> 0;
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

async function checkInvariants(ctx, label) {
  const { ethers, usdc, agents, arena, syndicate, treasury, ghost } = ctx;
  const arenaBal = await usdc.balanceOf(await arena.getAddress());
  const liability = await arena.totalRunwayLiability();
  expect(arenaBal, `${label}: arena solvent`).to.be.gte(liability);

  let runwaySum = 0n;
  let ticketSum = 0n;
  let claimableSum = 0n;
  let vaultSum = 0n;
  for (const agentId of ghost.agentIds) {
    const runway = await arena.runway(agentId);
    runwaySum += runway;
    const tickets = await treasury.tickets(agentId);
    ticketSum += tickets;
    expect(tickets, `${label}: tickets never decrease #${agentId}`).to.be.gte(ghost.tickets[agentId] || 0n);
    ghost.tickets[agentId] = tickets;
    claimableSum += await treasury.claimable(agentId);
    vaultSum += (await agents.getAgent(agentId)).vault;
  }
  expect(runwaySum, `${label}: runway sum == liability`).to.equal(liability);
  expect(ticketSum, `${label}: ticket sum == totalTickets`).to.equal(await treasury.totalTickets());

  const pot = await treasury.tranchePot();
  // Entitlements remain high precision until claim, so account-level floors cannot overstate custody.
  expect(claimableSum, `${label}: aggregate claimable <= pot`).to.be.lte(pot);
  expect(await usdc.balanceOf(await treasury.getAddress()), `${label}: treasury covers pot`).to.be.gte(pot);
  if (claimableSum > pot) {
    ghost.overClaimableEvents = (ghost.overClaimableEvents || 0) + 1;
    ghost.maxOverClaimableWei = ghost.maxOverClaimableWei > claimableSum - pot
      ? ghost.maxOverClaimableWei
      : claimableSum - pot;
  }

  // Executable claims must drain without reverting or overspending custody.
  if (claimableSum > 0n && (ghost.claimProbeCountdown = (ghost.claimProbeCountdown || 0) - 1) < 0) {
    ghost.claimProbeCountdown = 25;
    const snapshot = await ethers.provider.send("evm_snapshot", []);
    try {
      let paid = 0n;
      for (const agentId of ghost.agentIds) {
        const amount = await treasury.claimable(agentId);
        if (amount === 0n) continue;
        const potBefore = await treasury.tranchePot();
        const vaultBefore = (await agents.getAgent(agentId)).vault;
        const treasuryBalanceBefore = await usdc.balanceOf(await treasury.getAddress());
        await treasury.claim(agentId);
        const potAfter = await treasury.tranchePot();
        const vaultAfter = (await agents.getAgent(agentId)).vault;
        const treasuryBalanceAfter = await usdc.balanceOf(await treasury.getAddress());
        const delta = potBefore - potAfter;
        const expected = amount < potBefore ? amount : potBefore;
        paid += delta;
        expect(delta, `${label}: claim pays exact backed amount`).to.equal(expected);
        expect(vaultAfter - vaultBefore, `${label}: claim credits NFT vault`).to.equal(expected);
        expect(treasuryBalanceBefore - treasuryBalanceAfter, `${label}: claim transfers exact USDC`).to.equal(expected);
        expect(await treasury.claimable(agentId), `${label}: claim clears stored path`).to.equal(0n);
      }
      expect(paid, `${label}: aggregate claims <= prior pot`).to.be.lte(pot);
      expect(await treasury.tranchePot(), `${label}: pot conserved after drain`).to.equal(pot - paid);
    } finally {
      await ethers.provider.send("evm_revert", [snapshot]);
    }
  }

  const totalTickets = await treasury.totalTickets();
  if (totalTickets > 0n) {
    expect(await treasury.rewardRemainder(), `${label}: remainder cleared once tickets exist`).to.equal(0n);
  }

  const classId = await syndicate.currentClassId();
  expect(classId, `${label}: currentClassId monotonic`).to.be.gte(ghost.currentClassId);
  ghost.currentClassId = classId;

  expect(await usdc.balanceOf(await agents.getAddress()), `${label}: agents cover vaults`).to.be.gte(vaultSum);

  const fees = await treasury.totalFeesReceived();
  const protocolPaid = await treasury.totalProtocolPaid();
  expect(protocolPaid, `${label}: protocol cut <= fees`).to.be.lte(fees);
  if (fees > 0n) {
    // Every deposit takes floor(10%); aggregate paid is never more than 10% of fees.
    expect(protocolPaid * 10n, `${label}: protocol cut not above 10%`).to.be.lte(fees);
  }

  expect(await arena.runwaySolvent(), `${label}: runwaySolvent view`).to.equal(true);
  void ethers;
}

async function ensureFunded(ctx, signer, amount = ethersParse(ctx, "50")) {
  const bal = await ctx.usdc.balanceOf(signer.address);
  if (bal < amount) {
    await ctx.usdc.mint(signer.address, amount - bal + amount);
  }
  const arena = await ctx.arena.getAddress();
  if ((await ctx.usdc.allowance(signer.address, arena)) < amount) {
    await ctx.usdc.connect(signer).approve(arena, ctx.ethers.MaxUint256);
  }
}

function ethersParse(ctx, usdc) {
  return ctx.ethers.parseUnits(usdc, 6);
}

async function noteAgent(ctx, agentId) {
  if (!ctx.ghost.agentIds.includes(agentId)) {
    ctx.ghost.agentIds.push(agentId);
    ctx.ghost.tickets[agentId] = 0n;
  }
}

const ACTIONS = [
  {
    name: "hatch",
    weight: 8,
    async run(ctx) {
      const actor = pick(ctx, ctx.actors);
      await ensureFunded(ctx, actor, MIN_RUNWAY);
      const before = await ctx.agents.nextId();
      await ctx.arena.connect(actor).hatch(MIN_RUNWAY);
      await noteAgent(ctx, before);
      ctx.ghost.owners[before] = actor.address;
    },
  },
  {
    name: "referredHatch",
    weight: 4,
    async run(ctx) {
      if (ctx.ghost.agentIds.length === 0) return false;
      const referrerId = pick(ctx, ctx.ghost.agentIds);
      const actor = pick(ctx, ctx.actors);
      await ensureFunded(ctx, actor, MIN_RUNWAY);
      const before = await ctx.agents.nextId();
      await ctx.arena.connect(actor)["hatch(uint256,uint256)"](MIN_RUNWAY, referrerId);
      await noteAgent(ctx, before);
      ctx.ghost.owners[before] = actor.address;
    },
  },
  {
    name: "replenish",
    weight: 5,
    async run(ctx) {
      if (ctx.ghost.agentIds.length === 0) return false;
      const agentId = pick(ctx, ctx.ghost.agentIds);
      const actor = pick(ctx, ctx.actors);
      const amount = PENNY * BigInt(1 + Math.floor(ctx.rand() * 20));
      await ensureFunded(ctx, actor, amount);
      await ctx.arena.connect(actor).replenishRunway(agentId, amount);
    },
  },
  {
    name: "commit",
    weight: 10,
    async run(ctx) {
      if (ctx.ghost.agentIds.length === 0) return false;
      const agentId = pick(ctx, ctx.ghost.agentIds);
      const ownerAddr = await ctx.agents.ownerOf(agentId);
      const actor = ctx.actors.find((s) => s.address === ownerAddr);
      if (!actor) return false;
      const dueAt = await ctx.arena.nextCommitAt(agentId);
      const block = await ctx.ethers.provider.getBlock("latest");
      if (BigInt(block.timestamp) < dueAt) {
        await ctx.ethers.provider.send("evm_setNextBlockTimestamp", [Number(dueAt)]);
        await ctx.ethers.provider.send("evm_mine");
      }
      if ((await ctx.arena.runway(agentId)) < PENNY) {
        await ensureFunded(ctx, actor, PENNY);
        await ctx.arena.connect(actor).replenishRunway(agentId, PENNY);
      }
      await ctx.arena.connect(actor).commit(agentId);
    },
  },
  {
    name: "rain",
    weight: 10,
    async run(ctx) {
      if (ctx.ghost.agentIds.length === 0) return false;
      const agentId = pick(ctx, ctx.ghost.agentIds);
      const ownerAddr = await ctx.agents.ownerOf(agentId);
      const actor = ctx.actors.find((s) => s.address === ownerAddr);
      if (!actor) return false;
      const pennies = BigInt(1 + Math.floor(ctx.rand() * 10));
      const need = pennies * PENNY;
      if ((await ctx.arena.runway(agentId)) < need) {
        await ensureFunded(ctx, actor, need);
        await ctx.arena.connect(actor).replenishRunway(agentId, need);
      }
      await ctx.arena.connect(actor).rainFromRunway(agentId, pennies);
    },
  },
  {
    name: "signal",
    weight: 6,
    async run(ctx) {
      if (ctx.ghost.agentIds.length === 0) return false;
      const agentId = pick(ctx, ctx.ghost.agentIds);
      const ownerAddr = await ctx.agents.ownerOf(agentId);
      const actor = ctx.actors.find((s) => s.address === ownerAddr);
      if (!actor) return false;
      const classId = await ctx.syndicate.currentClassId();
      const typeCounts = [1, 0, 0, 0, 0, 0, 0, 0];
      const ink = 1n;
      const need = ink * PENNY;
      if ((await ctx.arena.runway(agentId)) < need) {
        await ensureFunded(ctx, actor, need);
        await ctx.arena.connect(actor).replenishRunway(agentId, need);
      }
      const root = ctx.ethers.id(`fuzz-${ctx.step}-${agentId}-${ctx.rand()}`);
      await ctx.arena.connect(actor).settleSignalBatchFromRunway(agentId, classId, root, typeCounts);
    },
  },
  {
    name: "depositFees",
    weight: 12,
    async run(ctx) {
      const roll = ctx.rand();
      let amount;
      if (roll < 0.35) amount = 1n;
      else if (roll < 0.55) amount = BigInt(1 + Math.floor(ctx.rand() * 99));
      else amount = ctx.ethers.parseUnits(String(1 + Math.floor(ctx.rand() * 50)), 6);
      await ctx.usdc.mint(ctx.deployer.address, amount);
      await ctx.usdc.connect(ctx.deployer).approve(await ctx.treasury.getAddress(), amount);
      await ctx.treasury.connect(ctx.deployer).depositFees(amount);
    },
  },
  {
    name: "claim",
    weight: 10,
    async run(ctx) {
      if (ctx.ghost.agentIds.length === 0) return false;
      const agentId = pick(ctx, ctx.ghost.agentIds);
      const amount = await ctx.treasury.claimable(agentId);
      if (amount === 0n) return false;
      await ctx.treasury.claim(agentId);
      expect(await ctx.treasury.claimable(agentId)).to.equal(0n);
    },
  },
  {
    name: "transferNft",
    weight: 5,
    async run(ctx) {
      if (ctx.ghost.agentIds.length === 0) return false;
      const agentId = pick(ctx, ctx.ghost.agentIds);
      const ownerAddr = await ctx.agents.ownerOf(agentId);
      const from = ctx.actors.find((s) => s.address === ownerAddr);
      const to = pick(ctx, ctx.actors.filter((s) => s.address !== ownerAddr));
      if (!from || !to) return false;
      await ctx.agents.connect(from).transferFrom(from.address, to.address, agentId);
      ctx.ghost.owners[agentId] = to.address;
    },
  },
  {
    name: "graduate",
    weight: 4,
    async run(ctx) {
      const classId = await ctx.syndicate.currentClassId();
      if (!(await ctx.syndicate.canGraduate(classId))) return false;
      await ctx.graduation.graduate();
      ctx.ghost.currentClassId = await ctx.syndicate.currentClassId();
    },
  },
  {
    name: "fundReferralFromRunway",
    weight: 3,
    async run(ctx) {
      if (ctx.ghost.agentIds.length === 0) return false;
      const agentId = pick(ctx, ctx.ghost.agentIds);
      const ownerAddr = await ctx.agents.ownerOf(agentId);
      const actor = ctx.actors.find((s) => s.address === ownerAddr);
      if (!actor) return false;
      if ((await ctx.arena.runway(agentId)) < PENNY) {
        await ensureFunded(ctx, actor, PENNY);
        await ctx.arena.connect(actor).replenishRunway(agentId, PENNY);
      }
      const proposal = ctx.ethers.id(`ref-${ctx.step}-${agentId}`);
      try {
        await ctx.arena.connect(actor).fundReferralPoolFromRunway(agentId, proposal);
      } catch (error) {
        if (String(error.message || error).includes("ReferralAlreadyFunded")) return false;
        throw error;
      }
    },
  },
  {
    name: "warp",
    weight: 4,
    async run(ctx) {
      const seconds = 3600 + Math.floor(ctx.rand() * 86400 * 2);
      await ctx.ethers.provider.send("evm_increaseTime", [seconds]);
      await ctx.ethers.provider.send("evm_mine");
    },
  },
  {
    name: "withdrawVault",
    weight: 4,
    async run(ctx) {
      if (ctx.ghost.agentIds.length === 0) return false;
      const agentId = pick(ctx, ctx.ghost.agentIds);
      const ownerAddr = await ctx.agents.ownerOf(agentId);
      const actor = ctx.actors.find((s) => s.address === ownerAddr);
      if (!actor) return false;
      const vault = (await ctx.agents.getAgent(agentId)).vault;
      if (vault === 0n) return false;
      const pull = ctx.rand() < 0.5 ? vault : vault / 2n;
      if (pull === 0n) return false;
      await ctx.agents.connect(actor).withdraw(agentId, pull);
    },
  },
];

function pick(ctx, list) {
  return list[Math.floor(ctx.rand() * list.length)];
}

function weightedAction(ctx) {
  const total = ACTIONS.reduce((sum, action) => sum + action.weight, 0);
  let roll = ctx.rand() * total;
  for (const action of ACTIONS) {
    roll -= action.weight;
    if (roll <= 0) return action;
  }
  return ACTIONS[ACTIONS.length - 1];
}

async function runInvariantCampaign(ethers, options = {}) {
  const steps = Number(options.steps || process.env.VERSUS_INVARIANT_STEPS || 250);
  const seed = parseSeed(options.seed ?? process.env.VERSUS_INVARIANT_SEED);
  const rand = mulberry32(seed);
  const [deployer, a, b, c, d] = await ethers.getSigners();
  const actors = [a, b, c, d];
  const floor = options.graduationFloor ?? 50_000n; // five pennies — reachable under fuzz
  const stack = await require("../../scripts/lib/deployOwnerless").deployLocalStack(ethers, {
    protocolRecipient: deployer.address,
    graduationFloor: floor,
    referralReward: 1_000_000n,
  });

  for (const actor of actors) {
    await stack.usdc.mint(actor.address, ethers.parseUnits("1000", 6));
    await stack.usdc.connect(actor).approve(await stack.arena.getAddress(), ethers.MaxUint256);
    await stack.usdc.connect(actor).approve(await stack.agents.getAddress(), ethers.MaxUint256);
    await stack.usdc.connect(actor).approve(await stack.referralPool.getAddress(), ethers.MaxUint256);
  }
  await stack.usdc.connect(deployer).approve(await stack.treasury.getAddress(), ethers.MaxUint256);

  const ctx = {
    ethers,
    deployer,
    actors,
    rand,
    step: 0,
    usdc: stack.usdc,
    agents: stack.agents,
    arena: stack.arena,
    syndicate: stack.syndicate,
    treasury: stack.treasury,
    graduation: stack.graduation,
    referralPool: stack.referralPool,
    ghost: {
      agentIds: [],
      tickets: {},
      owners: {},
      currentClassId: 1n,
      overClaimableEvents: 0,
      maxOverClaimableWei: 0n,
      claimProbeCountdown: 0,
    },
    history: [],
  };

  await checkInvariants(ctx, `seed=${seed} setup`);

  let executed = 0;
  let skipped = 0;
  for (let i = 0; i < steps; i += 1) {
    ctx.step = i;
    const action = weightedAction(ctx);
    try {
      const result = await action.run(ctx);
      if (result === false) {
        skipped += 1;
        continue;
      }
      executed += 1;
      ctx.history.push(action.name);
      await checkInvariants(ctx, `seed=${seed} step=${i} action=${action.name}`);
    } catch (error) {
      const message = String(error.message || error);
      // Expected user-level reverts are soft skips; invariant failures and unexpected reverts bubble.
      const expected = [
        "InsufficientRunway",
        "AlreadyCommitted",
        "NotAgentOwner",
        "InvalidRainAmount",
        "InvalidSignalBatch",
        "SignalBatchAlreadySettled",
        "WrongClass",
        "ReferralAlreadyFunded",
        "NothingToClaim",
        "NotReady",
        "AlreadyGraduated",
        "RunwayBelowMinimum",
        "InvalidReferral",
      ].some((code) => message.includes(code));
      if (expected) {
        skipped += 1;
        continue;
      }
      error.message = `Invariant campaign failed seed=${seed} step=${i} action=${action.name}\nHistory: ${ctx.history.join(",")}\n${message}`;
      throw error;
    }
  }

  return {
    seed,
    steps,
    executed,
    skipped,
    agents: ctx.ghost.agentIds.length,
    classId: Number(ctx.ghost.currentClassId),
    overClaimableEvents: ctx.ghost.overClaimableEvents,
    maxOverClaimableWei: ctx.ghost.maxOverClaimableWei.toString(),
    historyTail: ctx.history.slice(-20),
  };
}

module.exports = {
  PENNY,
  MIN_RUNWAY,
  checkInvariants,
  runInvariantCampaign,
  parseSeed,
};
