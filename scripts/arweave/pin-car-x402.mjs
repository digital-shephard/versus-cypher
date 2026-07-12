import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const RECEIPT_FILE = path.join(ROOT, "deployments", "ipfs", "cypher-nfts.json");
const STAGING_DIR = path.join(ROOT, "tmp", "ipfs-publish");
const DEFAULT_KEY_FILE = path.join(os.homedir(), ".versus-cypher", "turbo-base-payer.json");
const PIN_ENDPOINT = "https://402.pinata.cloud/v1/pin/public";

function saveReceipt(receipt) {
  const temporary = `${RECEIPT_FILE}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, RECEIPT_FILE);
}

async function verifyRoute(root, route, expectedHash) {
  const response = await fetch(`https://gateway.pinata.cloud/ipfs/${root}/${route}`);
  if (!response.ok) throw new Error(`Pinata gateway returned ${response.status} for ${route}`);
  const data = Buffer.from(await response.arrayBuffer());
  const actualHash = crypto.createHash("sha256").update(data).digest("hex");
  if (actualHash !== expectedHash) throw new Error(`Pinata gateway hash mismatch for ${route}`);
  return { gateway: "https://gateway.pinata.cloud/ipfs", bytes: data.length };
}

async function pinCar(fetchWithPayment, receipt, sectionName, carName, probeRoute) {
  const section = receipt[sectionName];
  if (section.pinata?.cid) {
    if (section.pinata.cid !== section.root) throw new Error(`${sectionName} Pinata CID does not match canonical root`);
    console.log(`${sectionName} already pinned as ${section.root}`);
    return;
  }

  const carPath = path.join(STAGING_DIR, carName);
  const car = fs.readFileSync(carPath);
  const authorization = await fetchWithPayment(`${PIN_ENDPOINT}?fileSize=${car.length}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileSize: car.length }),
  });
  if (!authorization.ok) throw new Error(`Pinata authorization failed: ${authorization.status} ${await authorization.text()}`);
  const { url } = await authorization.json();
  if (!url?.startsWith("https://uploads.pinata.cloud/")) throw new Error("Pinata returned an invalid upload URL");

  const form = new FormData();
  form.append("network", "public");
  form.append("car", "true");
  form.append("name", `versus-cypher-${sectionName}`);
  form.append("file", new Blob([car], { type: "application/vnd.ipld.car" }), carName);
  const upload = await fetch(url, { method: "POST", body: form });
  if (!upload.ok) throw new Error(`Pinata CAR upload failed: ${upload.status} ${await upload.text()}`);
  const result = await upload.json();
  const cid = result.data?.cid || result.IpfsHash || result.cid;
  if (cid !== section.root) throw new Error(`Pinata returned ${cid}; expected canonical root ${section.root}`);

  const route = section.files[probeRoute];
  section.pinata = {
    cid,
    pinnedAt: new Date().toISOString(),
    paymentReceipt: authorization.headers.get("payment-response") || authorization.headers.get("x-payment-response"),
    verified: await verifyRoute(cid, probeRoute, route.sha256),
  };
  saveReceipt(receipt);
  console.log(`${sectionName} pinned and verified as ${cid}`);
}

const keyFile = process.env.VERSUS_STORAGE_PAYER_KEY || DEFAULT_KEY_FILE;
const payer = JSON.parse(fs.readFileSync(keyFile, "utf8"));
const receipt = JSON.parse(fs.readFileSync(RECEIPT_FILE, "utf8"));
receipt.provider = "ipfs";
receipt.providers = [...new Set([...(receipt.providers || []), "lighthouse", "pinata-x402"])];
const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(payer.privateKey) });
const fetchWithPayment = wrapFetchWithPayment(fetch, client);

await pinCar(fetchWithPayment, receipt, "images", "images.car", "0.gif");
await pinCar(fetchWithPayment, receipt, "metadata", "metadata.car", "0.json");
receipt.completedAt = new Date().toISOString();
receipt.metadataBaseUri = `ipfs://${receipt.metadata.root}/`;
saveReceipt(receipt);
console.log(`Canonical metadata base URI: ${receipt.metadataBaseUri}`);
