const { expect } = require("chai");
const { artifacts, ethers } = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const {
  FxEvmAdapterError,
  preflightEvmCapability,
} = require("../../../packages/network/src/fx-evm-adapter");

const MIN_DURATION = 60;
const MAX_DURATION = 7 * 24 * 60 * 60;

async function deployManifest() {
  const Token = await ethers.getContractFactory("MockUSDC");
  const token = await Token.deploy();
  const Adapter = await ethers.getContractFactory("EvmHtlcV1");
  const adapter = await Adapter.deploy(
    await token.getAddress(),
    6,
    MIN_DURATION,
    MAX_DURATION
  );
  const artifact = await artifacts.readArtifact("EvmHtlcV1");
  const source = fs.readFileSync(
    path.join(__dirname, "..", "..", "contracts", "fx", "EvmHtlcV1.sol")
  );
  const chainId = (await ethers.provider.getNetwork()).chainId.toString();
  return {
    token,
    adapter,
    manifest: {
      schema: "versus-fx-adapter-capabilities",
      schemaVersion: 1,
      adapter: {
        id: "evm-htlc",
        version: 1,
        contract: "EvmHtlcV1",
        sourcePath: "versus/contracts/fx/EvmHtlcV1.sol",
      },
      build: {
        compiler: "0.8.26",
        evmVersion: "cancun",
        sourceTag: "agentic-fx-phase3-v1",
        optimizerRuns: 1,
        viaIR: true,
        sourceSha256: `0x${crypto.createHash("sha256").update(source).digest("hex")}`,
        creationCodeHash: ethers.keccak256(artifact.bytecode),
      },
      capabilities: [
        {
          chainId,
          adapterAddress: await adapter.getAddress(),
          runtimeCodeHash: ethers.keccak256(
            await ethers.provider.getCode(await adapter.getAddress())
          ),
          asset: {
            address: await token.getAddress(),
            runtimeCodeHash: ethers.keccak256(
              await ethers.provider.getCode(await token.getAddress())
            ),
            symbol: "USDC",
            decimals: 6,
            standard: "ERC20",
            features: {
              feeOnTransfer: false,
              rebasing: false,
              callbacks: false,
              issuerControls: "none",
            },
          },
          confirmationPolicy: {
            requiredConfirmations: 2,
            reorgSafetyBlocks: 6,
          },
          timeoutPolicy: {
            minimumSeconds: MIN_DURATION,
            maximumSeconds: MAX_DURATION,
            minimumCrossChainDeltaSeconds: 120,
          },
        },
      ],
    },
  };
}

describe("EvmHtlcV1 manifest preflight", function () {
  it("matches chain, token, runtime bytecode, decimals, and contract immutables", async function () {
    const { token, manifest } = await deployManifest();
    const capability = await preflightEvmCapability(ethers.provider, manifest, {
      chainId: 31337,
      token: await token.getAddress(),
      decimals: 6,
    });
    expect(capability.chainId).to.equal("31337");
  });

  it("fails an unsupported asset before making any provider call", async function () {
    const { manifest } = await deployManifest();
    let calls = 0;
    const provider = new Proxy(
      {},
      {
        get() {
          calls += 1;
          throw new Error("provider must not be touched");
        },
      }
    );
    let error;
    try {
      await preflightEvmCapability(provider, manifest, {
        chainId: 31337,
        token: "0x3000000000000000000000000000000000000003",
        decimals: 6,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(FxEvmAdapterError);
    expect(error.code).to.equal("UNSUPPORTED_ASSET");
    expect(calls).to.equal(0);
  });

  it("fails closed when deployed runtime bytecode differs", async function () {
    const { token, manifest } = await deployManifest();
    manifest.capabilities[0].runtimeCodeHash = `0x${"ff".repeat(32)}`;
    let error;
    try {
      await preflightEvmCapability(ethers.provider, manifest, {
        chainId: 31337,
        token: await token.getAddress(),
        decimals: 6,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(FxEvmAdapterError);
    expect(error.code).to.equal("BYTECODE_MISMATCH");
  });
});
