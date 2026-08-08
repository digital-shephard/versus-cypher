// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Ownerless exact-output ERC-20 locks with a permissionless executor bounty.
/// @dev One deployment is bound to one exact ERC-20. Source-side locks may set
/// executorAmount to zero. Destination-side locks pay the fixed beneficiary
/// first and the successful secret submitter second, atomically.
contract EvmHtlcV2 is ReentrancyGuard {
    using SafeERC20 for IERC20;

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

    IERC20 public immutable asset;
    uint8 public immutable assetDecimals;
    uint64 public immutable minimumLockDuration;
    uint64 public immutable maximumLockDuration;

    uint256 public totalLocked;

    mapping(bytes32 lockId => Lock lock) private locks;

    error AssetHasNoCode();
    error DecimalMismatch(uint8 expected, uint8 actual);
    error InvalidDurationPolicy();
    error InvalidLock();
    error InvalidParty();
    error InvalidSecretHash();
    error InvalidAmount();
    error LockAlreadyExists(bytes32 lockId);
    error InvalidRefundTimestamp();
    error LockNotFunded(bytes32 lockId);
    error LockExpired(bytes32 lockId);
    error LockNotExpired(bytes32 lockId);
    error WrongSecret(bytes32 lockId);
    error UnsupportedTokenBehavior();
    error NativeAssetUnsupported();

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

    constructor(
        address asset_,
        uint8 expectedDecimals_,
        uint64 minimumLockDuration_,
        uint64 maximumLockDuration_
    ) {
        if (asset_.code.length == 0) revert AssetHasNoCode();
        if (
            minimumLockDuration_ == 0 ||
            maximumLockDuration_ <= minimumLockDuration_
        ) {
            revert InvalidDurationPolicy();
        }

        uint8 actualDecimals = IERC20Metadata(asset_).decimals();
        if (actualDecimals != expectedDecimals_) {
            revert DecimalMismatch(expectedDecimals_, actualDecimals);
        }

        asset = IERC20(asset_);
        assetDecimals = expectedDecimals_;
        minimumLockDuration = minimumLockDuration_;
        maximumLockDuration = maximumLockDuration_;
    }

    receive() external payable {
        revert NativeAssetUnsupported();
    }

    fallback() external payable {
        revert NativeAssetUnsupported();
    }

    function fund(
        bytes32 lockId,
        address beneficiary,
        address refundAddress,
        bytes32 secretHash,
        uint64 refundTimestamp,
        uint256 beneficiaryAmount,
        uint256 executorAmount
    ) external nonReentrant {
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

        uint256 minimumTimestamp = block.timestamp + minimumLockDuration;
        uint256 maximumTimestamp = block.timestamp + maximumLockDuration;
        if (
            refundTimestamp < minimumTimestamp ||
            refundTimestamp > maximumTimestamp
        ) {
            revert InvalidRefundTimestamp();
        }

        uint256 amount = beneficiaryAmount + executorAmount;
        uint256 balanceBefore = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), amount);
        uint256 balanceAfter = asset.balanceOf(address(this));
        if (
            balanceAfter < balanceBefore ||
            balanceAfter - balanceBefore != amount
        ) {
            revert UnsupportedTokenBehavior();
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

        _transferExact(lock.beneficiary, beneficiaryAmount);
        if (executorAmount != 0) {
            _transferExact(msg.sender, executorAmount);
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
        _transferExact(lock.refundAddress, amount);

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
        return asset.balanceOf(address(this)) >= totalLocked;
    }

    function _transferExact(address recipient, uint256 amount) private {
        uint256 contractBefore = asset.balanceOf(address(this));
        uint256 recipientBefore = asset.balanceOf(recipient);
        asset.safeTransfer(recipient, amount);
        uint256 contractAfter = asset.balanceOf(address(this));
        uint256 recipientAfter = asset.balanceOf(recipient);
        if (
            contractAfter > contractBefore ||
            contractBefore - contractAfter != amount ||
            recipientAfter < recipientBefore ||
            recipientAfter - recipientBefore != amount
        ) {
            revert UnsupportedTokenBehavior();
        }
    }
}
