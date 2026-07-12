const fs = require("fs");
const path = require("path");

const source = process.argv[2];
if (!source) throw new Error("usage: node scripts/import-cypher-profiles.js <cypherList.json>");

const raw = JSON.parse(fs.readFileSync(source, "utf8"));
const records = raw.xpGuide || raw.cyphers || raw;
if (!Array.isArray(records)) throw new Error("source does not contain a Cypher array");

const statKeys = ["damage_min", "strength_min", "stamina_min", "dexterity_min", "spirit_min"];
const profiles = {};
const keyOf = (value) => String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
const cleanText = (value) => String(value || "")
  .replaceAll("â€™", "'")
  .replaceAll("â€œ", '"')
  .replaceAll("â€", '"')
  .replaceAll("â€”", "-")
  .replaceAll("’", "'");

for (const item of records) {
  profiles[keyOf(item.name)] = {
    name: item.name,
    type: item.type,
    rarity: Number(item.rarity || 0),
    description: cleanText(item.description),
    health: Number(item.health || 0),
    damageMin: Number(item.damage_min || 0),
    damageMax: Number(item.damage_max || 0),
    critChance: Number(item.crit_chance || 0),
    strength: Number(item.strength_min || 0),
    stamina: Number(item.stamina_min || 0),
    dexterity: Number(item.dexterity_min || 0),
    spirit: Number(item.spirit_min || 0),
  };
}

profiles.hokkaidowave = {
  name: "HokkaidoWave",
  type: "Water",
  rarity: 4,
  description: "One of three elemental dogs, HokkaidoWave embodies the water spirit. Quiet and watchful, it draws moisture from the air into a flowing mantle and can cross open water without disturbing its surface. The tide-like flame at its tail brightens before storms.",
  health: 162,
  damageMin: 44,
  damageMax: 54,
  critChance: 8,
  strength: 28,
  stamina: 42,
  dexterity: 16,
  spirit: 17,
};
profiles.kamakasu = {
  name: "Kamakasu",
  type: "Flying",
  rarity: 3,
  description: "Kamakasu is a vigilant forest bird whose long ribbon feathers harden into razor-fine blades in flight. It remains motionless for hours among bare branches, then strikes with a burst of crimson wings before its prey hears the leaves move.",
  health: 112,
  damageMin: 27,
  damageMax: 33,
  critChance: 10,
  strength: 17,
  stamina: 18,
  dexterity: 15,
  spirit: 9,
};

const maxima = {};
for (const key of statKeys) {
  maxima[key] = Math.max(...records.map((item) => Number(item[key] || 0)), 1);
}

const output = `/** Generated from the original Versus Mini Cypher catalog. */\n(function () {\n` +
  `  const PROFILES = ${JSON.stringify(profiles, null, 2)};\n` +
  `  const MAXIMA = ${JSON.stringify(maxima, null, 2)};\n` +
  `  const keyOf = (value) => String(value).toLowerCase().replace(/[^a-z0-9]/g, "");\n` +
  `  const profileOf = (name) => PROFILES[keyOf(name)] || null;\n` +
  `  window.VERSUS_CYPHER_PROFILES = { PROFILES, MAXIMA, profileOf };\n` +
  `})();\n`;

const destination = path.join(__dirname, "..", "renderer", "cypher-profiles.js");
fs.writeFileSync(destination, output, "utf8");
console.log(`wrote ${Object.keys(profiles).length} profiles to ${destination}`);
