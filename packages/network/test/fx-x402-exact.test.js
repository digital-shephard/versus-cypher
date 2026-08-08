const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { Wallet, keccak256, toUtf8Bytes } = require("ethers");
const { x402Client, x402HTTPClient } = require("@x402/core/client");
const {
  decodePaymentRequiredHeader,
} = require("@x402/core/http");
const { ExactEvmScheme } = require("@x402/evm/exact/client");
const { wrapFetchWithPayment } = require("@x402/fetch");
const {
  FxX402ExactCoordinator,
  FxX402ExactStore,
  createFxX402ExactHttpHandler,
  verifyExactPayment,
} = require("../src/fx-x402-exact");

const NETWORK = "eip155:84532";
const ASSET = "0x1111111111111111111111111111111111111111";
const PAY_TO = "0x2222222222222222222222222222222222222222";
const TRANSACTION = `0x${"33".repeat(32)}`;
const TRADE_ID = `0x${"44".repeat(32)}`;
const SECRET = `0x${"55".repeat(32)}`;
const SECRET_HASH = keccak256(SECRET);

function clientSigner(wallet) {
  return {
    address: wallet.address,
    signTypedData: ({ domain, types, primaryType, message }) =>
      wallet.signTypedData(domain, { [primaryType]: types[primaryType] }, message),
  };
}

function requestBody(wallet) {
  return {
    requestId: `0x${"66".repeat(32)}`,
    payer: wallet.address,
    input: { network: NETWORK, asset: ASSET },
    output: {
      network: "eip155:421614",
      asset: "0x7777777777777777777777777777777777777777",
      amount: "995000",
    },
    destinationAddress: "0x8888888888888888888888888888888888888888",
    secretHash: SECRET_HASH,
    maximumInput: "1005000",
  };
}

let server;
let endpoint;
let wallet;
let coordinator;
let settled;
let revealed;

before(async () => {
  wallet = Wallet.createRandom();
  settled = [];
  revealed = [];
  coordinator = new FxX402ExactCoordinator({
    prepare: async (body) => ({
      tradeId: TRADE_ID,
      network: NETWORK,
      asset: ASSET,
      amount: "1005000",
      payTo: PAY_TO,
      payer: body.payer,
      maxTimeoutSeconds: 300,
      tokenName: "USD Coin",
      tokenVersion: "2",
      publicState: {
        output: body.output,
        destinationAddress: body.destinationAddress,
        secretHash: body.secretHash,
      },
    }),
    settle: async (input) => {
      settled.push(input);
      return {
        transaction: TRANSACTION,
        publicState: { sourceLock: PAY_TO },
      };
    },
    reveal: async ({ secret }) => {
      revealed.push(secret);
      return { status: "secret_revealed" };
    },
  });
  const handler = createFxX402ExactHttpHandler({ coordinator });
  server = http.createServer(async (request, response) => {
    if (!(await handler(request, response))) response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${server.address().port}/v1/fx/exact`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("a stock @x402/fetch exact client funds an atomic intent", async () => {
  const client = new x402Client().register(
    NETWORK,
    new ExactEvmScheme(clientSigner(wallet))
  );
  const paidFetch = wrapFetchWithPayment(fetch, client);
  const response = await paidFetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody(wallet)),
  });
  assert.equal(response.status, 202);
  assert.ok(response.headers.get("PAYMENT-RESPONSE"));
  const body = await response.json();
  assert.equal(body.swap.status, "source_confirmed");
  assert.equal(body.swap.transaction, TRANSACTION);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].authorization.from, wallet.address.toLowerCase());
  assert.equal(settled[0].authorization.to, PAY_TO);
  assert.equal(settled[0].authorization.value, "1005000");
});

test("identical retries reuse the prepared quote instead of creating another trade", async () => {
  const first = await coordinator.prepare(requestBody(wallet));
  const second = await coordinator.prepare(requestBody(wallet));
  assert.deepEqual(first, second);
  assert.equal(first.tradeId, TRADE_ID);
});

test("concurrent identical requests create only one dealer reservation", async () => {
  let preparations = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const isolated = new FxX402ExactCoordinator({
    prepare: async (body) => {
      preparations += 1;
      await gate;
      return {
        tradeId: body.requestId,
        network: NETWORK,
        asset: ASSET,
        amount: "1005000",
        payTo: PAY_TO,
        payer: body.payer,
        tokenName: "USD Coin",
        tokenVersion: "2",
      };
    },
    settle: async () => ({ transaction: TRANSACTION }),
  });
  const body = requestBody(wallet);
  const first = isolated.prepare(body);
  const second = isolated.prepare(structuredClone(body));
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.deepEqual(left, right);
  assert.equal(preparations, 1);
});

test("a request ID cannot reserve two different generic intents", async () => {
  const isolated = new FxX402ExactCoordinator({
    prepare: async (body) => ({
      tradeId: body.requestId,
      network: NETWORK,
      asset: ASSET,
      amount: "1005000",
      payTo: PAY_TO,
      payer: body.payer,
      tokenName: "USD Coin",
      tokenVersion: "2",
    }),
    settle: async () => ({ transaction: TRANSACTION }),
  });
  const original = requestBody(wallet);
  await isolated.prepare(original);
  await assert.rejects(
    isolated.prepare({
      ...original,
      maximumInput: "9999999",
    }),
    (error) => error.code === "TRADE_CONFLICT"
  );
});

test("the standard payment cannot be replayed into changed requirements", async () => {
  const state = await coordinator.prepare(requestBody(wallet));
  const initial = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody(wallet)),
  });
  const challenge = decodePaymentRequiredHeader(
    initial.headers.get("PAYMENT-REQUIRED")
  );
  const client = new x402Client().register(
    NETWORK,
    new ExactEvmScheme(clientSigner(wallet))
  );
  const payment = await new x402HTTPClient(client).createPaymentPayload(challenge);
  payment.accepted = { ...payment.accepted, amount: "1005001" };
  assert.throws(
    () => verifyExactPayment({
      payment,
      state,
      now: Math.floor(Date.now() / 1000),
    }),
    (error) => error.code === "REQUIREMENT_MISMATCH"
  );
});

test("a payment signed for another deterministic payTo is rejected", async () => {
  const state = await coordinator.prepare(requestBody(wallet));
  const initial = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody(wallet)),
  });
  const challenge = decodePaymentRequiredHeader(
    initial.headers.get("PAYMENT-REQUIRED")
  );
  challenge.accepts[0] = {
    ...challenge.accepts[0],
    payTo: "0x9999999999999999999999999999999999999999",
  };
  const client = new x402Client().register(
    NETWORK,
    new ExactEvmScheme(clientSigner(wallet))
  );
  const payment = await new x402HTTPClient(client).createPaymentPayload(challenge);
  payment.accepted = { ...payment.accepted, payTo: state.payTo };
  assert.throws(
    () => verifyExactPayment({
      payment,
      state,
      now: Math.floor(Date.now() / 1000),
    }),
    (error) => error.code === "AUTHORIZATION_MISMATCH"
  );
});

test("expired standard authorizations fail before settlement", async () => {
  const state = await coordinator.prepare(requestBody(wallet));
  const initial = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody(wallet)),
  });
  const challenge = decodePaymentRequiredHeader(
    initial.headers.get("PAYMENT-REQUIRED")
  );
  const client = new x402Client().register(
    NETWORK,
    new ExactEvmScheme(clientSigner(wallet))
  );
  const payment = await new x402HTTPClient(client).createPaymentPayload(challenge);
  assert.throws(
    () => verifyExactPayment({ payment, state, now: state.expiresAt + 1 }),
    (error) => error.code === "PAYMENT_EXPIRED"
  );
});

test("an external agent can reveal after the exact source lock confirms", async () => {
  const response = await fetch(`${endpoint}/${TRADE_ID}/reveal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: SECRET }),
  });
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.swap.status, "secret_revealed");
  assert.deepEqual(revealed, [SECRET]);
});

test("prepared and settled intents survive restart without storing secrets", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-x402-exact-"));
  try {
    const state = await coordinator.prepare(requestBody(wallet));
    const store = new FxX402ExactStore({ directory });
    store.put(state);
    const restored = new FxX402ExactStore({ directory });
    assert.equal(restored.get(TRADE_ID).payTo, PAY_TO);
    assert.equal(restored.getByRequest(state.requestKey).tradeId, TRADE_ID);
    assert.throws(
      () => store.put({
        ...state,
        tradeId: `0x${"ab".repeat(32)}`,
        requestKey: `0x${"ac".repeat(32)}`,
        privateState: { secret: SECRET },
      }),
      (error) => error.code === "UNSAFE_PERSISTENCE"
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
