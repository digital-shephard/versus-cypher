const { expect } = require("chai");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  waitForRuntimeCode,
} = require("../../scripts/fx/deploy-market-v3-testnet");
const {
  writeFrozenArtifact,
} = require("../../scripts/fx/assemble-market-v1-testnet");
const {
  networkFor,
  preflightMarketChainAcrossRpcs,
  readMarket,
  rpcUrlsFor,
} = require("../../scripts/fx/market-candidate-config");

function mainnetNetwork(chainId) {
  const market = readMarket(path.resolve(__dirname, "../.."), "mainnet");
  return networkFor(market, chainId);
}

describe("FX market deployment runtime visibility", function () {
  it("waits through stale empty-code reads after a confirmed deployment", async function () {
    const reads = ["0x", "0x", "0x6000"];
    const provider = {
      getCode: async () => reads.shift(),
    };

    expect(await waitForRuntimeCode(provider, "0x01", {
      attempts: 3,
      delayMs: 0,
    })).to.equal("0x6000");
    expect(reads).to.deep.equal([]);
  });

  it("fails closed when runtime code never becomes visible", async function () {
    const provider = {
      getCode: async () => "0x",
    };

    expect(await waitForRuntimeCode(provider, "0x01", {
      attempts: 3,
      delayMs: 0,
    })).to.equal("0x");
  });

  it("accepts an identical freeze rerun and rejects drift without overwriting", function () {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-fx-market-freeze-"));
    const outputPath = path.join(directory, "deployment.json");
    const frozen = '{"deploymentId":"0x01"}\n';

    expect(writeFrozenArtifact(outputPath, frozen)).to.equal("created");
    expect(writeFrozenArtifact(outputPath, frozen)).to.equal("unchanged");
    expect(() => writeFrozenArtifact(
      outputPath,
      '{"deploymentId":"0x02"}\n'
    )).to.throw("differs from frozen artifact");
    expect(fs.readFileSync(outputPath, "utf8")).to.equal(frozen);
  });

  it("accepts Windows checkout line endings without weakening byte checks", function () {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-fx-market-crlf-"));
    const outputPath = path.join(directory, "deployment.json");
    fs.writeFileSync(outputPath, '{\r\n  "deploymentId": "0x01"\r\n}\r\n');

    expect(writeFrozenArtifact(
      outputPath,
      '{\n  "deploymentId": "0x01"\n}\n'
    )).to.equal("unchanged-platform-eol");
    expect(() => writeFrozenArtifact(
      outputPath,
      '{\n  "deploymentId": "0x02"\n}\n'
    )).to.throw("differs from frozen artifact");
  });

  it("pins two production RPCs per mainnet chain", function () {
    expect(rpcUrlsFor(mainnetNetwork("8453"), {})).to.deep.equal([
      "https://base-rpc.publicnode.com",
      "https://base.drpc.org",
    ]);
    expect(rpcUrlsFor(mainnetNetwork("43114"), {})).to.deep.equal([
      "https://api.avax.network/ext/bc/C/rpc",
      "https://avalanche-c-chain-rpc.publicnode.com",
    ]);
  });

  it("requires identical mainnet preflight evidence from primary and fallback", async function () {
    const network = mainnetNetwork("8453");
    const calls = [];
    const result = await preflightMarketChainAcrossRpcs(network, {
      environment: {},
      providerFactory: (_network, rpcUrl) => ({ rpcUrl }),
      preflight: async (provider, network) => {
        calls.push(provider.rpcUrl);
        return { chainId: network.chainId, assets: ["USDC", "EURC"] };
      },
    });
    expect(calls).to.deep.equal(rpcUrlsFor(network, {}));
    expect(result.consensus).to.deep.equal({
      chainId: "8453",
      endpointCount: 2,
      identical: true,
    });
  });

  it("fails closed on a single mainnet RPC or divergent provider evidence", async function () {
    const network = mainnetNetwork("8453");
    await expect(preflightMarketChainAcrossRpcs(network, {
      environment: { BASE_RPC_URL: "https://only-one.invalid" },
    })).to.be.rejectedWith("requires pinned primary and fallback RPCs");

    let index = 0;
    await expect(preflightMarketChainAcrossRpcs(network, {
      environment: {},
      providerFactory: () => ({}),
      preflight: async () => ({ value: index++ }),
    })).to.be.rejectedWith("primary and fallback RPC preflight results differ");
  });
});
