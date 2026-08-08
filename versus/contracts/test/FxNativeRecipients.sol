// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IEvmNativeHtlcV1 {
    function claim(bytes32 lockId, bytes32 secret) external;
}

contract FxNativeRejector {
    receive() external payable {
        revert("reject");
    }
}

contract FxNativeReentrantRecipient {
    IEvmNativeHtlcV1 public immutable adapter;
    bytes32 public lockId;
    bytes32 public secret;
    bool public attempted;
    bool public succeeded;

    constructor(address adapter_) {
        adapter = IEvmNativeHtlcV1(adapter_);
    }

    function configure(bytes32 lockId_, bytes32 secret_) external {
        lockId = lockId_;
        secret = secret_;
    }

    receive() external payable {
        attempted = true;
        (succeeded, ) = address(adapter).call(
            abi.encodeCall(IEvmNativeHtlcV1.claim, (lockId, secret))
        );
    }
}

interface IEvmNativeHtlcV3 {
    struct Terms {
        bytes32 tradeId;
        address funder;
        address beneficiary;
        bytes32 secretHash;
        uint64 refundTimestamp;
        uint128 beneficiaryAmount;
        uint128 executorAmount;
    }

    function claim(Terms calldata terms, bytes32 secret) external;
}

contract FxNativeV3ReentrantRecipient {
    IEvmNativeHtlcV3 public immutable adapter;
    IEvmNativeHtlcV3.Terms private terms;
    bytes32 private secret;
    bool public attempted;
    bool public succeeded;

    constructor(address adapter_) {
        adapter = IEvmNativeHtlcV3(adapter_);
    }

    function configure(
        IEvmNativeHtlcV3.Terms calldata terms_,
        bytes32 secret_
    ) external {
        terms = terms_;
        secret = secret_;
    }

    receive() external payable {
        attempted = true;
        (succeeded, ) = address(adapter).call(
            abi.encodeCall(IEvmNativeHtlcV3.claim, (terms, secret))
        );
    }
}

contract FxForceNative {
    constructor() payable {}

    function force(address payable recipient) external {
        selfdestruct(recipient);
    }
}
