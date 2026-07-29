// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";

import {EvmHtlcV2} from "../contracts/fx/EvmHtlcV2.sol";
import {MockUSDC} from "../contracts/test/MockUSDC.sol";

contract EvmHtlcV2Handler is Test {
    MockUSDC public immutable token;
    EvmHtlcV2 public immutable adapter;

    bytes32[] private lockIds;
    mapping(bytes32 lockId => bytes32 secret) private secrets;

    constructor(MockUSDC token_, EvmHtlcV2 adapter_) {
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
        uint256 beneficiaryAmount = bound(
            uint256(rawBeneficiaryAmount),
            1,
            1_000_000_000_000
        );
        uint256 executorAmount = bound(
            uint256(rawExecutorAmount),
            0,
            1_000_000_000
        );
        bytes32 lockId = keccak256(
            abi.encode("erc20-v2-invariant", lockIds.length, seed)
        );
        bytes32 secret = keccak256(abi.encode("secret", lockId));
        address beneficiary = address(
            uint160(uint256(keccak256(abi.encode("beneficiary", lockId))))
        );
        address refundAddress = address(
            uint160(uint256(keccak256(abi.encode("refund", lockId))))
        );
        if (beneficiary == address(0)) beneficiary = address(1);
        if (refundAddress == address(0)) refundAddress = address(2);

        adapter.fund(
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
        EvmHtlcV2.Lock memory lock = adapter.getLock(lockId);
        if (
            lock.state != EvmHtlcV2.LockState.FUNDED ||
            block.timestamp >= lock.refundTimestamp
        ) return;
        adapter.claim(lockId, secrets[lockId]);
    }

    function refund(uint256 rawIndex) external {
        if (lockIds.length == 0) return;
        bytes32 lockId = lockIds[rawIndex % lockIds.length];
        EvmHtlcV2.Lock memory lock = adapter.getLock(lockId);
        if (lock.state != EvmHtlcV2.LockState.FUNDED) return;
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

contract EvmHtlcV2InvariantTest is StdInvariant, Test {
    MockUSDC private token;
    EvmHtlcV2 private adapter;
    EvmHtlcV2Handler private handler;

    function setUp() public {
        token = new MockUSDC();
        adapter = new EvmHtlcV2(address(token), 6, 60, 7 days);
        handler = new EvmHtlcV2Handler(token, adapter);
        targetContract(address(handler));
    }

    function invariant_EveryActiveLiabilityIsBacked() public view {
        assertGe(token.balanceOf(address(adapter)), adapter.totalLocked());
        assertTrue(adapter.solvent());
    }

    function invariant_AccountingEqualsActiveLocks() public view {
        uint256 activeTotal;
        uint256 count = handler.lockCount();
        for (uint256 index = 0; index < count; index++) {
            EvmHtlcV2.Lock memory lock = adapter.getLock(
                handler.lockIdAt(index)
            );
            if (lock.state == EvmHtlcV2.LockState.FUNDED) {
                activeTotal += lock.beneficiaryAmount + lock.executorAmount;
            }
        }
        assertEq(activeTotal, adapter.totalLocked());
    }

    function invariant_AdapterHasNoNativeCustody() public view {
        assertEq(address(adapter).balance, 0);
    }
}
