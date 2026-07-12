const fs = require("fs");
const { AbiCoder, Contract, JsonRpcProvider, MaxUint256, NonceManager, Wallet, keccak256 } = require("ethers");
const { normalizeSignalBatch } = require("@versus/network");
const {
  BASE_UNISWAP_SWAP_ROUTER_02,
  BASE_USDC,
  BASE_WETH,
  createBaseProvider,
  quoteDepositPlan,
  quoteUsdDepositTarget,
  splitDepositWei,
} = require("./base-rpc");

const LOCAL_FIXTURE_DEPOSIT_WEI = 3_000_000_000_000_000n;
const LOCAL_FIXTURE_DEPOSIT_MICROS = 10_000_000n;
const ALLOWANCE_SYNC_TIMEOUT_MS = 15_000;
const CHAIN_STATE_SYNC_TIMEOUT_MS = 30_000;

const arenaAbi = [
  "function hatch(uint8 cypherId, uint256 runwayAmount) returns (uint256 agentId)",
  "function replenishRunway(uint256 agentId, uint256 amount)",
  "function commit(uint256 agentId)",
  "function rainFromRunway(uint256 agentId, uint256 pennies)",
  "function settleSignalBatchFromRunway(uint256 agentId, uint256 classId, bytes32 batchRoot, uint16[8] typeCounts)",
  "function settledSignalBatches(uint256 agentId, bytes32 batchRoot) view returns (bool)",
  "function runway(uint256 agentId) view returns (uint128)",
  "event Hatched(uint256 indexed agentId, address indexed owner, uint8 cypherId, uint256 runwayAmount)",
  "event SignalBatchSettled(uint256 indexed agentId, uint256 indexed classId, bytes32 indexed batchRoot, uint256 signalCount, uint256 inkPennies, uint256 amount, bytes32 typeCountsHash)",
];
const agentAbi = [
  "function getAgent(uint256 agentId) view returns (uint8 cypherId, uint32 level, uint32 streak, uint32 lastCommitDay, uint128 vault, address owner)",
  "function withdraw(uint256 agentId, uint256 amount)",
  "event VaultWithdrawn(uint256 indexed agentId, address indexed to, uint256 amount)",
];
const treasuryAbi = [
  "function tickets(uint256 agentId) view returns (uint256)",
  "function totalTickets() view returns (uint256)",
  "function tranchePot() view returns (uint256)",
  "function claimable(uint256 agentId) view returns (uint256)",
  "function previewTranche(uint256 agentId) view returns (uint256)",
  "function claim(uint256 agentId)",
  "event Claimed(uint256 indexed agentId, uint256 amount)",
];
const syndicateAbi = [
  "function currentClassId() view returns (uint256)",
  "function getClass(uint256 classId) view returns (uint256 totalCommitted, uint32 participantCount, uint32 openedDay, bool graduated)",
  "function isParticipant(uint256 classId, uint256 agentId) view returns (bool)",
  "function isGenesisAgent(uint256 agentId) view returns (bool)",
];
const usdcAbi = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)",
];
const swapRouterAbi = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
];
const missionEscrowAbi = [
  "function sponsorMission(bytes32 missionId, uint256 launchId, uint256 sponsorAgentId, uint256 recipientAgentId, uint256 amount, uint64 deadline) returns (uint256 escrowId)",
  "function release(uint256 escrowId)",
  "function refund(uint256 escrowId)",
  "function escrows(uint256 escrowId) view returns (bytes32 missionId, uint256 launchId, uint256 sponsorAgentId, uint256 recipientAgentId, uint128 amount, uint64 deadline, uint8 state, address sponsor)",
  "event MissionSponsored(uint256 indexed escrowId, bytes32 indexed missionId, uint256 indexed launchId, uint256 sponsorAgentId, uint256 recipientAgentId, address sponsor, uint256 amount, uint256 deadline)",
  "event MissionReleased(uint256 indexed escrowId, bytes32 indexed missionId, uint256 recipientAgentId, uint256 amount)",
  "event MissionRefunded(uint256 indexed escrowId, bytes32 indexed missionId, address sponsor, uint256 amount)",
];

function findEvent(contract, receipt, name) {
  for (const log of receipt.logs || []) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed?.name === name) return parsed;
    } catch (_) {}
  }
  throw new Error(`${name} event was missing from the confirmed receipt`);
}

function validateSignalReceipt(arena, receipt, agentId, batch) {
  const event = findEvent(arena, receipt, "SignalBatchSettled");
  const typeCountsHash = keccak256(
    AbiCoder.defaultAbiCoder().encode(["uint16[8]"], [batch.typeCounts])
  );
  if (
    event.args.agentId !== BigInt(agentId) ||
    event.args.classId !== BigInt(batch.launchId) ||
    event.args.batchRoot !== batch.root ||
    event.args.signalCount !== BigInt(batch.signalCount) ||
    event.args.inkPennies !== BigInt(batch.inkPennies) ||
    event.args.amount !== BigInt(batch.amountMicros) ||
    event.args.typeCountsHash !== typeCountsHash
  ) {
    throw new Error("signal settlement event does not match the prepared batch");
  }
  return event;
}

async function confirmed(tx, label, onSubmitted = null) {
  if (onSubmitted) await onSubmitted(tx.hash);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`${label} transaction did not confirm`);
  return receipt;
}

async function waitForAllowance(
  token,
  owner,
  spender,
  minimum,
  { timeoutMs = ALLOWANCE_SYNC_TIMEOUT_MS, pollMs = 250 } = {}
) {
  return waitForChainState(
    () => token.allowance(owner, spender),
    (allowance) => allowance >= minimum,
    { timeoutMs, pollMs, label: "confirmed approval" }
  );
}

async function waitForChainState(
  read,
  accept,
  { timeoutMs = CHAIN_STATE_SYNC_TIMEOUT_MS, pollMs = 250, label = "confirmed transaction state" } = {}
) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() <= deadline) {
    value = await read();
    if (accept(value)) return value;
    if (pollMs > 0) await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`${label} did not become readable within ${timeoutMs}ms`);
}

function loadChainConfig(env = process.env) {
  const rpcUrl = env.VERSUS_RPC_URL;
  const deploymentPath = env.VERSUS_DEPLOYMENT;
  if (!deploymentPath) return null;
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  const { arena, agents, treasury, syndicate } = deployment.contracts || {};
  if (!arena || !agents || !treasury || !syndicate || !deployment.chainId) {
    throw new Error("Versus deployment file is missing chainId or core contract addresses");
  }
  if (Number(deployment.chainId) !== 8453 && !rpcUrl) {
    throw new Error("Non-Base deployments require VERSUS_RPC_URL");
  }
  return { rpcUrl, deployment, env };
}

function localFixtureDepositPlan(depositWei) {
  const split = splitDepositWei(depositWei);
  const grossMicros = (split.depositWei * LOCAL_FIXTURE_DEPOSIT_MICROS) / LOCAL_FIXTURE_DEPOSIT_WEI;
  const quotedRunwayMicros = (grossMicros * split.runwayBps) / 10_000n;
  return {
    ...split,
    fee: 0,
    quotedRunwayMicros,
    minimumRunwayMicros: (quotedRunwayMicros * 9900n) / 10_000n,
    quoteGasEstimate: 0n,
    localFixture: true,
  };
}

function localFixtureTargetPlan(targetMicros) {
  targetMicros = BigInt(targetMicros);
  if (targetMicros <= 0n) throw new RangeError("target must be positive");
  const depositWei = (LOCAL_FIXTURE_DEPOSIT_WEI * targetMicros + LOCAL_FIXTURE_DEPOSIT_MICROS - 1n) /
    LOCAL_FIXTURE_DEPOSIT_MICROS;
  return localFixtureDepositPlan(depositWei);
}

function createChainRainService(config, { provider: injectedProvider = null } = {}) {
  if (!config) return null;
  const chainId = Number(config.deployment.chainId);
  const provider =
    injectedProvider ||
    (chainId === 8453
      ? createBaseProvider(config.env || (config.rpcUrl ? { VERSUS_RPC_URL: config.rpcUrl } : process.env))
      : new JsonRpcProvider(config.rpcUrl, chainId, { staticNetwork: true, cacheTimeout: -1 }));
  const addresses = config.deployment.contracts;
  const localFixture = Boolean(config.deployment.usedMockUsdc && config.deployment.usedMockRouter);
  const signalSigners = new Map();

  function signalSigner(privateKey) {
    const wallet = new Wallet(privateKey, provider);
    const key = wallet.address.toLowerCase();
    if (!signalSigners.has(key)) signalSigners.set(key, new NonceManager(wallet));
    return signalSigners.get(key);
  }

  return {
    async transactionStatus(transactionHash) {
      if (!/^0x[a-f0-9]{64}$/i.test(String(transactionHash || ""))) throw new RangeError("transaction hash is invalid");
      const receipt = await provider.getTransactionReceipt(transactionHash);
      if (!receipt) return { status: "pending", transactionHash };
      return {
        status: receipt.status === 1 ? "confirmed" : "failed",
        transactionHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      };
    },

    async getEthBalance(address) {
      return provider.getBalance(address);
    },

    async quoteHatchTarget({ targetMicros = 10_000_000n } = {}) {
      return localFixture
        ? localFixtureTargetPlan(targetMicros)
        : quoteUsdDepositTarget(provider, targetMicros);
    },

    async quoteHatch({ depositWei }) {
      return localFixture
        ? localFixtureDepositPlan(depositWei)
        : quoteDepositPlan(provider, depositWei);
    },

    async readState({ address, agentId }) {
      const agents = new Contract(addresses.agents, agentAbi, provider);
      const arena = new Contract(addresses.arena, arenaAbi, provider);
      const treasury = new Contract(addresses.treasury, treasuryAbi, provider);
      const syndicate = new Contract(addresses.syndicate, syndicateAbi, provider);
      const token = new Contract(addresses.usdc || BASE_USDC, usdcAbi, provider);
      const classId = await syndicate.currentClassId();
      const [ethBalance, usdcBalance, agent, runway, tickets, totalTickets, claimable, tranchePot, currentClass, genesis] = await Promise.all([
        provider.getBalance(address),
        token.balanceOf(address),
        agents.getAgent(BigInt(agentId)),
        arena.runway(BigInt(agentId)),
        treasury.tickets(BigInt(agentId)),
        treasury.totalTickets(),
        treasury.claimable(BigInt(agentId)),
        treasury.tranchePot(),
        syndicate.getClass(classId),
        syndicate.isGenesisAgent(BigInt(agentId)),
      ]);
      return {
        address,
        owner: agent.owner,
        agentId: BigInt(agentId),
        cypherId: agent.cypherId,
        level: agent.level,
        streak: agent.streak,
        lastCommitDay: agent.lastCommitDay,
        vault: agent.vault,
        runway,
        ethBalance,
        usdcBalance,
        tickets,
        totalTickets,
        claimable,
        tranchePreview: claimable,
        tranchePot,
        classId,
        classPotMicros: currentClass.totalCommitted,
        classAgents: currentClass.participantCount,
        classOpenedDay: currentClass.openedDay,
        classGraduated: currentClass.graduated,
        genesis,
      };
    },

    async hatchWithEth({ privateKey, cypherId, depositWei, onPhase = null }) {
      const wallet = new Wallet(privateKey, provider);
      const signer = new NonceManager(wallet);
      const owner = wallet.address;
      const plan = localFixture
        ? localFixtureDepositPlan(depositWei)
        : await quoteDepositPlan(provider, depositWei);
      if (onPhase) await onPhase("swapping", plan);
      const token = new Contract(addresses.usdc || BASE_USDC, usdcAbi, signer);
      let swapReceipt;
      if (localFixture) {
        swapReceipt = await confirmed(
          await token.mint(owner, plan.quotedRunwayMicros),
          "fixture runway conversion"
        );
      } else {
        const router = new Contract(addresses.swapRouter || BASE_UNISWAP_SWAP_ROUTER_02, swapRouterAbi, signer);
        swapReceipt = await confirmed(
          await router.exactInputSingle(
            {
              tokenIn: BASE_WETH,
              tokenOut: addresses.usdc || BASE_USDC,
              fee: plan.fee,
              recipient: owner,
              amountIn: plan.swapWei,
              amountOutMinimum: plan.minimumRunwayMicros,
              sqrtPriceLimitX96: 0,
            },
            { value: plan.swapWei }
          ),
          "runway swap"
        );
      }
      const runwayAmount = await token.balanceOf(owner);
      if (runwayAmount < plan.minimumRunwayMicros) throw new Error("swap returned less runway than quoted minimum");
      if (onPhase) await onPhase("minting", { ...plan, runwayAmount });
      const allowance = await token.allowance(owner, addresses.arena);
      if (allowance < runwayAmount) {
        await confirmed(await token.approve(addresses.arena, MaxUint256), "Arena approval");
        await waitForAllowance(token, owner, addresses.arena, runwayAmount);
      }
      const arena = new Contract(addresses.arena, arenaAbi, signer);
      const hatchReceipt = await confirmed(
        await arena.hatch(Number(cypherId), runwayAmount),
        "Cypher hatch"
      );
      const event = findEvent(arena, hatchReceipt, "Hatched");
      return {
        plan,
        agentId: event.args.agentId,
        runway: event.args.runwayAmount,
        swapHash: swapReceipt.hash,
        hatchHash: hatchReceipt.hash,
      };
    },

    async hatchWithRunway({ privateKey, cypherId, runwayAmount }) {
      runwayAmount = BigInt(runwayAmount);
      if (runwayAmount <= 0n) throw new RangeError("runway amount must be positive");
      const signer = new NonceManager(new Wallet(privateKey, provider));
      const owner = await signer.getAddress();
      const token = new Contract(addresses.usdc || BASE_USDC, usdcAbi, signer);
      if (await token.balanceOf(owner) < runwayAmount) throw new Error("insufficient wallet USDC for hatch runway");
      let approvalHash = null;
      if (await token.allowance(owner, addresses.arena) < runwayAmount) {
        const approval = await confirmed(await token.approve(addresses.arena, MaxUint256), "Arena approval");
        approvalHash = approval.hash;
        await waitForAllowance(token, owner, addresses.arena, runwayAmount);
      }
      const arena = new Contract(addresses.arena, arenaAbi, signer);
      const receipt = await confirmed(
        await arena.hatch(Number(cypherId), runwayAmount),
        "Cypher hatch"
      );
      const event = findEvent(arena, receipt, "Hatched");
      return {
        agentId: event.args.agentId,
        runway: event.args.runwayAmount,
        approvalHash,
        hatchHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
      };
    },

    async commitDaily({ privateKey, agentId }) {
      const signer = new Wallet(privateKey, provider);
      const arena = new Contract(addresses.arena, arenaAbi, signer);
      return confirmed(await arena.commit(BigInt(agentId)), "daily rain");
    },

    async replenishWithEth({ privateKey, agentId, depositWei }) {
      const wallet = new Wallet(privateKey, provider);
      const signer = new NonceManager(wallet);
      const owner = wallet.address;
      const plan = localFixture
        ? localFixtureDepositPlan(BigInt(depositWei))
        : await quoteDepositPlan(provider, BigInt(depositWei));
      const token = new Contract(addresses.usdc || BASE_USDC, usdcAbi, signer);
      const before = await token.balanceOf(owner);
      let swapReceipt;
      if (localFixture) {
        swapReceipt = await confirmed(
          await token.mint(owner, plan.quotedRunwayMicros),
          "fixture runway conversion"
        );
      } else {
        const router = new Contract(addresses.swapRouter || BASE_UNISWAP_SWAP_ROUTER_02, swapRouterAbi, signer);
        swapReceipt = await confirmed(
          await router.exactInputSingle(
            {
              tokenIn: BASE_WETH,
              tokenOut: addresses.usdc || BASE_USDC,
              fee: plan.fee,
              recipient: owner,
              amountIn: plan.swapWei,
              amountOutMinimum: plan.minimumRunwayMicros,
              sqrtPriceLimitX96: 0,
            },
            { value: plan.swapWei }
          ),
          "runway replenishment swap"
        );
      }
      const after = await token.balanceOf(owner);
      const amount = after - before;
      if (amount < plan.minimumRunwayMicros) throw new Error("replenishment swap returned less than quoted minimum");
      const allowance = await token.allowance(owner, addresses.arena);
      if (allowance < amount) {
        await confirmed(await token.approve(addresses.arena, MaxUint256), "Arena approval");
        await waitForAllowance(token, owner, addresses.arena, amount);
      }
      const arena = new Contract(addresses.arena, arenaAbi, signer);
      const receipt = await confirmed(await arena.replenishRunway(BigInt(agentId), amount), "runway replenishment");
      return { amount, runway: await arena.runway(BigInt(agentId)), swapHash: swapReceipt.hash, replenishHash: receipt.hash, plan };
    },

    async replenishRunway({ privateKey, agentId, amount }) {
      const wallet = new Wallet(privateKey, provider);
      const signer = new NonceManager(wallet);
      const token = new Contract(addresses.usdc || BASE_USDC, usdcAbi, signer);
      const arena = new Contract(addresses.arena, arenaAbi, signer);
      amount = BigInt(amount);
      if (amount <= 0n) throw new RangeError("runway replenishment amount must be positive");
      if (await token.balanceOf(wallet.address) < amount) throw new Error("insufficient wallet USDC for runway replenishment");
      const allowance = await token.allowance(wallet.address, addresses.arena);
      if (allowance < amount) {
        await confirmed(await token.approve(addresses.arena, MaxUint256), "Arena approval");
        await waitForAllowance(token, wallet.address, addresses.arena, amount);
      }
      const receipt = await confirmed(await arena.replenishRunway(BigInt(agentId), amount), "runway replenishment");
      return { amount, runway: await arena.runway(BigInt(agentId)), replenishHash: receipt.hash };
    },

    async finalizePreviousTranche() {
      return { status: "continuous", hash: null };
    },

    async claimTranche({ privateKey, agentId, onSubmitted = null }) {
      const signer = new Wallet(privateKey, provider);
      const treasury = new Contract(addresses.treasury, treasuryAbi, signer);
      const amount = await treasury.claimable(BigInt(agentId));
      if (amount === 0n) return { amount: 0n, hash: null };
      const receipt = await confirmed(await treasury.claim(BigInt(agentId)), "tranche claim", onSubmitted);
      const event = findEvent(treasury, receipt, "Claimed");
      const agents = new Contract(addresses.agents, agentAbi, provider);
      const agent = await agents.getAgent(BigInt(agentId));
      return { amount: event.args.amount, vault: agent.vault, hash: receipt.hash };
    },

    async withdrawVault({ privateKey, agentId, amount = null }) {
      const signer = new Wallet(privateKey, provider);
      const agents = new Contract(addresses.agents, agentAbi, signer);
      const before = await agents.getAgent(BigInt(agentId));
      const withdrawal = amount == null ? before.vault : BigInt(amount);
      if (withdrawal === 0n) return { amount: 0n, vault: before.vault, hash: null };
      const receipt = await confirmed(await agents.withdraw(BigInt(agentId), withdrawal), "vault withdrawal");
      const event = findEvent(agents, receipt, "VaultWithdrawn");
      const after = await agents.getAgent(BigInt(agentId));
      return { amount: event.args.amount, vault: after.vault, hash: receipt.hash };
    },

    async rainFromRunway({ privateKey, agentId, pennies, onSubmitted = null }) {
      const signer = new Wallet(privateKey, provider);
      const arena = new Contract(addresses.arena, arenaAbi, signer);
      const tx = await arena.rainFromRunway(BigInt(agentId), BigInt(pennies));
      if (onSubmitted) await onSubmitted(tx.hash);
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw new Error("rain transaction did not confirm");

      const agents = new Contract(addresses.agents, agentAbi, provider);
      const treasury = new Contract(addresses.treasury, treasuryAbi, provider);
      const syndicate = new Contract(addresses.syndicate, syndicateAbi, provider);
      const classId = await syndicate.currentClassId();
      const [agent, runway, tickets, totalTickets, currentClass] = await Promise.all([
        agents.getAgent(BigInt(agentId)),
        arena.runway(BigInt(agentId)),
        treasury.tickets(BigInt(agentId)),
        treasury.totalTickets(),
        syndicate.getClass(classId),
      ]);

      return {
        hash: receipt.hash,
        vault: agent.vault,
        runway,
        level: agent.level,
        streak: agent.streak,
        lastCommitDay: agent.lastCommitDay,
        tickets,
        totalTickets,
        classId,
        classPotMicros: currentClass.totalCommitted,
        classAgents: currentClass.participantCount,
      };
    },

    async settleSignalBatchFromRunway({ privateKey, agentId, batch, onSubmitted = null }) {
      batch = normalizeSignalBatch(batch);
      if (batch.chainId !== String(config.deployment.chainId)) {
        throw new Error("signal batch chain does not match the configured deployment");
      }
      if (batch.arena !== addresses.arena.toLowerCase() || batch.agentId !== String(agentId)) {
        throw new Error("signal batch Arena or Cypher does not match the configured signer");
      }
      const signer = signalSigner(privateKey);
      if (batch.author !== String(await signer.getAddress()).toLowerCase()) {
        throw new Error("signal batch author does not match the configured signer");
      }
      const arena = new Contract(addresses.arena, arenaAbi, signer);
      let tx;
      try {
        await signer.getNonce("pending");
        tx = await arena.settleSignalBatchFromRunway(
          BigInt(agentId),
          BigInt(batch.launchId),
          batch.root,
          batch.typeCounts
        );
      } catch (error) {
        signer.reset();
        throw error;
      }
      if (onSubmitted) await onSubmitted(tx.hash);
      const receipt = await confirmed(tx, "signal batch");
      const event = validateSignalReceipt(arena, receipt, agentId, batch);
      await waitForChainState(
        () => arena.settledSignalBatches(BigInt(agentId), batch.root),
        Boolean,
        { label: "confirmed signal batch root" }
      );
      return {
        hash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
        batch,
        amount: event.args.amount,
      };
    },

    async reconcileSignalBatch({ agentId, batch, transactionHash }) {
      batch = normalizeSignalBatch(batch);
      if (batch.chainId !== String(config.deployment.chainId)) {
        throw new Error("signal batch chain does not match the configured deployment");
      }
      if (batch.arena !== addresses.arena.toLowerCase() || batch.agentId !== String(agentId)) {
        throw new Error("signal batch Arena or Cypher does not match the configured deployment");
      }
      const receipt = await provider.getTransactionReceipt(transactionHash);
      if (!receipt) return { status: "pending", transactionHash, batch };
      if (receipt.status !== 1) {
        return { status: "failed", transactionHash, blockNumber: receipt.blockNumber, batch };
      }
      const arena = new Contract(addresses.arena, arenaAbi, provider);
      const event = validateSignalReceipt(arena, receipt, agentId, batch);
      return {
        status: "confirmed",
        hash: receipt.hash,
        transactionHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        batch,
        amount: event.args.amount,
      };
    },

    async sponsorMission({
      privateKey,
      missionId,
      launchId,
      sponsorAgentId,
      recipientAgentId,
      amount,
      deadline,
      onSubmitted = null,
    }) {
      if (!addresses.missionEscrow) throw new Error("mission escrow is not configured");
      const wallet = new Wallet(privateKey, provider);
      const signer = new NonceManager(wallet);
      const token = new Contract(addresses.usdc, usdcAbi, signer);
      amount = BigInt(amount);
      const allowance = await token.allowance(wallet.address, addresses.missionEscrow);
      if (allowance < amount) {
        await confirmed(await token.approve(addresses.missionEscrow, MaxUint256), "USDC approval");
        await waitForAllowance(token, wallet.address, addresses.missionEscrow, amount);
      }
      const escrow = new Contract(addresses.missionEscrow, missionEscrowAbi, signer);
      const receipt = await confirmed(
        await escrow.sponsorMission(
          missionId,
          BigInt(launchId),
          BigInt(sponsorAgentId),
          BigInt(recipientAgentId),
          amount,
          BigInt(deadline)
        ),
        "mission sponsorship",
        onSubmitted
      );
      const event = findEvent(escrow, receipt, "MissionSponsored");
      return {
        hash: receipt.hash,
        blockNumber: receipt.blockNumber,
        chainId: String(config.deployment.chainId),
        escrow: addresses.missionEscrow,
        escrowId: event.args.escrowId,
        missionId: event.args.missionId,
        launchId: event.args.launchId,
        sponsorAgentId: event.args.sponsorAgentId,
        recipientAgentId: event.args.recipientAgentId,
        sponsor: event.args.sponsor,
        amount: event.args.amount,
        deadline: event.args.deadline,
      };
    },

    async releaseMission({ privateKey, escrowId, onSubmitted = null }) {
      if (!addresses.missionEscrow) throw new Error("mission escrow is not configured");
      const escrow = new Contract(addresses.missionEscrow, missionEscrowAbi, new Wallet(privateKey, provider));
      const receipt = await confirmed(await escrow.release(BigInt(escrowId)), "mission release", onSubmitted);
      const event = findEvent(escrow, receipt, "MissionReleased");
      return { hash: receipt.hash, blockNumber: receipt.blockNumber, amount: event.args.amount };
    },

    async refundMission({ privateKey, escrowId, onSubmitted = null }) {
      if (!addresses.missionEscrow) throw new Error("mission escrow is not configured");
      const escrow = new Contract(addresses.missionEscrow, missionEscrowAbi, new Wallet(privateKey, provider));
      const receipt = await confirmed(await escrow.refund(BigInt(escrowId)), "mission refund", onSubmitted);
      const event = findEvent(escrow, receipt, "MissionRefunded");
      return { hash: receipt.hash, blockNumber: receipt.blockNumber, amount: event.args.amount };
    },

    async getMissionEscrow(escrowId) {
      if (!addresses.missionEscrow) throw new Error("mission escrow is not configured");
      const escrow = new Contract(addresses.missionEscrow, missionEscrowAbi, provider);
      const record = await escrow.escrows(BigInt(escrowId));
      return {
        missionId: record.missionId,
        launchId: record.launchId,
        sponsorAgentId: record.sponsorAgentId,
        recipientAgentId: record.recipientAgentId,
        amount: record.amount,
        deadline: record.deadline,
        state: Number(record.state),
        sponsor: record.sponsor,
      };
    },
  };
}

module.exports = {
  arenaAbi,
  missionEscrowAbi,
  loadChainConfig,
  createChainRainService,
  waitForAllowance,
  waitForChainState,
};
