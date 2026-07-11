// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IClassTaxCollector {
    function swapCollectedTax() external returns (uint256 usdcOut);
}

/// @title Versus Class Token (ownerless after launch)
/// @notice Fixed 1% buy/sell tax. Launcher configures pair once, then no admin forever.
contract ClassToken is ERC20 {
    uint256 public constant TAX_BPS = 100;
    uint256 public constant BPS = 10_000;

    address public immutable taxCollector;
    address public immutable router;
    address public immutable launcher;

    address public pair;
    bool public configured;
    bool public tradingEnabled;

    event Configured(address pair);
    event TradingEnabled();
    event TaxTaken(address indexed from, uint256 amount);
    event TaxSwapTriggered(uint256 tokenTax, uint256 usdcOut);

    error TradingOff();
    error ZeroAddress();
    error NotLauncher();
    error AlreadyConfigured();

    constructor(
        string memory name_,
        string memory symbol_,
        address taxCollector_,
        address router_,
        address launcher_
    ) ERC20(name_, symbol_) {
        if (taxCollector_ == address(0) || router_ == address(0) || launcher_ == address(0)) {
            revert ZeroAddress();
        }
        taxCollector = taxCollector_;
        router = router_;
        launcher = launcher_;
        _mint(launcher_, 1_000_000_000 ether);
    }

    /// @notice One-shot: set Uniswap pair. No further configuration possible.
    function configure(address pair_) external {
        if (msg.sender != launcher) revert NotLauncher();
        if (configured) revert AlreadyConfigured();
        if (pair_ == address(0)) revert ZeroAddress();
        pair = pair_;
        configured = true;
        emit Configured(pair_);
    }

    /// @notice One-shot trading enable after LP seed (launcher only).
    function enableTrading() external {
        if (msg.sender != launcher) revert NotLauncher();
        if (!configured) revert ZeroAddress();
        tradingEnabled = true;
        emit TradingEnabled();
    }

    function _isExcluded(address account) internal view returns (bool) {
        return account == taxCollector || account == router || account == launcher || account == address(this);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }

        if (!tradingEnabled && !_isExcluded(from) && !_isExcluded(to)) revert TradingOff();

        bool takeTax = tradingEnabled && configured && !_isExcluded(from) && !_isExcluded(to);
        bool isBuy = from == pair;
        bool isSell = to == pair;

        if (takeTax && (isBuy || isSell)) {
            uint256 tax = (value * TAX_BPS) / BPS;
            uint256 send = value - tax;
            if (tax > 0) {
                super._update(from, taxCollector, tax);
                emit TaxTaken(from, tax);
                if (isSell) {
                    uint256 usdcOut = IClassTaxCollector(taxCollector).swapCollectedTax();
                    emit TaxSwapTriggered(tax, usdcOut);
                }
            }
            super._update(from, to, send);
            return;
        }

        super._update(from, to, value);
    }
}
