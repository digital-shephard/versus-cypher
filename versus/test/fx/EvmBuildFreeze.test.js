const { expect } = require("chai");
const fs = require("node:fs");
const path = require("node:path");
const Ajv2020 = require("ajv/dist/2020");

const { buildFreezeRecord } = require("../../scripts/fx/build-freeze");
const {
  validateEvmAdapterManifest,
} = require("../../../packages/network/src/fx-evm-adapter");

describe("EvmHtlcV1 reproducible build freeze", function () {
  it("recomputes identical bytecode and source evidence", function () {
    const root = path.resolve(__dirname, "..", "..");
    const first = buildFreezeRecord(root);
    const second = buildFreezeRecord(root);
    expect(second).to.deep.equal(first);
    expect(first.adapter).to.deep.include({
      id: "evm-htlc",
      version: 1,
      contract: "EvmHtlcV1",
    });
    expect(first.compiler).to.deep.include({
      version: "0.8.26",
      evmVersion: "cancun",
      viaIR: true,
    });
    expect(first.creationCodeHash).to.match(/^0x[0-9a-f]{64}$/);
    expect(first.sourceSha256).to.match(/^0x[0-9a-f]{64}$/);
  });

  it("validates the frozen Phase 3 capability fixture against its JSON schema", function () {
    const repositoryRoot = path.resolve(__dirname, "..", "..", "..");
    const schema = JSON.parse(
      fs.readFileSync(
        path.join(repositoryRoot, "docs", "fx", "schemas", "adapter-capability-v1.schema.json"),
        "utf8"
      )
    );
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(
          repositoryRoot,
          "packages",
          "network",
          "fixtures",
          "fx-phase3-adapter-manifest.json"
        ),
        "utf8"
      )
    );
    const validate = new Ajv2020({ allErrors: true }).compile(schema);
    expect(validate(manifest), JSON.stringify(validate.errors)).to.equal(true);

    const localDeployment = JSON.parse(
      fs.readFileSync(
        path.join(
          repositoryRoot,
          "versus",
          "deployments",
          "fx",
          "localhost-31337-evm-htlc-v1.json"
        ),
        "utf8"
      )
    );
    expect(validate(localDeployment), JSON.stringify(validate.errors)).to.equal(true);
    expect(validateEvmAdapterManifest(localDeployment)).to.deep.equal(
      validateEvmAdapterManifest(manifest)
    );
  });
});
