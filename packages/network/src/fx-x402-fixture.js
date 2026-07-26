const http = require("node:http");
const { keccak256, toUtf8Bytes } = require("ethers");
const { canonicalJson } = require("./fx-protocol");
const {
  FX_PHASE4_OUTPUT_TOKEN,
  FX_PHASE4_SCHEME,
} = require("./fx-phase4");

const PAYMENT_REQUIRED = "PAYMENT-REQUIRED";
const PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";
const PAYMENT_RESPONSE = "PAYMENT-RESPONSE";

class FxX402FixtureError extends Error {
  constructor(message, code = "FX_X402_FIXTURE_ERROR") {
    super(message);
    this.name = "FxX402FixtureError";
    this.code = code;
  }
}

function base64Json(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function parseBase64Json(value, label) {
  try {
    return JSON.parse(Buffer.from(String(value || ""), "base64").toString("utf8"));
  } catch {
    throw new FxX402FixtureError(`${label} is not valid base64 JSON`);
  }
}

function buildControlledRequirement({
  resource = "/weather",
  outputAmountAtomic,
  outputRecipient,
  paymentId,
  description = "Controlled Versus Phase 4 x402 fixture",
}) {
  const normalizedPaymentId = String(paymentId || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalizedPaymentId)) {
    throw new FxX402FixtureError("paymentId must be a unique bytes32 value");
  }
  const requirement = {
    x402Version: 2,
    scheme: FX_PHASE4_SCHEME,
    network: "eip155:8453",
    asset: FX_PHASE4_OUTPUT_TOKEN,
    amount: BigInt(outputAmountAtomic).toString(),
    payTo: String(outputRecipient).toLowerCase(),
    maxTimeoutSeconds: 20,
    resource,
    description,
    extensions: {
      paymentIdentifier: normalizedPaymentId,
    },
  };
  return {
    requirement,
    commitment: keccak256(toUtf8Bytes(canonicalJson(requirement))),
  };
}

function createControlledX402Fixture({
  requirement,
  commitment,
  verifySettlement,
  resourceBody = { temperature: 72, unit: "F", source: "versus-phase4" },
}) {
  if (typeof verifySettlement !== "function") {
    throw new TypeError("verifySettlement is required");
  }
  const server = http.createServer(async (request, response) => {
    try {
      if (request.url !== requirement.resource || request.method !== "GET") {
        response.writeHead(404).end();
        return;
      }
      const proofHeader = request.headers[PAYMENT_SIGNATURE.toLowerCase()];
      if (!proofHeader) {
        response.writeHead(402, {
          "content-type": "application/json",
          [PAYMENT_REQUIRED]: base64Json({
            x402Version: 2,
            accepts: [requirement],
          }),
        });
        response.end(JSON.stringify({ error: "payment_required" }));
        return;
      }

      const proof = parseBase64Json(proofHeader, PAYMENT_SIGNATURE);
      if (
        proof.scheme !== FX_PHASE4_SCHEME ||
        String(proof.paymentCommitment || "").toLowerCase() !== commitment
      ) {
        throw new FxX402FixtureError("payment proof does not bind this requirement");
      }
      const settlement = await verifySettlement(proof);
      if (
        settlement.confirmed !== true ||
        BigInt(settlement.outputAmountAtomic) !== BigInt(requirement.amount) ||
        String(settlement.outputRecipient).toLowerCase() !== requirement.payTo ||
        String(settlement.paymentCommitment).toLowerCase() !== commitment
      ) {
        throw new FxX402FixtureError("settlement does not satisfy exact payment");
      }

      response.writeHead(200, {
        "content-type": "application/json",
        [PAYMENT_RESPONSE]: base64Json({
          success: true,
          network: requirement.network,
          transaction: proof.transactionHash,
          payer: settlement.buyer,
        }),
      });
      response.end(JSON.stringify(resourceBody));
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.code || "invalid_payment" }));
    }
  });

  return {
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      return `http://127.0.0.1:${address.port}${requirement.resource}`;
    },
    async close() {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    },
  };
}

module.exports = {
  PAYMENT_REQUIRED,
  PAYMENT_RESPONSE,
  PAYMENT_SIGNATURE,
  FxX402FixtureError,
  base64Json,
  buildControlledRequirement,
  createControlledX402Fixture,
  parseBase64Json,
};
