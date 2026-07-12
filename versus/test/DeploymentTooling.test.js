const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployLocalStack } = require("../scripts/lib/deployOwnerless");
const { auditDeployment } = require("../scripts/lib/deployment-audit");
const {
  MANIFEST_VERSION,
  RELEASE_STAGES,
  assertBaseSourceReady,
  constructorArguments,
  evaluateSafePolicy,
  resolveReleaseStage,
  validateManifest,
} = require("../scripts/lib/deployment-manifest");

describe("production deployment tooling", function () {
  it("separates closed-cohort and unrestricted-public Safe policy", function () {
    const oneOfOne = { owners: [ethers.Wallet.createRandom().address], threshold: 1 };
    expect(evaluateSafePolicy({ ...oneOfOne, releaseStage: RELEASE_STAGES.CLOSED_COHORT })).to.include({
      passed: true,
      hardeningRequired: true,
      publicReady: false,
    });
    expect(evaluateSafePolicy({ ...oneOfOne, releaseStage: RELEASE_STAGES.UNRESTRICTED_PUBLIC }).passed).to.equal(false);
    const owners = Array.from({ length: 3 }, () => ethers.Wallet.createRandom().address);
    expect(evaluateSafePolicy({ owners, threshold: 2, releaseStage: RELEASE_STAGES.UNRESTRICTED_PUBLIC }).passed).to.equal(true);
  });

  it("fails Base releases without explicit stage or clean full source identity", function () {
    expect(() => resolveReleaseStage("base", undefined)).to.throw("VERSUS_RELEASE_STAGE");
    expect(() => resolveReleaseStage("base", "test")).to.throw("closed-cohort");
    expect(() => assertBaseSourceReady({ commit: "abc", clean: true, dirtyEntries: [] })).to.throw("40-character");
    expect(() => assertBaseSourceReady({ commit: "a".repeat(40), headCommit: "a".repeat(40), clean: false, dirtyEntries: [" M file"] })).to.throw("clean git worktree");
    expect(() => assertBaseSourceReady({ commit: "a".repeat(40), headCommit: "b".repeat(40), clean: true, dirtyEntries: [] })).to.throw("checked-out HEAD");
  });

  it("records the immutable recipient in treasury verification arguments", function () {
    const address = () => ethers.Wallet.createRandom().address;
    const contracts = {
      usdc: address(), v2Router: address(), v2Factory: address(), agents: address(), syndicate: address(),
      treasury: address(), missionEscrow: address(), arena: address(), graduation: address(),
    };
    const recipient = address();
    const args = constructorArguments(contracts, 1_000_000_000n, recipient);
    expect(args.treasury).to.deep.equal([contracts.usdc, recipient]);
  });

  it("independently audits a locally deployed ownerless stack", async function () {
    const [deployer] = await ethers.getSigners();
    const stack = await deployLocalStack(ethers, { protocolRecipient: deployer.address, graduationFloor: 1_000_000_000n });
    const contracts = {
      usdc: await stack.usdc.getAddress(),
      v2Factory: await stack.v2Factory.getAddress(),
      v2Router: await stack.v2Router.getAddress(),
      ...stack.addresses,
    };
    const runtimeBytecode = {};
    for (const [label, address] of Object.entries(contracts)) {
      if (!ethers.isAddress(address)) continue;
      const code = await ethers.provider.getCode(address);
      if (code === "0x") continue;
      runtimeBytecode[label] = { address, bytes: (code.length - 2) / 2, keccak256: ethers.keccak256(code) };
    }
    const manifest = {
      manifestVersion: MANIFEST_VERSION,
      protocol: "versus-cypher",
      network: "hardhat",
      chainId: 31337,
      releaseStage: RELEASE_STAGES.TEST,
      source: { commit: "a".repeat(40), clean: false, treeSha256: "b".repeat(64) },
      contracts,
      constructorArguments: constructorArguments(contracts, 1_000_000_000n, deployer.address),
      economics: {
        protocolRecipient: deployer.address,
        graduationFloorRaw: "1000000000",
      },
      runtimeBytecode,
    };
    expect(validateManifest(manifest)).to.deep.equal({ valid: true, errors: [] });
    const report = await auditDeployment(ethers.provider, manifest);
    expect(report.passed).to.equal(true);
    expect(report.checks.every((entry) => entry.passed)).to.equal(true);
  });
});
