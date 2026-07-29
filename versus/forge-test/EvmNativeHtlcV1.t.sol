// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {EvmNativeHtlcV1} from "../contracts/fx/EvmNativeHtlcV1.sol";

contract EvmNativeHtlcV1FuzzTest is Test {
    EvmNativeHtlcV1 private adapter;

    address private funder = makeAddr("native-funder");
    address private beneficiary = makeAddr("native-beneficiary");
    address private refundAddress = makeAddr("native-refund");
    address private relayer = makeAddr("native-relayer");

    function setUp() public {
        adapter = new EvmNativeHtlcV1(60, 7 days);
        vm.deal(funder, type(uint128).max);
    }

    function testFuzz_ExactValueClaimCannotRedirect(
        bytes32 seed,
        bytes32 secret,
        uint96 rawAmount
    ) public {
        bytes32 lockId = keccak256(abi.encode("native-claim", seed));
        uint256 amount = bound(uint256(rawAmount), 1, type(uint96).max);
        uint64 timeout = uint64(block.timestamp + 1 hours);

        vm.prank(funder);
        adapter.fund{value: amount}(
            lockId,
            beneficiary,
            refundAddress,
            keccak256(abi.encodePacked(secret)),
            timeout
        );

        vm.prank(relayer);
        adapter.claim(lockId, secret);

        assertEq(beneficiary.balance, amount);
        assertEq(relayer.balance, 0);
        assertEq(adapter.totalLocked(), 0);
        assertTrue(adapter.solvent());
    }

    function testFuzz_RefundBoundaryIsExclusive(
        bytes32 seed,
        bytes32 secret,
        uint96 rawAmount
    ) public {
        bytes32 lockId = keccak256(abi.encode("native-refund", seed));
        uint256 amount = bound(uint256(rawAmount), 1, type(uint96).max);
        uint64 timeout = uint64(block.timestamp + 1 hours);

        vm.prank(funder);
        adapter.fund{value: amount}(
            lockId,
            beneficiary,
            refundAddress,
            keccak256(abi.encodePacked(secret)),
            timeout
        );

        vm.warp(timeout);
        vm.expectRevert(
            abi.encodeWithSelector(EvmNativeHtlcV1.LockExpired.selector, lockId)
        );
        adapter.claim(lockId, secret);
        adapter.refund(lockId);

        assertEq(refundAddress.balance, amount);
        assertEq(adapter.totalLocked(), 0);
        assertTrue(adapter.solvent());
    }
}
