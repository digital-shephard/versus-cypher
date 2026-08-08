const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const V3 = require(path.resolve(
  __dirname,
  "../../../versus/deployments/fx/phase13-v3-exact-public-testnet.json"
));
const FACTORIES = require(path.resolve(
  __dirname,
  "../../../versus/deployments/fx/phase13-x402-exact-factories.json"
));
const LEGACY = require(path.resolve(
  __dirname,
  "../../../versus/deployments/fx/phase12-v3-public-testnet.json"
));

test("generic exact public-testnet cohort is frozen to official USDC and a new domain", () => {
  assert.equal(V3.deploymentId, FACTORIES.deploymentId);
  assert.notEqual(V3.deploymentId, LEGACY.deploymentId);
  assert.notEqual(V3.coordinationDomain, LEGACY.coordinationDomain);
  assert.deepEqual(
    V3.capabilities.map((item) => [item.chainId, item.erc20.asset.address]),
    [
      ["84532", "0x036cbd53842c5426634e7929541ec2318f3dcf7e"],
      ["421614", "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d"],
    ]
  );
  assert.deepEqual(
    FACTORIES.factories.map((item) => item.chainId),
    ["84532", "421614"]
  );
  for (const factory of FACTORIES.factories) {
    const capability = V3.capabilities.find((item) => item.chainId === factory.chainId);
    assert.equal(factory.asset, capability.erc20.asset.address);
    assert.equal(factory.htlcAddress, capability.erc20.adapterAddress);
    assert.match(factory.factoryRuntimeCodeHash, /^0x[0-9a-f]{64}$/);
  }
});
