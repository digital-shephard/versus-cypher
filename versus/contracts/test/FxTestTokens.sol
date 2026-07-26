// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract FxDecimalToken is ERC20 {
    uint8 private immutable configuredDecimals;

    constructor(uint8 decimals_) ERC20("FX Test Token", "FXT") {
        configuredDecimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return configuredDecimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract FxFeeOnTransferToken is FxDecimalToken {
    constructor() FxDecimalToken(6) {}

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0xdead), fee);
            super._update(from, to, value - fee);
            return;
        }
        super._update(from, to, value);
    }
}

interface IFxFundingTarget {
    function fund(
        bytes32 lockId,
        address beneficiary,
        address refundAddress,
        bytes32 secretHash,
        uint64 refundTimestamp,
        uint256 amount
    ) external;
}

contract FxCallbackToken is FxDecimalToken {
    address public callbackTarget;
    bool public callbackAttempted;
    bool public callbackSucceeded;

    constructor() FxDecimalToken(6) {}

    function setCallbackTarget(address target) external {
        callbackTarget = target;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (
            from != address(0) &&
            to == callbackTarget &&
            !callbackAttempted
        ) {
            callbackAttempted = true;
            try IFxFundingTarget(callbackTarget).fund(
                keccak256("callback"),
                address(this),
                address(this),
                keccak256("secret"),
                uint64(block.timestamp + 1 hours),
                1
            ) {
                callbackSucceeded = true;
            } catch {}
        }
    }
}
