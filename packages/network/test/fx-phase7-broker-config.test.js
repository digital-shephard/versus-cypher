const assert = require("node:assert/strict");
const test = require("node:test");
const {
  publicTestnetProviderConfiguration,
} = require("../scripts/fx-phase7-broker");

const MANIFEST = {
  capabilities: [{ chainId: "84532" }, { chainId: "43113" }],
};

test("public broker pins Base Sepolia and Avalanche Fuji RPCs", () => {
  assert.deepEqual(
    publicTestnetProviderConfiguration(MANIFEST, {
      FX_X402_BASE_SEPOLIA_RPC_URL: "https://base.example",
      FX_X402_AVALANCHE_FUJI_RPC_URL: "https://fuji.example",
    }),
    {
      "43113": { chainId: 43113, url: "https://fuji.example" },
      "84532": { chainId: 84532, url: "https://base.example" },
    }
  );
});

test("public broker rejects a different chain cohort or a missing pinned RPC", () => {
  assert.throws(
    () => publicTestnetProviderConfiguration({
      capabilities: [{ chainId: "8453" }, { chainId: "43114" }],
    }, {}),
    /restricted to the frozen public testnets/
  );
  assert.throws(
    () => publicTestnetProviderConfiguration(MANIFEST, {
      FX_X402_BASE_SEPOLIA_RPC_URL: "https://base.example",
    }),
    /FX_X402_AVALANCHE_FUJI_RPC_URL is required/
  );
});
