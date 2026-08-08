// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {EvmHtlcV2} from "../contracts/fx/EvmHtlcV2.sol";
import {MockUSDC} from "../contracts/test/MockUSDC.sol";

contract EvmHtlcV2FuzzTest is Test {
    MockUSDC private token;
    EvmHtlcV2 private adapter;

    address private funder = makeAddr("v2-funder");
    address private beneficiary = makeAddr("v2-beneficiary");
    address private refundAddress = makeAddr("v2-refund");
    address private relayer = makeAddr("v2-relayer");

    function setUp() public {
        token = new MockUSDC();
        adapter = new EvmHtlcV2(address(token), 6, 60, 7 days);
        token.mint(funder, type(uint128).max);
        vm.prank(funder);
        token.approve(address(adapter), type(uint256).max);
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
        uint256 executorAmount = uint256(rawExecutorAmount);
        bytes32 lockId = keccak256(abi.encode("erc20-v2-claim", seed));

        vm.prank(funder);
        adapter.fund(
            lockId,
            beneficiary,
            refundAddress,
            keccak256(abi.encodePacked(secret)),
            uint64(block.timestamp + 1 hours),
            beneficiaryAmount,
            executorAmount
        );

        vm.prank(relayer);
        adapter.claim(lockId, secret);

        assertEq(token.balanceOf(beneficiary), beneficiaryAmount);
        assertEq(token.balanceOf(relayer), executorAmount);
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
        bytes32 lockId = keccak256(abi.encode("erc20-v2-refund", seed));
        uint64 timeout = uint64(block.timestamp + 1 hours);

        vm.prank(funder);
        adapter.fund(
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

        assertEq(
            token.balanceOf(refundAddress),
            beneficiaryAmount + executorAmount
        );
        assertEq(token.balanceOf(relayer), 0);
        assertEq(adapter.totalLocked(), 0);
        assertTrue(adapter.solvent());
    }
}
