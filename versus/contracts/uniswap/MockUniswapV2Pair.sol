// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockUniswapV2Pair is ERC20 {
    uint224 private constant Q112 = 2 ** 112;

    address public immutable token0;
    address public immutable token1;

    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;

    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;

    constructor(address _token0, address _token1) ERC20("Mock Uniswap V2 LP", "UNI-V2") {
        token0 = _token0;
        token1 = _token1;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, blockTimestampLast);
    }

    function sync() external {
        _updateReserves(
            IERC20(token0).balanceOf(address(this)),
            IERC20(token1).balanceOf(address(this))
        );
    }

    function mint(address to) external returns (uint256 liquidity) {
        uint256 balance0 = IERC20(token0).balanceOf(address(this));
        uint256 balance1 = IERC20(token1).balanceOf(address(this));
        uint256 amount0 = balance0 - reserve0;
        uint256 amount1 = balance1 - reserve1;

        uint256 supply = totalSupply();
        if (supply == 0) {
            liquidity = _sqrt(amount0 * amount1);
        } else {
            liquidity = _min(
                (amount0 * supply) / reserve0,
                (amount1 * supply) / reserve1
            );
        }

        require(liquidity > 0, "Insufficient liquidity minted");
        _mint(to, liquidity);
        _updateReserves(balance0, balance1);
    }

    function burn(address to) external returns (uint256 amount0, uint256 amount1) {
        uint256 liquidity = balanceOf(address(this));
        uint256 balance0 = IERC20(token0).balanceOf(address(this));
        uint256 balance1 = IERC20(token1).balanceOf(address(this));
        uint256 supply = totalSupply();

        require(liquidity > 0, "No liquidity to burn");

        amount0 = (liquidity * balance0) / supply;
        amount1 = (liquidity * balance1) / supply;

        _burn(address(this), liquidity);

        IERC20(token0).transfer(to, amount0);
        IERC20(token1).transfer(to, amount1);

        _updateReserves(
            IERC20(token0).balanceOf(address(this)),
            IERC20(token1).balanceOf(address(this))
        );
    }

    function swapFromRouter(address tokenIn, address to) external returns (uint256 amountOut) {
        require(tokenIn == token0 || tokenIn == token1, "Invalid tokenIn");

        bool zeroForOne = tokenIn == token0;
        uint256 reserveIn = zeroForOne ? reserve0 : reserve1;
        uint256 reserveOut = zeroForOne ? reserve1 : reserve0;
        address tokenOut = zeroForOne ? token1 : token0;

        uint256 balanceIn = IERC20(tokenIn).balanceOf(address(this));
        uint256 amountIn = balanceIn - reserveIn;
        require(amountIn > 0, "Insufficient input amount");

        uint256 amountInWithFee = amountIn * 997;
        amountOut = (reserveOut * amountInWithFee) / ((reserveIn * 1000) + amountInWithFee);
        require(amountOut > 0, "Insufficient output amount");

        IERC20(tokenOut).transfer(to, amountOut);

        _updateReserves(
            IERC20(token0).balanceOf(address(this)),
            IERC20(token1).balanceOf(address(this))
        );
    }

    function _updateReserves(uint256 balance0, uint256 balance1) internal {
        uint32 blockTimestamp = uint32(block.timestamp);
        uint32 timeElapsed = blockTimestamp - blockTimestampLast;

        if (timeElapsed > 0 && reserve0 > 0 && reserve1 > 0) {
            price0CumulativeLast += uint256(_uqdiv(reserve1, reserve0)) * timeElapsed;
            price1CumulativeLast += uint256(_uqdiv(reserve0, reserve1)) * timeElapsed;
        }

        reserve0 = uint112(balance0);
        reserve1 = uint112(balance1);
        blockTimestampLast = blockTimestamp;
    }

    function _uqdiv(uint112 numerator, uint112 denominator) private pure returns (uint224) {
        return uint224((uint256(numerator) * Q112) / uint256(denominator));
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }

    function _sqrt(uint256 y) private pure returns (uint256 z) {
        if (y == 0) return 0;
        if (y <= 3) return 1;

        z = y;
        uint256 x = (y / 2) + 1;
        while (x < z) {
            z = x;
            x = ((y / x) + x) / 2;
        }
    }
}
