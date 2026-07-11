// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title Versus Syndicate Engine (ownerless)
/// @notice One open class fills with daily pennies until graduationFloor.
///         Agents are the fund. No seed account.
contract SyndicateEngine {
    using SafeERC20 for IERC20;

    uint256 public constant DAY = 1 days;
    uint256 public constant GENESIS_CLASS_ID = 1;

    IERC20 public immutable usdc;
    uint256 public immutable graduationFloor; // e.g. $1000 USDC = 1_000_000_000
    address public immutable deployer;

    address public arena;
    address public graduation;
    bool public bootstrapped;

    struct Class {
        uint256 totalCommitted;
        uint32 participantCount;
        uint32 openedDay;
        bool graduated;
        address token;
        address pair;
        uint256 liquidity;
    }

    uint256 public currentClassId = 1;
    mapping(uint256 => Class) public classes;
    mapping(uint256 => mapping(uint256 => uint256)) public commitOf; // class => agent => total
    mapping(uint256 => mapping(uint256 => bool)) public isParticipant;
    mapping(uint256 => uint256[]) private _participants;

    event Bootstrapped(address arena, address graduation);
    event CommitReceived(
        uint256 indexed classId, uint256 indexed agentId, uint32 day, uint256 amount, uint256 classTotal
    );
    event ClassGraduated(uint256 indexed classId, address token, address pair, uint256 liquidity);
    event ClassFundsPulled(uint256 indexed classId, address indexed to, uint256 amount);
    event ClassOpened(uint256 indexed classId, uint32 openedDay);

    error NotArena();
    error NotGraduation();
    error NotDeployer();
    error ZeroAddress();
    error AlreadyGraduated();
    error NothingToPull();
    error AlreadyBootstrapped();
    error BelowFloor();
    error ClassNotOpen();

    modifier onlyArena() {
        if (msg.sender != arena) revert NotArena();
        _;
    }

    modifier onlyGraduation() {
        if (msg.sender != graduation) revert NotGraduation();
        _;
    }

    /// @param graduationFloor_ Production: 1_000_000_000 ($1000 USDC 6dp). Tests may use a smaller floor.
    constructor(address usdc_, uint256 graduationFloor_) {
        if (usdc_ == address(0)) revert ZeroAddress();
        if (graduationFloor_ == 0) revert ZeroAddress();
        usdc = IERC20(usdc_);
        graduationFloor = graduationFloor_;
        deployer = msg.sender;
    }

    function bootstrap(address arena_, address graduation_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (bootstrapped) revert AlreadyBootstrapped();
        if (arena_ == address(0) || graduation_ == address(0)) revert ZeroAddress();
        arena = arena_;
        graduation = graduation_;
        bootstrapped = true;
        emit Bootstrapped(arena_, graduation_);
    }

    function receiveCommit(uint256 agentId, uint32 day, uint256 amount) external onlyArena {
        uint256 classId = currentClassId;
        Class storage c = classes[classId];
        if (c.graduated) revert AlreadyGraduated();

        if (c.openedDay == 0) {
            c.openedDay = day;
            emit ClassOpened(classId, day);
        }

        if (!isParticipant[classId][agentId]) {
            isParticipant[classId][agentId] = true;
            _participants[classId].push(agentId);
            unchecked {
                c.participantCount += 1;
            }
        }

        commitOf[classId][agentId] += amount;
        c.totalCommitted += amount;

        emit CommitReceived(classId, agentId, day, amount, c.totalCommitted);
    }

    function canGraduate(uint256 classId) public view returns (bool) {
        Class memory c = classes[classId];
        return !c.graduated && c.totalCommitted >= graduationFloor;
    }

    function pullClassFunds(uint256 classId) external onlyGraduation returns (uint256 amount) {
        Class storage c = classes[classId];
        if (c.graduated) revert AlreadyGraduated();
        if (c.totalCommitted < graduationFloor) revert BelowFloor();
        amount = c.totalCommitted;
        if (amount == 0) revert NothingToPull();
        usdc.safeTransfer(msg.sender, amount);
        emit ClassFundsPulled(classId, msg.sender, amount);
    }

    function markGraduated(uint256 classId, address token, address pair, uint256 liquidity) external onlyGraduation {
        Class storage c = classes[classId];
        if (c.graduated) revert AlreadyGraduated();
        if (c.totalCommitted < graduationFloor) revert BelowFloor();
        c.graduated = true;
        c.token = token;
        c.pair = pair;
        c.liquidity = liquidity;
        emit ClassGraduated(classId, token, pair, liquidity);

        // Open the next class — rain continues
        unchecked {
            currentClassId = classId + 1;
        }
    }

    function getParticipants(uint256 classId) external view returns (uint256[] memory) {
        return _participants[classId];
    }

    /// @notice True when the Cypher participated in the first tranche.
    /// @dev Genesis status is historical provenance only and grants no economic weight.
    function isGenesisAgent(uint256 agentId) external view returns (bool) {
        return isParticipant[GENESIS_CLASS_ID][agentId];
    }

    function genesisAgentCount() external view returns (uint256) {
        return _participants[GENESIS_CLASS_ID].length;
    }

    function genesisAgentAt(uint256 index) external view returns (uint256) {
        return _participants[GENESIS_CLASS_ID][index];
    }

    function getGenesisAgents() external view returns (uint256[] memory) {
        return _participants[GENESIS_CLASS_ID];
    }

    function getClass(uint256 classId)
        external
        view
        returns (uint256 totalCommitted, uint32 participantCount, uint32 openedDay, bool graduated)
    {
        Class memory c = classes[classId];
        return (c.totalCommitted, c.participantCount, c.openedDay, c.graduated);
    }

    function getGraduationInfo(uint256 classId)
        external
        view
        returns (address token, address pair, uint256 liquidity)
    {
        Class memory c = classes[classId];
        return (c.token, c.pair, c.liquidity);
    }

    function currentDay() external view returns (uint32) {
        return uint32(block.timestamp / DAY);
    }
}
