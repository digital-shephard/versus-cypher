const { Contract, Interface, getAddress, isAddress } = require("ethers");
const { normalizeSignalSettlement } = require("./signal-batch");
const { normalizeMissionSponsorship } = require("./sponsorship");

const ARENA_ABI = [
  "function settledSignalBatches(bytes32 batchRoot) view returns (bool)",
  "event SignalBatchSettled(uint256 indexed agentId, uint256 indexed classId, bytes32 indexed batchRoot, uint256 signalCount, uint256 inkPennies, uint256 amount)",
];
const ESCROW_ABI = [
  "function escrows(uint256 escrowId) view returns (bytes32 missionId, uint256 launchId, uint256 sponsorAgentId, uint256 recipientAgentId, uint128 amount, uint64 deadline, uint8 state, address sponsor)",
  "event MissionSponsored(uint256 indexed escrowId, bytes32 indexed missionId, uint256 indexed launchId, uint256 sponsorAgentId, uint256 recipientAgentId, address sponsor, uint256 amount, uint256 deadline)",
];

class EconomicProofError extends Error {
  constructor(message, code = "INVALID_ECONOMIC_PROOF") {
    super(message);
    this.name = "EconomicProofError";
    this.code = code;
  }
}

function matchingEvent(receipt, address, abi, eventName) {
  const iface = new Interface(abi);
  const normalizedAddress = getAddress(address).toLowerCase();
  for (const log of receipt.logs || []) {
    if (String(log.address).toLowerCase() !== normalizedAddress) continue;
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === eventName) return parsed;
    } catch (_) {}
  }
  throw new EconomicProofError(`${eventName} event is missing from its receipt`, "MISSING_ECONOMIC_EVENT");
}

class ContractEconomicVerifier {
  constructor({ provider, chainId, arena, missionEscrow }) {
    if (!provider || typeof provider.getNetwork !== "function" || typeof provider.getTransactionReceipt !== "function") {
      throw new TypeError("economic verifier requires an ethers provider");
    }
    for (const [label, value] of [["arena", arena]]) {
      if (typeof value !== "string" || !isAddress(value)) {
        throw new TypeError(`${label} must be an ethereum address`);
      }
    }
    if (missionEscrow != null && (typeof missionEscrow !== "string" || !isAddress(missionEscrow))) {
      throw new TypeError("missionEscrow must be an ethereum address");
    }
    this.provider = provider;
    this.chainId = BigInt(chainId);
    this.arenaAddress = getAddress(arena);
    this.escrowAddress = missionEscrow ? getAddress(missionEscrow) : null;
    this.arena = new Contract(this.arenaAddress, ARENA_ABI, provider);
    this.escrow = this.escrowAddress ? new Contract(this.escrowAddress, ESCROW_ABI, provider) : null;
    this.networkCheck = null;
  }

  async assertNetwork() {
    if (!this.networkCheck) {
      this.networkCheck = this.provider.getNetwork().then((network) => {
        if (BigInt(network.chainId) !== this.chainId) {
          throw new EconomicProofError("economic verifier provider is on the wrong chain", "WRONG_CHAIN");
        }
        return true;
      });
    }
    return this.networkCheck;
  }

  async receipt(transactionHash, blockNumber) {
    await this.assertNetwork();
    const receipt = await this.provider.getTransactionReceipt(transactionHash);
    if (!receipt || receipt.status !== 1) {
      throw new EconomicProofError("economic proof transaction is not confirmed", "UNCONFIRMED_ECONOMIC_PROOF");
    }
    if (BigInt(receipt.blockNumber) !== BigInt(blockNumber)) {
      throw new EconomicProofError("economic proof block does not match its receipt");
    }
    return receipt;
  }

  async verifySignalSettlement(value) {
    const settlement = normalizeSignalSettlement(value);
    if (
      BigInt(settlement.batch.chainId) !== this.chainId ||
      settlement.batch.arena !== this.arenaAddress.toLowerCase()
    ) {
      throw new EconomicProofError("signal proof targets another deployment", "WRONG_ECONOMIC_DEPLOYMENT");
    }
    if (!(await this.arena.settledSignalBatches(settlement.batch.root))) {
      throw new EconomicProofError("signal batch root is not settled onchain", "UNSETTLED_SIGNAL_BATCH");
    }
    const receipt = await this.receipt(settlement.transactionHash, settlement.blockNumber);
    const event = matchingEvent(receipt, this.arenaAddress, ARENA_ABI, "SignalBatchSettled");
    if (
      event.args.agentId !== BigInt(settlement.batch.agentId) ||
      event.args.classId !== BigInt(settlement.batch.launchId) ||
      event.args.batchRoot !== settlement.batch.root ||
      event.args.signalCount !== BigInt(settlement.batch.signalCount) ||
      event.args.inkPennies !== BigInt(settlement.batch.inkPennies) ||
      event.args.amount !== BigInt(settlement.batch.amountMicros)
    ) {
      throw new EconomicProofError("signal settlement event does not match its artifact");
    }
    return { verified: true, kind: "signal", settlement, receipt };
  }

  async verifyMissionSponsorship(value) {
    if (!this.escrow) throw new EconomicProofError("mission escrow verification is not configured");
    const sponsorship = normalizeMissionSponsorship(value);
    if (
      BigInt(sponsorship.chainId) !== this.chainId ||
      sponsorship.escrow !== this.escrowAddress.toLowerCase()
    ) {
      throw new EconomicProofError("sponsorship proof targets another deployment", "WRONG_ECONOMIC_DEPLOYMENT");
    }
    const escrow = await this.escrow.escrows(BigInt(sponsorship.escrowId));
    if (
      escrow.missionId !== sponsorship.missionId ||
      escrow.launchId !== BigInt(sponsorship.launchId) ||
      escrow.sponsorAgentId !== BigInt(sponsorship.sponsorAgentId) ||
      escrow.recipientAgentId !== BigInt(sponsorship.recipientAgentId) ||
      escrow.amount !== BigInt(sponsorship.amountMicros) ||
      escrow.deadline !== BigInt(sponsorship.deadline) ||
      escrow.sponsor.toLowerCase() !== sponsorship.sponsor
    ) {
      throw new EconomicProofError("mission escrow state does not match its artifact");
    }
    const receipt = await this.receipt(sponsorship.transactionHash, sponsorship.blockNumber);
    const event = matchingEvent(receipt, this.escrowAddress, ESCROW_ABI, "MissionSponsored");
    if (
      event.args.escrowId !== BigInt(sponsorship.escrowId) ||
      event.args.missionId !== sponsorship.missionId ||
      event.args.launchId !== BigInt(sponsorship.launchId) ||
      event.args.sponsorAgentId !== BigInt(sponsorship.sponsorAgentId) ||
      event.args.recipientAgentId !== BigInt(sponsorship.recipientAgentId) ||
      event.args.sponsor.toLowerCase() !== sponsorship.sponsor ||
      event.args.amount !== BigInt(sponsorship.amountMicros) ||
      event.args.deadline !== BigInt(sponsorship.deadline)
    ) {
      throw new EconomicProofError("mission sponsorship event does not match its artifact");
    }
    return { verified: true, kind: "sponsorship", sponsorship, escrowState: Number(escrow.state), receipt };
  }
}

module.exports = {
  ARENA_ABI,
  ESCROW_ABI,
  ContractEconomicVerifier,
  EconomicProofError,
  matchingEvent,
};
