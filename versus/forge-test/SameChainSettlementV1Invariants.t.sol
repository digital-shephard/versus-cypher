// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";

import {SameChainSettlementV1} from "../contracts/fx/SameChainSettlementV1.sol";
import {MockUSDC} from "../contracts/test/MockUSDC.sol";

contract SameChainSettlementV1Handler is Test {
    uint256 private constant BUYER_KEY = 0xB001;
    uint256 private constant DEALER_KEY = 0xD001;
    address private constant BROKER = address(0xB0B);
    address private constant ENDPOINT = address(0xE402);

    MockUSDC public immutable inputToken;
    MockUSDC public immutable outputToken;
    SameChainSettlementV1 public immutable settlement;
    address public immutable buyer;
    address public immutable dealer;

    uint256 public successfulSettlements;
    uint256 public totalDealerInput;
    uint256 public totalBrokerFees;
    uint256 public totalExactOutput;

    constructor(
        MockUSDC inputToken_,
        MockUSDC outputToken_,
        SameChainSettlementV1 settlement_
    ) {
        inputToken = inputToken_;
        outputToken = outputToken_;
        settlement = settlement_;
        buyer = vm.addr(BUYER_KEY);
        dealer = vm.addr(DEALER_KEY);
        inputToken.mint(buyer, type(uint128).max);
        outputToken.mint(dealer, type(uint128).max);
        vm.prank(buyer);
        inputToken.approve(address(settlement), type(uint256).max);
        vm.prank(dealer);
        outputToken.approve(address(settlement), type(uint256).max);
    }

    function settle(
        uint96 rawOutput,
        uint96 rawSpread,
        uint96 rawBrokerFee
    ) external {
        uint256 outputAmount = bound(
            uint256(rawOutput),
            settlement.minimumOutputAmount(),
            settlement.maximumOutputAmount()
        );
        uint256 inputAmount = bound(
            outputAmount + uint256(rawSpread),
            outputAmount,
            settlement.maximumInputAmount()
        );
        uint256 brokerFee = bound(
            uint256(rawBrokerFee),
            0,
            settlement.maximumInputAmount() - inputAmount
        );
        uint256 index = successfulSettlements + 1;
        SameChainSettlementV1.DealerQuote memory quote = SameChainSettlementV1
            .DealerQuote({
                quoteId: keccak256(abi.encode("phase-4", index)),
                dealer: dealer,
                buyer: buyer,
                inputAmount: inputAmount,
                outputAmount: outputAmount,
                outputRecipient: ENDPOINT,
                issuedAt: uint64(block.timestamp),
                expiresAt: uint64(
                    block.timestamp + settlement.maximumQuoteLifetime()
                ),
                nonce: index,
                paymentCommitment: keccak256(
                    abi.encode("x402-requirement", index)
                )
            });
        bytes32 quoteDigest = settlement.hashDealerQuote(quote);
        SameChainSettlementV1.BuyerAcceptance
            memory acceptance = SameChainSettlementV1.BuyerAcceptance({
                quoteDigest: quoteDigest,
                buyer: buyer,
                maxInputAmount: inputAmount + brokerFee,
                broker: brokerFee == 0 ? address(0) : BROKER,
                brokerFee: brokerFee,
                expiresAt: quote.expiresAt,
                nonce: index
            });
        bytes32 acceptanceDigest = settlement.hashBuyerAcceptance(acceptance);

        (uint8 dealerV, bytes32 dealerR, bytes32 dealerS) = vm.sign(
            DEALER_KEY,
            quoteDigest
        );
        (uint8 buyerV, bytes32 buyerR, bytes32 buyerS) = vm.sign(
            BUYER_KEY,
            acceptanceDigest
        );
        settlement.settle(
            quote,
            abi.encodePacked(dealerR, dealerS, dealerV),
            acceptance,
            abi.encodePacked(buyerR, buyerS, buyerV)
        );

        successfulSettlements = index;
        totalDealerInput += inputAmount;
        totalBrokerFees += brokerFee;
        totalExactOutput += outputAmount;
    }

    function broker() external pure returns (address) {
        return BROKER;
    }

    function endpoint() external pure returns (address) {
        return ENDPOINT;
    }
}

contract SameChainSettlementV1InvariantTest is StdInvariant, Test {
    MockUSDC private inputToken;
    MockUSDC private outputToken;
    SameChainSettlementV1 private settlement;
    SameChainSettlementV1Handler private handler;
    uint256 private buyerInitial;
    uint256 private dealerOutputInitial;

    function setUp() public {
        inputToken = new MockUSDC();
        outputToken = new MockUSDC();
        settlement = new SameChainSettlementV1(
            address(inputToken),
            address(outputToken),
            6,
            6,
            100_000,
            1_000_000,
            2_000_000,
            20
        );
        handler = new SameChainSettlementV1Handler(
            inputToken,
            outputToken,
            settlement
        );
        buyerInitial = inputToken.balanceOf(handler.buyer());
        dealerOutputInitial = outputToken.balanceOf(handler.dealer());
        targetContract(address(handler));
    }

    function invariant_SettlementContractNeverCustodiesTradeFunds() public view {
        assertEq(inputToken.balanceOf(address(settlement)), 0);
        assertEq(outputToken.balanceOf(address(settlement)), 0);
        assertEq(address(settlement).balance, 0);
    }

    function invariant_ExactLegAccounting() public view {
        assertEq(
            buyerInitial - inputToken.balanceOf(handler.buyer()),
            handler.totalDealerInput() + handler.totalBrokerFees()
        );
        assertEq(
            inputToken.balanceOf(handler.dealer()),
            handler.totalDealerInput()
        );
        assertEq(
            inputToken.balanceOf(handler.broker()),
            handler.totalBrokerFees()
        );
        assertEq(
            dealerOutputInitial - outputToken.balanceOf(handler.dealer()),
            handler.totalExactOutput()
        );
        assertEq(
            outputToken.balanceOf(handler.endpoint()),
            handler.totalExactOutput()
        );
    }
}
