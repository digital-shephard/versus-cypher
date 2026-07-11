export const CYPHERS = [
  {
    id: 0,
    name: "CalFire",
    element: "fire",
    emoji: "🔥",
    glow: "linear-gradient(145deg, #ffb347, #d4552a)",
  },
  {
    id: 1,
    name: "OhWail",
    element: "water",
    emoji: "🐋",
    glow: "linear-gradient(145deg, #7ec8e3, #2a6fdb)",
  },
  {
    id: 2,
    name: "FlexSeed",
    element: "grass",
    emoji: "🌱",
    glow: "linear-gradient(145deg, #b6e27a, #2f8f4e)",
  },
];

const KEY = "versus.bond";

export function loadBond() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveBond(bond) {
  localStorage.setItem(KEY, JSON.stringify(bond));
}
