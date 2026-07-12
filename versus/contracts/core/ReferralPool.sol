// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IReferralAgentNFT {
    function ownerOf(uint256 tokenId) external view returns (address);
    function receiveProfit(uint256 agentId, uint256 amount) external;
}

/// @title Versus Referral Pool (ownerless)
/// @notice One continuously funded pool paying a fixed reward for an atomically referred hatch.
contract ReferralPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    IReferralAgentNFT public immutable agents;
    address public immutable deployer;
    uint256 public immutable rewardPerReferral;

    address public arena;
    bool public bootstrapped;
    uint256 public totalFunded;
    uint256 public totalPaid;

    mapping(uint256 => uint256) public referredBy;

    event Bootstrapped(address arena);
    event ReferralPoolFunded(
        uint256 indexed sponsorAgentId,
        bytes32 indexed proposalId,
        address indexed funder,
        uint256 amount,
        uint256 balance
    );
    event ReferralRewardPaid(
        uint256 indexed referredAgentId,
        uint256 indexed referrerAgentId,
        address indexed referredOwner,
        uint256 amount
    );
    event ReferralRewardSkipped(
        uint256 indexed referredAgentId,
        uint256 indexed referrerAgentId,
        address indexed referredOwner,
        uint256 poolBalance
    );
    event ReferralPoolFundedFromRunway(
        uint256 indexed sponsorAgentId,
        bytes32 indexed proposalId,
        uint256 amount,
        uint256 balance
    );

    error NotAuthorized();
    error AlreadyBootstrapped();
    error NotAgentOwner();
    error InvalidReferral();
    error InvalidAmount();
    error ZeroAddress();

    constructor(address usdc_, address agents_, uint256 rewardPerReferral_) {
        if (usdc_ == address(0) || agents_ == address(0)) revert ZeroAddress();
        if (rewardPerReferral_ == 0) revert InvalidAmount();
        usdc = IERC20(usdc_);
        agents = IReferralAgentNFT(agents_);
        rewardPerReferral = rewardPerReferral_;
        deployer = msg.sender;
        IERC20(usdc_).forceApprove(agents_, type(uint256).max);
    }

    function bootstrap(address arena_) external {
        if (msg.sender != deployer) revert NotAuthorized();
        if (bootstrapped) revert AlreadyBootstrapped();
        if (arena_ == address(0)) revert ZeroAddress();
        arena = arena_;
        bootstrapped = true;
        emit Bootstrapped(arena_);
    }

    /// @notice Voluntarily and irreversibly refills the permanent referral pool.
    /// @param proposalId Optional signed Narrowband proposal ID motivating the contribution.
    function fund(uint256 sponsorAgentId, bytes32 proposalId, uint256 amount) external nonReentrant {
        if (agents.ownerOf(sponsorAgentId) != msg.sender) revert NotAgentOwner();
        if (amount == 0) revert InvalidAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        totalFunded += amount;
        emit ReferralPoolFunded(sponsorAgentId, proposalId, msg.sender, amount, usdc.balanceOf(address(this)));
    }

    /// @notice Records the one-penny fixed-destination contribution transferred by Arena.
    function recordRunwayFunding(uint256 sponsorAgentId, bytes32 proposalId, uint256 amount) external nonReentrant {
        if (msg.sender != arena) revert NotAuthorized();
        if (amount != 10_000) revert InvalidAmount();
        totalFunded += amount;
        emit ReferralPoolFundedFromRunway(sponsorAgentId, proposalId, amount, usdc.balanceOf(address(this)));
    }

    /// @notice Called only by Arena during hatch; records valid attribution and pays only when funded.
    function recordReferral(uint256 referredAgentId, uint256 referrerAgentId, address referredOwner)
        external
        nonReentrant
        returns (uint256 rewardPaid)
    {
        if (msg.sender != arena) revert NotAuthorized();
        if (referredBy[referredAgentId] != 0 || referredAgentId == referrerAgentId || referredOwner == address(0)) {
            revert InvalidReferral();
        }
        address referrerOwner = agents.ownerOf(referrerAgentId);
        if (referrerOwner == referredOwner) revert InvalidReferral();

        referredBy[referredAgentId] = referrerAgentId;
        uint256 poolBalance = usdc.balanceOf(address(this));
        if (poolBalance < rewardPerReferral) {
            emit ReferralRewardSkipped(referredAgentId, referrerAgentId, referredOwner, poolBalance);
            return 0;
        }

        totalPaid += rewardPerReferral;
        agents.receiveProfit(referrerAgentId, rewardPerReferral);
        emit ReferralRewardPaid(referredAgentId, referrerAgentId, referredOwner, rewardPerReferral);
        return rewardPerReferral;
    }

    function availableRewards() external view returns (uint256) {
        return usdc.balanceOf(address(this)) / rewardPerReferral;
    }
}
