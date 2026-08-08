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
});
