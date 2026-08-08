// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {EvmHtlcV3} from "../contracts/fx/EvmHtlcV3.sol";
import {MockUSDC} from "../contracts/test/MockUSDC.sol";

contract EvmHtlcV3FuzzTest is Test {
    MockUSDC private token;
    EvmHtlcV3 private adapter;

    address private funder = makeAddr("erc20-v3-funder");
    address private beneficiary = makeAddr("erc20-v3-beneficiary");
    address private relayer = makeAddr("erc20-v3-relayer");

    function setUp() public {
        token = new MockUSDC();
        adapter = new EvmHtlcV3(address(token), 6, 60, 7 days);
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
        uint128 beneficiaryAmount = uint128(
            bound(uint256(rawBeneficiaryAmount), 1, type(uint96).max)
        );
        uint128 executorAmount = uint128(rawExecutorAmount);
        EvmHtlcV3.Terms memory terms = _terms(
            seed,
            secret,
            beneficiaryAmount,
            executorAmount
        );
        bytes32 digest = adapter.lockDigest(terms);

        vm.prank(funder);
        adapter.fund(
            terms.tradeId,
            terms.beneficiary,
            terms.secretHash,
            _settlement(terms)
        );
        vm.prank(relayer);
        adapter.claim(
            terms.tradeId,
            terms.funder,
            terms.beneficiary,
            _settlement(terms),
            secret
        );

        assertEq(token.balanceOf(beneficiary), beneficiaryAmount);
        assertEq(token.balanceOf(relayer), executorAmount);
        assertEq(
            uint8(adapter.stateOf(digest)),
            uint8(EvmHtlcV3.LockState.CLAIMED)
        );
        assertEq(token.balanceOf(address(adapter)), 0);
    }

    function testFuzz_RefundReturnsEveryLiability(
        bytes32 seed,
        bytes32 secret,
        uint96 rawBeneficiaryAmount,
        uint64 rawExecutorAmount
    ) public {
        uint128 beneficiaryAmount = uint128(
            bound(uint256(rawBeneficiaryAmount), 1, type(uint96).max)
        );
        uint128 executorAmount = uint128(rawExecutorAmount);
        EvmHtlcV3.Terms memory terms = _terms(
            seed,
            secret,
            beneficiaryAmount,
            executorAmount
        );
        bytes32 digest = adapter.lockDigest(terms);

        vm.prank(funder);
        adapter.fund(
            terms.tradeId,
            terms.beneficiary,
            terms.secretHash,
            _settlement(terms)
        );
        vm.warp(terms.refundTimestamp);
        vm.prank(relayer);
        adapter.refund(terms);

        assertEq(token.balanceOf(funder), type(uint128).max);
        assertEq(token.balanceOf(relayer), 0);
        assertEq(
            uint8(adapter.stateOf(digest)),
            uint8(EvmHtlcV3.LockState.REFUNDED)
        );
        assertEq(token.balanceOf(address(adapter)), 0);
    }

    function _settlement(
        EvmHtlcV3.Terms memory terms
    ) private pure returns (uint256) {
        return
            (uint256(terms.refundTimestamp) << 192) |
            (uint256(terms.beneficiaryAmount) << 96) |
            uint256(terms.executorAmount);
    }

    function _terms(
        bytes32 seed,
        bytes32 secret,
        uint128 beneficiaryAmount,
        uint128 executorAmount
    ) private view returns (EvmHtlcV3.Terms memory) {
        return
            EvmHtlcV3.Terms({
                tradeId: keccak256(abi.encode("erc20-v3-fuzz", seed)),
                funder: funder,
                beneficiary: beneficiary,
                secretHash: keccak256(abi.encodePacked(secret)),
                refundTimestamp: uint64(block.timestamp + 1 hours),
                beneficiaryAmount: beneficiaryAmount,
                executorAmount: executorAmount
            });
    }
}
