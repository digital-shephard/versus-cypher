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
