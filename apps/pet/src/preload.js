const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("versus", {
  getServiceActivity: () => ipcRenderer.invoke("service:activitySnapshot"),
  getHealth: () => ipcRenderer.invoke("health:snapshot"),
  exportDiagnostics: () => ipcRenderer.invoke("diagnostics:export"),
  onServiceActivity: (callback) => {
    const listener = (_event, activity) => callback(activity);
    ipcRenderer.on("service:activity", listener);
    return () => ipcRenderer.removeListener("service:activity", listener);
  },
  onHealth: (callback) => {
    const listener = (_event, health) => callback(health);
    ipcRenderer.on("health:changed", listener);
    return () => ipcRenderer.removeListener("health:changed", listener);
  },
  loadBond: () => ipcRenderer.invoke("bond:load"),
  saveBond: (state) => ipcRenderer.invoke("bond:save", state),
  ensureWallet: () => ipcRenderer.invoke("wallet:ensure"),
  getWallet: () => ipcRenderer.invoke("wallet:getPublic"),
  getAddressQr: () => ipcRenderer.invoke("wallet:getAddressQr"),
  copyAddress: () => ipcRenderer.invoke("wallet:copyAddress"),
  copyPrivateKey: () => ipcRenderer.invoke("wallet:copyPrivateKey"),
  createWalletBackup: (password) => ipcRenderer.invoke("wallet:createBackup", { password }),
  restoreWalletBackup: (password) => ipcRenderer.invoke("wallet:restoreBackup", { password }),
  createCypherArchive: (password) => ipcRenderer.invoke("cypher:createArchive", { password }),
  restoreCypherArchive: (password) => ipcRenderer.invoke("cypher:restoreArchive", { password }),
  getHatchQuote: () => ipcRenderer.invoke("wallet:getHatchQuote"),
  beginFunding: () => ipcRenderer.invoke("wallet:beginFunding"),
  completeFunding: () => ipcRenderer.invoke("wallet:completeFunding"),
  reconcile: () => ipcRenderer.invoke("wallet:reconcile"),
  simulateDeposit: () => ipcRenderer.invoke("wallet:simulateDeposit"),
  claimTranche: () => ipcRenderer.invoke("wallet:claimTranche"),
  withdrawVault: (amount) => ipcRenderer.invoke("wallet:withdrawVault", { amount }),
  rainFromRunway: (pennies) => ipcRenderer.invoke("wallet:rainFromRunway", { pennies }),
  networkStatus: () => ipcRenderer.invoke("network:status"),
  networkConnect: (peerUrl) => ipcRenderer.invoke("network:connect", { peerUrl }),
  networkPublish: (postcard) => ipcRenderer.invoke("network:publish", postcard),
  networkPublishMission: (input) => ipcRenderer.invoke("network:publishMission", input),
  networkPublishOutcome: (input) => ipcRenderer.invoke("network:publishOutcome", input),
  networkList: (query) => ipcRenderer.invoke("network:list", query),
  networkCoalitionView: (launchId) => ipcRenderer.invoke("network:coalitionView", { launchId }),
  networkClusterView: () => ipcRenderer.invoke("network:clusterView"),
  networkGetArtifact: (reference) => ipcRenderer.invoke("network:getArtifact", { reference }),
  networkAssessOutcome: (input) => ipcRenderer.invoke("network:assessOutcome", input),
  networkListOutcomeAssessments: () => ipcRenderer.invoke("network:listOutcomeAssessments"),
  networkListSignalBatches: () => ipcRenderer.invoke("network:listSignalBatches"),
  networkSettleSignalBatch: (launchId, limit) =>
    ipcRenderer.invoke("network:settleSignalBatch", { launchId, limit }),
  networkSponsorMission: (missionId, amount, deadline) =>
    ipcRenderer.invoke("network:sponsorMission", { missionId, amount, deadline }),
  networkReleaseMission: (escrowId) => ipcRenderer.invoke("network:releaseMission", { escrowId }),
  networkRefundMission: (escrowId) => ipcRenderer.invoke("network:refundMission", { escrowId }),
  networkGetMissionEscrow: (escrowId) => ipcRenderer.invoke("network:getMissionEscrow", { escrowId }),
  networkVerifyEconomicProof: (reference) =>
    ipcRenderer.invoke("network:verifyEconomicProof", { reference }),
  networkSetBlocked: (address, blocked) =>
    ipcRenderer.invoke("network:setBlocked", { address, blocked }),
  networkSetTrustScore: (address, dimension, score) =>
    ipcRenderer.invoke("network:setTrustScore", { address, dimension, score }),
  networkListPeerRelationships: (query) => ipcRenderer.invoke("network:listPeerRelationships", query),
  networkSetPeerPreference: (address, preference) =>
    ipcRenderer.invoke("network:setPeerPreference", { address, preference }),
  networkSetPeerAffinity: (address, affinity, evidence) =>
    ipcRenderer.invoke("network:setPeerAffinity", { address, affinity, evidence }),
  networkListMemories: (query) => ipcRenderer.invoke("network:listMemories", query),
  networkPutMemory: (memory) => ipcRenderer.invoke("network:putMemory", memory),
  agentStatus: () => ipcRenderer.invoke("agent:status"),
  agentTick: () => ipcRenderer.invoke("agent:tick"),
  agentStart: () => ipcRenderer.invoke("agent:start"),
  agentStop: () => ipcRenderer.invoke("agent:stop"),
  agentNextThought: () => ipcRenderer.invoke("agent:nextThought"),
  agentMarkThoughtShowing: (id) => ipcRenderer.invoke("agent:markThoughtShowing", { id }),
  agentMarkThoughtSeen: (id) => ipcRenderer.invoke("agent:markThoughtSeen", { id }),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  getBrainCapabilities: () => ipcRenderer.invoke("settings:brainCapabilities"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  testBrain: (settings) => ipcRenderer.invoke("settings:testBrain", settings),
  getUpdateStatus: () => ipcRenderer.invoke("update:status"),
  checkForUpdates: () => ipcRenderer.invoke("update:check"),
  downloadUpdate: () => ipcRenderer.invoke("update:download"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  onUpdateStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("update:status", listener);
    return () => ipcRenderer.removeListener("update:status", listener);
  },
  runOnboardPipeline: (cypherCount) =>
    ipcRenderer.invoke("wallet:runOnboardPipeline", { cypherCount }),
  hide: () => ipcRenderer.invoke("window:close"),
  quit: () => ipcRenderer.invoke("window:quit"),
});
