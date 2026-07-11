#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
require("dotenv").config();

const {
  Contract,
  JsonRpcProvider,
  MaxUint256,
  Wallet,
  formatEther,
  formatUnits,
} = require("ethers");

const ROOT = path.resolve(__dirname, "..", "..");
const CHAIN_ID = 84532;
const EXPECTED_FACTORY = "0x7Ae58f10f7849cA6F5fB71b7f45CB416c9204b1e";
const EXPECTED_ROUTER = "0x1689E7B1F10000AE47eBfE339a4f69dECd19F602";
const EXPECTED_WETH = "0x4200000000000000000000000000000000000006";
const FLOOR = 30_000n;
const BUY_AMOUNT = 5_000n;
const RUNWAY = 7_000_000n;

function artifact(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", ...relativePath.split("/")), "utf8"));
}

const ABIS = Object.freeze({
  usdc: artifact("contracts/test/MockUSDC.sol/MockUSDC.json").abi,
  arena: artifact("contracts/core/Arena.sol/Arena.json").abi,
  agents: artifact("contracts/core/AgentNFT.sol/AgentNFT.json").abi,
  syndicate: artifact("contracts/core/SyndicateEngine.sol/SyndicateEngine.json").abi,
  treasury: artifact("contracts/core/TrancheTreasury.sol/TrancheTreasury.json").abi,
  graduation: artifact("contracts/launch/GraduationModule.sol/GraduationModule.json").abi,
  classToken: artifact("contracts/launch/ClassToken.sol/ClassToken.json").abi,
  router: [
    "function factory() view returns (address)",
    "function WETH() view returns (address)",
    "function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)",
  ],
  factory: [
    "function getPair(address,address) view returns (address)",
    "function allPairsLength() view returns (uint256)",
  ],
  pair: [
    "function factory() view returns (address)",
    "function token0() view returns (address)",
    "function token1() view returns (address)",
    "function getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)",
  ],
});

function json(value, spacing = 0) {
  return JSON.stringify(value, (_, child) => typeof child === "bigint" ? child.toString() : child, spacing);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const deploymentPath = path.resolve(
    process.env.VERSUS_DEPLOYMENT || path.join(__dirname, "..", "deployments", "baseSepolia-v5-real-v2.json")
  );
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("PRIVATE_KEY is required");

  const provider = new JsonRpcProvider(rpcUrl, CHAIN_ID, { staticNetwork: true, cacheTimeout: -1 });
  const wallet = new Wallet(privateKey, provider);
  const address = wallet.address;
  const contracts = deployment.contracts;
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-base-sepolia-real-v2`;
  const runDir = path.join(ROOT, "research", "sepolia-real-v2-runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  const eventsPath = path.join(runDir, "events.jsonl");
  const transactions = [];
  const classes = [];
  const startedAt = Date.now();

  function record(type, detail = {}) {
    fs.appendFileSync(eventsPath, `${json({ at: new Date().toISOString(), type, detail })}\n`, "utf8");
  }

  async function submit(label, transactionPromise, detail = {}) {
    const transaction = await transactionPromise;
    record("transaction_broadcast", { label, hash: transaction.hash, ...detail });
    const receipt = await transaction.wait();
    assert(Number(receipt.status) === 1, `${label} failed`);
    const item = {
      label,
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      ...detail,
    };
    transactions.push(item);
    record("transaction_confirmed", item);
    return receipt;
  }

  try {
    assert(deployment.chainId === CHAIN_ID, "deployment is not Base Sepolia");
    assert(deployment.usedMockUsdc === true, "focused run requires the fresh mintable test USDC");
    assert(deployment.usedMockRouter === false, "focused run must use an external V2 deployment");
    assert(BigInt(deployment.economics.graduationFloorRaw) === FLOOR, "deployment floor must be exactly $0.03");
    assert(contracts.v2Factory.toLowerCase() === EXPECTED_FACTORY.toLowerCase(), "unexpected external V2 factory");
    assert(contracts.v2Router.toLowerCase() === EXPECTED_ROUTER.toLowerCase(), "unexpected external V2 router");

    const network = await provider.getNetwork();
    assert(Number(network.chainId) === CHAIN_ID, "RPC returned the wrong chain");
    const router = new Contract(contracts.v2Router, ABIS.router, wallet);
    const factory = new Contract(contracts.v2Factory, ABIS.factory, provider);
    const [routerFactory, routerWeth, factoryPairsBefore] = await Promise.all([
      router.factory(), router.WETH(), factory.allPairsLength(),
    ]);
    assert(routerFactory.toLowerCase() === EXPECTED_FACTORY.toLowerCase(), "router changed its factory binding");
    assert(routerWeth.toLowerCase() === EXPECTED_WETH.toLowerCase(), "router changed its WETH binding");

    const usdc = new Contract(contracts.usdc, ABIS.usdc, wallet);
    const arena = new Contract(contracts.arena, ABIS.arena, wallet);
    const agents = new Contract(contracts.agents, ABIS.agents, provider);
    const syndicate = new Contract(contracts.syndicate, ABIS.syndicate, provider);
    const treasury = new Contract(contracts.treasury, ABIS.treasury, wallet);
    const graduation = new Contract(contracts.graduation, ABIS.graduation, wallet);

    const deploymentCodes = await Promise.all(
      [contracts.usdc, contracts.arena, contracts.agents, contracts.syndicate, contracts.treasury, contracts.graduation]
        .map((contractAddress) => provider.getCode(contractAddress))
    );
    assert(deploymentCodes.every((code) => code !== "0x"), "a fresh Versus deployment address has no bytecode");
    const balanceStart = await provider.getBalance(address);
    record("run_started", {
      runId,
      wallet: address,
      deploymentPath,
      balanceStart,
      factoryPairsBefore,
      externalFactory: contracts.v2Factory,
      externalRouter: contracts.v2Router,
    });

    const usdcNeeded = (RUNWAY * 2n) + (FLOOR * 2n) + (BUY_AMOUNT * 2n);
    if (await usdc.balanceOf(address) < usdcNeeded) {
      await submit("mint focused test USDC", usdc.mint(address, 20_000_000n), { amount: 20_000_000n });
    }
    await submit("approve Arena test USDC", usdc.approve(contracts.arena, MaxUint256));
    await submit("approve external V2 router test USDC", usdc.approve(contracts.v2Router, MaxUint256));

    await submit("hatch class-one Cypher", arena.hatch(0, RUNWAY), { cypherId: 0, runway: RUNWAY });
    await submit("hatch class-two Cypher", arena.hatch(1, RUNWAY), { cypherId: 1, runway: RUNWAY });
    assert(await agents.ownerOf(1) === address, "agent 1 owner mismatch");
    assert(await agents.ownerOf(2) === address, "agent 2 owner mismatch");

    async function fillGraduateAndTrade(classId, agentId, expectedName, expectedSymbol) {
      assert(await syndicate.currentClassId() === BigInt(classId), `class ${classId} was not open`);
      await submit(`fill class ${classId} with three pennies`, arena.rainFromRunway(agentId, 3), {
        classId, agentId, pennies: 3,
      });
      const beforeGraduation = await syndicate.getClass(classId);
      assert(beforeGraduation.totalCommitted === FLOOR, `class ${classId} did not reach the exact floor`);
      assert(beforeGraduation.graduated === false, `class ${classId} graduated before the graduation transaction`);

      const graduateReceipt = await submit(`graduate class ${classId}`, graduation.graduate(), { classId });
      const graduated = await graduation.getGraduation(classId);
      assert(graduated.active === true && graduated.usdcSeeded === FLOOR, `class ${classId} graduation state is wrong`);
      assert(await syndicate.currentClassId() === BigInt(classId + 1), `class counter did not advance after class ${classId}`);
      assert((await factory.getPair(contracts.usdc, graduated.token)).toLowerCase() === graduated.pair.toLowerCase(), "factory pair mismatch");

      const token = new Contract(graduated.token, ABIS.classToken, wallet);
      const pair = new Contract(graduated.pair, ABIS.pair, provider);
      const [name, symbol, pairFactory, reservesBefore, treasuryBefore, protocolBefore] = await Promise.all([
        token.name(), token.symbol(), pair.factory(), pair.getReserves(), treasury.tranchePot(), treasury.totalProtocolPaid(),
      ]);
      assert(name === expectedName && symbol === expectedSymbol, `class ${classId} token metadata mismatch`);
      assert(pairFactory.toLowerCase() === EXPECTED_FACTORY.toLowerCase(), `class ${classId} is not on the external factory`);

      const deadline = BigInt((await provider.getBlock("latest")).timestamp + 600);
      const usdcBeforeBuy = await usdc.balanceOf(address);
      await submit(
        `buy ${expectedSymbol} with tiny fake USDC`,
        router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
          BUY_AMOUNT, 0, [contracts.usdc, graduated.token], address, deadline
        ),
        { classId, amountIn: BUY_AMOUNT }
      );
      const [boughtBalance, accumulatedBuyTax, usdcAfterBuy] = await Promise.all([
        token.balanceOf(address), token.balanceOf(contracts.graduation), usdc.balanceOf(address),
      ]);
      assert(boughtBalance > 0n, `class ${classId} buy returned no tokens`);
      assert(accumulatedBuyTax > 0n, `class ${classId} buy produced no tax`);
      assert(usdcBeforeBuy - usdcAfterBuy === BUY_AMOUNT, `class ${classId} buy spent the wrong fake USDC amount`);

      await submit(`approve external V2 router ${expectedSymbol}`, token.approve(contracts.v2Router, MaxUint256), { classId });
      const sellAmount = boughtBalance / 2n;
      const usdcBeforeSell = await usdc.balanceOf(address);
      const sellReceipt = await submit(
        `sell ${expectedSymbol} and atomically swap tax`,
        router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
          sellAmount, 0, [graduated.token, contracts.usdc], address, deadline
        ),
        { classId, amountIn: sellAmount, accumulatedBuyTax }
      );
      const [remainingTax, usdcAfterSell, treasuryAfter, protocolAfter, reservesAfter] = await Promise.all([
        token.balanceOf(contracts.graduation),
        usdc.balanceOf(address),
        treasury.tranchePot(),
        treasury.totalProtocolPaid(),
        pair.getReserves(),
      ]);
      assert(remainingTax === 0n, `class ${classId} automatic tax swap left token tax behind`);
      assert(usdcAfterSell > usdcBeforeSell, `class ${classId} seller received no fake USDC`);
      assert(treasuryAfter > treasuryBefore, `class ${classId} tax did not reach ticket rewards`);
      assert(protocolAfter > protocolBefore, `class ${classId} tax did not pay the protocol cut`);

      const result = {
        classId,
        agentId,
        token: graduated.token,
        pair: graduated.pair,
        name,
        symbol,
        graduationHash: graduateReceipt.hash,
        sellHash: sellReceipt.hash,
        usdcSeeded: graduated.usdcSeeded,
        buyUsdc: BUY_AMOUNT,
        buyTaxTokens: accumulatedBuyTax,
        sellTokens: sellAmount,
        sellerUsdcReceived: usdcAfterSell - usdcBeforeSell,
        ticketRewardsAdded: treasuryAfter - treasuryBefore,
        protocolAdded: protocolAfter - protocolBefore,
        reservesBefore: [reservesBefore.reserve0, reservesBefore.reserve1],
        reservesAfter: [reservesAfter.reserve0, reservesAfter.reserve1],
      };
      classes.push(result);
      record("class_proven", result);
      return result;
    }

    await fillGraduateAndTrade(1, 1, "Versus Token 0", "VRS0");
    await fillGraduateAndTrade(2, 2, "Versus Token 1", "VRS1");
    assert(await syndicate.currentClassId() === 3n, "two graduations did not open class 3");

    const [claimableOne, claimableTwo] = await Promise.all([treasury.claimable(1), treasury.claimable(2)]);
    assert(claimableOne > 0n && claimableTwo > 0n, "both participating Cyphers must have claimable rolling rewards");
    await submit("claim agent 1 rolling rewards", treasury.claim(1), { agentId: 1, amount: claimableOne });
    await submit("claim agent 2 rolling rewards", treasury.claim(2), { agentId: 2, amount: claimableTwo });
    const [agentOne, agentTwo, balanceEnd, factoryPairsAfter] = await Promise.all([
      agents.getAgent(1), agents.getAgent(2), provider.getBalance(address), factory.allPairsLength(),
    ]);
    assert(agentOne.vault >= claimableOne && agentTwo.vault >= claimableTwo, "claims did not reach both NFT vaults");
    assert(factoryPairsAfter >= factoryPairsBefore + 2n, "external factory did not include both new Versus pairs");

    const summary = {
      version: 1,
      runId,
      passed: true,
      durationMs: Date.now() - startedAt,
      chainId: CHAIN_ID,
      wallet: address,
      deploymentPath,
      externalV2: { factory: contracts.v2Factory, router: contracts.v2Router, weth: routerWeth },
      floorPerClass: FLOOR,
      finalCurrentClassId: await syndicate.currentClassId(),
      factoryPairsBefore,
      factoryPairsAfter,
      classes,
      claims: { agentOne: claimableOne, agentTwo: claimableTwo },
      vaults: { agentOne: agentOne.vault, agentTwo: agentTwo.vault },
      gas: { startWei: balanceStart, endWei: balanceEnd, spentWei: balanceStart - balanceEnd },
      transactions,
    };
    fs.writeFileSync(path.join(runDir, "summary.json"), `${json(summary, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(runDir, "REPORT.md"), [
      "# Base Sepolia Real Uniswap V2 Two-Class Proof",
      "",
      "- Result: **PASS**",
      `- Run: \`${runId}\``,
      `- External factory: \`${contracts.v2Factory}\``,
      `- External Router02: \`${contracts.v2Router}\``,
      `- Fake USDC: \`${contracts.usdc}\``,
      `- Class sequence: \`1 -> 2 -> 3\``,
      `- V2 pairs created: ${factoryPairsAfter - factoryPairsBefore}`,
      `- ETH spent by test wallet: ${formatEther(balanceStart - balanceEnd)} ETH`,
      "",
      "## Classes",
      "",
      ...classes.map((item) => `- Class ${item.classId}: ${item.symbol} at \`${item.token}\`, pair \`${item.pair}\`, ${formatUnits(item.usdcSeeded, 6)} fake USDC seeded, ${formatUnits(item.sellerUsdcReceived, 6)} fake USDC returned to seller, ${formatUnits(item.ticketRewardsAdded, 6)} credited to tickets.`),
      "",
      "## Claims",
      "",
      `- Agent 1: ${formatUnits(claimableOne, 6)} fake USDC`,
      `- Agent 2: ${formatUnits(claimableTwo, 6)} fake USDC`,
      "",
      "## Transactions",
      "",
      ...transactions.map((item) => `- ${item.label}: https://sepolia.basescan.org/tx/${item.hash}`),
      "",
    ].join("\n"), "utf8");
    record("run_completed", { passed: true, summaryPath: path.join(runDir, "summary.json") });
    console.log(`PASS ${runDir}`);
  } catch (error) {
    const failure = { runId, passed: false, failedAt: new Date().toISOString(), message: error.message, stack: error.stack, transactions, classes };
    fs.writeFileSync(path.join(runDir, "failure.json"), `${json(failure, 2)}\n`, "utf8");
    record("run_failed", failure);
    console.error(`FAIL ${runDir}`);
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
