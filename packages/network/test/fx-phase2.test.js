const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { getAddress, keccak256 } = require("ethers");
const {
  FxTradeJournal,
  computeFxActionNullifier,
} = require("../src/fx-journal");
const {
  createFxRecoveryPacket,
  restoreFxRecoveryPacket,
} = require("../src/fx-recovery");
const {
  FxDeterministicSimulator,
  deterministicAddress,
  deterministicHash,
} = require("../src/fx-simulator");
const { selectSingleDealerRoute } = require("../src/fx-protocol");

function temporaryRun(seed = "phase-two") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-fx-phase2-"));
  const deploymentId = deterministicHash("phase-two-deployment");
  const journalPath = path.join(directory, "journal.sqlite");
  const recoveryDirectory = path.join(directory, "recovery");
  const stateFile = path.join(directory, "simulator.json");
  const journal = new FxTradeJournal({ filePath: journalPath, deploymentId });
  const simulator = new FxDeterministicSimulator({
    seed,
    journal,
    recoveryDirectory,
    stateFile,
    gitCommit: "phase-two-test",
  });
  return {
    directory,
    deploymentId,
    journalPath,
    recoveryDirectory,
    stateFile,
    journal,
    simulator,
  };
}

function restart(run) {
  run.journal.close();
  run.journal = new FxTradeJournal({
    filePath: run.journalPath,
    deploymentId: run.deploymentId,
  });
  run.simulator = new FxDeterministicSimulator({
    seed: run.simulator.seed,
    journal: run.journal,
    recoveryDirectory: run.recoveryDirectory,
    stateFile: run.stateFile,
    gitCommit: "phase-two-test",
  });
  return run;
}

function cleanup(run) {
  try { run.journal.close(); } catch (_) {}
  fs.rmSync(run.directory, { recursive: true, force: true });
}

async function reachReservation(run, label = "trade") {
  let trade = run.simulator.newTrade(label);
  await run.simulator.openRfq(trade);
  await run.simulator.quote(trade);
  await run.simulator.accept(trade);
  await run.simulator.reserve(trade);
  return trade;
}

test("settles exact principal and fee while surviving restart at every transition", async () => {
  const run = temporaryRun("restart-every-transition");
  try {
    let trade = run.simulator.newTrade("happy");
    const steps = [
      "openRfq",
      "quote",
      "accept",
      "reserve",
      "fundSource",
      "fundDestination",
      "claimDestination",
      "claimSource",
      "complete",
    ];
    for (const step of steps) {
      await run.simulator[step](trade);
      const before = run.journal.snapshot(trade.tradeId);
      restart(run);
      trade = run.simulator.trades.get(trade.tradeId);
      const after = run.journal.snapshot(trade.tradeId);
      assert.equal(after.stateHash, before.stateHash);
    }

    assert.equal(run.journal.snapshot(trade.tradeId).settlementState, "complete");
    assert.equal(
      run.simulator.inventory(
        "requester",
        run.simulator.sourceChainId,
        run.simulator.sourceToken
      ),
      "898750"
    );
    assert.equal(
      run.simulator.inventory(
        "requester",
        run.simulator.destinationChainId,
        run.simulator.destinationToken
      ),
      "100000"
    );
    assert.equal(
      run.simulator.inventory(
        "dealer",
        run.simulator.sourceChainId,
        run.simulator.sourceToken
      ),
      "101000"
    );
    assert.equal(
      run.simulator.inventory(
        "broker",
        run.simulator.sourceChainId,
        run.simulator.sourceToken
      ),
      "250"
    );
    const report = run.simulator.report("happy-restart");
    assert.equal(report.metrics.feesMovedAtomic, "250");
    assert.doesNotMatch(JSON.stringify(report), /privateKey|"secret":/);
  } finally {
    cleanup(run);
  }
});

test("restart reconciles a prepared message that crashed before journal admission", async () => {
  const run = temporaryRun("crash-before-admission");
  try {
    const trade = run.simulator.newTrade("prepared-rfq");
    run.journal.apply = () => {
      throw new Error("simulated process crash");
    };
    await assert.rejects(run.simulator.openRfq(trade), /simulated process crash/);
    restart(run);
    assert.equal(
      run.journal.snapshot(trade.tradeId).settlementState,
      "rfq_open"
    );
    assert.equal(
      run.simulator.events.at(-1).type,
      "restart_reconciled"
    );
  } finally {
    cleanup(run);
  }
});

test("crash after admission cannot duplicate principal or broker fee", async () => {
  const run = temporaryRun("crash-after-admission");
  try {
    let trade = await reachReservation(run, "post-admission");
    const realApply = run.journal.apply.bind(run.journal);
    run.journal.apply = (...arguments_) => {
      realApply(...arguments_);
      throw new Error("simulated process crash");
    };
    await assert.rejects(
      run.simulator.fundSource(trade),
      /simulated process crash/
    );
    const fundedBalance = run.simulator.inventory(
      "requester",
      run.simulator.sourceChainId,
      run.simulator.sourceToken
    );
    restart(run);
    trade = run.simulator.trades.get(trade.tradeId);
    await run.simulator.fundSource(trade);
    assert.equal(
      run.simulator.inventory(
        "requester",
        run.simulator.sourceChainId,
        run.simulator.sourceToken
      ),
      fundedBalance
    );

    await run.simulator.fundDestination(trade);
    await run.simulator.claimDestination(trade);
    const realClaimApply = run.journal.apply.bind(run.journal);
    run.journal.apply = (...arguments_) => {
      realClaimApply(...arguments_);
      throw new Error("simulated process crash");
    };
    await assert.rejects(
      run.simulator.claimSource(trade),
      /simulated process crash/
    );
    restart(run);
    trade = run.simulator.trades.get(trade.tradeId);
    await run.simulator.claimSource(trade);
    assert.equal(
      run.simulator.inventory(
        "broker",
        run.simulator.sourceChainId,
        run.simulator.sourceToken
      ),
      "250"
    );
  } finally {
    cleanup(run);
  }
});

test("durable sequence reservations and economic nullifiers reject replay", async () => {
  const run = temporaryRun("replay");
  try {
    const trade = run.simulator.newTrade("replay");
    const rfq = await run.simulator.openRfq(trade);
    assert.equal(run.journal.apply(rfq, { temporal: false }).status, "duplicate");
    await run.simulator.quote(trade);
    const accept = await run.simulator.accept(trade);
    restart(run);
    const restored = run.simulator.trades.get(trade.tradeId);
    const replay = await run.simulator.signed(
      "fx_accept",
      restored.tradeId,
      accept.payload,
      { actor: "requester" }
    );
    assert.throws(
      () => run.journal.apply(replay, { temporal: false }),
      (error) => error.code === "ACTION_REPLAY"
    );
    const reserved = BigInt(replay.sequence);
    restart(run);
    const next = BigInt(
      run.journal.reserveSequence(
        restored.tradeId,
        run.simulator.actor("requester").address
      )
    );
    assert.equal(next, reserved + 1n);
  } finally {
    cleanup(run);
  }
});

test("economic nullifiers are scoped to both deployment and trade", async () => {
  const run = temporaryRun("nullifier-scope");
  try {
    const trade = run.simulator.newTrade("nullifier");
    const rfq = await run.simulator.openRfq(trade);
    const baseline = computeFxActionNullifier(rfq);
    assert.notEqual(
      baseline,
      computeFxActionNullifier({
        ...rfq,
        deploymentId: deterministicHash("another-deployment"),
      })
    );
    assert.notEqual(
      baseline,
      computeFxActionNullifier({
        ...rfq,
        tradeId: deterministicHash("another-trade"),
      })
    );
  } finally {
    cleanup(run);
  }
});

test("both abandonment paths refund every unit of funded principal", async () => {
  for (const destinationFunded of [false, true]) {
    const run = temporaryRun(`refund-${destinationFunded}`);
    try {
      let trade = await reachReservation(run, `refund-${destinationFunded}`);
      await run.simulator.fundSource(trade);
      if (destinationFunded) {
        await run.simulator.fundDestination(trade);
        await run.simulator.refundDestination(trade);
      }
      await run.simulator.refundSource(trade);
      restart(run);
      trade = run.simulator.trades.get(trade.tradeId);
      assert.equal(run.journal.snapshot(trade.tradeId).settlementState, "refunded");
      assert.equal(
        run.simulator.inventory(
          "requester",
          run.simulator.sourceChainId,
          run.simulator.sourceToken
        ),
        "1000000"
      );
      assert.equal(
        run.simulator.inventory(
          "dealer",
          run.simulator.destinationChainId,
          run.simulator.destinationToken
        ),
        "1000000"
      );
      assert.equal(
        run.simulator.inventory(
          "broker",
          run.simulator.sourceChainId,
          run.simulator.sourceToken
        ),
        "0"
      );
    } finally {
      cleanup(run);
    }
  }
});

test("a dealer disappearance after counter-lock cannot strand requester output", async () => {
  const run = temporaryRun("dealer-after-lock");
  try {
    const trade = await reachReservation(run);
    await run.simulator.fundSource(trade);
    await run.simulator.fundDestination(trade);
    await run.simulator.claimDestination(trade);
    restart(run);
    const restored = run.simulator.trades.get(trade.tradeId);
    await run.simulator.claimSource(restored);
    await run.simulator.complete(restored);
    assert.equal(run.journal.snapshot(trade.tradeId).settlementState, "complete");
  } finally {
    cleanup(run);
  }
});

test("wrong lock construction is rejected before counterparty inventory moves", async () => {
  const mutations = [
    { chainId: "1" },
    { token: deterministicAddress("wrong-token") },
    { amountAtomic: "99999" },
    { beneficiary: deterministicAddress("wrong-beneficiary") },
    { refundAddress: deterministicAddress("wrong-refund") },
    { secretHash: deterministicHash("wrong-secret") },
    { timeout: 1_800_100_001 },
    { adapterId: "wrong-adapter" },
    { adapterVersion: 2 },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const run = temporaryRun(`bad-lock-${index}`);
    try {
      const trade = await reachReservation(run, `bad-lock-${index}`);
      const before = run.simulator.inventory(
        "requester",
        run.simulator.sourceChainId,
        run.simulator.sourceToken
      );
      await assert.rejects(
        run.simulator.fundSource(trade, { mutate }),
        (error) => error.code === "MALFORMED_LOCK"
      );
      assert.equal(
        run.simulator.inventory(
          "requester",
          run.simulator.sourceChainId,
          run.simulator.sourceToken
        ),
        before
      );
      assert.equal(run.simulator.chain.locks.size, 0);
    } finally {
      cleanup(run);
    }
  }
});

test("malformed destination evidence is rejected before dealer inventory moves", async () => {
  const mutations = [
    { chainId: "10" },
    { token: deterministicAddress("wrong-destination-token") },
    { amountAtomic: "99999" },
    { beneficiary: deterministicAddress("wrong-destination-beneficiary") },
    { refundAddress: deterministicAddress("wrong-destination-refund") },
    { secretHash: deterministicHash("wrong-destination-secret") },
    { timeout: 1_800_100_001 },
    { adapterId: "wrong-destination-adapter" },
    { adapterVersion: 2 },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const run = temporaryRun(`bad-destination-${index}`);
    try {
      const trade = await reachReservation(run, `bad-destination-${index}`);
      await run.simulator.fundSource(trade);
      const before = run.simulator.inventory(
        "dealer",
        run.simulator.destinationChainId,
        run.simulator.destinationToken
      );
      await assert.rejects(
        run.simulator.fundDestination(trade, { mutate }),
        (error) => error.code === "MALFORMED_LOCK"
      );
      assert.equal(
        run.simulator.inventory(
          "dealer",
          run.simulator.destinationChainId,
          run.simulator.destinationToken
        ),
        before
      );
      assert.equal(run.simulator.chain.locks.size, 1);
    } finally {
      cleanup(run);
    }
  }
  const run = temporaryRun("unsafe-timeout-order");
  try {
    const trade = await reachReservation(run, "unsafe-timeout-order");
    await run.simulator.fundSource(trade);
    const before = run.simulator.inventory(
      "dealer",
      run.simulator.destinationChainId,
      run.simulator.destinationToken
    );
    await assert.rejects(
      run.simulator.fundDestination(trade, { timeoutSeconds: 4000 }),
      (error) => error.code === "MALFORMED_LOCK"
    );
    assert.equal(
      run.simulator.inventory(
        "dealer",
        run.simulator.destinationChainId,
        run.simulator.destinationToken
      ),
      before
    );
  } finally {
    cleanup(run);
  }
});

test("confirmation delay blocks evidence until the configured depth", () => {
  const run = temporaryRun("confirmations");
  try {
    const lockId = deterministicHash("manual-lock");
    const candidate = {
      id: lockId,
      chainId: run.simulator.sourceChainId,
      token: run.simulator.sourceToken,
      amountAtomic: "1",
      funder: run.simulator.actor("requester").address.toLowerCase(),
      beneficiary: run.simulator.actor("dealer").address,
      refundAddress: run.simulator.actor("requester").address,
      secretHash: deterministicHash("secret"),
      timeout: run.simulator.time + 100,
      adapterId: "sim-htlc-v1",
      adapterVersion: 1,
    };
    run.simulator.chain.fund(candidate);
    assert.throws(
      () => run.simulator.chain.verify(lockId, { beneficiary: candidate.beneficiary }),
      (error) => error.code === "UNCONFIRMED_LOCK"
    );
    run.simulator.chain.mine(candidate.chainId);
    assert.equal(
      run.simulator.chain.verify(lockId, {
        beneficiary: getAddress(candidate.beneficiary).toLowerCase(),
      }).id,
      lockId
    );
  } finally {
    cleanup(run);
  }
});

test("route recomputation rejects stale or modified quotes and defeats hiding by union", async () => {
  const run = temporaryRun("broker-manipulation");
  try {
    const trade = run.simulator.newTrade("broker");
    const rfq = await run.simulator.openRfq(trade);
    const expensive = await run.simulator.quote(trade, {
      inputAmountAtomic: "102000",
    });
    const cheap = await run.simulator.quote(trade, {
      inputAmountAtomic: "100500",
      messageKey: "betterQuote",
    });
    const hidden = selectSingleDealerRoute(
      rfq,
      [{ quote: expensive, brokerFeeAtomic: "250" }],
      { now: run.simulator.time }
    );
    const independentlyCombined = selectSingleDealerRoute(
      rfq,
      [
        { quote: expensive, brokerFeeAtomic: "250" },
        { quote: cheap, brokerFeeAtomic: "250" },
      ],
      { now: run.simulator.time }
    );
    assert.equal(hidden.quoteId, expensive.id);
    assert.equal(independentlyCombined.quoteId, cheap.id);

    const changed = structuredClone(cheap);
    changed.payload.inputAmountAtomic = "1";
    assert.throws(
      () =>
        selectSingleDealerRoute(
          rfq,
          [{ quote: changed, brokerFeeAtomic: "250" }],
          { now: run.simulator.time }
        ),
      (error) => ["BAD_ID", "BAD_SIGNATURE", "NO_VALID_ROUTE"].includes(error.code)
    );
    assert.throws(
      () =>
        selectSingleDealerRoute(
          rfq,
          [{ quote: cheap, brokerFeeAtomic: "250" }],
          { now: cheap.payload.referenceTimestamp + 61 }
        ),
      (error) =>
        ["NO_VALID_ROUTE", "EXPIRED_MESSAGE", "STALE_REFERENCE"].includes(error.code)
    );
  } finally {
    cleanup(run);
  }
});

test("encrypted recovery is trade-bound, crash-safe, and corruption fails closed", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versus-fx-recovery-"));
  try {
    const filePath = path.join(directory, "packet.json");
    const secret = Buffer.alloc(32, 7);
    const deploymentId = deterministicHash("recovery-deployment");
    const tradeId = deterministicHash("recovery-trade");
    const created = createFxRecoveryPacket({
      filePath,
      password: "correct horse battery staple",
      deploymentId,
      tradeId,
      createdAt: 1_800_100_000,
      secret,
    });
    const serialized = fs.readFileSync(filePath, "utf8");
    assert.doesNotMatch(serialized, new RegExp(secret.toString("base64")));
    assert.deepEqual(
      restoreFxRecoveryPacket({
        filePath,
        password: "correct horse battery staple",
        deploymentId,
        tradeId,
      }).secret,
      secret
    );
    assert.throws(
      () =>
        restoreFxRecoveryPacket({
          filePath,
          password: "wrong-password-value",
          deploymentId,
          tradeId,
        }),
      (error) => error.code === "CORRUPT_PACKET"
    );
    const packet = JSON.parse(serialized);
    packet.ciphertext = `${packet.ciphertext.slice(0, -2)}AA`;
    fs.writeFileSync(filePath, JSON.stringify(packet));
    assert.throws(
      () =>
        restoreFxRecoveryPacket({
          filePath,
          password: "correct horse battery staple",
          deploymentId,
          tradeId,
        }),
      (error) => error.code === "CORRUPT_PACKET"
    );
    assert.equal(created.secretHash, keccak256(secret));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("identical seeds produce identical scientific evidence hashes", async () => {
  const hashes = [];
  for (let index = 0; index < 2; index += 1) {
    const run = temporaryRun("deterministic-science");
    try {
      const trade = await reachReservation(run, "deterministic");
      await run.simulator.fundSource(trade);
      await run.simulator.refundSource(trade);
      hashes.push(run.simulator.report("deterministic-refund").reportHash);
    } finally {
      cleanup(run);
    }
  }
  assert.equal(hashes[0], hashes[1]);
});
