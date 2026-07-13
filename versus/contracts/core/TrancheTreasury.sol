// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IAgentNFTTreasury {
    function receiveProfit(uint256 agentId, uint256 amount) external;
}

/// @title Versus rolling reward treasury (ownerless)
/// @notice Every fee is allocated immediately: 10% immutable protocol cut, 90% to permanent tickets.
///         New tickets dilute future allocations but cannot reach backward into already allocated rewards.
contract TrancheTreasury {
    using SafeERC20 for IERC20;

    uint256 public constant PROTOCOL_TRANCHE_BPS = 1_000;
    uint256 public constant BPS = 10_000;
    uint256 public constant ACC_REWARD_PRECISION = 1e27;

    IERC20 public immutable usdc;
    address public immutable protocolRecipient;
    address public immutable deployer;

    address public arena;
    IAgentNFTTreasury public agents;
    bool public bootstrapped;

    /// @notice Agent rewards still held by this contract (claimable liabilities plus any sub-precision dust).
    uint256 public tranchePot;
    uint256 public totalFeesReceived;
    uint256 public totalProtocolPaid;
    /// @notice Fees received while totalTickets == 0; indexed once when the first ticket arrives.
    uint256 public rewardRemainder;

    mapping(uint256 => uint256) public tickets;
    uint256 public totalTickets;
    uint256 public accRewardPerTicket;
    /// @notice High-precision entitlement checkpoint used to prevent new tickets reaching old rewards.
    mapping(uint256 => uint256) public rewardDebtScaled;
    /// @notice High-precision settled entitlement. Whole USDC units are removed only when claimed.
    mapping(uint256 => uint256) public storedRewardsScaled;

    event Bootstrapped(address arena, address agents);
    event FeeReceived(uint256 amount, uint256 tranchePot);
    event FeesAllocated(uint256 agentPot, uint256 protocolCut, uint256 rewardPerTicket, uint256 totalTickets);
    event TicketsAwarded(uint256 indexed agentId, uint256 amount, uint256 newTotal);
    event Claimed(uint256 indexed agentId, uint256 amount);
    event ClaimCapped(uint256 indexed agentId, uint256 requested, uint256 paid);

    error NotArena();
    error NotDeployer();
    error ZeroAddress();
    error AlreadyBootstrapped();
    error NothingToClaim();

    modifier onlyArena() {
        if (msg.sender != arena) revert NotArena();
        _;
    }

    constructor(address usdc_, address protocolRecipient_) {
        if (usdc_ == address(0) || protocolRecipient_ == address(0)) revert ZeroAddress();
        usdc = IERC20(usdc_);
        protocolRecipient = protocolRecipient_;
        deployer = msg.sender;
    }

    function bootstrap(address arena_, address agents_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (bootstrapped) revert AlreadyBootstrapped();
        if (arena_ == address(0) || agents_ == address(0)) revert ZeroAddress();
        arena = arena_;
        agents = IAgentNFTTreasury(agents_);
        usdc.forceApprove(agents_, type(uint256).max);
        bootstrapped = true;
        emit Bootstrapped(arena_, agents_);
    }

    function depositFees(uint256 amount) external {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        _take(amount);
    }

    function awardCommitTicket(uint256 agentId) external onlyArena {
        _awardTickets(agentId, 1);
    }

    function awardTickets(uint256 agentId, uint256 amount) external onlyArena {
        if (amount == 0) return;
        _awardTickets(agentId, amount);
    }

    function _awardTickets(uint256 agentId, uint256 amount) internal {
        uint256 previousTotal = totalTickets;
        _settle(agentId);
        tickets[agentId] += amount;
        totalTickets += amount;
        rewardDebtScaled[agentId] = tickets[agentId] * accRewardPerTicket;

        // Fees cannot normally arrive before graduation and tickets, but do not strand them if they do.
        if (previousTotal == 0 && rewardRemainder > 0) {
            uint256 waiting = rewardRemainder;
            rewardRemainder = 0;
            _indexRewards(waiting);
        }
        emit TicketsAwarded(agentId, amount, tickets[agentId]);
    }

    /// @notice Exact rolling rewards earned by permanent tickets and not yet moved into the NFT vault.
    function claimable(uint256 agentId) public view returns (uint256) {
        uint256 accumulatedScaled = tickets[agentId] * accRewardPerTicket;
        uint256 debtScaled = rewardDebtScaled[agentId];
        uint256 unsettledScaled = accumulatedScaled > debtScaled ? accumulatedScaled - debtScaled : 0;
        return (storedRewardsScaled[agentId] + unsettledScaled) / ACC_REWARD_PRECISION;
    }

    /// @notice Backward-compatible view alias. Rolling rewards are already earned and claimable.
    function previewTranche(uint256 agentId) external view returns (uint256) {
        return claimable(agentId);
    }

    /// @notice Permissionless accounting; the reward is deposited into the separately withdrawable NFT vault.
    /// @dev Entitlements remain scaled until this final conversion, so account-level flooring cannot create
    ///      liabilities above tranchePot. The cap is a fail-safe for any future invariant regression and emits
    ///      ClaimCapped if it ever activates.
    function claim(uint256 agentId) external {
        _settle(agentId);
        uint256 scaled = storedRewardsScaled[agentId];
        uint256 requested = scaled / ACC_REWARD_PRECISION;
        if (requested == 0) revert NothingToClaim();

        // Keep only the sub-USDC fraction. Any impossible unbacked whole-unit liability is discarded by
        // the fail-safe rather than leaking into rewards deposited after this claim.
        storedRewardsScaled[agentId] = scaled % ACC_REWARD_PRECISION;
        uint256 pot = tranchePot;
        uint256 amount = requested > pot ? pot : requested;
        if (amount < requested) emit ClaimCapped(agentId, requested, amount);
        if (amount > 0) {
            tranchePot = pot - amount;
            agents.receiveProfit(agentId, amount);
        }
        emit Claimed(agentId, amount);
    }

    function _take(uint256 amount) internal {
        if (amount == 0) return;
        totalFeesReceived += amount;

        uint256 protocolCut = (amount * PROTOCOL_TRANCHE_BPS) / BPS;
        uint256 agentPot = amount - protocolCut;
        if (protocolCut > 0) {
            totalProtocolPaid += protocolCut;
            usdc.safeTransfer(protocolRecipient, protocolCut);
        }

        tranchePot += agentPot;
        if (totalTickets == 0) {
            rewardRemainder += agentPot;
        } else {
            _indexRewards(agentPot);
        }

        emit FeeReceived(amount, tranchePot);
        emit FeesAllocated(agentPot, protocolCut, accRewardPerTicket, totalTickets);
    }

    /// @dev Indexes `amount` into accRewardPerTicket once. Sub-precision dust stays as excess USDC
    ///      rather than a second liability in rewardRemainder (which would double-count).
    function _indexRewards(uint256 amount) internal {
        if (amount == 0 || totalTickets == 0) return;
        accRewardPerTicket += (amount * ACC_REWARD_PRECISION) / totalTickets;
    }

    function _settle(uint256 agentId) internal {
        uint256 accumulatedScaled = tickets[agentId] * accRewardPerTicket;
        uint256 debtScaled = rewardDebtScaled[agentId];
        if (accumulatedScaled > debtScaled) {
            storedRewardsScaled[agentId] += accumulatedScaled - debtScaled;
        }
        rewardDebtScaled[agentId] = accumulatedScaled;
    }
}
