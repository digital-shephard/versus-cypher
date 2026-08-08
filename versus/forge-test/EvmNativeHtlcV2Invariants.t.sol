// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";

import {EvmNativeHtlcV2} from "../contracts/fx/EvmNativeHtlcV2.sol";

contract EvmNativeHtlcV2Handler is Test {
    EvmNativeHtlcV2 public immutable adapter;

    bytes32[] private lockIds;
    mapping(bytes32 lockId => bytes32 secret) private secrets;

    constructor(EvmNativeHtlcV2 adapter_) {
        adapter = adapter_;
        vm.deal(address(this), type(uint128).max);
    }

    receive() external payable {}

    function fund(
        uint96 rawBeneficiaryAmount,
        uint64 rawExecutorAmount,
        uint256 seed
    ) external {
        uint256 beneficiaryAmount = bound(
            uint256(rawBeneficiaryAmount),
            1,
            100 ether
        );
        uint256 executorAmount = bound(
            uint256(rawExecutorAmount),
            0,
            1 ether
        );
        bytes32 lockId = keccak256(
            abi.encode("native-v2-invariant", lockIds.length, seed)
        );
        bytes32 secret = keccak256(abi.encode("secret", lockId));
        address beneficiary = address(
            uint160(uint256(keccak256(abi.encode("beneficiary", lockId))))
        );
        address refundAddress = address(
            uint160(uint256(keccak256(abi.encode("refund", lockId))))
        );
        if (
            beneficiary == address(0) ||
            beneficiary == address(this) ||
            beneficiary == address(adapter)
        ) beneficiary = address(1);
        if (
            refundAddress == address(0) ||
            refundAddress == address(this) ||
            refundAddress == address(adapter)
        ) refundAddress = address(2);

        adapter.fund{value: beneficiaryAmount + executorAmount}(
            lockId,
            beneficiary,
            refundAddress,
            keccak256(abi.encodePacked(secret)),
            uint64(block.timestamp + 1 hours),
            beneficiaryAmount,
            executorAmount
        );
        lockIds.push(lockId);
        secrets[lockId] = secret;
    }

    function claim(uint256 rawIndex) external {
        if (lockIds.length == 0) return;
        bytes32 lockId = lockIds[rawIndex % lockIds.length];
        EvmNativeHtlcV2.Lock memory lock = adapter.getLock(lockId);
        if (
            lock.state != EvmNativeHtlcV2.LockState.FUNDED ||
            block.timestamp >= lock.refundTimestamp
        ) return;
        adapter.claim(lockId, secrets[lockId]);
    }

    function refund(uint256 rawIndex) external {
        if (lockIds.length == 0) return;
        bytes32 lockId = lockIds[rawIndex % lockIds.length];
        EvmNativeHtlcV2.Lock memory lock = adapter.getLock(lockId);
        if (lock.state != EvmNativeHtlcV2.LockState.FUNDED) return;
        vm.warp(lock.refundTimestamp);
        adapter.refund(lockId);
    }

    function lockCount() external view returns (uint256) {
        return lockIds.length;
    }

    function lockIdAt(uint256 index) external view returns (bytes32) {
        return lockIds[index];
    }
}

contract EvmNativeHtlcV2InvariantTest is StdInvariant, Test {
    EvmNativeHtlcV2 private adapter;
    EvmNativeHtlcV2Handler private handler;

    function setUp() public {
        adapter = new EvmNativeHtlcV2(60, 7 days);
        handler = new EvmNativeHtlcV2Handler(adapter);
        targetContract(address(handler));
    }

    function invariant_EveryActiveLiabilityIsBacked() public view {
        assertGe(address(adapter).balance, adapter.totalLocked());
        assertTrue(adapter.solvent());
    }

    function invariant_AccountingEqualsActiveLocks() public view {
        uint256 activeTotal;
        uint256 count = handler.lockCount();
        for (uint256 index = 0; index < count; index++) {
            EvmNativeHtlcV2.Lock memory lock = adapter.getLock(
                handler.lockIdAt(index)
            );
            if (lock.state == EvmNativeHtlcV2.LockState.FUNDED) {
                activeTotal += lock.beneficiaryAmount + lock.executorAmount;
            }
        }
        assertEq(activeTotal, adapter.totalLocked());
    }
}
