import { useMemo, useState } from "react";
import { CYPHERS, loadBond, saveBond } from "./lib/bond.js";

function formatUsdc(micros) {
  return `$${(Number(micros) / 1e6).toFixed(4)}`;
}

export default function App() {
  const [bond, setBond] = useState(() => loadBond());
  const [picked, setPicked] = useState(0);
  const [flash, setFlash] = useState("");

  const cypher = useMemo(
    () => CYPHERS.find((c) => c.id === (bond?.cypherId ?? picked)) ?? CYPHERS[0],
    [bond, picked]
  );

  const committedToday = bond?.lastCommitDay === todayIndex();

  function mintBond() {
    const next = {
      agentId: 1,
      cypherId: picked,
      level: 0,
      streak: 0,
      vault: 0,
      lastCommitDay: null,
      createdAt: Date.now(),
    };
    saveBond(next);
    setBond(next);
    setFlash("Your agent took a seat. $3.65 a year is enough.");
  }

  function doCommit() {
    if (!bond || committedToday) return;
    const next = {
      ...bond,
      level: bond.level + 1,
      streak: bond.lastCommitDay === todayIndex() - 1 ? bond.streak + 1 : 1,
      lastCommitDay: todayIndex(),
      vault: Math.max(0, bond.vault),
    };
    saveBond(next);
    setBond(next);
    setFlash(`${cypher.name} dropped today's penny in the jar.`);
  }

  function simulateOil() {
    if (!bond) return;
    const next = { ...bond, vault: bond.vault + 1_750_000_000 }; // +$1750 demo
    saveBond(next);
    setBond(next);
    setFlash("A class graduated. Human volume hit. Your nest egg woke up.");
  }

  function reset() {
    localStorage.removeItem("versus.bond");
    setBond(null);
    setFlash("");
  }

  return (
    <div className="app">
      <header>
        <h1 className="brand">Versus</h1>
        <p className="tagline">
          Every day, agents gather and launch one thing. Your Cypher is the face of a nest egg —
          most days nothing, sometimes the machine prints.
        </p>
        <div className="pill">local demo · contracts live in <code>versus/</code></div>
      </header>

      {!bond ? (
        <section className="stage">
          <h2 style={{ fontFamily: "Fraunces, Georgia, serif", marginTop: 0 }}>Choose your bond</h2>
          <p style={{ color: "var(--muted)", marginTop: 0 }}>
            Skins only. No power differences. Level comes from showing up.
          </p>
          <div className="chooser">
            {CYPHERS.map((c) => (
              <button
                key={c.id}
                className={`choice ${picked === c.id ? "selected" : ""}`}
                onClick={() => setPicked(c.id)}
                type="button"
              >
                <span className="emoji">{c.emoji}</span>
                <span className="label">{c.name}</span>
              </button>
            ))}
          </div>
          <div className="actions">
            <button className="btn btn-primary" type="button" onClick={mintBond}>
              Register · 1¢
            </button>
          </div>
        </section>
      ) : (
        <section className="stage">
          <div className="cypher-stage">
            <div
              className="cypher-orb"
              style={{
                background: `radial-gradient(circle at 30% 30%, #fff8, transparent 45%), ${cypher.glow}`,
              }}
            >
              <div className="cypher-face" aria-hidden>
                {cypher.emoji}
              </div>
            </div>
            <h2 className="cypher-name">{cypher.name}</h2>
            <p className="cypher-meta">Agent #{bond.agentId} · {cypher.element}</p>
          </div>

          <div className="stats">
            <div className="stat">
              <strong>{bond.level}</strong>
              <span>level</span>
            </div>
            <div className="stat">
              <strong>{bond.streak}</strong>
              <span>streak</span>
            </div>
            <div className="stat">
              <strong>{formatUsdc(bond.vault)}</strong>
              <span>vault</span>
            </div>
          </div>

          <div className={`status ${committedToday ? "" : "pending"}`}>
            <h3>{committedToday ? "Committed today" : "Waiting on today's penny"}</h3>
            <p>
              {committedToday
                ? "Your agent showed up. Come back tomorrow."
                : "One penny into the global class. That's the whole ritual."}
            </p>
          </div>

          {flash && (
            <p style={{ marginTop: "1rem", color: "var(--teal-deep)", fontWeight: 500 }}>{flash}</p>
          )}

          <div className="actions">
            <button
              className="btn btn-primary"
              type="button"
              onClick={doCommit}
              disabled={committedToday}
            >
              {committedToday ? "Done for today" : "Commit 1¢"}
            </button>
            <button className="btn btn-ghost" type="button" onClick={simulateOil}>
              Simulate oil strike
            </button>
            <button className="btn btn-ghost" type="button" onClick={reset}>
              Reset demo
            </button>
          </div>
        </section>
      )}

      <p className="foot">
        This watch UI is the human face. Agents hit the Arena contract directly (or via x402 later).
        Sell the NFT on a marketplace and the vault goes with it. Local Hardhat:{" "}
        <code>cd versus && npm test && npm run simulate</code>. Base Sepolia when you're ready to go live.
      </p>
    </div>
  );
}

function todayIndex() {
  return Math.floor(Date.now() / 86_400_000);
}
