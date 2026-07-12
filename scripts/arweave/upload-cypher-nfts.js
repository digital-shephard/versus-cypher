const crypto = require("crypto");
const childProcess = require("child_process");
const dns = require("dns");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..", "..");
const ASSET_DIR = path.join(ROOT, "apps", "pet", "assets", "cyphers");
const ROSTER_FILE = path.join(ROOT, "apps", "pet", "renderer", "cyphers.js");
const PROFILE_FILE = path.join(ROOT, "apps", "pet", "renderer", "cypher-profiles.js");
const STAGING_DIR = path.join(ROOT, "tmp", "ipfs-publish");
const IMAGE_DIR = path.join(STAGING_DIR, "images");
const METADATA_DIR = path.join(STAGING_DIR, "metadata");
const IMAGE_CAR = path.join(STAGING_DIR, "images.car");
const METADATA_CAR = path.join(STAGING_DIR, "metadata.car");
const RECEIPT_DIR = path.join(ROOT, "deployments", "ipfs");
const RECEIPT_FILE = path.join(RECEIPT_DIR, "cypher-nfts.json");
const DEFAULT_API_KEY_FILE = path.join(os.homedir(), ".versus-cypher", "lighthouse-api-key.txt");
const VERIFY_ONLY = process.argv.includes("--verify-only");

const LIGHTHOUSE_DNS = Object.freeze({
  "api.lighthouse.storage": "178.105.0.135",
  "upload.lighthouse.storage": "178.104.189.228",
  "gateway.lighthouse.storage": "138.201.186.179",
});
const originalLookup = dns.lookup;
dns.lookup = (hostname, options, callback) => {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  const address = LIGHTHOUSE_DNS[hostname];
  if (!address) return originalLookup(hostname, options, callback);
  return options?.all
    ? callback(null, [{ address, family: 4 }])
    : callback(null, address, 4);
};

const RARITY = Object.freeze(["Archive", "Common", "Rare", "Epic", "Legendary"]);
const BACKGROUND = Object.freeze({
  Electric: "E7C63F",
  Fighting: "B95E4B",
  Fire: "E66B43",
  Flying: "7EA9C9",
  Ghost: "74628D",
  Grass: "70A66B",
  Normal: "A59B8C",
  Psychic: "B66E9B",
  Water: "4A9EC2",
});
const GATEWAYS = ["https://gateway.pinata.cloud/ipfs", "https://ipfs.io/ipfs"];

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function loadCatalog() {
  const browser = {};
  const context = vm.createContext({ window: browser });
  vm.runInContext(fs.readFileSync(ROSTER_FILE, "utf8"), context, { filename: ROSTER_FILE });
  vm.runInContext(fs.readFileSync(PROFILE_FILE, "utf8"), context, { filename: PROFILE_FILE });
  const roster = browser.VERSUS_CYPHERS.CYPHERS;
  const profileOf = browser.VERSUS_CYPHER_PROFILES.profileOf;
  if (roster.length !== 29) throw new Error(`Expected 29 Cyphers, found ${roster.length}`);
  return roster.map((cypher, index) => {
    if (cypher.id !== index) throw new Error(`Cypher roster is not contiguous at index ${index}`);
    const profile = profileOf(cypher.name);
    if (!profile || profile.archivePending || !profile.type || !profile.rarity) {
      throw new Error(`Cypher ${cypher.id} (${cypher.name}) has incomplete permanent metadata`);
    }
    return { ...cypher, profile };
  });
}

function metadataFor(cypher, imageRoot) {
  const profile = cypher.profile;
  return {
    name: `Versus Cypher: ${cypher.name}`,
    description: profile.description,
    image: `ipfs://${imageRoot}/${cypher.id}.gif`,
    animation_url: `ipfs://${imageRoot}/${cypher.id}.gif`,
    external_url: "https://versuscypher.com",
    background_color: BACKGROUND[profile.type] || BACKGROUND.Normal,
    attributes: [
      { trait_type: "Cypher ID", value: cypher.id, display_type: "number" },
      { trait_type: "Species", value: cypher.name },
      { trait_type: "Type", value: profile.type },
      { trait_type: "Rarity", value: RARITY[profile.rarity] },
      { trait_type: "Health", value: profile.health, display_type: "number" },
      { trait_type: "Damage Min", value: profile.damageMin, display_type: "number" },
      { trait_type: "Damage Max", value: profile.damageMax, display_type: "number" },
      { trait_type: "Critical Chance", value: profile.critChance, display_type: "number" },
      { trait_type: "Strength", value: profile.strength, display_type: "number" },
      { trait_type: "Stamina", value: profile.stamina, display_type: "number" },
      { trait_type: "Dexterity", value: profile.dexterity, display_type: "number" },
      { trait_type: "Spirit", value: profile.spirit, display_type: "number" },
    ],
  };
}

function prepareImages(catalog) {
  fs.rmSync(STAGING_DIR, { recursive: true, force: true });
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  const files = {};
  for (const cypher of catalog) {
    const data = fs.readFileSync(path.join(ASSET_DIR, cypher.file));
    fs.writeFileSync(path.join(IMAGE_DIR, `${cypher.id}.gif`), data);
    files[`${cypher.id}.gif`] = { name: cypher.name, bytes: data.length, sha256: sha256(data) };
  }
  return files;
}

function prepareMetadata(catalog, imageRoot) {
  fs.mkdirSync(METADATA_DIR, { recursive: true });
  const files = {};
  for (const cypher of catalog) {
    const data = Buffer.from(stableJson(metadataFor(cypher, imageRoot)));
    fs.writeFileSync(path.join(METADATA_DIR, `${cypher.id}.json`), data);
    files[`${cypher.id}.json`] = { name: cypher.name, bytes: data.length, sha256: sha256(data) };
  }
  const collection = Buffer.from(stableJson({
    name: "Versus Cypher",
    description: "Persistent agent identities for the Versus network.",
    external_url: "https://versuscypher.com",
    image_root: `ipfs://${imageRoot}`,
    total_species: catalog.length,
  }));
  fs.writeFileSync(path.join(METADATA_DIR, "collection.json"), collection);
  files["collection.json"] = { bytes: collection.length, sha256: sha256(collection) };
  return files;
}

function packCar(directory, output, expectedRoot) {
  const bin = path.join(__dirname, "node_modules", "ipfs-car", "bin.js");
  const result = childProcess.spawnSync(process.execPath, [bin, "pack", directory, "--output", output], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Unable to create ${path.basename(output)}: ${result.stderr || result.stdout}`);
  }
  const root = result.stdout.trim().split(/\r?\n/).at(-1);
  if (root !== expectedRoot) {
    throw new Error(`${path.basename(output)} root ${root} does not match published root ${expectedRoot}`);
  }
  const data = fs.readFileSync(output);
  return {
    file: path.relative(ROOT, output).replaceAll(path.sep, "/"),
    root,
    bytes: data.length,
    sha256: sha256(data),
  };
}

function loadReceipt() {
  if (!fs.existsSync(RECEIPT_FILE)) {
    return {
      schema: "versus-cypher-ipfs-v1",
      provider: "ipfs",
      providers: ["lighthouse"],
      createdAt: new Date().toISOString(),
      images: null,
      metadata: null,
    };
  }
  const receipt = JSON.parse(fs.readFileSync(RECEIPT_FILE, "utf8"));
  if (receipt.schema !== "versus-cypher-ipfs-v1") throw new Error(`Unsupported receipt: ${receipt.schema}`);
  receipt.provider = "ipfs";
  receipt.providers = [...new Set([...(receipt.providers || []), "lighthouse", ...(receipt.images?.pinata ? ["pinata-x402"] : [])])];
  return receipt;
}

function sourceFilesMatch(receiptFiles, localFiles) {
  const compact = (files) => Object.fromEntries(Object.entries(files).map(([route, record]) => [route, {
    ...(record.name ? { name: record.name } : {}),
    bytes: record.bytes,
    sha256: record.sha256,
  }]));
  return stableJson(compact(receiptFiles)) === stableJson(compact(localFiles));
}

function saveReceipt(receipt) {
  fs.mkdirSync(RECEIPT_DIR, { recursive: true });
  const temporary = `${RECEIPT_FILE}.tmp`;
  fs.writeFileSync(temporary, stableJson(receipt), "utf8");
  fs.renameSync(temporary, RECEIPT_FILE);
}

async function uploadDirectory(lighthouse, directory, apiKey) {
  const response = await lighthouse.upload(directory, apiKey, { cidVersion: 1 });
  const result = response?.data;
  const root = Array.isArray(result) ? result[result.length - 1] : result;
  if (!root?.Hash) throw new Error(`Lighthouse upload returned no root CID: ${JSON.stringify(result)}`);
  return root.Hash;
}

async function fetchVerified(root, route, expectedHash) {
  let lastError;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    for (const gateway of GATEWAYS) {
      try {
        const response = await fetch(`${gateway}/${root}/${route}`, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const data = Buffer.from(await response.arrayBuffer());
        if (sha256(data) !== expectedHash) throw new Error("content hash mismatch");
        return { gateway, bytes: data.length };
      } catch (error) {
        lastError = error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Unable to verify ${root}/${route}: ${lastError?.message || "gateway unavailable"}`);
}

async function publish() {
  const lighthouse = require("@lighthouse-web3/sdk");
  const catalog = loadCatalog();
  const imageFiles = prepareImages(catalog);
  const receipt = loadReceipt();
  const apiKeyFile = process.env.VERSUS_LIGHTHOUSE_API_KEY_FILE || DEFAULT_API_KEY_FILE;
  if (!VERIFY_ONLY && !fs.existsSync(apiKeyFile)) throw new Error(`Lighthouse API key not found: ${apiKeyFile}`);
  const apiKey = VERIFY_ONLY ? null : fs.readFileSync(apiKeyFile, "utf8").trim();

  if (!receipt.images) {
    if (VERIFY_ONLY) throw new Error("Image root has not been published");
    console.log("Publishing deterministic Cypher image directory");
    receipt.images = { root: await uploadDirectory(lighthouse, IMAGE_DIR, apiKey), files: imageFiles };
    saveReceipt(receipt);
  } else if (!sourceFilesMatch(receipt.images.files, imageFiles)) {
    throw new Error("Local image directory no longer matches its published receipt");
  }

  const metadataFiles = prepareMetadata(catalog, receipt.images.root);
  if (!receipt.metadata) {
    if (VERIFY_ONLY) throw new Error("Metadata root has not been published");
    console.log("Publishing deterministic Cypher metadata directory");
    receipt.metadata = { root: await uploadDirectory(lighthouse, METADATA_DIR, apiKey), files: metadataFiles };
    saveReceipt(receipt);
  } else if (!sourceFilesMatch(receipt.metadata.files, metadataFiles)) {
    throw new Error("Local metadata directory no longer matches its published receipt");
  }

  receipt.cars = {
    images: packCar(IMAGE_DIR, IMAGE_CAR, receipt.images.root),
    metadata: packCar(METADATA_DIR, METADATA_CAR, receipt.metadata.root),
  };
  saveReceipt(receipt);

  const checks = [
    ...Object.entries(receipt.images.files).map(([route, record]) => [receipt.images.root, route, record]),
    ...Object.entries(receipt.metadata.files).map(([route, record]) => [receipt.metadata.root, route, record]),
  ];
  for (let index = 0; index < checks.length; index += 1) {
    const [root, route, record] = checks[index];
    console.log(`Verifying ${index + 1}/${checks.length}: ${route}`);
    record.verified = await fetchVerified(root, route, record.sha256);
    record.verifiedAt = new Date().toISOString();
    saveReceipt(receipt);
  }

  for (const section of [receipt.images, receipt.metadata]) {
    try {
      section.filecoin = (await lighthouse.dealStatus(section.root)).data;
    } catch (error) {
      section.filecoin = { pending: true, reason: error.message };
    }
  }
  receipt.metadataBaseUri = `ipfs://${receipt.metadata.root}/`;
  receipt.completedAt = new Date().toISOString();
  saveReceipt(receipt);
  console.log(`Permanent metadata base URI: ${receipt.metadataBaseUri}`);
}

publish().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
