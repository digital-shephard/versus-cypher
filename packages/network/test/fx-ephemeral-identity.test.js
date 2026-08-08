const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadOrCreateFxEphemeralIdentity } = require("../src");

test("ephemeral FX coordination identities are encrypted and recover across restart", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-fx-ephemeral-"));
  const filePath = path.join(directory, "identity.json");
  const password = "phase-six-test-password";
  const created = await loadOrCreateFxEphemeralIdentity({
    filePath,
    password,
    lifetimeSeconds: 600,
    now: () => 1_800_000_000,
  });
  const bytes = fs.readFileSync(filePath, "utf8");
  assert.equal(bytes.includes(created.wallet.privateKey), false);
  const recovered = await loadOrCreateFxEphemeralIdentity({
    filePath,
    password,
    lifetimeSeconds: 600,
    now: () => 1_800_000_100,
  });
  assert.equal(recovered.created, false);
  assert.equal(recovered.wallet.address, created.wallet.address);
});

test("expired FX coordination identities fail closed instead of silently rotating", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-fx-expired-"));
  const filePath = path.join(directory, "identity.json");
  const password = "phase-six-test-password";
  await loadOrCreateFxEphemeralIdentity({
    filePath,
    password,
    lifetimeSeconds: 60,
    now: () => 1_800_000_000,
  });
  await assert.rejects(
    loadOrCreateFxEphemeralIdentity({
      filePath,
      password,
      lifetimeSeconds: 60,
      now: () => 1_800_000_061,
    }),
    (error) => error.code === "EPHEMERAL_IDENTITY_EXPIRED"
  );
});
