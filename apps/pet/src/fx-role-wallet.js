const {
  Wallet,
  concat,
  getBytes,
  keccak256,
  toUtf8Bytes,
} = require("ethers");

const FX_WALLET_ROLES = Object.freeze([
  "requester",
  "dealer",
  "broker",
]);

function deriveFxRoleWallet(baseWallet, role) {
  if (!baseWallet?.privateKey) {
    throw new TypeError("base Cypher wallet is unavailable");
  }
  if (!FX_WALLET_ROLES.includes(role)) {
    throw new TypeError(`unsupported FX wallet role ${role}`);
  }
  const privateKey = keccak256(concat([
    getBytes(baseWallet.privateKey),
    toUtf8Bytes(`versus-cypher:agentic-fx:v1:${role}`),
  ]));
  return new Wallet(privateKey);
}

function fxRoleWalletProvider(baseWalletProvider) {
  if (typeof baseWalletProvider !== "function") {
    throw new TypeError("base wallet provider is required");
  }
  return (role = "requester") => {
    const wallet = deriveFxRoleWallet(baseWalletProvider(), role);
    return {
      address: wallet.address.toLowerCase(),
      privateKey: wallet.privateKey,
    };
  };
}

module.exports = {
  FX_WALLET_ROLES,
  deriveFxRoleWallet,
  fxRoleWalletProvider,
};
