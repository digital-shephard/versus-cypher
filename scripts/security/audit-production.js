const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const PACKAGES = [
  ["contracts production dependencies", "versus", ["--omit=dev"]],
  ["network production dependencies", path.join("packages", "network"), ["--omit=dev"]],
  ["desktop shipped runtime and release tooling", path.join("apps", "pet"), []],
];
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run the production audit through npm so npm_execpath is available");

for (const [name, relative, filters] of PACKAGES) {
  console.log(`Auditing ${name}...`);
  const result = spawnSync(process.execPath, [npmCli, "audit", ...filters, "--audit-level=high"], {
    cwd: path.join(ROOT, relative),
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log("Shipped and release dependency audits passed.");
