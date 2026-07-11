const { keccak256, toUtf8Bytes } = require("ethers");

const DEFAULT_MIN_SHARED_TARGETS = 3;
const DEFAULT_MIN_AGREEMENT = 0.85;
const DEFAULT_MIN_COVERAGE = 0.75;

function stableClusterId(members) {
  return keccak256(toUtf8Bytes([...members].sort().join(":")));
}

class StanceClusterAnalyzer {
  constructor({
    store,
    trust = null,
    minSharedTargets = DEFAULT_MIN_SHARED_TARGETS,
    minAgreement = DEFAULT_MIN_AGREEMENT,
    minCoverage = DEFAULT_MIN_COVERAGE,
  }) {
    if (!store) throw new TypeError("cluster analyzer requires a postcard store");
    if (!Number.isInteger(minSharedTargets) || minSharedTargets < 2) {
      throw new RangeError("minSharedTargets must be at least two");
    }
    for (const [label, value] of [
      ["minAgreement", minAgreement],
      ["minCoverage", minCoverage],
    ]) {
      if (!Number.isFinite(value) || value <= 0 || value > 1) {
        throw new RangeError(`${label} must be above zero and at most one`);
      }
    }
    this.store = store;
    this.trust = trust;
    this.minSharedTargets = minSharedTargets;
    this.minAgreement = minAgreement;
    this.minCoverage = minCoverage;
    this.cached = null;
  }

  build() {
    const postcards = this.store.list({ limit: 100_000 });
    const byId = new Map(postcards.map((postcard) => [postcard.id, postcard]));
    const candidateFor = (postcard) => {
      let parentId = postcard.replyTo;
      const visited = new Set();
      while (parentId && !visited.has(parentId)) {
        visited.add(parentId);
        const parent = byId.get(parentId);
        if (!parent || parent.launchId !== postcard.launchId) return null;
        if (parent.type === "proposal" || parent.type === "mission") return parent.id;
        parentId = parent.replyTo;
      }
      return null;
    };

    const stances = new Map();
    const ordered = [...postcards].sort(
      (left, right) => left.createdAt - right.createdAt || left.sequence - right.sequence
    );
    for (const postcard of ordered) {
      if (postcard.type !== "endorsement" && postcard.type !== "critique") continue;
      if (this.trust?.isBlocked(postcard.author)) continue;
      const targetId = candidateFor(postcard);
      if (!targetId) continue;
      if (!stances.has(postcard.author)) stances.set(postcard.author, new Map());
      stances.get(postcard.author).set(targetId, postcard.type === "endorsement" ? 1 : -1);
    }

    const authors = Array.from(stances.keys()).sort();
    const correlations = [];
    const correlatedPairs = new Set();
    for (let leftIndex = 0; leftIndex < authors.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < authors.length; rightIndex += 1) {
        const left = authors[leftIndex];
        const right = authors[rightIndex];
        const leftStances = stances.get(left);
        const rightStances = stances.get(right);
        const sharedTargets = Array.from(leftStances.keys()).filter((target) => rightStances.has(target));
        if (sharedTargets.length < this.minSharedTargets) continue;
        const matching = sharedTargets.filter(
          (target) => leftStances.get(target) === rightStances.get(target)
        ).length;
        const agreement = matching / sharedTargets.length;
        const coverage = sharedTargets.length / Math.min(leftStances.size, rightStances.size);
        if (agreement < this.minAgreement || coverage < this.minCoverage) continue;
        correlatedPairs.add(`${left}:${right}`);
        correlations.push({ left, right, sharedTargets: sharedTargets.length, agreement, coverage });
      }
    }

    const groups = [];
    for (const author of authors) {
      const compatible = groups.find((members) =>
        members.every((member) => {
          const [left, right] = [author, member].sort();
          return correlatedPairs.has(`${left}:${right}`);
        })
      );
      if (compatible) compatible.push(author);
      else groups.push([author]);
    }
    const authorClusters = new Map();
    const clusters = [];
    for (const members of groups) {
      members.sort();
      const id = stableClusterId(members);
      const memberSet = new Set(members);
      const evidence = correlations.filter(
        (correlation) => memberSet.has(correlation.left) && memberSet.has(correlation.right)
      );
      const cluster = {
        id,
        members,
        size: members.length,
        independenceFactor: 1 / Math.sqrt(members.length),
        evidence,
      };
      clusters.push(cluster);
      for (const member of members) authorClusters.set(member, cluster);
    }
    clusters.sort((left, right) => right.size - left.size || left.id.localeCompare(right.id));
    this.cached = { authorClusters, clusters, correlations };
    return this.cached;
  }

  analysis() {
    return this.cached || this.build();
  }

  forAuthor(address) {
    address = String(address).toLowerCase();
    const existing = this.analysis().authorClusters.get(address);
    if (existing) return existing;
    return {
      id: stableClusterId([address]),
      members: [address],
      size: 1,
      independenceFactor: 1,
      evidence: [],
    };
  }

  view() {
    return this.analysis().clusters.map((cluster) => ({
      id: cluster.id,
      members: [...cluster.members],
      size: cluster.size,
      independenceFactor: cluster.independenceFactor,
      evidence: cluster.evidence.map((item) => ({ ...item })),
    }));
  }
}

module.exports = {
  DEFAULT_MIN_AGREEMENT,
  DEFAULT_MIN_COVERAGE,
  DEFAULT_MIN_SHARED_TARGETS,
  StanceClusterAnalyzer,
  stableClusterId,
};
