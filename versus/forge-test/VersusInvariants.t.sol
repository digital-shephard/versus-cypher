// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {MockUSDC} from "../contracts/test/MockUSDC.sol";
import {MockUniswapV2Factory} from "../contracts/uniswap/MockUniswapV2Factory.sol";
import {MockUniswapV2Router} from "../contracts/uniswap/MockUniswapV2Router.sol";
import {AgentNFT} from "../contracts/core/AgentNFT.sol";
import {Arena} from "../contracts/core/Arena.sol";
import {SyndicateEngine} from "../contracts/core/SyndicateEngine.sol";
import {TrancheTreasury} from "../contracts/core/TrancheTreasury.sol";
import {MissionEscrow} from "../contracts/core/MissionEscrow.sol";
import {ReferralPool} from "../contracts/core/ReferralPool.sol";
import {GraduationModule} from "../contracts/launch/GraduationModule.sol";

/// @dev Stateful random driver mirroring the Hardhat invariant campaign actions.
contract VersusHandler is Test {
    uint256 internal constant PENNY = 10_000;
    uint256 internal constant MIN_RUNWAY = 7_000_000;

    MockUSDC public immutable usdc;
    AgentNFT public immutable agents;
    Arena public immutable arena;
    SyndicateEngine public immutable syndicate;
    TrancheTreasury public immutable treasury;
    GraduationModule public immutable graduation;
    ReferralPool public immutable referralPool;

    address public immutable feeDepositor;
    address[] public actors;
    uint256[] public agentIds;
    uint256 public signalNonce;
    uint256 public claimCapActivations;
    uint256 public claimAccountingMismatches;

    constructor(
        MockUSDC usdc_,
        AgentNFT agents_,
        Arena arena_,
        SyndicateEngine syndicate_,
        TrancheTreasury treasury_,
        GraduationModule graduation_,
        ReferralPool referralPool_,
        address feeDepositor_,
        address[] memory actors_
    ) {
        usdc = usdc_;
        agents = agents_;
        arena = arena_;
        syndicate = syndicate_;
        treasury = treasury_;
        graduation = graduation_;
        referralPool = referralPool_;
        feeDepositor = feeDepositor_;
        actors = actors_;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function agentCount() external view returns (uint256) {
        return agentIds.length;
    }

    function hatch(uint256 actorSeed, uint256 runwaySeed) public {
        address actor = _actor(actorSeed);
        uint256 runwayAmount = MIN_RUNWAY + (runwaySeed % (20 * PENNY));
        _fundAndApprove(actor, runwayAmount);
        vm.prank(actor);
        uint256 id = arena.hatch(runwayAmount);
        agentIds.push(id);
    }

    function referredHatch(uint256 actorSeed, uint256 runwaySeed, uint256 referrerSeed) public {
        if (agentIds.length == 0) return;
        address actor = _actor(actorSeed);
        uint256 runwayAmount = MIN_RUNWAY + (runwaySeed % (20 * PENNY));
        uint256 referrerId = agentIds[referrerSeed % agentIds.length];
        _fundAndApprove(actor, runwayAmount);
        vm.prank(actor);
        uint256 id = arena.hatch(runwayAmount, referrerId);
        agentIds.push(id);
    }

    function replenish(uint256 actorSeed, uint256 agentSeed, uint256 amountSeed) public {
        if (agentIds.length == 0) return;
        address actor = _actor(actorSeed);
        uint256 agentId = agentIds[agentSeed % agentIds.length];
        uint256 amount = PENNY * (1 + (amountSeed % 20));
        _fundAndApprove(actor, amount);
        vm.prank(actor);
        arena.replenishRunway(agentId, amount);
    }

    function commit(uint256 agentSeed) public {
        if (agentIds.length == 0) return;
        uint256 agentId = agentIds[agentSeed % agentIds.length];
        address owner_ = agents.ownerOf(agentId);
        uint64 dueAt = arena.nextCommitAt(agentId);
        if (block.timestamp < dueAt) {
            vm.warp(dueAt);
        }
        if (arena.runway(agentId) < PENNY) {
            _fundAndApprove(owner_, PENNY);
            vm.prank(owner_);
            arena.replenishRunway(agentId, PENNY);
        }
        vm.prank(owner_);
        arena.commit(agentId);
    }

    function rain(uint256 agentSeed, uint256 pennySeed) public {
        if (agentIds.length == 0) return;
        uint256 agentId = agentIds[agentSeed % agentIds.length];
        address owner_ = agents.ownerOf(agentId);
        uint256 pennies = 1 + (pennySeed % 10);
        uint256 need = pennies * PENNY;
        if (arena.runway(agentId) < need) {
            _fundAndApprove(owner_, need);
            vm.prank(owner_);
            arena.replenishRunway(agentId, need);
        }
        vm.prank(owner_);
        arena.rainFromRunway(agentId, pennies);
    }

    function signal(uint256 agentSeed, uint256 salt) public {
        if (agentIds.length == 0) return;
        uint256 agentId = agentIds[agentSeed % agentIds.length];
        address owner_ = agents.ownerOf(agentId);
        uint256 classId = syndicate.currentClassId();
        uint16[8] memory typeCounts;
        typeCounts[0] = 1;
        if (arena.runway(agentId) < PENNY) {
            _fundAndApprove(owner_, PENNY);
            vm.prank(owner_);
            arena.replenishRunway(agentId, PENNY);
        }
        bytes32 root = keccak256(abi.encodePacked("forge-fuzz", agentId, salt, block.timestamp, signalNonce++));
        vm.prank(owner_);
        arena.settleSignalBatchFromRunway(agentId, classId, root, typeCounts);
    }

    function depositFees(uint256 amountSeed) public {
        uint256 roll = amountSeed % 100;
        uint256 amount;
        if (roll < 35) amount = 1;
        else if (roll < 55) amount = 1 + (amountSeed % 99);
        else amount = 1e6 + (amountSeed % 50e6);

        usdc.mint(feeDepositor, amount);
        vm.startPrank(feeDepositor);
        usdc.approve(address(treasury), amount);
        treasury.depositFees(amount);
        vm.stopPrank();
    }

    function claim(uint256 agentSeed) public {
        if (agentIds.length == 0) return;
        uint256 agentId = agentIds[agentSeed % agentIds.length];
        uint256 requested = treasury.claimable(agentId);
        if (requested == 0) return;
        uint256 potBefore = treasury.tranchePot();
        uint256 treasuryBalanceBefore = usdc.balanceOf(address(treasury));
        (,,,, uint128 vaultBefore,) = agents.getAgent(agentId);
        treasury.claim(agentId);
        uint256 potAfter = treasury.tranchePot();
        uint256 treasuryBalanceAfter = usdc.balanceOf(address(treasury));
        (,,,, uint128 vaultAfter,) = agents.getAgent(agentId);
        uint256 paid = potBefore - potAfter;
        if (paid < requested) claimCapActivations++;
        if (
            paid != requested || treasuryBalanceBefore - treasuryBalanceAfter != paid
                || uint256(vaultAfter) - uint256(vaultBefore) != paid
        ) {
            claimAccountingMismatches++;
        }
    }

    function transferNft(uint256 agentSeed, uint256 toSeed) public {
        if (agentIds.length == 0) return;
        uint256 agentId = agentIds[agentSeed % agentIds.length];
        address from = agents.ownerOf(agentId);
        address to = _actor(toSeed);
        if (from == to) return;
        vm.prank(from);
        agents.transferFrom(from, to, agentId);
    }

    function graduate() public {
        uint256 classId = syndicate.currentClassId();
        if (!syndicate.canGraduate(classId)) return;
        graduation.graduate();
    }

    function fundReferral(uint256 agentSeed, uint256 salt) public {
        if (agentIds.length == 0) return;
        uint256 agentId = agentIds[agentSeed % agentIds.length];
        address owner_ = agents.ownerOf(agentId);
        if (arena.runway(agentId) < PENNY) {
            _fundAndApprove(owner_, PENNY);
            vm.prank(owner_);
            arena.replenishRunway(agentId, PENNY);
        }
        bytes32 proposal = keccak256(abi.encodePacked("ref", agentId, salt));
        vm.prank(owner_);
        try arena.fundReferralPoolFromRunway(agentId, proposal) {} catch {}
    }

    function warp(uint256 secondsSeed) public {
        uint256 delta = 3600 + (secondsSeed % (2 days));
        vm.warp(block.timestamp + delta);
    }

    function withdrawVault(uint256 agentSeed, uint256 halfSeed) public {
        if (agentIds.length == 0) return;
        uint256 agentId = agentIds[agentSeed % agentIds.length];
        address owner_ = agents.ownerOf(agentId);
        (,,,, uint128 vault,) = agents.getAgent(agentId);
        if (vault == 0) return;
        uint256 pull = halfSeed % 2 == 0 ? uint256(vault) : uint256(vault) / 2;
        if (pull == 0) return;
        vm.prank(owner_);
        agents.withdraw(agentId, pull);
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _fundAndApprove(address actor, uint256 amount) internal {
        uint256 bal = usdc.balanceOf(actor);
        if (bal < amount) {
            usdc.mint(actor, amount - bal + amount);
        }
        vm.startPrank(actor);
        if (usdc.allowance(actor, address(arena)) < amount) {
            usdc.approve(address(arena), type(uint256).max);
        }
        if (usdc.allowance(actor, address(agents)) < amount) {
            usdc.approve(address(agents), type(uint256).max);
        }
        vm.stopPrank();
    }
}

contract VersusInvariants is StdInvariant, Test {
    uint256 internal constant GRADUATION_FLOOR = 50_000; // five pennies -- reachable under fuzz
    uint256 internal constant REFERRAL_REWARD = 1_000_000;

    MockUSDC internal usdc;
    AgentNFT internal agents;
    Arena internal arena;
    SyndicateEngine internal syndicate;
    TrancheTreasury internal treasury;
    GraduationModule internal graduation;
    ReferralPool internal referralPool;
    VersusHandler internal handler;

    address internal protocolRecipient;
    address[] internal actors;

    function setUp() public {
        protocolRecipient = makeAddr("protocol");
        actors.push(makeAddr("alice"));
        actors.push(makeAddr("bob"));
        actors.push(makeAddr("carol"));
        actors.push(makeAddr("dave"));

        usdc = new MockUSDC();
        MockUniswapV2Factory v2Factory = new MockUniswapV2Factory();
        MockUniswapV2Router v2Router = new MockUniswapV2Router(address(v2Factory));

        agents = new AgentNFT(address(usdc));
        syndicate = new SyndicateEngine(address(usdc), GRADUATION_FLOOR);
        treasury = new TrancheTreasury(address(usdc), protocolRecipient);
        MissionEscrow missionEscrow = new MissionEscrow(address(usdc), address(agents));
        referralPool = new ReferralPool(address(usdc), address(agents), REFERRAL_REWARD);
        arena = new Arena(address(usdc), address(agents), address(syndicate), address(treasury), address(referralPool));
        graduation = new GraduationModule(address(usdc), address(v2Router), address(syndicate), address(treasury));

        syndicate.bootstrap(address(arena), address(graduation));
        treasury.bootstrap(address(arena), address(agents));
        referralPool.bootstrap(address(arena));
        agents.bootstrap(address(arena), address(treasury), address(missionEscrow), address(referralPool));

        for (uint256 i = 0; i < actors.length; i++) {
            usdc.mint(actors[i], 1_000e6);
            vm.startPrank(actors[i]);
            usdc.approve(address(arena), type(uint256).max);
            usdc.approve(address(agents), type(uint256).max);
            usdc.approve(address(referralPool), type(uint256).max);
            vm.stopPrank();
        }
        usdc.mint(address(this), 10_000e6);
        usdc.approve(address(treasury), type(uint256).max);

        handler = new VersusHandler(
            usdc, agents, arena, syndicate, treasury, graduation, referralPool, address(this), actors
        );

        targetContract(address(handler));
    }

    /// @notice Aggregate claimable must never exceed tranchePot (MasterChef floor bug class).
    function invariant_aggregateClaimableLePot() public view {
        uint256 n = handler.agentCount();
        uint256 claimableSum;
        for (uint256 i = 0; i < n; i++) {
            claimableSum += treasury.claimable(handler.agentIds(i));
        }
        assertLe(claimableSum, treasury.tranchePot(), "aggregate claimable > pot");
        assertEq(handler.claimCapActivations(), 0, "ClaimCapped path activated");
        assertEq(handler.claimAccountingMismatches(), 0, "claim accounting mismatch");
    }

    /// @notice Arena USDC covers runway liability; ticket sum matches totalTickets.
    function invariant_arenaAndTicketsSolvent() public view {
        assertGe(usdc.balanceOf(address(arena)), arena.totalRunwayLiability(), "arena insolvent");
        assertTrue(arena.runwaySolvent(), "runwaySolvent false");

        uint256 n = handler.agentCount();
        uint256 runwaySum;
        uint256 ticketSum;
        uint256 vaultSum;
        for (uint256 i = 0; i < n; i++) {
            uint256 agentId = handler.agentIds(i);
            runwaySum += arena.runway(agentId);
            ticketSum += treasury.tickets(agentId);
            (,,,, uint128 vault,) = agents.getAgent(agentId);
            vaultSum += vault;
        }
        assertEq(runwaySum, arena.totalRunwayLiability(), "runway sum != liability");
        assertEq(ticketSum, treasury.totalTickets(), "ticket sum != totalTickets");
        assertGe(usdc.balanceOf(address(agents)), vaultSum, "agents undercover vaults");
        assertGe(usdc.balanceOf(address(treasury)), treasury.tranchePot(), "treasury undercovers pot");
    }

    /// @notice Protocol cut never exceeds 10% of fees received.
    function invariant_protocolCutBounded() public view {
        uint256 fees = treasury.totalFeesReceived();
        uint256 paid = treasury.totalProtocolPaid();
        assertLe(paid, fees, "protocol paid > fees");
        if (fees > 0) {
            assertLe(paid * 10, fees, "protocol cut above 10%");
        }
        if (treasury.totalTickets() > 0) {
            assertEq(treasury.rewardRemainder(), 0, "remainder stranded after tickets");
        }
    }
}
