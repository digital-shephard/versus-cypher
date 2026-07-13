const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const PATTERNS = [
  ["private key block", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i],
  ["OpenAI or OpenRouter token", /\bsk-(?:or-v1-)?[a-z0-9_-]{20,}\b/i],
  ["GitHub token", /\bgh[pousr]_[a-z0-9]{30,}\b/i],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{30,}\b/],
  ["Slack token", /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/],
  ["npm token", /\bnpm_[a-z0-9]{30,}\b/i],
  ["live payment secret", /\b(?:sk|rk)_live_[a-z0-9]{20,}\b/i],
  [
    "quoted credential",
    /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*["'][a-z0-9_+/.=-]{24,}["']/i,
  ],
  [
    "environment credential",
    /^\s*(?:export\s+)?(?:[A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|CLIENT_SECRET|PRIVATE_KEY))\s*=\s*[a-z0-9_+/.=-]{24,}\s*$/i,
  ],
];

function git(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || "git command failed\n");
    process.exit(result.status || 1);
  }
  return result.stdout;
}

function findingsForLine(line) {
  return PATTERNS.filter(([, pattern]) => pattern.test(line)).map(([name]) => name);
}

const findings = [];
const tracked = git(["ls-files", "-z"]).split("\0").filter(Boolean);
for (const relative of tracked) {
  const absolute = path.join(ROOT, relative);
  // A tracked file can be intentionally deleted in the working tree before the removal is committed.
  if (!fs.existsSync(absolute)) continue;
  // Git submodules are tracked as gitlinks but appear as directories in the working tree.
  if (!fs.statSync(absolute).isFile()) continue;
  const content = fs.readFileSync(absolute);
  if (content.includes(0)) continue;
  const lines = content.toString("utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const pattern of findingsForLine(line)) {
      findings.push({ source: `${relative}:${index + 1}`, pattern });
    }
  });
}

const history = git([
  "log",
  "--all",
  "--full-history",
  "--format=@@COMMIT %H",
  "--no-ext-diff",
  "--unified=0",
  "-p",
  "--",
  ".",
]);
let commit = "unknown";
let file = "unknown";
for (const line of history.split(/\r?\n/)) {
  if (line.startsWith("@@COMMIT ")) {
    commit = line.slice(9, 21);
    continue;
  }
  if (line.startsWith("+++ b/")) {
    file = line.slice(6);
    continue;
  }
  if (!line.startsWith("+") || line.startsWith("+++")) continue;
  for (const pattern of findingsForLine(line.slice(1))) {
    findings.push({ source: `history:${commit}:${file}`, pattern });
  }
}

const unique = [...new Map(findings.map((finding) => [`${finding.source}|${finding.pattern}`, finding])).values()];
if (unique.length) {
  console.error(`Secret scan failed with ${unique.length} finding(s). Values are intentionally hidden.`);
  for (const finding of unique.slice(0, 100)) console.error(`- ${finding.pattern} at ${finding.source}`);
  if (unique.length > 100) console.error(`- ${unique.length - 100} additional findings hidden`);
  process.exit(1);
}

console.log(`Secret scan passed across ${tracked.length} tracked files and complete Git history.`);
