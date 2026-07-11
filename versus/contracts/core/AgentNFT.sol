// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title Versus Agent NFT (ownerless)
/// @notice Tradeable pet + USDC vault. Wired once by VersusFactory, then immutable auth.
contract AgentNFT is ERC721 {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    address public immutable deployer;

    address public arena;
    address public treasury;
    address public missionEscrow;
    bool public bootstrapped;

    struct Agent {
        uint8 cypherId;
        uint32 level;
        uint32 streak;
        uint32 lastCommitDay;
        uint128 vault;
    }

    uint256 public nextId = 1;
    mapping(uint256 => Agent) public agents;

    event Bootstrapped(address arena, address treasury, address missionEscrow);
    event VaultDeposited(uint256 indexed agentId, address indexed from, uint256 amount);
    event VaultWithdrawn(uint256 indexed agentId, address indexed to, uint256 amount);
    event ProfitReceived(uint256 indexed agentId, uint256 amount);
    event CommitRecorded(uint256 indexed agentId, uint32 level, uint32 streak, uint32 day);

    error NotAuthorized();
    error NotAgentOwner();
    error InvalidAgent();
    error InsufficientVault();
    error ZeroAddress();
    error AlreadyBootstrapped();

    modifier onlyArena() {
        if (msg.sender != arena) revert NotAuthorized();
        _;
    }

    modifier onlyProfitSource() {
        if (msg.sender != arena && msg.sender != treasury && msg.sender != missionEscrow) revert NotAuthorized();
        _;
    }

    constructor(address usdc_) ERC721("Versus Agent", "VAGENT") {
        if (usdc_ == address(0)) revert ZeroAddress();
        usdc = IERC20(usdc_);
        deployer = msg.sender;
    }

    /// @notice One-shot wire from VersusFactory. No further admin.
    function bootstrap(address arena_, address treasury_, address missionEscrow_) external {
        if (msg.sender != deployer) revert NotAuthorized();
        if (bootstrapped) revert AlreadyBootstrapped();
        if (arena_ == address(0) || treasury_ == address(0) || missionEscrow_ == address(0)) revert ZeroAddress();
        arena = arena_;
        treasury = treasury_;
        missionEscrow = missionEscrow_;
        bootstrapped = true;
        emit Bootstrapped(arena_, treasury_, missionEscrow_);
    }

    function mint(address to, uint8 cypherId) external onlyArena returns (uint256 agentId) {
        agentId = nextId++;
        agents[agentId] = Agent({cypherId: cypherId, level: 0, streak: 0, lastCommitDay: 0, vault: 0});
        _safeMint(to, agentId);
    }

    function recordCommit(uint256 agentId, uint32 day) external onlyArena {
        Agent storage a = agents[agentId];
        if (!_exists(agentId)) revert InvalidAgent();
        if (a.lastCommitDay == day) return;

        if (a.lastCommitDay + 1 == day) {
            unchecked {
                a.streak += 1;
            }
        } else {
            a.streak = 1;
        }
        unchecked {
            a.level += 1;
        }
        a.lastCommitDay = day;
        emit CommitRecorded(agentId, a.level, a.streak, day);
    }

    function receiveProfit(uint256 agentId, uint256 amount) external onlyProfitSource {
        if (!_exists(agentId)) revert InvalidAgent();
        if (amount == 0) return;
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        agents[agentId].vault += uint128(amount);
        emit ProfitReceived(agentId, amount);
    }

    function deposit(uint256 agentId, uint256 amount) external {
        _requireOwner(agentId);
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        agents[agentId].vault += uint128(amount);
        emit VaultDeposited(agentId, msg.sender, amount);
    }

    function withdraw(uint256 agentId, uint256 amount) external {
        _requireOwner(agentId);
        Agent storage a = agents[agentId];
        if (a.vault < amount) revert InsufficientVault();
        unchecked {
            a.vault -= uint128(amount);
        }
        usdc.safeTransfer(msg.sender, amount);
        emit VaultWithdrawn(agentId, msg.sender, amount);
    }

    function pullFromVault(uint256 agentId, uint256 amount) external onlyArena returns (bool) {
        Agent storage a = agents[agentId];
        if (!_exists(agentId)) revert InvalidAgent();
        if (a.vault < amount) return false;
        unchecked {
            a.vault -= uint128(amount);
        }
        usdc.safeTransfer(msg.sender, amount);
        return true;
    }

    function getAgent(uint256 agentId)
        external
        view
        returns (uint8 cypherId, uint32 level, uint32 streak, uint32 lastCommitDay, uint128 vault, address owner_)
    {
        if (!_exists(agentId)) revert InvalidAgent();
        Agent memory a = agents[agentId];
        return (a.cypherId, a.level, a.streak, a.lastCommitDay, a.vault, ownerOf(agentId));
    }

    function _requireOwner(uint256 agentId) internal view {
        if (ownerOf(agentId) != msg.sender) revert NotAgentOwner();
    }

    function _exists(uint256 agentId) internal view returns (bool) {
        return _ownerOf(agentId) != address(0);
    }
}
