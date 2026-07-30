// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";

import {EvmHtlcV3} from "../contracts/fx/EvmHtlcV3.sol";
import {MockUSDC} from "../contracts/test/MockUSDC.sol";

contract EvmHtlcV3Handler is Test {
    MockUSDC public immutable token;
    EvmHtlcV3 public immutable adapter;

    EvmHtlcV3.Terms[] private terms;
    bytes32[] private secrets;
    uint256 public directDonations;

    constructor(MockUSDC token_, EvmHtlcV3 adapter_) {
        token = token_;
        adapter = adapter_;
        token.mint(address(this), type(uint128).max);
        token.approve(address(adapter), type(uint256).max);
    }

    function fund(
        uint96 rawBeneficiaryAmount,
        uint64 rawExecutorAmount,
        uint256 seed
    ) external {
        uint128 beneficiaryAmount = uint128(
            bound(uint256(rawBeneficiaryAmount), 1, 1_000_000_000_000)
        );
        uint128 executorAmount = uint128(
            bound(uint256(rawExecutorAmount), 0, 1_000_000_000)
        );
        bytes32 tradeId = keccak256(
            abi.encode("erc20-v3-invariant", terms.length, seed)
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

        EvmHtlcV3.Terms memory prepared = EvmHtlcV3.Terms({
            tradeId: tradeId,
            funder: address(this),
            beneficiary: beneficiary,
            secretHash: keccak256(abi.encodePacked(secret)),
            refundTimestamp: uint64(block.timestamp + 1 hours),
            beneficiaryAmount: beneficiaryAmount,
            executorAmount: executorAmount
        });

        adapter.fund(
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
        EvmHtlcV3.Terms memory prepared = terms[index];
        bytes32 digest = adapter.lockDigest(prepared);
        if (
            adapter.stateOf(digest) != EvmHtlcV3.LockState.FUNDED ||
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
        EvmHtlcV3.Terms memory prepared = terms[
            rawIndex % terms.length
        ];
        bytes32 digest = adapter.lockDigest(prepared);
        if (adapter.stateOf(digest) != EvmHtlcV3.LockState.FUNDED) {
            return;
        }
        vm.warp(prepared.refundTimestamp);
        adapter.refund(prepared);
    }

    function donate(uint64 rawAmount) external {
        uint256 amount = bound(uint256(rawAmount), 1, 1_000_000_000);
        token.transfer(address(adapter), amount);
        directDonations += amount;
    }

    function activeLiability() external view returns (uint256 total) {
        for (uint256 index = 0; index < terms.length; index++) {
            EvmHtlcV3.Terms memory prepared = terms[index];
            if (
                adapter.stateOf(adapter.lockDigest(prepared)) ==
                EvmHtlcV3.LockState.FUNDED
            ) {
                total +=
                    uint256(prepared.beneficiaryAmount) +
                    prepared.executorAmount;
            }
        }
    }

    function _settlement(
        EvmHtlcV3.Terms memory prepared
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
    ) external view returns (EvmHtlcV3.Terms memory) {
        return terms[index];
    }
}

contract EvmHtlcV3InvariantTest is StdInvariant, Test {
    MockUSDC private token;
    EvmHtlcV3 private adapter;
    EvmHtlcV3Handler private handler;

    function setUp() public {
        token = new MockUSDC();
        adapter = new EvmHtlcV3(address(token), 6, 60, 7 days);
        handler = new EvmHtlcV3Handler(token, adapter);
        targetContract(address(handler));
    }

    function invariant_EveryActiveLiabilityIsBacked() public view {
        assertGe(
            token.balanceOf(address(adapter)),
            handler.activeLiability()
        );
    }

    function invariant_BalanceEqualsLiabilityPlusDirectDonations() public view {
        assertEq(
            token.balanceOf(address(adapter)),
            handler.activeLiability() + handler.directDonations()
        );
    }

    function invariant_EveryRecordedDigestHasState() public view {
        uint256 count = handler.lockCount();
        for (uint256 index = 0; index < count; index++) {
            EvmHtlcV3.Terms memory prepared = handler.termsAt(index);
            assertTrue(
                adapter.stateOf(adapter.lockDigest(prepared)) !=
                    EvmHtlcV3.LockState.EMPTY
            );
        }
    }

    function invariant_AdapterHasNoNativeCustody() public view {
        assertEq(address(adapter).balance, 0);
    }
}
