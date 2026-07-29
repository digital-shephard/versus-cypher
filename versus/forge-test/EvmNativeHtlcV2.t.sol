// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {EvmNativeHtlcV2} from "../contracts/fx/EvmNativeHtlcV2.sol";

contract EvmNativeHtlcV2FuzzTest is Test {
    EvmNativeHtlcV2 private adapter;

    address private funder = makeAddr("native-v2-funder");
    address private beneficiary = makeAddr("native-v2-beneficiary");
    address private refundAddress = makeAddr("native-v2-refund");
    address private relayer = makeAddr("native-v2-relayer");

    function setUp() public {
        adapter = new EvmNativeHtlcV2(60, 7 days);
        vm.deal(funder, type(uint128).max);
    }

    function testFuzz_ExactRecipientAndExecutorPayouts(
        bytes32 seed,
        bytes32 secret,
        uint96 rawBeneficiaryAmount,
        uint64 rawExecutorAmount
    ) public {
        uint256 beneficiaryAmount = bound(
            uint256(rawBeneficiaryAmount),
            1,
            type(uint96).max
        );
        uint256 executorAmount = bound(
            uint256(rawExecutorAmount),
            0,
            type(uint64).max
        );
        bytes32 lockId = keccak256(abi.encode("native-v2-claim", seed));
        uint64 timeout = uint64(block.timestamp + 1 hours);

        vm.prank(funder);
        adapter.fund{value: beneficiaryAmount + executorAmount}(
            lockId,
            beneficiary,
            refundAddress,
            keccak256(abi.encodePacked(secret)),
            timeout,
            beneficiaryAmount,
            executorAmount
        );

        vm.prank(relayer);
        adapter.claim(lockId, secret);

        assertEq(beneficiary.balance, beneficiaryAmount);
        assertEq(relayer.balance, executorAmount);
        assertEq(adapter.totalLocked(), 0);
        assertTrue(adapter.solvent());
    }

    function testFuzz_RefundReturnsEveryLiability(
        bytes32 seed,
        bytes32 secret,
        uint96 rawBeneficiaryAmount,
        uint64 rawExecutorAmount
    ) public {
        uint256 beneficiaryAmount = bound(
            uint256(rawBeneficiaryAmount),
            1,
            type(uint96).max
        );
        uint256 executorAmount = uint256(rawExecutorAmount);
        bytes32 lockId = keccak256(abi.encode("native-v2-refund", seed));
        uint64 timeout = uint64(block.timestamp + 1 hours);

        vm.prank(funder);
        adapter.fund{value: beneficiaryAmount + executorAmount}(
            lockId,
            beneficiary,
            refundAddress,
            keccak256(abi.encodePacked(secret)),
            timeout,
            beneficiaryAmount,
            executorAmount
        );

        vm.warp(timeout);
        vm.prank(relayer);
        adapter.refund(lockId);

        assertEq(refundAddress.balance, beneficiaryAmount + executorAmount);
        assertEq(relayer.balance, 0);
        assertEq(adapter.totalLocked(), 0);
        assertTrue(adapter.solvent());
    }
}
