// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

interface IEvmHtlcV3Exact {
    struct Terms {
        bytes32 tradeId;
        address funder;
        address beneficiary;
        bytes32 secretHash;
        uint64 refundTimestamp;
        uint128 beneficiaryAmount;
        uint128 executorAmount;
    }

    function asset() external view returns (IERC20);

    function fund(
        bytes32 tradeId,
        address beneficiary,
        bytes32 secretHash,
        uint256 settlement
    ) external;

    function refund(Terms calldata terms) external;
}

interface IERC3009Exact {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @notice A deterministic, one-trade bridge between a stock x402 EIP-3009
/// payment and the ownerless Versus V3 HTLC.
/// @dev Its CREATE2 address commits the x402 `payTo` field to every source-lock
/// term. It has no owner, arbitrary call, upgrade, pause, or sweep surface.
contract EvmExactHtlcEscrow is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    address public immutable factory;
    IERC20 public immutable asset;
    IEvmHtlcV3Exact public immutable htlc;
    address public immutable payer;
    bytes32 public immutable tradeId;
    address public immutable beneficiary;
    address public immutable facilitator;
    uint256 public immutable facilitatorAmount;
    bytes32 public immutable secretHash;
    uint256 public immutable settlement;
    uint64 public immutable refundTimestamp;
    uint128 public immutable beneficiaryAmount;
    uint128 public immutable executorAmount;

    bool public activated;

    error OnlyFactory();
    error AlreadyActivated();
    error InvalidPayer();
    error InvalidFacilitator();
    error InvalidAmount();
    error RefundNotReady();
    error InsufficientRefundBalance();
    error UnsupportedTokenBehavior();
    error NativeAssetUnsupported();

    event EscrowActivated(
        bytes32 indexed tradeId,
        uint256 htlcAmount,
        address indexed facilitator,
        uint256 facilitatorAmount
    );
    event EscrowRefundForwarded(
        bytes32 indexed tradeId,
        address indexed payer,
        uint256 amount
    );

    constructor(
        address factory_,
        address asset_,
        address htlc_,
        address payer_,
        bytes32 tradeId_,
        address beneficiary_,
        address facilitator_,
        uint256 facilitatorAmount_,
        bytes32 secretHash_,
        uint256 settlement_
    ) {
        if (payer_ == address(0) || payer_ == address(this)) {
            revert InvalidPayer();
        }
        if (
            (facilitatorAmount_ == 0 && facilitator_ != address(0)) ||
            (facilitatorAmount_ != 0 && facilitator_ == address(0))
        ) revert InvalidFacilitator();

        factory = factory_;
        asset = IERC20(asset_);
        htlc = IEvmHtlcV3Exact(htlc_);
        payer = payer_;
        tradeId = tradeId_;
        beneficiary = beneficiary_;
        facilitator = facilitator_;
        facilitatorAmount = facilitatorAmount_;
        secretHash = secretHash_;
        settlement = settlement_;

        uint64 unpackedRefundTimestamp = uint64(settlement_ >> 192);
        uint128 unpackedBeneficiaryAmount = uint96(settlement_ >> 96);
        uint128 unpackedExecutorAmount = uint96(settlement_);
        if (unpackedBeneficiaryAmount == 0) revert InvalidAmount();

        refundTimestamp = unpackedRefundTimestamp;
        beneficiaryAmount = unpackedBeneficiaryAmount;
        executorAmount = unpackedExecutorAmount;
    }

    receive() external payable {
        revert NativeAssetUnsupported();
    }

    fallback() external payable {
        revert NativeAssetUnsupported();
    }

    function htlcAmount() public view returns (uint256) {
        return uint256(beneficiaryAmount) + uint256(executorAmount);
    }

    function totalAmount() public view returns (uint256) {
        return htlcAmount() + facilitatorAmount;
    }

    function activate() external nonReentrant {
        if (msg.sender != factory) revert OnlyFactory();
        if (activated) revert AlreadyActivated();

        uint256 requiredHtlcAmount = htlcAmount();
        if (asset.balanceOf(address(this)) < totalAmount()) {
            revert InvalidAmount();
        }

        activated = true;
        if (facilitatorAmount != 0) {
            uint256 escrowBefore = asset.balanceOf(address(this));
            uint256 facilitatorBefore = asset.balanceOf(facilitator);
            asset.safeTransfer(facilitator, facilitatorAmount);
            uint256 escrowAfter = asset.balanceOf(address(this));
            uint256 facilitatorAfter = asset.balanceOf(facilitator);
            if (
                escrowAfter > escrowBefore ||
                escrowBefore - escrowAfter != facilitatorAmount ||
                facilitatorAfter < facilitatorBefore ||
                facilitatorAfter - facilitatorBefore != facilitatorAmount
            ) revert UnsupportedTokenBehavior();
        }
        asset.forceApprove(address(htlc), requiredHtlcAmount);
        htlc.fund(tradeId, beneficiary, secretHash, settlement);
        asset.forceApprove(address(htlc), 0);

        emit EscrowActivated(
            tradeId,
            requiredHtlcAmount,
            facilitator,
            facilitatorAmount
        );
    }

    /// @notice Forwards a timed-out V3 refund to the original x402 payer.
    /// Anyone may execute it. If another actor already called the V3 refund,
    /// the escrow detects its returned balance and only performs the forward.
    function refund() external nonReentrant {
        if (!activated) revert InvalidAmount();
        if (block.timestamp < refundTimestamp) revert RefundNotReady();

        uint256 requiredAmount = htlcAmount();
        if (asset.balanceOf(address(this)) < requiredAmount) {
            IEvmHtlcV3Exact.Terms memory terms = IEvmHtlcV3Exact.Terms({
                tradeId: tradeId,
                funder: address(this),
                beneficiary: beneficiary,
                secretHash: secretHash,
                refundTimestamp: refundTimestamp,
                beneficiaryAmount: beneficiaryAmount,
                executorAmount: executorAmount
            });
            htlc.refund(terms);
        }

        uint256 escrowBefore = asset.balanceOf(address(this));
        if (escrowBefore < requiredAmount) revert InsufficientRefundBalance();
        uint256 payerBefore = asset.balanceOf(payer);
        asset.safeTransfer(payer, requiredAmount);
        uint256 escrowAfter = asset.balanceOf(address(this));
        uint256 payerAfter = asset.balanceOf(payer);
        if (
            escrowAfter > escrowBefore ||
            escrowBefore - escrowAfter != requiredAmount ||
            payerAfter < payerBefore ||
            payerAfter - payerBefore != requiredAmount
        ) {
            revert UnsupportedTokenBehavior();
        }

        emit EscrowRefundForwarded(tradeId, payer, requiredAmount);
    }
}

/// @notice Ownerless facilitator for standard x402 `exact` EIP-3009 payments.
/// @dev The signed authorization transfers directly to a CREATE2 escrow whose
/// address commits every V3 lock term. Settlement and HTLC funding are atomic.
contract EvmExactHtlcFactory is ReentrancyGuardTransient {
    IERC20 public immutable asset;
    IEvmHtlcV3Exact public immutable htlc;

    error AssetHasNoCode();
    error HtlcHasNoCode();
    error AssetMismatch();
    error InvalidAuthorization();
    error InvalidFacilitator();
    error InvalidAmount();
    error InvalidSignatureLength();
    error EscrowAlreadyDeployed(address escrow);
    error NativeAssetUnsupported();

    event ExactPaymentSettled(
        bytes32 indexed tradeId,
        address indexed payer,
        address indexed escrow,
        uint256 amount,
        address facilitator,
        uint256 facilitatorAmount,
        bytes32 nonce
    );

    struct LockTerms {
        address payer;
        bytes32 tradeId;
        address beneficiary;
        address facilitator;
        uint256 facilitatorAmount;
        bytes32 secretHash;
        uint256 settlement;
    }

    struct Authorization {
        address from;
        address to;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
    }

    constructor(address asset_, address htlc_) {
        if (asset_.code.length == 0) revert AssetHasNoCode();
        if (htlc_.code.length == 0) revert HtlcHasNoCode();
        if (address(IEvmHtlcV3Exact(htlc_).asset()) != asset_) {
            revert AssetMismatch();
        }
        asset = IERC20(asset_);
        htlc = IEvmHtlcV3Exact(htlc_);
    }

    receive() external payable {
        revert NativeAssetUnsupported();
    }

    fallback() external payable {
        revert NativeAssetUnsupported();
    }

    function amountFor(LockTerms calldata terms) public pure returns (uint256) {
        return _htlcAmount(terms) + terms.facilitatorAmount;
    }

    function escrowInitCodeHash(
        LockTerms calldata terms
    ) public view returns (bytes32) {
        _htlcAmount(terms);
        return keccak256(_escrowInitCode(terms));
    }

    function predictEscrow(
        LockTerms calldata terms
    ) public view returns (address escrow) {
        bytes32 salt = _salt(terms);
        bytes32 digest = keccak256(
            abi.encodePacked(bytes1(0xff), address(this), salt, escrowInitCodeHash(terms))
        );
        escrow = address(uint160(uint256(digest)));
    }

    function settleEip3009(
        LockTerms calldata terms,
        Authorization calldata authorization,
        bytes calldata signature
    ) external nonReentrant returns (address escrow) {
        escrow = predictEscrow(terms);
        uint256 requiredAmount = amountFor(terms);
        if (
            authorization.from != terms.payer ||
            authorization.to != escrow ||
            authorization.value != requiredAmount
        ) {
            revert InvalidAuthorization();
        }
        if (escrow.code.length != 0) revert EscrowAlreadyDeployed(escrow);
        if (signature.length != 65) revert InvalidSignatureLength();

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }

        bytes memory initCode = _escrowInitCode(terms);
        bytes32 salt = _salt(terms);
        address deployed;
        assembly ("memory-safe") {
            deployed := create2(0, add(initCode, 32), mload(initCode), salt)
        }
        if (deployed != escrow) revert InvalidAuthorization();

        IERC3009Exact(address(asset)).transferWithAuthorization(
            authorization.from,
            authorization.to,
            authorization.value,
            authorization.validAfter,
            authorization.validBefore,
            authorization.nonce,
            v,
            r,
            s
        );
        EvmExactHtlcEscrow(payable(escrow)).activate();

        emit ExactPaymentSettled(
            terms.tradeId,
            terms.payer,
            escrow,
            requiredAmount,
            terms.facilitator,
            terms.facilitatorAmount,
            authorization.nonce
        );
    }

    function _salt(LockTerms calldata terms) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                terms.payer,
                terms.tradeId,
                terms.beneficiary,
                terms.facilitator,
                terms.facilitatorAmount,
                terms.secretHash,
                terms.settlement
            )
        );
    }

    function _htlcAmount(
        LockTerms calldata terms
    ) private pure returns (uint256 amount) {
        if (
            (terms.facilitatorAmount == 0 && terms.facilitator != address(0)) ||
            (terms.facilitatorAmount != 0 && terms.facilitator == address(0))
        ) revert InvalidFacilitator();
        amount =
            uint256(uint96(terms.settlement >> 96)) +
            uint256(uint96(terms.settlement));
        if (amount == 0) revert InvalidAmount();
    }

    function _escrowInitCode(
        LockTerms calldata terms
    ) private view returns (bytes memory) {
        return abi.encodePacked(
            type(EvmExactHtlcEscrow).creationCode,
            abi.encode(
                address(this),
                address(asset),
                address(htlc),
                terms.payer,
                terms.tradeId,
                terms.beneficiary,
                terms.facilitator,
                terms.facilitatorAmount,
                terms.secretHash,
                terms.settlement
            )
        );
    }
}
