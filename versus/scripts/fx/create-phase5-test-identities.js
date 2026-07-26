const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Wallet } = require("ethers");

const ROLES = ["deployer", "requester", "dealer", "relayer"];

function writePrivate(filePath, value) {
  fs.writeFileSync(filePath, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

async function main() {
  const root = path.resolve(__dirname, "..", "..", "..");
  const outputDirectory = path.resolve(
    process.env.FX_PHASE5_IDENTITY_DIRECTORY ||
      path.join(root, ".local", "fx-phase5-testnet")
  );
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(outputDirectory, 0o700); } catch {}

  const publicPath = path.join(outputDirectory, "identities.public.json");
  const passwordPath = path.join(outputDirectory, "identity-password.txt");
  if (
    fs.existsSync(publicPath) ||
    fs.existsSync(passwordPath) ||
    ROLES.some((role) =>
      fs.existsSync(path.join(outputDirectory, `${role}.keystore.json`))
    )
  ) {
    throw new Error(
      `Phase 5 identities already exist at ${outputDirectory}; refusing to replace them`
    );
  }

  const password = crypto.randomBytes(32).toString("base64url");
  writePrivate(passwordPath, `${password}\n`);
  const identities = {};
  for (const role of ROLES) {
    const wallet = Wallet.createRandom();
    const encrypted = await wallet.encrypt(password);
    writePrivate(
      path.join(outputDirectory, `${role}.keystore.json`),
      `${encrypted}\n`
    );
    identities[role] = wallet.address.toLowerCase();
  }
  const publicRecord = {
    schema: "versus-fx-phase5-test-identities",
    schemaVersion: 1,
    environment: "public-testnet",
    productionFunds: false,
    createdAt: new Date().toISOString(),
    identities,
  };
  fs.writeFileSync(publicPath, `${JSON.stringify(publicRecord, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  console.log(JSON.stringify({ outputDirectory, publicPath, identities }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
