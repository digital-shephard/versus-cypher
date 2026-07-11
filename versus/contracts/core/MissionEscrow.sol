// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IAgentNFTEscrow {
    function ownerOf(uint256 tokenId) external view returns (address);
    function receiveProfit(uint256 agentId, uint256 amount) external;
}

/// @title Versus Mission Escrow (ownerless)
/// @notice Voluntary mission sponsorship bound to signed postcard IDs.
///         The sponsor judges release; expiry restores their funds. No protocol oracle or admin.
contract MissionEscrow {
    using SafeERC20 for IERC20;

    uint256 public constant MIN_DURATION = 1 hours;
    uint256 public constant MAX_DURATION = 30 days;

    IERC20 public immutable usdc;
    IAgentNFTEscrow public immutable agents;

    enum EscrowState {
        Active,
        Released,
        Refunded
    }

    struct Escrow {
        bytes32 missionId;
        uint256 launchId;
        uint256 sponsorAgentId;
        uint256 recipientAgentId;
        uint128 amount;
        uint64 deadline;
        EscrowState state;
        address sponsor;
    }

    uint256 public nextEscrowId = 1;
    mapping(uint256 => Escrow) public escrows;

    event MissionSponsored(
        uint256 indexed escrowId,
        bytes32 indexed missionId,
        uint256 indexed launchId,
        uint256 sponsorAgentId,
        uint256 recipientAgentId,
        address sponsor,
        uint256 amount,
        uint256 deadline
    );
    event MissionReleased(uint256 indexed escrowId, bytes32 indexed missionId, uint256 recipientAgentId, uint256 amount);
    event MissionRefunded(uint256 indexed escrowId, bytes32 indexed missionId, address sponsor, uint256 amount);

    error NotAgentOwner();
    error NotSponsor();
    error InvalidMission();
    error InvalidAmount();
    error InvalidDeadline();
    error EscrowNotActive();
    error EscrowNotExpired();
    error ZeroAddress();

    constructor(address usdc_, address agents_) {
        if (usdc_ == address(0) || agents_ == address(0)) revert ZeroAddress();
        usdc = IERC20(usdc_);
        agents = IAgentNFTEscrow(agents_);
        usdc.forceApprove(agents_, type(uint256).max);
    }

    function sponsorMission(
        bytes32 missionId,
        uint256 launchId,
        uint256 sponsorAgentId,
        uint256 recipientAgentId,
        uint256 amount,
        uint64 deadline
    ) external returns (uint256 escrowId) {
        if (missionId == bytes32(0) || launchId == 0) revert InvalidMission();
        if (amount == 0 || amount > type(uint128).max) revert InvalidAmount();
        if (agents.ownerOf(sponsorAgentId) != msg.sender) revert NotAgentOwner();
        agents.ownerOf(recipientAgentId);
        if (deadline < block.timestamp + MIN_DURATION || deadline > block.timestamp + MAX_DURATION) {
            revert InvalidDeadline();
        }

        escrowId = nextEscrowId++;
        escrows[escrowId] = Escrow({
            missionId: missionId,
            launchId: launchId,
            sponsorAgentId: sponsorAgentId,
            recipientAgentId: recipientAgentId,
            amount: uint128(amount),
            deadline: deadline,
            state: EscrowState.Active,
            sponsor: msg.sender
        });
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit MissionSponsored(
            escrowId,
            missionId,
            launchId,
            sponsorAgentId,
            recipientAgentId,
            msg.sender,
            amount,
            deadline
        );
    }

    function release(uint256 escrowId) external {
        Escrow storage escrow = escrows[escrowId];
        if (escrow.state != EscrowState.Active) revert EscrowNotActive();
        if (escrow.sponsor != msg.sender) revert NotSponsor();
        escrow.state = EscrowState.Released;
        agents.receiveProfit(escrow.recipientAgentId, escrow.amount);
        emit MissionReleased(escrowId, escrow.missionId, escrow.recipientAgentId, escrow.amount);
    }

    function refund(uint256 escrowId) external {
        Escrow storage escrow = escrows[escrowId];
        if (escrow.state != EscrowState.Active) revert EscrowNotActive();
        if (escrow.sponsor != msg.sender) revert NotSponsor();
        if (block.timestamp < escrow.deadline) revert EscrowNotExpired();
        escrow.state = EscrowState.Refunded;
        usdc.safeTransfer(escrow.sponsor, escrow.amount);
        emit MissionRefunded(escrowId, escrow.missionId, escrow.sponsor, escrow.amount);
    }
}
