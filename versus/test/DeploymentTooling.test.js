const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");
const Ajv2020 = require("ajv/dist/2020");
const { deployLocalStack } = require("../scripts/lib/deployOwnerless");
const { auditDeployment } = require("../scripts/lib/deployment-audit");
const { canonicalBaseDependencies } = require("../scripts/lib/base-production");
const {
  assertBuildMatchesFreeze,
  collectFreshBuildFingerprint,
  loadBuildFreeze,
} = require("../scripts/lib/build-freeze");
const CONSTANTS = require("../scripts/lib/constants");
const {
  MANIFEST_VERSION,
  CONTRACT_KEYS,
  RELEASE_STAGES,
  assertBaseSourceReady,
  collectSourceHashes,
  constructorArguments,
  evaluateSafePolicy,
  resolveReleaseStage,
  validateManifest,
} = require("../scripts/lib/deployment-manifest");

const projectRoot = path.join(__dirname, "..");

function fixtureSource() {
  const inventory = collectSourceHashes(projectRoot);
  return {
    repository: "digital-shephard/versus-cypher",
    commit: "a".repeat(40),
    clean: true,
    ...inventory,
  };
}

function runtimeFor(contracts) {
  return Object.fromEntries(CONTRACT_KEYS.map((key) => [key, {
    address: contracts[key],
    keccak256: "c".repeat(64),
  }]));
}

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

  it("rejects every noncanonical Base dependency override", function () {
    const canonical = canonicalBaseDependencies({
      USDC_ADDRESS: CONSTANTS.base.usdc,
      UNISWAP_V2_FACTORY: CONSTANTS.base.uniswapV2Factory,
      UNISWAP_V2_ROUTER: CONSTANTS.base.uniswapV2Router,
      PROTOCOL_RECIPIENT: CONSTANTS.base.protocolRecipient,
    });
    expect(canonical).to.include({
      usdc: ethers.getAddress(CONSTANTS.base.usdc),
      factory: ethers.getAddress(CONSTANTS.base.uniswapV2Factory),
      router: ethers.getAddress(CONSTANTS.base.uniswapV2Router),
      protocolRecipient: ethers.getAddress(CONSTANTS.base.protocolRecipient),
      safeSingleton: ethers.getAddress(CONSTANTS.base.safeSingleton),
      safeFallbackHandler: ethers.getAddress(CONSTANTS.base.safeFallbackHandler),
    });
    expect(() => canonicalBaseDependencies({ USDC_ADDRESS: ethers.Wallet.createRandom().address }))
      .to.throw("cannot override canonical Base dependency");
    expect(() => canonicalBaseDependencies({ UNISWAP_V2_FACTORY: ethers.Wallet.createRandom().address }))
      .to.throw("cannot override canonical Base dependency");
    expect(() => canonicalBaseDependencies({ UNISWAP_V2_ROUTER: ethers.Wallet.createRandom().address }))
      .to.throw("cannot override canonical Base dependency");
    expect(() => canonicalBaseDependencies({ PROTOCOL_RECIPIENT: ethers.Wallet.createRandom().address }))
      .to.throw("cannot override canonical Base dependency");
    expect(() => canonicalBaseDependencies({ USE_MOCK_ROUTER: "true" })).to.throw("cannot use mock");
  });

  it("rejects a Base manifest that substitutes a dependency or runtime address", function () {
    const address = () => ethers.Wallet.createRandom().address;
    const contracts = {
      usdc: CONSTANTS.base.usdc,
      v2Factory: CONSTANTS.base.uniswapV2Factory,
      v2Router: CONSTANTS.base.uniswapV2Router,
      agents: address(),
      syndicate: address(),
      treasury: address(),
      missionEscrow: address(),
      referralPool: address(),
      arena: address(),
      graduation: address(),
    };
    const freeze = loadBuildFreeze(projectRoot);
    const manifest = {
      manifestVersion: MANIFEST_VERSION,
      protocol: "versus-cypher",
      network: "base",
      chainId: 8453,
      releaseStage: RELEASE_STAGES.CLOSED_COHORT,
      source: fixtureSource(),
      contracts,
      constructorArguments: constructorArguments(contracts, 1_000_000_000n, CONSTANTS.base.protocolRecipient),
      economics: {
        protocolRecipient: CONSTANTS.base.protocolRecipient,
        graduationFloorRaw: "1000000000",
        referralRewardRaw: "1000000",
        protocolTrancheBps: 1000,
      },
      runtimeBytecode: runtimeFor(contracts),
      compiler: {
        solidity: "0.8.26",
        optimizer: { enabled: true, runs: 1 },
        viaIR: true,
        evmVersion: "cancun",
        compilerInputSha256: freeze.compilerInputSha256,
        creationBytecode: Object.fromEntries(
          Object.entries(freeze.contracts).map(([name, value]) => [
            name,
            { keccak256: value.creationBytecodeKeccak256 },
          ])
        ),
      },
    };
    expect(validateManifest(manifest)).to.deep.equal({ valid: true, errors: [] });
    manifest.contracts.v2Router = address();
    expect(validateManifest(manifest).errors.join(" ")).to.include("canonical address");
    manifest.contracts.v2Router = CONSTANTS.base.uniswapV2Router;
    manifest.runtimeBytecode.agents.address = address();
    expect(validateManifest(manifest).errors.join(" ")).to.include("must equal contracts.agents");
    manifest.runtimeBytecode.agents.address = contracts.agents;
    manifest.economics.protocolRecipient = address();
    expect(validateManifest(manifest).errors.join(" ")).to.include("canonical Safe");
    manifest.economics.protocolRecipient = CONSTANTS.base.protocolRecipient;
    manifest.contracts.unreviewed = address();
    expect(validateManifest(manifest).errors.join(" ")).to.include("contracts key set");
    delete manifest.contracts.unreviewed;
    manifest.compiler.creationBytecode.Unreviewed = { keccak256: "d".repeat(64) };
    expect(validateManifest(manifest).errors.join(" ")).to.include("creationBytecode key set");
    delete manifest.compiler.creationBytecode.Unreviewed;
    expect(validateManifest(manifest, { projectRoot })).to.deep.equal({ valid: true, errors: [] });
    const originalHash = manifest.source.files[0].sha256;
    manifest.source.files[0].sha256 = "e".repeat(64);
    manifest.source.treeSha256 = require("crypto").createHash("sha256")
      .update(manifest.source.files.map((entry) => `${entry.path}:${entry.sha256}`).join("\n"))
      .digest("hex");
    expect(validateManifest(manifest, { projectRoot }).errors.join(" ")).to.include("live repository inventory");
    manifest.source.files[0].sha256 = originalHash;
  });

  it("records the immutable recipient in treasury verification arguments", function () {
    const address = () => ethers.Wallet.createRandom().address;
    const contracts = {
      usdc: address(), v2Router: address(), v2Factory: address(), agents: address(), syndicate: address(),
      treasury: address(), missionEscrow: address(), referralPool: address(), arena: address(), graduation: address(),
    };
    const recipient = address();
    const args = constructorArguments(contracts, 1_000_000_000n, recipient);
    expect(args.treasury).to.deep.equal([contracts.usdc, recipient]);
    expect(args.referralPool).to.deep.equal([contracts.usdc, contracts.agents, "1000000"]);
  });

  it("matches the committed Base build freeze against freshly compiled artifacts", function () {
    if (hre.__SOLIDITY_COVERAGE_RUNNING) this.skip();
    const freeze = loadBuildFreeze(projectRoot);
    const fresh = collectFreshBuildFingerprint(projectRoot, ethers);
    expect(() => assertBuildMatchesFreeze(fresh, freeze)).to.not.throw();
  });

  it("validates a generated fixture against schema v2 and the semantic validator", async function () {
    const [deployer] = await ethers.getSigners();
    const stack = await deployLocalStack(ethers, { protocolRecipient: deployer.address, graduationFloor: 1_000_000_000n });
    const contracts = {
      usdc: await stack.usdc.getAddress(),
      v2Factory: await stack.v2Factory.getAddress(),
      v2Router: await stack.v2Router.getAddress(),
      agents: stack.addresses.agents,
      arena: stack.addresses.arena,
      syndicate: stack.addresses.syndicate,
      treasury: stack.addresses.treasury,
      missionEscrow: stack.addresses.missionEscrow,
      referralPool: stack.addresses.referralPool,
      graduation: stack.addresses.graduation,
    };
    const runtimeBytecode = {};
    for (const key of CONTRACT_KEYS) {
      const code = await ethers.provider.getCode(contracts[key]);
      runtimeBytecode[key] = {
        address: contracts[key],
        bytes: (code.length - 2) / 2,
        keccak256: ethers.keccak256(code),
      };
    }
    const manifest = {
      manifestVersion: MANIFEST_VERSION,
      protocol: "versus-cypher",
      network: "hardhat",
      chainId: 31337,
      releaseStage: RELEASE_STAGES.TEST,
      source: fixtureSource(),
      contracts,
      constructorArguments: constructorArguments(contracts, 1_000_000_000n, deployer.address),
      economics: {
        protocolRecipient: deployer.address,
        graduationFloorRaw: "1000000000",
        referralRewardRaw: "1000000",
        protocolTrancheBps: 1000,
      },
      dependencies: {
        usdc: contracts.usdc,
        uniswapV2Factory: contracts.v2Factory,
        uniswapV2Router: contracts.v2Router,
      },
      compiler: {
        solidity: "0.8.26",
        optimizer: { enabled: true, runs: 1 },
        viaIR: true,
        evmVersion: "cancun",
      },
      transactions: stack.transactions,
      runtimeBytecode,
      verification: { basescan: { status: "not-applicable" }, independentAudit: { status: "pending" } },
      deployedAt: new Date().toISOString(),
    };

    const schema = JSON.parse(fs.readFileSync(path.join(projectRoot, "deployments", "schema-v2.json"), "utf8"));
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    expect(validate(manifest), JSON.stringify(validate.errors)).to.equal(true);
    expect(validateManifest(manifest)).to.deep.equal({ valid: true, errors: [] });

    const report = await auditDeployment(ethers.provider, manifest);
    expect(report.passed).to.equal(true);
    expect(report.checks.every((entry) => entry.passed)).to.equal(true);
  });

  it("independently audits a locally deployed ownerless stack", async function () {
    const [deployer] = await ethers.getSigners();
    const stack = await deployLocalStack(ethers, { protocolRecipient: deployer.address, graduationFloor: 1_000_000_000n });
    const contracts = {
      usdc: await stack.usdc.getAddress(),
      v2Factory: await stack.v2Factory.getAddress(),
      v2Router: await stack.v2Router.getAddress(),
      agents: stack.addresses.agents,
      arena: stack.addresses.arena,
      syndicate: stack.addresses.syndicate,
      treasury: stack.addresses.treasury,
      missionEscrow: stack.addresses.missionEscrow,
      referralPool: stack.addresses.referralPool,
      graduation: stack.addresses.graduation,
    };
    const runtimeBytecode = {};
    for (const key of CONTRACT_KEYS) {
      const code = await ethers.provider.getCode(contracts[key]);
      runtimeBytecode[key] = { address: contracts[key], bytes: (code.length - 2) / 2, keccak256: ethers.keccak256(code) };
    }
    const manifest = {
      manifestVersion: MANIFEST_VERSION,
      protocol: "versus-cypher",
      network: "hardhat",
      chainId: 31337,
      releaseStage: RELEASE_STAGES.TEST,
      source: fixtureSource(),
      contracts,
      constructorArguments: constructorArguments(contracts, 1_000_000_000n, deployer.address),
      economics: {
        protocolRecipient: deployer.address,
        graduationFloorRaw: "1000000000",
        referralRewardRaw: "1000000",
        protocolTrancheBps: 1000,
      },
      runtimeBytecode,
    };
    expect(validateManifest(manifest)).to.deep.equal({ valid: true, errors: [] });
    const report = await auditDeployment(ethers.provider, manifest);
    expect(report.passed).to.equal(true);
    expect(report.checks.every((entry) => entry.passed)).to.equal(true);
  });
});
