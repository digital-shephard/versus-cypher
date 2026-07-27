const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const DEPLOYMENT_ID =
  "0xd0935aa32dc4d37e33180ac9409c993b7bf39749ff375df4da033bd106c0983e";
const TEST_TOKEN = "0xcba3d9354dd4c30bb6961abb4473a6340486e01b";
const DEALER_SETTLEMENT_ADDRESS =
  "0x3550648bd09c4f6acd3782433fcbdb85abcc8bf7";

function delayFromEnvironment(environment = process.env) {
  const value = Number(environment.FX_PHASE6_ARM_DELAY_MS || 30_000);
  if (!Number.isSafeInteger(value) || value < 0 || value > 300_000) {
    throw new Error("FX_PHASE6_ARM_DELAY_MS must be between 0 and 300000");
  }
  return value;
}

function labEnvironment({
  environment = process.env,
  homeDirectory = os.homedir(),
  timestamp = Date.now(),
} = {}) {
  const dataDirectory =
    environment.FX_PHASE6_DATA_DIR ||
    path.join(
      homeDirectory,
      "Library",
      "Application Support",
      "Versus Cypher",
      `fx-phase6-dealer-${timestamp}`
    );
  const result = {
    ...environment,
    FX_PHASE6_ROLE: "dealer",
    FX_PHASE6_DEPLOYMENT_ID: DEPLOYMENT_ID,
    FX_PHASE6_DATA_DIR: dataDirectory,
    FX_PHASE6_COORDINATION_PASSWORD:
      environment.FX_PHASE6_COORDINATION_PASSWORD ||
      crypto.randomBytes(32).toString("hex"),
    FX_PHASE6_INPUT_CHAIN_ID: "84532",
    FX_PHASE6_INPUT_TOKEN: TEST_TOKEN,
    FX_PHASE6_INPUT_AMOUNT_ATOMIC: "10000",
    FX_PHASE6_SOURCE_CLAIM_ADDRESS: DEALER_SETTLEMENT_ADDRESS,
    FX_PHASE6_DESTINATION_REFUND_ADDRESS: DEALER_SETTLEMENT_ADDRESS,
    FX_PHASE6_REFERENCE_SOURCE: "phase6:public-testnet-manifest",
    FX_PHASE6_REFERENCE_PRICE_MICROS: "1000000",
    FX_PHASE6_SPREAD_BPS: "0",
  };
  for (const name of [
    "FX_PHASE6_SETTLE",
    "FX_PHASE6_PRIVATE_KEY",
    "FX_PHASE6_KEYSTORE",
    "FX_PHASE6_COORDINATION_KEYSTORE",
  ]) {
    delete result[name];
  }
  return result;
}

function signalExitCode(signal) {
  return signal === "SIGINT" ? 130 : 143;
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("the Phase 6 Mac dealer launcher only runs on macOS");
  }
  const delayMs = delayFromEnvironment();
  const environment = labEnvironment();
  let child = null;
  let cancelDelay = () => {};
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    process.exitCode = signalExitCode(signal);
    cancelDelay();
    if (child && child.exitCode === null && !child.killed) {
      child.kill(signal);
    }
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.stdout.write(`${JSON.stringify({
    event: "mac-dealer:armed",
    delayMs,
    startsAt: new Date(Date.now() + delayMs).toISOString(),
    dataDirectory: environment.FX_PHASE6_DATA_DIR,
    testnetOnly: true,
    settlementEnabled: false,
  })}\n`);
  const shouldStart = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(true), delayMs);
    cancelDelay = () => {
      clearTimeout(timer);
      resolve(false);
    };
  });
  if (!shouldStart || stopping) return;
  child = spawn(
    process.execPath,
    [path.join(__dirname, "fx-phase6-headless.js")],
    {
      env: environment,
      stdio: "inherit",
    }
  );
  child.once("error", (error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (signal) {
      process.exitCode = signalExitCode(signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEALER_SETTLEMENT_ADDRESS,
  DEPLOYMENT_ID,
  TEST_TOKEN,
  delayFromEnvironment,
  labEnvironment,
  signalExitCode,
};
