// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {EvmHtlcV3} from "../contracts/fx/EvmHtlcV3.sol";
import {
    EvmExactHtlcEscrow,
    EvmExactHtlcFactory
} from "../contracts/fx/EvmExactHtlcFactory.sol";
import {MockEip3009USDC} from "../contracts/test/MockEip3009USDC.sol";

contract EvmExactHtlcFactoryFuzzTest is Test {
    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    uint256 private payerKey = 0xA11CE;
    address private payer;
    address private beneficiary = makeAddr("exact-beneficiary");
    address private relayer = makeAddr("exact-relayer");
    address private facilitator = makeAddr("exact-facilitator");

    MockEip3009USDC private token;
    EvmHtlcV3 private htlc;
    EvmExactHtlcFactory private factory;

    function setUp() public {
        payer = vm.addr(payerKey);
        token = new MockEip3009USDC();
        htlc = new EvmHtlcV3(address(token), 6, 60, 7 days);
        factory = new EvmExactHtlcFactory(address(token), address(htlc));
        token.mint(payer, type(uint128).max);
    }

    function testFuzz_ExactPaymentAlwaysCreatesOneBoundV3Lock(
        bytes32 seed,
        bytes32 secret,
        uint64 rawAmount,
        uint32 rawBounty
    ) public {
        uint96 amount = uint96(bound(uint256(rawAmount), 1, type(uint64).max));
        uint96 bounty = uint96(rawBounty);
        EvmExactHtlcFactory.LockTerms memory terms = _terms(
            seed,
            secret,
            amount,
            bounty
        );
        address escrow = factory.predictEscrow(terms);
        EvmExactHtlcFactory.Authorization memory authorization = _authorization(
            escrow,
            factory.amountFor(terms),
            seed
        );
        bytes memory signature = _sign(authorization);

        factory.settleEip3009(terms, authorization, signature);

        EvmHtlcV3.Terms memory lockTerms = EvmHtlcV3.Terms({
            tradeId: terms.tradeId,
            funder: escrow,
            beneficiary: terms.beneficiary,
            secretHash: terms.secretHash,
            refundTimestamp: uint64(terms.settlement >> 192),
            beneficiaryAmount: amount,
            executorAmount: bounty
        });
        bytes32 digest = htlc.lockDigest(lockTerms);
        assertEq(uint8(htlc.stateOf(digest)), uint8(EvmHtlcV3.LockState.FUNDED));
        assertEq(token.balanceOf(address(htlc)), uint256(amount) + bounty);
        assertEq(token.balanceOf(facilitator), 1);
        assertEq(token.balanceOf(escrow), 0);
    }

    function testFuzz_AnyChangedTermInvalidatesSignedPayTo(
        bytes32 seed,
        bytes32 otherSecret
    ) public {
        EvmExactHtlcFactory.LockTerms memory terms = _terms(seed, seed, 1_000_000, 0);
        address escrow = factory.predictEscrow(terms);
        EvmExactHtlcFactory.Authorization memory authorization = _authorization(
            escrow,
            factory.amountFor(terms),
            seed
        );
        bytes memory signature = _sign(authorization);
        terms.secretHash = keccak256(abi.encodePacked(otherSecret, bytes1(0x01)));

        vm.expectRevert(EvmExactHtlcFactory.InvalidAuthorization.selector);
        factory.settleEip3009(terms, authorization, signature);
        assertFalse(token.authorizationState(payer, authorization.nonce));
    }

    function testFuzz_TimeoutRefundAlwaysReturnsExactPrincipal(
        bytes32 seed,
        bytes32 secret,
        uint64 rawAmount
    ) public {
        uint96 amount = uint96(bound(uint256(rawAmount), 1, type(uint64).max));
        EvmExactHtlcFactory.LockTerms memory terms = _terms(
            seed,
            secret,
            amount,
            0
        );
        address escrow = factory.predictEscrow(terms);
        EvmExactHtlcFactory.Authorization memory authorization = _authorization(
            escrow,
            factory.amountFor(terms),
            seed
        );
        factory.settleEip3009(terms, authorization, _sign(authorization));
        uint256 payerBefore = token.balanceOf(payer);

        vm.warp(uint64(terms.settlement >> 192));
        vm.prank(relayer);
        EvmExactHtlcEscrow(payable(escrow)).refund();

        assertEq(token.balanceOf(payer), payerBefore + amount);
        assertEq(token.balanceOf(facilitator), 1);
        assertEq(token.balanceOf(escrow), 0);
        assertEq(token.balanceOf(address(htlc)), 0);
    }

    function _terms(
        bytes32 seed,
        bytes32 secret,
        uint96 amount,
        uint96 bounty
    ) private view returns (EvmExactHtlcFactory.LockTerms memory) {
        uint64 refundTimestamp = uint64(block.timestamp + 1 hours);
        uint256 settlement =
            (uint256(refundTimestamp) << 192) |
            (uint256(amount) << 96) |
            uint256(bounty);
        return EvmExactHtlcFactory.LockTerms({
            payer: payer,
            tradeId: keccak256(abi.encode("generic-exact", seed)),
            beneficiary: beneficiary,
            facilitator: facilitator,
            facilitatorAmount: 1,
            secretHash: keccak256(abi.encodePacked(secret)),
            settlement: settlement
        });
    }

    function _authorization(
        address escrow,
        uint256 amount,
        bytes32 seed
    ) private view returns (EvmExactHtlcFactory.Authorization memory) {
        return EvmExactHtlcFactory.Authorization({
            from: payer,
            to: escrow,
            value: amount,
            validAfter: 0,
            validBefore: block.timestamp + 10 minutes,
            nonce: keccak256(abi.encode("nonce", seed))
        });
    }

    function _sign(
        EvmExactHtlcFactory.Authorization memory authorization
    ) private view returns (bytes memory) {
        bytes32 domain = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("Mock EIP3009 USDC")),
                keccak256(bytes("2")),
                block.chainid,
                address(token)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                AUTHORIZATION_TYPEHASH,
                authorization.from,
                authorization.to,
                authorization.value,
                authorization.validAfter,
                authorization.validBefore,
                authorization.nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerKey, digest);
        return abi.encodePacked(r, s, v);
    }
}
