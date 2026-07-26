// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Ownerless, exact-output settlement for one reviewed same-chain pair.
/// @dev The buyer pays the dealer and optional broker in inputToken while the
/// dealer pays the fixed recipient in outputToken. All legs settle atomically.
contract SameChainSettlementV1 is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant SETTLEMENT_VERSION = 1;

    bytes32 public constant DEALER_QUOTE_TYPEHASH = keccak256(
        "DealerQuote(bytes32 quoteId,address dealer,address buyer,uint256 inputAmount,uint256 outputAmount,address outputRecipient,uint64 issuedAt,uint64 expiresAt,uint256 nonce,bytes32 paymentCommitment)"
    );
    bytes32 public constant BUYER_ACCEPTANCE_TYPEHASH = keccak256(
        "BuyerAcceptance(bytes32 quoteDigest,address buyer,uint256 maxInputAmount,address broker,uint256 brokerFee,uint64 expiresAt,uint256 nonce)"
    );

    struct DealerQuote {
        bytes32 quoteId;
        address dealer;
        address buyer;
        uint256 inputAmount;
        uint256 outputAmount;
        address outputRecipient;
        uint64 issuedAt;
        uint64 expiresAt;
        uint256 nonce;
        bytes32 paymentCommitment;
    }

    struct BuyerAcceptance {
        bytes32 quoteDigest;
        address buyer;
        uint256 maxInputAmount;
        address broker;
        uint256 brokerFee;
        uint64 expiresAt;
        uint256 nonce;
    }

    IERC20 public immutable inputToken;
    IERC20 public immutable outputToken;
    uint8 public immutable inputDecimals;
    uint8 public immutable outputDecimals;
    uint256 public immutable minimumOutputAmount;
    uint256 public immutable maximumOutputAmount;
    uint256 public immutable maximumInputAmount;
    uint64 public immutable maximumQuoteLifetime;

    mapping(bytes32 digest => bool used) public usedDealerQuotes;
    mapping(bytes32 digest => bool used) public usedBuyerAcceptances;

    error TokenHasNoCode();
    error SameToken();
    error DecimalMismatch();
    error InvalidLimits();
    error InvalidParty();
    error InvalidAmount();
    error InvalidQuoteTime();
    error InvalidAcceptance();
    error InvalidDealerSignature();
    error InvalidBuyerSignature();
    error QuoteAlreadyUsed(bytes32 digest);
    error AcceptanceAlreadyUsed(bytes32 digest);
    error UnsupportedTokenBehavior();
    error NativeAssetUnsupported();

    event FxSettled(
        bytes32 indexed quoteDigest,
        bytes32 indexed acceptanceDigest,
        bytes32 indexed quoteId,
        address buyer,
        address dealer,
        address broker,
        address outputRecipient,
        uint256 dealerInputAmount,
        uint256 brokerFee,
        uint256 exactOutputAmount,
        bytes32 paymentCommitment
    );

    constructor(
        address inputToken_,
        address outputToken_,
        uint8 expectedInputDecimals_,
        uint8 expectedOutputDecimals_,
        uint256 minimumOutputAmount_,
        uint256 maximumOutputAmount_,
        uint256 maximumInputAmount_,
        uint64 maximumQuoteLifetime_
    ) EIP712("Versus Same Chain Settlement", "1") {
        if (inputToken_.code.length == 0 || outputToken_.code.length == 0) {
            revert TokenHasNoCode();
        }
        if (inputToken_ == outputToken_) revert SameToken();
        if (
            IERC20Metadata(inputToken_).decimals() != expectedInputDecimals_ ||
            IERC20Metadata(outputToken_).decimals() != expectedOutputDecimals_
        ) {
            revert DecimalMismatch();
        }
        if (
            minimumOutputAmount_ == 0 ||
            maximumOutputAmount_ < minimumOutputAmount_ ||
            maximumInputAmount_ == 0 ||
            maximumQuoteLifetime_ == 0
        ) {
            revert InvalidLimits();
        }

        inputToken = IERC20(inputToken_);
        outputToken = IERC20(outputToken_);
        inputDecimals = expectedInputDecimals_;
        outputDecimals = expectedOutputDecimals_;
        minimumOutputAmount = minimumOutputAmount_;
        maximumOutputAmount = maximumOutputAmount_;
        maximumInputAmount = maximumInputAmount_;
        maximumQuoteLifetime = maximumQuoteLifetime_;
    }

    receive() external payable {
        revert NativeAssetUnsupported();
    }

    fallback() external payable {
        revert NativeAssetUnsupported();
    }

    function settle(
        DealerQuote calldata quote,
        bytes calldata dealerSignature,
        BuyerAcceptance calldata acceptance,
        bytes calldata buyerSignature
    ) external nonReentrant {
        bytes32 quoteDigest = hashDealerQuote(quote);
        bytes32 acceptanceDigest = hashBuyerAcceptance(acceptance);

        _validateQuote(quote, quoteDigest, dealerSignature);
        _validateAcceptance(
            quote,
            quoteDigest,
            acceptance,
            acceptanceDigest,
            buyerSignature
        );

        usedDealerQuotes[quoteDigest] = true;
        usedBuyerAcceptances[acceptanceDigest] = true;

        _transferFromExact(
            inputToken,
            quote.buyer,
            quote.dealer,
            quote.inputAmount
        );
        if (acceptance.brokerFee != 0) {
            _transferFromExact(
                inputToken,
                quote.buyer,
                acceptance.broker,
                acceptance.brokerFee
            );
        }
        _transferFromExact(
            outputToken,
            quote.dealer,
            quote.outputRecipient,
            quote.outputAmount
        );

        emit FxSettled(
            quoteDigest,
            acceptanceDigest,
            quote.quoteId,
            quote.buyer,
            quote.dealer,
            acceptance.broker,
            quote.outputRecipient,
            quote.inputAmount,
            acceptance.brokerFee,
            quote.outputAmount,
            quote.paymentCommitment
        );
    }

    function hashDealerQuote(
        DealerQuote calldata quote
    ) public view returns (bytes32) {
        return
            _hashTypedDataV4(
                keccak256(
                    abi.encode(
                        DEALER_QUOTE_TYPEHASH,
                        quote.quoteId,
                        quote.dealer,
                        quote.buyer,
                        quote.inputAmount,
                        quote.outputAmount,
                        quote.outputRecipient,
                        quote.issuedAt,
                        quote.expiresAt,
                        quote.nonce,
                        quote.paymentCommitment
                    )
                )
            );
    }

    function hashBuyerAcceptance(
        BuyerAcceptance calldata acceptance
    ) public view returns (bytes32) {
        return
            _hashTypedDataV4(
                keccak256(
                    abi.encode(
                        BUYER_ACCEPTANCE_TYPEHASH,
                        acceptance.quoteDigest,
                        acceptance.buyer,
                        acceptance.maxInputAmount,
                        acceptance.broker,
                        acceptance.brokerFee,
                        acceptance.expiresAt,
                        acceptance.nonce
                    )
                )
            );
    }

    function _validateQuote(
        DealerQuote calldata quote,
        bytes32 quoteDigest,
        bytes calldata dealerSignature
    ) private view {
        if (
            quote.quoteId == bytes32(0) ||
            quote.paymentCommitment == bytes32(0)
        ) {
            revert InvalidAmount();
        }
        if (
            quote.dealer == address(0) ||
            quote.buyer == address(0) ||
            quote.outputRecipient == address(0) ||
            quote.dealer == quote.buyer ||
            quote.outputRecipient == quote.dealer ||
            quote.outputRecipient == address(this)
        ) {
            revert InvalidParty();
        }
        if (
            quote.inputAmount == 0 ||
            quote.inputAmount > maximumInputAmount ||
            quote.outputAmount < minimumOutputAmount ||
            quote.outputAmount > maximumOutputAmount
        ) {
            revert InvalidAmount();
        }
        if (
            quote.issuedAt > block.timestamp ||
            quote.expiresAt <= block.timestamp ||
            quote.expiresAt <= quote.issuedAt ||
            quote.expiresAt - quote.issuedAt > maximumQuoteLifetime
        ) {
            revert InvalidQuoteTime();
        }
        if (usedDealerQuotes[quoteDigest]) {
            revert QuoteAlreadyUsed(quoteDigest);
        }
        if (
            !SignatureChecker.isValidSignatureNow(
                quote.dealer,
                quoteDigest,
                dealerSignature
            )
        ) {
            revert InvalidDealerSignature();
        }
    }

    function _validateAcceptance(
        DealerQuote calldata quote,
        bytes32 quoteDigest,
        BuyerAcceptance calldata acceptance,
        bytes32 acceptanceDigest,
        bytes calldata buyerSignature
    ) private view {
        uint256 allInInput = quote.inputAmount + acceptance.brokerFee;
        if (
            acceptance.quoteDigest != quoteDigest ||
            acceptance.buyer != quote.buyer ||
            acceptance.expiresAt <= block.timestamp ||
            acceptance.expiresAt > quote.expiresAt ||
            acceptance.maxInputAmount > maximumInputAmount ||
            allInInput > acceptance.maxInputAmount
        ) {
            revert InvalidAcceptance();
        }
        if (acceptance.brokerFee == 0) {
            if (acceptance.broker != address(0)) revert InvalidAcceptance();
        } else if (
            acceptance.broker == address(0) ||
            acceptance.broker == quote.buyer ||
            acceptance.broker == quote.dealer ||
            acceptance.broker == quote.outputRecipient ||
            acceptance.broker == address(this)
        ) {
            revert InvalidParty();
        }
        if (usedBuyerAcceptances[acceptanceDigest]) {
            revert AcceptanceAlreadyUsed(acceptanceDigest);
        }
        if (
            !SignatureChecker.isValidSignatureNow(
                quote.buyer,
                acceptanceDigest,
                buyerSignature
            )
        ) {
            revert InvalidBuyerSignature();
        }
    }

    function _transferFromExact(
        IERC20 token,
        address sender,
        address recipient,
        uint256 amount
    ) private {
        uint256 senderBefore = token.balanceOf(sender);
        uint256 recipientBefore = token.balanceOf(recipient);
        token.safeTransferFrom(sender, recipient, amount);
        uint256 senderAfter = token.balanceOf(sender);
        uint256 recipientAfter = token.balanceOf(recipient);
        if (
            senderAfter > senderBefore ||
            senderBefore - senderAfter != amount ||
            recipientAfter < recipientBefore ||
            recipientAfter - recipientBefore != amount
        ) {
            revert UnsupportedTokenBehavior();
        }
    }
}
