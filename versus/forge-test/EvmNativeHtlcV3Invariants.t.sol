// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";

import {EvmNativeHtlcV3} from "../contracts/fx/EvmNativeHtlcV3.sol";

contract EvmNativeHtlcV3ForcedDonation {
    constructor() payable {}

    function force(address payable recipient) external {
        selfdestruct(recipient);
    }
}

contract EvmNativeHtlcV3Handler is Test {
    EvmNativeHtlcV3 public immutable adapter;

    EvmNativeHtlcV3.Terms[] private terms;
    bytes32[] private secrets;
    uint256 public forcedDonations;

    constructor(EvmNativeHtlcV3 adapter_) {
        adapter = adapter_;
        vm.deal(address(this), type(uint128).max);
    }

    receive() external payable {}

    function fund(
        uint96 rawBeneficiaryAmount,
        uint64 rawExecutorAmount,
        uint256 seed
    ) external {
        uint128 beneficiaryAmount = uint128(
            bound(uint256(rawBeneficiaryAmount), 1, 100 ether)
        );
        uint128 executorAmount = uint128(
            bound(uint256(rawExecutorAmount), 0, 1 ether)
        );
        bytes32 tradeId = keccak256(
            abi.encode("native-v3-invariant", terms.length, seed)
        );
        bytes32 secret = keccak256(abi.encode("secret", tradeId));
        address beneficiary = address(
            uint160(uint256(keccak256(abi.encode("beneficiary", tradeId))))
        );
        if (
            beneficiary == address(0) ||
            beneficiary == address(this) ||
            beneficiary == address(adapter)
        ) beneficiary = address(1);

        EvmNativeHtlcV3.Terms memory prepared = EvmNativeHtlcV3.Terms({
            tradeId: tradeId,
            funder: address(this),
            beneficiary: beneficiary,
            secretHash: keccak256(abi.encodePacked(secret)),
            refundTimestamp: uint64(block.timestamp + 1 hours),
            beneficiaryAmount: beneficiaryAmount,
            executorAmount: executorAmount
        });

        adapter.fund{
            value: uint256(beneficiaryAmount) + executorAmount
        }(
            prepared.tradeId,
            prepared.beneficiary,
            prepared.secretHash,
            _settlement(prepared)
        );
        terms.push(prepared);
        secrets.push(secret);
    }

    function claim(uint256 rawIndex) external {
        if (terms.length == 0) return;
        uint256 index = rawIndex % terms.length;
        EvmNativeHtlcV3.Terms memory prepared = terms[index];
        bytes32 digest = adapter.lockDigest(prepared);
        if (
            adapter.stateOf(digest) != EvmNativeHtlcV3.LockState.FUNDED ||
            block.timestamp >= prepared.refundTimestamp
        ) return;
        adapter.claim(
            prepared.tradeId,
            prepared.funder,
            prepared.beneficiary,
            _settlement(prepared),
            secrets[index]
        );
    }

    function refund(uint256 rawIndex) external {
        if (terms.length == 0) return;
        EvmNativeHtlcV3.Terms memory prepared = terms[
            rawIndex % terms.length
        ];
        bytes32 digest = adapter.lockDigest(prepared);
        if (
            adapter.stateOf(digest) != EvmNativeHtlcV3.LockState.FUNDED
        ) return;
        vm.warp(prepared.refundTimestamp);
        adapter.refund(prepared);
    }

    function donate(uint64 rawAmount) external {
        uint256 amount = bound(uint256(rawAmount), 1, 1 ether);
        EvmNativeHtlcV3ForcedDonation donation =
            new EvmNativeHtlcV3ForcedDonation{value: amount}();
        donation.force(payable(address(adapter)));
        forcedDonations += amount;
    }

    function activeLiability() external view returns (uint256 total) {
        for (uint256 index = 0; index < terms.length; index++) {
            EvmNativeHtlcV3.Terms memory prepared = terms[index];
            if (
                adapter.stateOf(adapter.lockDigest(prepared)) ==
                EvmNativeHtlcV3.LockState.FUNDED
            ) {
                total +=
                    uint256(prepared.beneficiaryAmount) +
                    prepared.executorAmount;
            }
        }
    }

    function _settlement(
        EvmNativeHtlcV3.Terms memory prepared
    ) private pure returns (uint256) {
        return
            (uint256(prepared.refundTimestamp) << 192) |
            (uint256(prepared.beneficiaryAmount) << 96) |
            uint256(prepared.executorAmount);
    }

    function lockCount() external view returns (uint256) {
        return terms.length;
    }

    function termsAt(
        uint256 index
    ) external view returns (EvmNativeHtlcV3.Terms memory) {
        return terms[index];
    }
}

contract EvmNativeHtlcV3InvariantTest is StdInvariant, Test {
    EvmNativeHtlcV3 private adapter;
    EvmNativeHtlcV3Handler private handler;

    function setUp() public {
        adapter = new EvmNativeHtlcV3(60, 7 days);
        handler = new EvmNativeHtlcV3Handler(adapter);
        targetContract(address(handler));
    }

    function invariant_EveryActiveLiabilityIsBacked() public view {
        assertGe(address(adapter).balance, handler.activeLiability());
    }

    function invariant_BalanceEqualsLiabilityPlusForcedDonations() public view {
        assertEq(
            address(adapter).balance,
            handler.activeLiability() + handler.forcedDonations()
        );
    }

    function invariant_EveryRecordedDigestHasState() public view {
        uint256 count = handler.lockCount();
        for (uint256 index = 0; index < count; index++) {
            EvmNativeHtlcV3.Terms memory prepared = handler.termsAt(index);
            assertTrue(
                adapter.stateOf(adapter.lockDigest(prepared)) !=
                    EvmNativeHtlcV3.LockState.EMPTY
            );
        }
    }
}
