const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Wallet, hexlify, keccak256, randomBytes } = require("ethers");
const { x402Client } = require("@x402/core/client");
const { ExactEvmScheme } = require("@x402/evm/exact/client");
const { wrapFetchWithPayment } = require("@x402/fetch");

const TESTNETS = new Set(["eip155:84532", "eip155:421614"]);
const TERMINAL = new Set(["complete", "refunded", "defaulted"]);

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name, fallback = null) {
  const raw = String(process.env[name] || fallback || "");
  if (!/^[0-9]+$/.test(raw) || BigInt(raw) <= 0n) {
    throw new Error(`${name} must be a positive integer`);
  }
  return BigInt(raw).toString();
}

function milliseconds(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 250 || value > 30 * 60 * 1000) {
    throw new Error(`${name} is outside the safe range`);
  }
  return value;
}

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporary, filePath);
}

function clientSigner(wallet) {
  return {
    address: wallet.address,
    signTypedData: ({ domain, types, primaryType, message }) =>
      wallet.signTypedData(domain, { [primaryType]: types[primaryType] }, message),
  };
}

async function jsonResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`endpoint returned non-JSON status ${response.status}`);
  }
}

async function waitForStatus(endpoint, tradeId, predicate, { intervalMs, deadline }) {
  while (Date.now() < deadline) {
    const response = await fetch(`${endpoint}/${tradeId}`, {
      headers: { accept: "application/json" },
    });
    const body = await jsonResponse(response);
    if (!response.ok) {
      throw new Error(`status failed (${response.status}): ${body.error || body.message || "unknown"}`);
    }
    const swap = body.swap || {};
    if (predicate(swap)) return swap;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("timed out waiting for exact swap state");
}

async function main() {
  if (process.env.FX_X402_TESTNET_ONLY !== "1") {
    throw new Error("FX_X402_TESTNET_ONLY=1 is required");
  }
  const endpoint = required("FX_X402_EXACT_ENDPOINT").replace(/\/$/, "");
  const inputNetwork = required("FX_X402_EXACT_INPUT_NETWORK");
  const outputNetwork = required("FX_X402_EXACT_OUTPUT_NETWORK");
  if (!TESTNETS.has(inputNetwork) || !TESTNETS.has(outputNetwork)) {
    throw new Error("generic exact acceptance is restricted to the frozen public testnets");
  }
  if (inputNetwork === outputNetwork) {
    throw new Error("acceptance requires two distinct test networks");
  }

  const payer = await Wallet.fromEncryptedJson(
    fs.readFileSync(path.resolve(required("FX_X402_EXACT_PAYER_KEYSTORE")), "utf8"),
    required("FX_X402_EXACT_PAYER_KEYSTORE_PASSWORD")
  );
  const requestId = hexlify(randomBytes(32)).toLowerCase();
  const secret = hexlify(randomBytes(32)).toLowerCase();
  const request = {
    requestId,
    payer: payer.address,
    input: {
      network: inputNetwork,
      asset: required("FX_X402_EXACT_INPUT_ASSET"),
    },
    maximumInputAtomic: positiveInteger("FX_X402_EXACT_MAXIMUM_INPUT_ATOMIC"),
    output: {
      network: outputNetwork,
      asset: required("FX_X402_EXACT_OUTPUT_ASSET"),
      amountAtomic: positiveInteger("FX_X402_EXACT_OUTPUT_AMOUNT_ATOMIC"),
    },
    destinationAddress: required("FX_X402_EXACT_DESTINATION_ADDRESS"),
    secretHash: keccak256(secret),
  };
  const recoveryDirectory = path.resolve(required("FX_X402_EXACT_RECOVERY_DIR"));
  const recoveryPath = path.join(recoveryDirectory, `${requestId.slice(2)}.json`);
  const recoveryPassword = required("FX_X402_EXACT_RECOVERY_PASSWORD");
  const encryptedSecret = JSON.parse(await new Wallet(secret).encrypt(recoveryPassword));
  atomicWrite(recoveryPath, {
    schema: "versus-x402-exact-requester-recovery",
    schemaVersion: 1,
    request,
    secretKeystore: encryptedSecret,
    createdAt: new Date().toISOString(),
  });

  const client = new x402Client().register(
    inputNetwork,
    new ExactEvmScheme(clientSigner(payer))
  );
  const paidFetch = wrapFetchWithPayment(fetch, client);
  const paymentResponse = await paidFetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(request),
  });
  const paymentBody = await jsonResponse(paymentResponse);
  if (paymentResponse.status !== 202) {
    const reason = [paymentBody.error, paymentBody.message]
      .filter(Boolean)
      .join(": ") || "unknown";
    throw new Error(
      `exact payment failed (${paymentResponse.status}): ` +
      reason
    );
  }
  const source = paymentBody.swap || {};
  const intervalMs = milliseconds("FX_X402_EXACT_POLL_INTERVAL_MS", 2_000);
  const deadline = Date.now() + milliseconds("FX_X402_EXACT_TIMEOUT_MS", 10 * 60 * 1000);
  const destination = await waitForStatus(
    endpoint,
    requestId,
    (swap) => swap.status === "destination_locked" || TERMINAL.has(swap.status),
    { intervalMs, deadline }
  );
  if (destination.status !== "destination_locked") {
    throw new Error(`swap terminated before reveal: ${destination.status}`);
  }
  const revealResponse = await fetch(`${endpoint}/${requestId}/reveal`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ secret }),
  });
  const revealBody = await jsonResponse(revealResponse);
  if (revealResponse.status !== 202) {
    const reason = [revealBody.error, revealBody.message]
      .filter(Boolean)
      .join(": ") || "unknown";
    throw new Error(
      `reveal failed (${revealResponse.status}): ` +
      reason
    );
  }
  const completed = await waitForStatus(
    endpoint,
    requestId,
    (swap) => TERMINAL.has(swap.status),
    { intervalMs, deadline }
  );
  if (completed.status !== "complete") {
    throw new Error(`swap did not complete: ${completed.status}`);
  }
  atomicWrite(recoveryPath, {
    schema: "versus-x402-exact-requester-recovery",
    schemaVersion: 1,
    request,
    secretKeystore: encryptedSecret,
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    publicEvidence: completed,
  });
  process.stdout.write(`${JSON.stringify({
    schema: "versus-x402-exact-acceptance",
    schemaVersion: 1,
    endpoint,
    requestId,
    payer: payer.address.toLowerCase(),
    sourceTransaction: source.transaction || null,
    sourceEscrow: source.sourceEscrow || null,
    destinationTransaction: completed.destinationTransactionHash || null,
    facilitatorFeeAtomic: completed.input?.facilitatorFeeAtomic || null,
    dealerAmountAtomic: completed.input?.dealerAmountAtomic || null,
    outputAmountAtomic: completed.output?.amountAtomic || null,
    status: completed.status,
    recoveryPath,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
