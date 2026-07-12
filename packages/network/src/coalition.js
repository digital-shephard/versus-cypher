const { StanceClusterAnalyzer } = require("./cluster");

class CoalitionEngine {
  constructor({
    store,
    trust,
    minEndorsers = 2,
    minIndependentClusters = 2,
    readinessThreshold = 1.5,
    readinessMargin = 0.25,
  }) {
    if (!store || !trust) throw new TypeError("coalition engine requires store and trust");
    this.store = store;
    this.trust = trust;
    this.minEndorsers = minEndorsers;
    this.minIndependentClusters = minIndependentClusters;
    this.readinessThreshold = readinessThreshold;
    this.readinessMargin = readinessMargin;
  }

  evaluateStances(stances, proposer = null, clusters = null) {
    const latestByAuthor = new Map();
    const ordered = [...stances].sort(
      (a, b) => a.createdAt - b.createdAt || a.sequence - b.sequence
    );
    for (const postcard of ordered) {
      if (this.trust.isBlocked(postcard.author)) continue;
      if (postcard.author === proposer && postcard.type === "endorsement") continue;
      latestByAuthor.set(postcard.author, postcard);
    }

    const supporters = [];
    const detractors = [];
    for (const postcard of latestByAuthor.values()) {
      if (postcard.type === "endorsement") {
        const cluster = clusters?.forAuthor(postcard.author) || {
          id: postcard.author,
          size: 1,
          independenceFactor: 1,
        };
        supporters.push({
          author: postcard.author,
          postcardId: postcard.id,
          clusterId: cluster.id,
          clusterSize: cluster.size,
          independenceFactor: cluster.independenceFactor,
          weight:
            this.trust.domainWeight(postcard.author, ["taste", "prediction", "integrity"]) *
            cluster.independenceFactor,
        });
      } else if (postcard.type === "critique") {
        const cluster = clusters?.forAuthor(postcard.author) || {
          id: postcard.author,
          size: 1,
          independenceFactor: 1,
        };
        detractors.push({
          author: postcard.author,
          postcardId: postcard.id,
          clusterId: cluster.id,
          clusterSize: cluster.size,
          independenceFactor: cluster.independenceFactor,
          weight:
            this.trust.domainWeight(postcard.author, ["criticism", "integrity"]) *
            cluster.independenceFactor,
        });
      }
    }

    const supportWeight = supporters.reduce((sum, item) => sum + item.weight, 0);
    const dissentWeight = detractors.reduce((sum, item) => sum + item.weight, 0);
    const netWeight = supportWeight - dissentWeight;
    const independentSupportClusters = new Set(supporters.map((supporter) => supporter.clusterId)).size;
    const independentDissentClusters = new Set(detractors.map((detractor) => detractor.clusterId)).size;
    let status = "emerging";
    if (detractors.length > 0 && dissentWeight >= supportWeight) {
      status = "contested";
    } else if (
      supporters.length >= this.minEndorsers &&
      independentSupportClusters >= this.minIndependentClusters &&
      supportWeight >= this.readinessThreshold &&
      netWeight >= this.readinessMargin
    ) {
      status = "ready";
    }

    return {
      status,
      supportWeight,
      dissentWeight,
      netWeight,
      independentSupportClusters,
      independentDissentClusters,
      supporters,
      detractors,
    };
  }

  view(launchId) {
    launchId = String(launchId);
    const postcards = this.store.list({ launchId, limit: 10_000 });
    const byId = new Map(postcards.map((postcard) => [postcard.id, postcard]));
    const clusters = new StanceClusterAnalyzer({ store: this.store, trust: this.trust });
    const proposals = postcards.filter(
      (postcard) => postcard.type === "proposal" && !this.trust.isBlocked(postcard.author)
    );
    const missions = postcards.filter(
      (postcard) => postcard.type === "mission" && !this.trust.isBlocked(postcard.author)
    );

    const candidateFor = (postcard) => {
      let parentId = postcard.replyTo;
      const visited = new Set();
      while (parentId && !visited.has(parentId)) {
        visited.add(parentId);
        const parent = byId.get(parentId);
        if (!parent || parent.launchId !== launchId) return null;
        if (parent.type === "proposal" || parent.type === "mission") return parent.id;
        parentId = parent.replyTo;
      }
      return null;
    };

    const stancesByTarget = new Map();
    for (const postcard of postcards) {
      if (postcard.type !== "endorsement" && postcard.type !== "critique") continue;
      const targetId = candidateFor(postcard);
      if (!targetId) continue;
      if (!stancesByTarget.has(targetId)) stancesByTarget.set(targetId, []);
      stancesByTarget.get(targetId).push(postcard);
    }

    const missionViews = new Map();
    for (const mission of missions) {
      const parentProposalId = candidateFor(mission);
      if (!parentProposalId || byId.get(parentProposalId)?.type !== "proposal") continue;
      const evaluation = this.evaluateStances(
        stancesByTarget.get(mission.id) || [],
        mission.author,
        clusters
      );
      const view = {
        id: mission.id,
        proposalId: parentProposalId,
        author: mission.author,
        createdAt: mission.createdAt,
        body: mission.body,
        artifact: mission.artifact,
        declaredAmountMicros: mission.amountMicros,
        ...evaluation,
        score:
          this.trust.domainWeight(mission.author, ["execution", "stewardship", "integrity"]) +
          evaluation.netWeight,
      };
      if (!missionViews.has(parentProposalId)) missionViews.set(parentProposalId, []);
      missionViews.get(parentProposalId).push(view);
    }

    const proposalViews = proposals.map((proposal) => {
      const evaluation = this.evaluateStances(
        stancesByTarget.get(proposal.id) || [],
        proposal.author,
        clusters
      );
      const attachedMissions = (missionViews.get(proposal.id) || []).sort((a, b) => b.score - a.score);
      return {
        id: proposal.id,
        author: proposal.author,
        createdAt: proposal.createdAt,
        body: proposal.body,
        artifact: proposal.artifact,
        fundingGoalMicros: proposal.amountMicros,
        ...evaluation,
        score:
          this.trust.domainWeight(proposal.author, ["taste", "prediction", "integrity"]) +
          evaluation.netWeight,
        missions: attachedMissions,
        leadingMissionId: attachedMissions[0]?.id || null,
      };
    });

    proposalViews.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const currentReferralDrive = proposalViews
      .filter((proposal) => proposal.status === "ready")
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0] || null;
    return {
      launchId,
      postcardCount: postcards.length,
      proposalCount: proposalViews.length,
      leadingProposalId: proposalViews[0]?.id || null,
      currentReferralDrive,
      proposals: proposalViews,
      stanceClusters: clusters.view(),
    };
  }
}

module.exports = { CoalitionEngine };
