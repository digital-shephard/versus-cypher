// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Ownerless exact-output native locks with a permissionless executor bounty.
/// @dev Source-side locks may set executorAmount to zero. Destination-side
/// locks let any watcher finish delivery without requiring recipient gas.
contract EvmNativeHtlcV2 is ReentrancyGuard {
    uint16 public constant ADAPTER_VERSION = 2;

    enum LockState {
        EMPTY,
        FUNDED,
        CLAIMED,
        REFUNDED
    }

    struct Lock {
        address funder;
        address beneficiary;
        address refundAddress;
        bytes32 secretHash;
        uint64 refundTimestamp;
        LockState state;
        uint256 beneficiaryAmount;
        uint256 executorAmount;
    }

    uint64 public immutable minimumLockDuration;
    uint64 public immutable maximumLockDuration;

    uint256 public totalLocked;

    mapping(bytes32 lockId => Lock lock) private locks;

    error InvalidDurationPolicy();
    error InvalidLock();
    error InvalidParty();
    error InvalidSecretHash();
    error InvalidAmount();
    error IncorrectValue(uint256 expected, uint256 actual);
    error LockAlreadyExists(bytes32 lockId);
    error InvalidRefundTimestamp();
    error LockNotFunded(bytes32 lockId);
    error LockExpired(bytes32 lockId);
    error LockNotExpired(bytes32 lockId);
    error WrongSecret(bytes32 lockId);
    error NativeTransferFailed(address recipient, uint256 amount);
    error DirectTransferUnsupported();

    event LockFunded(
        bytes32 indexed lockId,
        address indexed funder,
        address indexed beneficiary,
        address refundAddress,
        bytes32 secretHash,
        uint64 refundTimestamp,
        uint256 beneficiaryAmount,
        uint256 executorAmount
    );
    event LockClaimed(
        bytes32 indexed lockId,
        address indexed submitter,
        address indexed beneficiary,
        bytes32 secret,
        uint256 beneficiaryAmount,
        uint256 executorAmount
    );
    event LockRefunded(
        bytes32 indexed lockId,
        address indexed submitter,
        address indexed refundAddress,
        uint256 amount
    );

    constructor(uint64 minimumLockDuration_, uint64 maximumLockDuration_) {
        if (
            minimumLockDuration_ == 0 ||
            maximumLockDuration_ <= minimumLockDuration_
        ) {
            revert InvalidDurationPolicy();
        }
        minimumLockDuration = minimumLockDuration_;
        maximumLockDuration = maximumLockDuration_;
    }

    receive() external payable {
        revert DirectTransferUnsupported();
    }

    fallback() external payable {
        revert DirectTransferUnsupported();
    }

    function fund(
        bytes32 lockId,
        address beneficiary,
        address refundAddress,
        bytes32 secretHash,
        uint64 refundTimestamp,
        uint256 beneficiaryAmount,
        uint256 executorAmount
    ) external payable nonReentrant {
        if (lockId == bytes32(0)) revert InvalidLock();
        if (
            beneficiary == address(0) ||
            refundAddress == address(0) ||
            beneficiary == address(this) ||
            refundAddress == address(this)
        ) {
            revert InvalidParty();
        }
        if (secretHash == bytes32(0)) revert InvalidSecretHash();
        if (beneficiaryAmount == 0) revert InvalidAmount();
        if (locks[lockId].state != LockState.EMPTY) {
            revert LockAlreadyExists(lockId);
        }

        uint256 amount = beneficiaryAmount + executorAmount;
        if (msg.value != amount) revert IncorrectValue(amount, msg.value);

        uint256 minimumTimestamp = block.timestamp + minimumLockDuration;
        uint256 maximumTimestamp = block.timestamp + maximumLockDuration;
        if (
            refundTimestamp < minimumTimestamp ||
            refundTimestamp > maximumTimestamp
        ) {
            revert InvalidRefundTimestamp();
        }

        locks[lockId] = Lock({
            funder: msg.sender,
            beneficiary: beneficiary,
            refundAddress: refundAddress,
            secretHash: secretHash,
            refundTimestamp: refundTimestamp,
            state: LockState.FUNDED,
            beneficiaryAmount: beneficiaryAmount,
            executorAmount: executorAmount
        });
        totalLocked += amount;

        emit LockFunded(
            lockId,
            msg.sender,
            beneficiary,
            refundAddress,
            secretHash,
            refundTimestamp,
            beneficiaryAmount,
            executorAmount
        );
    }

    /// @notice Anyone may reveal the secret. The recipient gets the exact
    /// beneficiary amount and the successful submitter gets the executor amount.
    function claim(bytes32 lockId, bytes32 secret) external nonReentrant {
        Lock storage lock = locks[lockId];
        if (lock.state != LockState.FUNDED) revert LockNotFunded(lockId);
        if (block.timestamp >= lock.refundTimestamp) revert LockExpired(lockId);
        if (keccak256(abi.encodePacked(secret)) != lock.secretHash) {
            revert WrongSecret(lockId);
        }

        uint256 beneficiaryAmount = lock.beneficiaryAmount;
        uint256 executorAmount = lock.executorAmount;
        lock.state = LockState.CLAIMED;
        totalLocked -= beneficiaryAmount + executorAmount;

        _transfer(lock.beneficiary, beneficiaryAmount);
        if (executorAmount != 0) {
            _transfer(msg.sender, executorAmount);
        }

        emit LockClaimed(
            lockId,
            msg.sender,
            lock.beneficiary,
            secret,
            beneficiaryAmount,
            executorAmount
        );
    }

    function refund(bytes32 lockId) external nonReentrant {
        Lock storage lock = locks[lockId];
        if (lock.state != LockState.FUNDED) revert LockNotFunded(lockId);
        if (block.timestamp < lock.refundTimestamp) {
            revert LockNotExpired(lockId);
        }

        uint256 amount = lock.beneficiaryAmount + lock.executorAmount;
        lock.state = LockState.REFUNDED;
        totalLocked -= amount;
        _transfer(lock.refundAddress, amount);

        emit LockRefunded(
            lockId,
            msg.sender,
            lock.refundAddress,
            amount
        );
    }

    function getLock(bytes32 lockId) external view returns (Lock memory) {
        return locks[lockId];
    }

    function solvent() external view returns (bool) {
        return address(this).balance >= totalLocked;
    }

    function _transfer(address recipient, uint256 amount) private {
        (bool success, ) = payable(recipient).call{value: amount}("");
        if (!success) revert NativeTransferFailed(recipient, amount);
    }
}
