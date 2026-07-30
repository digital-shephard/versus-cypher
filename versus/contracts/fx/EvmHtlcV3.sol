// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @notice Ownerless exact-output ERC-20 HTLC with a permissionless executor
/// bounty and commitment-only persistent state.
/// @dev One deployment is bound to one exact token. Every settlement term is
/// domain-separated by chain and adapter before its state is persisted.
contract EvmHtlcV3 is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint16 public constant ADAPTER_VERSION = 3;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("VersusFxHtlcV3Domain(uint256 chainId,address adapter)");
    bytes32 private constant LOCK_TYPEHASH =
        keccak256(
            "VersusFxHtlcV3(bytes32 domain,bytes32 tradeId,address funder,address beneficiary,bytes32 secretHash,uint64 refundTimestamp,uint128 beneficiaryAmount,uint128 executorAmount)"
        );

    enum LockState {
        EMPTY,
        FUNDED,
        CLAIMED,
        REFUNDED
    }

    struct Terms {
        bytes32 tradeId;
        address funder;
        address beneficiary;
        bytes32 secretHash;
        uint64 refundTimestamp;
        uint128 beneficiaryAmount;
        uint128 executorAmount;
    }

    IERC20 public immutable asset;
    uint8 public immutable assetDecimals;
    uint64 public immutable minimumLockDuration;
    uint64 public immutable maximumLockDuration;
    bytes32 public immutable DOMAIN_SEPARATOR;

    mapping(bytes32 lockDigest => LockState lockState) public stateOf;

    error AssetHasNoCode();
    error DecimalMismatch(uint8 expected, uint8 actual);
    error InvalidDurationPolicy();
    error InvalidTrade();
    error InvalidParty();
    error InvalidSecretHash();
    error InvalidAmount();
    error AmountTooLargeForCompactEncoding();
    error InvalidFunder(address expected, address actual);
    error LockAlreadyExists(bytes32 lockDigest);
    error InvalidRefundTimestamp();
    error LockNotFunded(bytes32 lockDigest);
    error LockExpired(bytes32 lockDigest);
    error LockNotExpired(bytes32 lockDigest);
    error WrongSecret(bytes32 lockDigest);
    error UnsupportedTokenBehavior();
    error NativeAssetUnsupported();

    event LockFunded(
        bytes32 indexed lockDigest,
        bytes32 indexed tradeId,
        address indexed funder,
        address beneficiary,
        bytes32 secretHash,
        uint64 refundTimestamp,
        uint128 beneficiaryAmount,
        uint128 executorAmount
    );
    event LockClaimed(
        bytes32 indexed lockDigest,
        bytes32 indexed tradeId,
        address indexed submitter,
        bytes32 secret
    );
    event LockRefunded(
        bytes32 indexed lockDigest,
        bytes32 indexed tradeId,
        address indexed submitter
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
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(DOMAIN_TYPEHASH, block.chainid, address(this))
        );
    }

    receive() external payable {
        revert NativeAssetUnsupported();
    }

    fallback() external payable {
        revert NativeAssetUnsupported();
    }

    function lockDigest(Terms calldata terms) public view returns (bytes32) {
        return
            _lockDigest(
                terms.tradeId,
                terms.funder,
                terms.beneficiary,
                terms.secretHash,
                terms.refundTimestamp,
                terms.beneficiaryAmount,
                terms.executorAmount
            );
    }

    function packSettlement(
        uint64 refundTimestamp,
        uint128 beneficiaryAmount,
        uint128 executorAmount
    ) public pure returns (uint256 settlement) {
        if (
            beneficiaryAmount > type(uint96).max ||
            executorAmount > type(uint96).max
        ) {
            revert AmountTooLargeForCompactEncoding();
        }
        settlement =
            (uint256(refundTimestamp) << 192) |
            (uint256(beneficiaryAmount) << 96) |
            uint256(executorAmount);
    }

    function _lockDigest(
        bytes32 tradeId,
        address funder,
        address beneficiary,
        bytes32 secretHash,
        uint64 refundTimestamp,
        uint128 beneficiaryAmount,
        uint128 executorAmount
    ) private view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    LOCK_TYPEHASH,
                    DOMAIN_SEPARATOR,
                    tradeId,
                    funder,
                    beneficiary,
                    secretHash,
                    refundTimestamp,
                    beneficiaryAmount,
                    executorAmount
                )
            );
    }

    function fund(Terms calldata terms) external nonReentrant {
        if (terms.funder != msg.sender) {
            revert InvalidFunder(terms.funder, msg.sender);
        }
        _fund(
            terms.tradeId,
            terms.funder,
            terms.beneficiary,
            terms.secretHash,
            terms.refundTimestamp,
            terms.beneficiaryAmount,
            terms.executorAmount
        );
    }

    /// @notice Canonical low-calldata funding path. The funder is the caller.
    /// settlement packs uint64 timeout | uint96 beneficiary | uint96 executor.
    function fund(
        bytes32 tradeId,
        address beneficiary,
        bytes32 secretHash,
        uint256 settlement
    ) external nonReentrant {
        (
            uint64 refundTimestamp,
            uint128 beneficiaryAmount,
            uint128 executorAmount
        ) = _unpackSettlement(settlement);
        _fund(
            tradeId,
            msg.sender,
            beneficiary,
            secretHash,
            refundTimestamp,
            beneficiaryAmount,
            executorAmount
        );
    }

    function _fund(
        bytes32 tradeId,
        address funder,
        address beneficiary,
        bytes32 secretHash,
        uint64 refundTimestamp,
        uint128 beneficiaryAmount,
        uint128 executorAmount
    ) private {
        uint256 amount = _validateTerms(
            tradeId,
            funder,
            beneficiary,
            secretHash,
            refundTimestamp,
            beneficiaryAmount,
            executorAmount
        );
        bytes32 digest = _lockDigest(
            tradeId,
            funder,
            beneficiary,
            secretHash,
            refundTimestamp,
            beneficiaryAmount,
            executorAmount
        );
        if (stateOf[digest] != LockState.EMPTY) {
            revert LockAlreadyExists(digest);
        }
        stateOf[digest] = LockState.FUNDED;

        uint256 balanceBefore = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), amount);
        uint256 balanceAfter = asset.balanceOf(address(this));
        if (
            balanceAfter < balanceBefore ||
            balanceAfter - balanceBefore != amount
        ) {
            revert UnsupportedTokenBehavior();
        }

        emit LockFunded(
            digest,
            tradeId,
            funder,
            beneficiary,
            secretHash,
            refundTimestamp,
            beneficiaryAmount,
            executorAmount
        );
    }

    /// @notice Anyone may reveal the requester-owned secret. The fixed
    /// beneficiary receives the exact output and the successful submitter
    /// receives the exact executor bounty.
    function claim(
        Terms calldata terms,
        bytes32 secret
    ) external nonReentrant {
        if (keccak256(abi.encodePacked(secret)) != terms.secretHash) {
            revert WrongSecret(lockDigest(terms));
        }
        _claim(
            terms.tradeId,
            terms.funder,
            terms.beneficiary,
            terms.secretHash,
            terms.refundTimestamp,
            terms.beneficiaryAmount,
            terms.executorAmount,
            secret
        );
    }

    /// @notice Canonical low-calldata claim path. The secret hash is derived
    /// from the supplied requester secret and remains commitment-bound.
    function claim(
        bytes32 tradeId,
        address funder,
        address beneficiary,
        uint256 settlement,
        bytes32 secret
    ) external nonReentrant {
        (
            uint64 refundTimestamp,
            uint128 beneficiaryAmount,
            uint128 executorAmount
        ) = _unpackSettlement(settlement);
        _claim(
            tradeId,
            funder,
            beneficiary,
            keccak256(abi.encodePacked(secret)),
            refundTimestamp,
            beneficiaryAmount,
            executorAmount,
            secret
        );
    }

    function _claim(
        bytes32 tradeId,
        address funder,
        address beneficiary,
        bytes32 secretHash,
        uint64 refundTimestamp,
        uint128 beneficiaryAmount,
        uint128 executorAmount,
        bytes32 secret
    ) private {
        bytes32 digest = _lockDigest(
            tradeId,
            funder,
            beneficiary,
            secretHash,
            refundTimestamp,
            beneficiaryAmount,
            executorAmount
        );
        if (stateOf[digest] != LockState.FUNDED) {
            revert LockNotFunded(digest);
        }
        if (block.timestamp >= refundTimestamp) {
            revert LockExpired(digest);
        }

        stateOf[digest] = LockState.CLAIMED;
        _transferExact(
            beneficiary,
            beneficiaryAmount,
            msg.sender,
            executorAmount
        );

        emit LockClaimed(digest, tradeId, msg.sender, secret);
    }

    function refund(Terms calldata terms) external nonReentrant {
        bytes32 digest = lockDigest(terms);
        if (stateOf[digest] != LockState.FUNDED) {
            revert LockNotFunded(digest);
        }
        if (block.timestamp < terms.refundTimestamp) {
            revert LockNotExpired(digest);
        }

        stateOf[digest] = LockState.REFUNDED;
        _transferExact(
            terms.funder,
            uint256(terms.beneficiaryAmount) + terms.executorAmount,
            address(0),
            0
        );

        emit LockRefunded(digest, terms.tradeId, msg.sender);
    }

    function _validateTerms(
        bytes32 tradeId,
        address funder,
        address beneficiary,
        bytes32 secretHash,
        uint64 refundTimestamp,
        uint128 beneficiaryAmount,
        uint128 executorAmount
    ) private view returns (uint256 amount) {
        if (tradeId == bytes32(0)) revert InvalidTrade();
        if (
            funder == address(0) ||
            beneficiary == address(0) ||
            funder == address(this) ||
            beneficiary == address(this)
        ) {
            revert InvalidParty();
        }
        if (secretHash == bytes32(0)) revert InvalidSecretHash();
        if (beneficiaryAmount == 0) revert InvalidAmount();

        uint256 minimumTimestamp = block.timestamp + minimumLockDuration;
        uint256 maximumTimestamp = block.timestamp + maximumLockDuration;
        if (
            refundTimestamp < minimumTimestamp ||
            refundTimestamp > maximumTimestamp
        ) {
            revert InvalidRefundTimestamp();
        }

        amount = uint256(beneficiaryAmount) + uint256(executorAmount);
    }

    function _unpackSettlement(
        uint256 settlement
    )
        private
        pure
        returns (
            uint64 refundTimestamp,
            uint128 beneficiaryAmount,
            uint128 executorAmount
        )
    {
        refundTimestamp = uint64(settlement >> 192);
        beneficiaryAmount = uint96(settlement >> 96);
        executorAmount = uint96(settlement);
    }

    function _transferExact(
        address beneficiary,
        uint256 beneficiaryAmount,
        address executor,
        uint256 executorAmount
    ) private {
        uint256 total = beneficiaryAmount + executorAmount;
        uint256 contractBefore = asset.balanceOf(address(this));

        if (executorAmount == 0 || executor == beneficiary) {
            uint256 recipientBefore = asset.balanceOf(beneficiary);
            asset.safeTransfer(beneficiary, total);
            uint256 contractAfterSingle = asset.balanceOf(address(this));
            uint256 recipientAfter = asset.balanceOf(beneficiary);
            if (
                contractAfterSingle > contractBefore ||
                contractBefore - contractAfterSingle != total ||
                recipientAfter < recipientBefore ||
                recipientAfter - recipientBefore != total
            ) {
                revert UnsupportedTokenBehavior();
            }
            return;
        }

        uint256 beneficiaryBefore = asset.balanceOf(beneficiary);
        uint256 executorBefore = asset.balanceOf(executor);
        asset.safeTransfer(beneficiary, beneficiaryAmount);
        asset.safeTransfer(executor, executorAmount);
        uint256 contractAfter = asset.balanceOf(address(this));
        uint256 beneficiaryAfter = asset.balanceOf(beneficiary);
        uint256 executorAfter = asset.balanceOf(executor);
        if (
            contractAfter > contractBefore ||
            contractBefore - contractAfter != total ||
            beneficiaryAfter < beneficiaryBefore ||
            beneficiaryAfter - beneficiaryBefore != beneficiaryAmount ||
            executorAfter < executorBefore ||
            executorAfter - executorBefore != executorAmount
        ) {
            revert UnsupportedTokenBehavior();
        }
    }
}
