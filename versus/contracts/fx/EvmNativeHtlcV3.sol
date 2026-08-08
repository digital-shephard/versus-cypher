// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Ownerless exact-output native HTLC with a permissionless executor
/// bounty and commitment-only persistent state.
/// @dev Every settlement term is bound into a domain-separated lock digest.
/// Callers supply those terms again when claiming or refunding; changing any
/// field selects an unfunded digest. Source locks set executorAmount to zero.
contract EvmNativeHtlcV3 {
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

    uint64 public immutable minimumLockDuration;
    uint64 public immutable maximumLockDuration;
    bytes32 public immutable DOMAIN_SEPARATOR;

    mapping(bytes32 lockDigest => LockState lockState) public stateOf;

    error InvalidDurationPolicy();
    error InvalidTrade();
    error InvalidParty();
    error InvalidSecretHash();
    error InvalidAmount();
    error AmountTooLargeForCompactEncoding();
    error InvalidFunder(address expected, address actual);
    error IncorrectValue(uint256 expected, uint256 actual);
    error LockAlreadyExists(bytes32 lockDigest);
    error InvalidRefundTimestamp();
    error LockNotFunded(bytes32 lockDigest);
    error LockExpired(bytes32 lockDigest);
    error LockNotExpired(bytes32 lockDigest);
    error WrongSecret(bytes32 lockDigest);
    error NativeTransferFailed(address recipient, uint256 amount);
    error DirectTransferUnsupported();

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

    constructor(uint64 minimumLockDuration_, uint64 maximumLockDuration_) {
        if (
            minimumLockDuration_ == 0 ||
            maximumLockDuration_ <= minimumLockDuration_
        ) {
            revert InvalidDurationPolicy();
        }
        minimumLockDuration = minimumLockDuration_;
        maximumLockDuration = maximumLockDuration_;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(DOMAIN_TYPEHASH, block.chainid, address(this))
        );
    }

    receive() external payable {
        revert DirectTransferUnsupported();
    }

    fallback() external payable {
        revert DirectTransferUnsupported();
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

    function fund(Terms calldata terms) external payable {
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
    ) external payable {
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
        if (msg.value != amount) revert IncorrectValue(amount, msg.value);

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
    function claim(Terms calldata terms, bytes32 secret) external {
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
    ) external {
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

        _transfer(beneficiary, beneficiaryAmount);
        if (executorAmount != 0) {
            _transfer(msg.sender, executorAmount);
        }

        emit LockClaimed(digest, tradeId, msg.sender, secret);
    }

    function refund(Terms calldata terms) external {
        bytes32 digest = lockDigest(terms);
        if (stateOf[digest] != LockState.FUNDED) {
            revert LockNotFunded(digest);
        }
        if (block.timestamp < terms.refundTimestamp) {
            revert LockNotExpired(digest);
        }

        stateOf[digest] = LockState.REFUNDED;
        _transfer(
            terms.funder,
            uint256(terms.beneficiaryAmount) + terms.executorAmount
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

    function _transfer(address recipient, uint256 amount) private {
        (bool success, ) = payable(recipient).call{value: amount}("");
        if (!success) revert NativeTransferFailed(recipient, amount);
    }
}
