// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {EvmNativeHtlcV3} from "../contracts/fx/EvmNativeHtlcV3.sol";

contract EvmNativeHtlcV3FuzzTest is Test {
    EvmNativeHtlcV3 private adapter;

    address private funder = makeAddr("native-v3-funder");
    address private beneficiary = makeAddr("native-v3-beneficiary");
    address private relayer = makeAddr("native-v3-relayer");

    function setUp() public {
        adapter = new EvmNativeHtlcV3(60, 7 days);
        vm.deal(funder, type(uint128).max);
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
        EvmNativeHtlcV3.Terms memory terms = _terms(
            seed,
            secret,
            beneficiaryAmount,
            executorAmount
        );
        bytes32 digest = adapter.lockDigest(terms);

        vm.prank(funder);
        adapter.fund{
            value: uint256(beneficiaryAmount) + executorAmount
        }(
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

        assertEq(beneficiary.balance, beneficiaryAmount);
        assertEq(relayer.balance, executorAmount);
        assertEq(
            uint8(adapter.stateOf(digest)),
            uint8(EvmNativeHtlcV3.LockState.CLAIMED)
        );
        assertEq(address(adapter).balance, 0);
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
        EvmNativeHtlcV3.Terms memory terms = _terms(
            seed,
            secret,
            beneficiaryAmount,
            executorAmount
        );
        bytes32 digest = adapter.lockDigest(terms);

        vm.prank(funder);
        adapter.fund{
            value: uint256(beneficiaryAmount) + executorAmount
        }(
            terms.tradeId,
            terms.beneficiary,
            terms.secretHash,
            _settlement(terms)
        );
        vm.warp(terms.refundTimestamp);
        vm.prank(relayer);
        adapter.refund(terms);

        assertEq(
            funder.balance,
            type(uint128).max
        );
        assertEq(relayer.balance, 0);
        assertEq(
            uint8(adapter.stateOf(digest)),
            uint8(EvmNativeHtlcV3.LockState.REFUNDED)
        );
        assertEq(address(adapter).balance, 0);
    }

    function testFuzz_EveryTermIsCommitmentBound(
        bytes32 seed,
        bytes32 secret,
        address changedBeneficiary,
        uint96 rawAmount
    ) public {
        vm.assume(
            changedBeneficiary != address(0) &&
                changedBeneficiary != beneficiary &&
                changedBeneficiary != address(adapter)
        );
        uint128 amount = uint128(
            bound(uint256(rawAmount), 1, type(uint96).max)
        );
        EvmNativeHtlcV3.Terms memory terms = _terms(seed, secret, amount, 0);

        vm.prank(funder);
        adapter.fund{value: amount}(
            terms.tradeId,
            terms.beneficiary,
            terms.secretHash,
            _settlement(terms)
        );

        terms.beneficiary = changedBeneficiary;
        bytes32 changedDigest = adapter.lockDigest(terms);
        vm.expectRevert(
            abi.encodeWithSelector(
                EvmNativeHtlcV3.LockNotFunded.selector,
                changedDigest
            )
        );
        adapter.claim(
            terms.tradeId,
            terms.funder,
            terms.beneficiary,
            _settlement(terms),
            secret
        );
    }

    function _settlement(
        EvmNativeHtlcV3.Terms memory terms
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
    ) private view returns (EvmNativeHtlcV3.Terms memory) {
        return
            EvmNativeHtlcV3.Terms({
                tradeId: keccak256(abi.encode("native-v3-fuzz", seed)),
                funder: funder,
                beneficiary: beneficiary,
                secretHash: keccak256(abi.encodePacked(secret)),
                refundTimestamp: uint64(block.timestamp + 1 hours),
                beneficiaryAmount: beneficiaryAmount,
                executorAmount: executorAmount
            });
    }
}
