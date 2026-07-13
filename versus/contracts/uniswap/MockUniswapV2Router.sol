// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./MockUniswapV2Factory.sol";
import "./MockUniswapV2Pair.sol";

contract MockUniswapV2Router {
    address private immutable _factory;
    bool public failQuotes;
    uint256 public lastSwapAmountIn;
    uint256 public lastSwapAmountOutMin;

    constructor(address factory_) {
        _factory = factory_;
    }

    function factory() external view returns (address) {
        return _factory;
    }

    function WETH() external pure returns (address) {
        return address(0);
    }

    function setFailQuotes(bool value) external {
        failQuotes = value;
    }

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        require(block.timestamp <= deadline, "Expired");
        require(amountADesired >= amountAMin && amountBDesired >= amountBMin, "Insufficient desired amount");

        address pair = _pairFor(tokenA, tokenB);
        if (pair == address(0)) {
            pair = MockUniswapV2Factory(_factory).createPair(tokenA, tokenB);
        }

        IERC20(tokenA).transferFrom(msg.sender, pair, amountADesired);
        IERC20(tokenB).transferFrom(msg.sender, pair, amountBDesired);

        liquidity = MockUniswapV2Pair(pair).mint(to);
        amountA = amountADesired;
        amountB = amountBDesired;
    }

    function removeLiquidity(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256,
        uint256,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB) {
        require(block.timestamp <= deadline, "Expired");

        address pair = _pairFor(tokenA, tokenB);
        require(pair != address(0), "Pair missing");

        IERC20(pair).transferFrom(msg.sender, pair, liquidity);
        (uint256 amount0, uint256 amount1) = MockUniswapV2Pair(pair).burn(to);

        (address token0,) = _sortTokens(tokenA, tokenB);
        if (tokenA == token0) {
            amountA = amount0;
            amountB = amount1;
        } else {
            amountA = amount1;
            amountB = amount0;
        }
    }

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external {
        require(block.timestamp <= deadline, "Expired");
        require(path.length == 2, "Only 2-token path");
        lastSwapAmountIn = amountIn;
        lastSwapAmountOutMin = amountOutMin;

        address tokenIn = path[0];
        address tokenOut = path[1];
        address pair = _pairFor(tokenIn, tokenOut);
        require(pair != address(0), "Pair missing");

        uint256 balanceBefore = IERC20(tokenOut).balanceOf(to);
        IERC20(tokenIn).transferFrom(msg.sender, pair, amountIn);
        MockUniswapV2Pair(pair).swapFromRouter(tokenIn, to);
        uint256 amountOut = IERC20(tokenOut).balanceOf(to) - balanceBefore;

        require(amountOut >= amountOutMin, "Insufficient output");
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts) {
        require(!failQuotes, "Quote unavailable");
        require(path.length == 2, "Only 2-token path");

        address pair = _pairFor(path[0], path[1]);
        require(pair != address(0), "Pair missing");

        (uint112 reserve0, uint112 reserve1,) = MockUniswapV2Pair(pair).getReserves();
        (address token0,) = _sortTokens(path[0], path[1]);

        uint256 reserveIn = path[0] == token0 ? reserve0 : reserve1;
        uint256 reserveOut = path[0] == token0 ? reserve1 : reserve0;

        uint256 amountInWithFee = amountIn * 997;
        uint256 amountOut = (reserveOut * amountInWithFee) / ((reserveIn * 1000) + amountInWithFee);

        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountOut;
    }

    function _pairFor(address tokenA, address tokenB) internal view returns (address) {
        return MockUniswapV2Factory(_factory).getPair(tokenA, tokenB);
    }

    function _sortTokens(address tokenA, address tokenB) internal pure returns (address token0, address token1) {
        return tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
    }
}
