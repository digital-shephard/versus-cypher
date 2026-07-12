// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IAgentNFT {
    function mint(address to, uint8 cypherId) external returns (uint256 agentId);
    function recordCommit(uint256 agentId, uint32 day) external;
    function ownerOf(uint256 tokenId) external view returns (address);
    function agents(uint256 agentId)
        external
        view
        returns (uint8 cypherId, uint32 level, uint32 streak, uint32 lastCommitDay, uint128 vault);
}

interface ISyndicateEngine {
    function receiveCommit(uint256 agentId, uint32 day, uint256 amount) external;
    function currentClassId() external view returns (uint256);
}

interface ITrancheTreasury {
    function receiveFee(uint256 amount) external;
    function awardCommitTicket(uint256 agentId) external;
    function awardTickets(uint256 agentId, uint256 amount) external;
}

/// @title Versus Arena (ownerless)
/// @notice Immutable entrypoint. No admin. No pause.
contract Arena {
    using SafeERC20 for IERC20;

    uint256 public constant PENNY = 10_000;
    uint256 public constant MIN_RUNWAY = 7_000_000;
    uint256 public constant DAY = 1 days;
    uint256 public constant MAX_RAIN_PENNIES = 100;
    uint256 public constant MAX_SIGNAL_BATCH = 100;
    uint256 public constant MAX_SIGNAL_INK_PENNIES = 500;

    IERC20 public immutable usdc;
    IAgentNFT public immutable agents;
    ISyndicateEngine public immutable syndicate;
    ITrancheTreasury public immutable treasury;
    mapping(uint256 => mapping(uint32 => bool)) public committedDays;
    mapping(uint256 => mapping(bytes32 => bool)) public settledSignalBatches;
    mapping(uint256 => uint128) public runway;
    uint256 public totalRunwayLiability;

    event Hatched(uint256 indexed agentId, address indexed owner, uint8 cypherId, uint256 runwayAmount);
    event RunwayReplenished(uint256 indexed agentId, address indexed from, uint256 amount);
    event Committed(uint256 indexed agentId, address indexed owner, uint32 day, uint256 amount);
    event Rained(uint256 indexed agentId, address indexed owner, uint32 day, uint256 pennies, uint256 amount);
    event SignalBatchSettled(
        uint256 indexed agentId,
        uint256 indexed classId,
        bytes32 indexed batchRoot,
        uint256 signalCount,
        uint256 inkPennies,
        uint256 amount,
        bytes32 typeCountsHash
    );

    error NotAgentOwner();
    error AlreadyCommitted();
    error InsufficientRunway();
    error RunwayBelowMinimum();
    error InvalidRainAmount();
    error InvalidSignalBatch();
    error SignalBatchAlreadySettled();
    error WrongClass();
    error ZeroAddress();

    constructor(address usdc_, address agents_, address syndicate_, address treasury_) {
        if (usdc_ == address(0) || agents_ == address(0) || syndicate_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        usdc = IERC20(usdc_);
        agents = IAgentNFT(agents_);
        syndicate = ISyndicateEngine(syndicate_);
        treasury = ITrancheTreasury(treasury_);
    }

    /// @notice Hatches a Cypher with nonwithdrawable protocol fuel held by the Arena.
    function hatch(uint8 cypherId, uint256 runwayAmount) external returns (uint256 agentId) {
        if (runwayAmount < MIN_RUNWAY || runwayAmount > type(uint128).max) revert RunwayBelowMinimum();
        usdc.safeTransferFrom(msg.sender, address(this), runwayAmount);
        agentId = agents.mint(msg.sender, cypherId);
        runway[agentId] = uint128(runwayAmount);
        totalRunwayLiability += runwayAmount;
        emit Hatched(agentId, msg.sender, cypherId, runwayAmount);
    }

    /// @notice Adds protocol fuel to an existing Cypher. Anyone may sponsor a Cypher.
    function replenishRunway(uint256 agentId, uint256 amount) external {
        agents.ownerOf(agentId);
        if (amount == 0 || amount > type(uint128).max) revert InvalidRainAmount();
        uint256 next = uint256(runway[agentId]) + amount;
        if (next > type(uint128).max) revert InvalidRainAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        runway[agentId] = uint128(next);
        totalRunwayLiability += amount;
        emit RunwayReplenished(agentId, msg.sender, amount);
    }

    function commit(uint256 agentId) external {
        _commit(agentId);
    }

    /// @notice Sends a capped batch of pennies from the Cypher vault into the open class.
    ///         Each confirmed penny creates one permanent tranche ticket.
    function rainFromRunway(uint256 agentId, uint256 pennies) external {
        if (agents.ownerOf(agentId) != msg.sender) revert NotAgentOwner();
        if (pennies == 0 || pennies > MAX_RAIN_PENNIES) revert InvalidRainAmount();

        uint256 amount = pennies * PENNY;
        _spendRunway(agentId, amount);

        uint32 day = uint32(block.timestamp / DAY);
        syndicate.receiveCommit(agentId, day, amount);
        treasury.awardTickets(agentId, pennies);

        emit Rained(agentId, msg.sender, day, pennies, amount);
    }

    /// @notice Settles a bounded set of durable postcard IDs as one vault transaction.
    ///         Each signal contributes one penny to the current class and awards one ticket.
    ///         The root is an offchain-verifiable commitment; payment buys ink, not network weight.
    function settleSignalBatchFromRunway(
        uint256 agentId,
        uint256 classId,
        bytes32 batchRoot,
        uint16[8] calldata typeCounts
    ) external {
        if (agents.ownerOf(agentId) != msg.sender) revert NotAgentOwner();
        (uint256 signalCount, uint256 inkPennies) = _signalTotals(typeCounts);
        if (batchRoot == bytes32(0) || signalCount == 0 || signalCount > MAX_SIGNAL_BATCH) {
            revert InvalidSignalBatch();
        }
        if (settledSignalBatches[agentId][batchRoot]) revert SignalBatchAlreadySettled();
        if (syndicate.currentClassId() != classId) revert WrongClass();

        uint256 amount = inkPennies * PENNY;
        settledSignalBatches[agentId][batchRoot] = true;
        _spendRunway(agentId, amount);

        uint32 day = uint32(block.timestamp / DAY);
        syndicate.receiveCommit(agentId, day, amount);
        treasury.awardTickets(agentId, inkPennies);
        emit SignalBatchSettled(
            agentId, classId, batchRoot, signalCount, inkPennies, amount, keccak256(abi.encode(typeCounts))
        );
    }

    function _signalTotals(uint16[8] calldata counts) internal pure returns (uint256 total, uint256 ink) {
        uint8[8] memory prices = [1, 1, 3, 1, 1, 1, 5, 2];
        for (uint256 i; i < counts.length; ++i) {
            total += counts[i];
            ink += uint256(counts[i]) * prices[i];
        }
        if (ink > MAX_SIGNAL_INK_PENNIES) revert InvalidSignalBatch();
    }

    function currentDay() public view returns (uint32) {
        return uint32(block.timestamp / DAY);
    }

    function _commit(uint256 agentId) internal {
        if (agents.ownerOf(agentId) != msg.sender) revert NotAgentOwner();

        uint32 day = uint32(block.timestamp / DAY);
        (, , , uint32 lastDay, ) = agents.agents(agentId);
        if (lastDay == day) revert AlreadyCommitted();

        _spendRunway(agentId, PENNY);

        agents.recordCommit(agentId, day);
        committedDays[agentId][day] = true;
        syndicate.receiveCommit(agentId, day, PENNY);
        treasury.awardCommitTicket(agentId);

        emit Committed(agentId, msg.sender, day, PENNY);
    }

    function runwayDays(uint256 agentId) external view returns (uint256) {
        return uint256(runway[agentId]) / PENNY;
    }

    function runwaySolvent() external view returns (bool) {
        return usdc.balanceOf(address(this)) >= totalRunwayLiability;
    }

    function _spendRunway(uint256 agentId, uint256 amount) internal {
        uint128 available = runway[agentId];
        if (available < amount) revert InsufficientRunway();
        unchecked {
            runway[agentId] = available - uint128(amount);
            totalRunwayLiability -= amount;
        }
        usdc.safeTransfer(address(syndicate), amount);
    }
}
