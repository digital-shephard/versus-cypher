const hre = require("hardhat");
const { deployLocalStack } = require("./lib/deployOwnerless");

async function main() {
  const [deployer, alice, bob, carol] = await hre.ethers.getSigners();
  console.log("\n=== Versus: $1k-floor story (test floor $0.03) ===\n");

  const TEST_FLOOR = 30_000n;
  const { usdc, agents, arena, syndicate, treasury, graduation } = await deployLocalStack(hre.ethers, {
    protocolRecipient: deployer.address,
    graduationFloor: TEST_FLOOR,
  });

  for (const who of [alice, bob, carol]) {
    await (await usdc.mint(who.address, hre.ethers.parseUnits("10", 6))).wait();
    await (await usdc.connect(who).approve(await arena.getAddress(), hre.ethers.MaxUint256)).wait();
  }

  console.log("1) Rain pennies into the open class (we are the fund)");
  const runway = hre.ethers.parseUnits("7", 6);
  await (await arena.connect(alice).hatch(runway)).wait();
  await (await arena.connect(bob).hatch(runway)).wait();
  await (await arena.connect(carol).hatch(runway)).wait();
  await (await arena.connect(alice).commit(1)).wait();
  await (await arena.connect(bob).commit(2)).wait();
  await (await arena.connect(carol).commit(3)).wait();

  const classId = await syndicate.currentClassId();
  console.log("   class", classId.toString(), await syndicate.getClass(classId));
  console.log("   floor", (await syndicate.graduationFloor()).toString(), "canGraduate", await syndicate.canGraduate(classId));

  console.log("2) Anyone graduates at floor → Uniswap V2");
  await (await graduation.connect(bob).graduate()).wait();
  const g = await graduation.getGraduation(classId);
  console.log("   token", g.token, "pair", g.pair, "seeded", g.usdcSeeded.toString());

  console.log("3) Oil strike fees → immediate rolling rewards; 10% protocol + 90% agents");
  const oil = hre.ethers.parseUnits("30000", 6);
  await (await usdc.mint(deployer.address, oil)).wait();
  await (await usdc.approve(await treasury.getAddress(), oil)).wait();
  const before = await treasury.totalProtocolPaid();
  await (await treasury.depositFees(oil)).wait();
  const after = await treasury.totalProtocolPaid();
  console.log("   immediate protocol 10% cut:", hre.ethers.formatUnits(after - before, 6), "USDC");

  await (await treasury.claim(1)).wait();
  await (await treasury.claim(2)).wait();
  await (await treasury.claim(3)).wait();

  for (const id of [1, 2, 3]) {
    const a = await agents.getAgent(id);
    console.log(`   agent #${id} vault:`, hre.ethers.formatUnits(a.vault, 6));
  }
  console.log("   tranchePot left:", hre.ethers.formatUnits(await treasury.tranchePot(), 6));
  console.log("\n=== done (no seed fund) ===\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
