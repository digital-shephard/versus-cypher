// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";

import {EvmHtlcV1} from "../contracts/fx/EvmHtlcV1.sol";
import {MockUSDC} from "../contracts/test/MockUSDC.sol";

contract EvmHtlcV1Handler is Test {
    uint64 private constant MIN_DURATION = 60;

    MockUSDC public immutable token;
    EvmHtlcV1 public immutable adapter;

    bytes32[] private lockIds;
    mapping(bytes32 lockId => bytes32 secret) private secrets;

    constructor(MockUSDC token_, EvmHtlcV1 adapter_) {
        token = token_;
        adapter = adapter_;
        token.mint(address(this), type(uint128).max);
        token.approve(address(adapter), type(uint256).max);
    }

    function fund(uint96 rawAmount, uint256 seed) external {
        uint256 amount = bound(uint256(rawAmount), 1, 1_000_000_000_000);
        bytes32 lockId = keccak256(
            abi.encode("phase-3-invariant", lockIds.length, seed)
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
            uint64(block.timestamp + MIN_DURATION + 1 hours),
            amount
        );
        lockIds.push(lockId);
        secrets[lockId] = secret;
    }

    function claim(uint256 rawIndex) external {
        if (lockIds.length == 0) return;
        bytes32 lockId = lockIds[rawIndex % lockIds.length];
        EvmHtlcV1.Lock memory lock = adapter.getLock(lockId);
        if (
            lock.state != EvmHtlcV1.LockState.FUNDED ||
            block.timestamp >= lock.refundTimestamp
        ) return;
        adapter.claim(lockId, secrets[lockId]);
    }

    function refund(uint256 rawIndex) external {
        if (lockIds.length == 0) return;
        bytes32 lockId = lockIds[rawIndex % lockIds.length];
        EvmHtlcV1.Lock memory lock = adapter.getLock(lockId);
        if (lock.state != EvmHtlcV1.LockState.FUNDED) return;
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

contract EvmHtlcV1InvariantTest is StdInvariant, Test {
    MockUSDC private token;
    EvmHtlcV1 private adapter;
    EvmHtlcV1Handler private handler;

    function setUp() public {
        token = new MockUSDC();
        adapter = new EvmHtlcV1(address(token), 6, 60, 7 days);
        handler = new EvmHtlcV1Handler(token, adapter);
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
            EvmHtlcV1.Lock memory lock = adapter.getLock(
                handler.lockIdAt(index)
            );
            if (lock.state == EvmHtlcV1.LockState.FUNDED) {
                activeTotal += lock.amount;
            }
        }
        assertEq(activeTotal, adapter.totalLocked());
    }

    function invariant_AdapterHasNoNativeCustody() public view {
        assertEq(address(adapter).balance, 0);
    }
}
