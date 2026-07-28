const assert = require("node:assert/strict");
const test = require("node:test");
const { Wallet } = require("ethers");
const {
  deriveFxRoleWallet,
  fxRoleWalletProvider,
} = require("../src/fx-role-wallet");

test("FX requester dealer and broker wallets are deterministic and isolated", () => {
  const base = Wallet.createRandom();
  const requester = deriveFxRoleWallet(base, "requester");
  const dealer = deriveFxRoleWallet(base, "dealer");
  const broker = deriveFxRoleWallet(base, "broker");
  assert.equal(
    deriveFxRoleWallet(base, "requester").address,
    requester.address
  );
  assert.notEqual(requester.address, base.address);
  assert.notEqual(requester.address, dealer.address);
  assert.notEqual(requester.address, broker.address);
  assert.notEqual(dealer.address, broker.address);

  const provider = fxRoleWalletProvider(() => base);
  assert.equal(provider("requester").address, requester.address.toLowerCase());
  assert.equal(provider("dealer").address, dealer.address.toLowerCase());
});
