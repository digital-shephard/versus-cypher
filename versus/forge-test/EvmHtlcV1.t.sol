// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {EvmHtlcV1} from "../contracts/fx/EvmHtlcV1.sol";
import {MockUSDC} from "../contracts/test/MockUSDC.sol";

contract EvmHtlcV1FuzzTest is Test {
    uint64 private constant MIN_DURATION = 60;
    uint64 private constant MAX_DURATION = 7 days;

    MockUSDC private token;
    EvmHtlcV1 private adapter;

    address private funder = makeAddr("funder");
    address private beneficiary = makeAddr("beneficiary");
    address private refundAddress = makeAddr("refund");
    address private relayer = makeAddr("relayer");

    function setUp() public {
        token = new MockUSDC();
        adapter = new EvmHtlcV1(
            address(token),
            6,
            MIN_DURATION,
            MAX_DURATION
        );
        token.mint(funder, type(uint128).max);
        vm.prank(funder);
        token.approve(address(adapter), type(uint256).max);
    }

    function testFuzz_ThirdPartyClaimCannotRedirect(
        bytes32 lockIdSeed,
        bytes32 secret,
        uint96 rawAmount
    ) public {
        bytes32 lockId = keccak256(abi.encode("claim", lockIdSeed));
        bytes32 secretHash = keccak256(abi.encodePacked(secret));
        uint256 amount = bound(uint256(rawAmount), 1, type(uint96).max);
        uint64 refundTimestamp = uint64(block.timestamp + 1 hours);

        vm.prank(funder);
        adapter.fund(
            lockId,
            beneficiary,
            refundAddress,
            secretHash,
            refundTimestamp,
            amount
        );

        vm.prank(relayer);
        adapter.claim(lockId, secret);

        assertEq(token.balanceOf(beneficiary), amount);
        assertEq(token.balanceOf(relayer), 0);
        assertEq(adapter.totalLocked(), 0);
        assertTrue(adapter.solvent());
    }

    function testFuzz_RefundBoundaryIsExclusive(
        bytes32 lockIdSeed,
        bytes32 secret,
        uint96 rawAmount
    ) public {
        bytes32 lockId = keccak256(abi.encode("refund", lockIdSeed));
        uint256 amount = bound(uint256(rawAmount), 1, type(uint96).max);
        uint64 refundTimestamp = uint64(block.timestamp + 1 hours);

        vm.prank(funder);
        adapter.fund(
            lockId,
            beneficiary,
            refundAddress,
            keccak256(abi.encodePacked(secret)),
            refundTimestamp,
            amount
        );

        vm.warp(refundTimestamp);
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(EvmHtlcV1.LockExpired.selector, lockId)
        );
        adapter.claim(lockId, secret);

        vm.prank(relayer);
        adapter.refund(lockId);
        assertEq(token.balanceOf(refundAddress), amount);
        assertEq(token.balanceOf(relayer), 0);
        assertEq(adapter.totalLocked(), 0);
        assertTrue(adapter.solvent());
    }

    function testFuzz_LockIdCannotReplayAfterSettlement(
        bytes32 lockIdSeed,
        bytes32 secret,
        uint96 rawAmount
    ) public {
        bytes32 lockId = keccak256(abi.encode("replay", lockIdSeed));
        uint256 amount = bound(uint256(rawAmount), 1, type(uint96).max);
        uint64 refundTimestamp = uint64(block.timestamp + 1 hours);
        bytes32 secretHash = keccak256(abi.encodePacked(secret));

        vm.prank(funder);
        adapter.fund(
            lockId,
            beneficiary,
            refundAddress,
            secretHash,
            refundTimestamp,
            amount
        );
        vm.prank(relayer);
        adapter.claim(lockId, secret);

        vm.prank(funder);
        vm.expectRevert(
            abi.encodeWithSelector(EvmHtlcV1.LockAlreadyExists.selector, lockId)
        );
        adapter.fund(
            lockId,
            beneficiary,
            refundAddress,
            secretHash,
            uint64(block.timestamp + 1 hours),
            amount
        );
    }
}
