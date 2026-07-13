// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ClassToken} from "./ClassToken.sol";

interface IUniswapV2Factory {
    function createPair(address tokenA, address tokenB) external returns (address pair);
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

interface IUniswapV2Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 timestamp);
}

interface IUniswapV2Router02 {
    function factory() external view returns (address);
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts);
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity);

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

interface ISyndicateGraduation {
    function currentClassId() external view returns (uint256);
    function canGraduate(uint256 classId) external view returns (bool);
    function markGraduated(uint256 classId, address token, address pair, uint256 liquidity) external;
    function pullClassFunds(uint256 classId) external returns (uint256 amount);
    function getClass(uint256 classId)
        external
        view
        returns (uint256 totalCommitted, uint32 participantCount, uint32 openedDay, bool graduated);
    function graduationFloor() external view returns (uint256);
}

interface ITrancheTreasuryFees {
    function depositFees(uint256 amount) external;
}

/// @title Versus Graduation Module (ownerless)
/// @notice Anyone can graduate the open class once the floor is met. Sells automatically swap collected tax.
contract GraduationModule is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant DEAD = address(0x000000000000000000000000000000000000dEaD);

    IERC20 public immutable usdc;
    IUniswapV2Router02 public immutable router;
    IUniswapV2Factory public immutable factory;
    ISyndicateGraduation public immutable syndicate;
    ITrancheTreasuryFees public immutable treasury;

    uint256 public constant TOKEN_FOR_LP = 500_000_000 ether;
    uint256 public constant TAX_SWAP_MIN_BPS = 9_900;
    uint256 public constant BPS = 10_000;

    struct Graduation {
        address token;
        address pair;
        uint256 liquidity;
        uint256 usdcSeeded;
        bool active;
    }

    mapping(uint256 => Graduation) public graduations;
    mapping(address => uint256) public classIdForToken;

    event Graduated(
        uint256 indexed classId,
        address token,
        address pair,
        uint256 usdcSeeded,
        uint256 liquidity,
        address indexed caller
    );
    event TaxHarvested(uint256 indexed classId, uint256 tokenTax, uint256 usdcOut, address indexed caller);

    error ZeroAddress();
    error NotReady();
    error AlreadyGraduated();
    error NotClassToken();
    error InvalidCanonicalPair();
    error PairAlreadySeeded();

    constructor(address usdc_, address router_, address syndicate_, address treasury_) {
        if (usdc_ == address(0) || router_ == address(0) || syndicate_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        usdc = IERC20(usdc_);
        router = IUniswapV2Router02(router_);
        factory = IUniswapV2Factory(router.factory());
        syndicate = ISyndicateGraduation(syndicate_);
        treasury = ITrancheTreasuryFees(treasury_);
        usdc.forceApprove(treasury_, type(uint256).max);
    }

    /// @notice Graduate the current open class once floor is hit. Permissionless.
    function graduate() external nonReentrant returns (address token, address pair) {
        uint256 classId = syndicate.currentClassId();
        return _graduate(classId);
    }

    function graduateClass(uint256 classId) external nonReentrant returns (address token, address pair) {
        return _graduate(classId);
    }

    function tokenNameForClass(uint256 classId) public pure returns (string memory) {
        if (classId == 0) revert NotReady();
        return string.concat("Versus Token ", Strings.toString(classId - 1));
    }

    function tokenSymbolForClass(uint256 classId) public pure returns (string memory) {
        if (classId == 0) revert NotReady();
        return string.concat("VRS", Strings.toString(classId - 1));
    }

    function _graduate(uint256 classId) internal returns (address token, address pair) {
        (uint256 totalCommitted, , , bool graduatedFlag) = syndicate.getClass(classId);
        if (graduatedFlag || graduations[classId].active) revert AlreadyGraduated();
        if (!syndicate.canGraduate(classId) || totalCommitted == 0) revert NotReady();

        uint256 usdcAmount = syndicate.pullClassFunds(classId);
        require(usdcAmount == totalCommitted, "amount mismatch");

        ClassToken classToken = new ClassToken(
            tokenNameForClass(classId),
            tokenSymbolForClass(classId),
            address(this),
            address(router),
            address(this)
        );
        token = address(classToken);

        pair = factory.getPair(token, address(usdc));
        if (pair == address(0)) {
            pair = factory.createPair(token, address(usdc));
        } else {
            address token0 = IUniswapV2Pair(pair).token0();
            address token1 = IUniswapV2Pair(pair).token1();
            if (!((token0 == token && token1 == address(usdc)) || (token1 == token && token0 == address(usdc)))) {
                revert InvalidCanonicalPair();
            }
            (uint112 reserve0, uint112 reserve1,) = IUniswapV2Pair(pair).getReserves();
            if (reserve0 != 0 || reserve1 != 0) revert PairAlreadySeeded();
        }
        classToken.configure(pair);

        IERC20(token).forceApprove(address(router), TOKEN_FOR_LP);
        usdc.forceApprove(address(router), usdcAmount);

        (, , uint256 liquidity) = router.addLiquidity(
            token,
            address(usdc),
            TOKEN_FOR_LP,
            usdcAmount,
            TOKEN_FOR_LP,
            usdcAmount,
            address(this),
            block.timestamp + 600
        );

        uint256 leftover = classToken.balanceOf(address(this));
        if (leftover > 0) {
            IERC20(token).safeTransfer(DEAD, leftover);
        }

        classToken.enableTrading();

        graduations[classId] = Graduation({
            token: token,
            pair: pair,
            liquidity: liquidity,
            usdcSeeded: usdcAmount,
            active: true
        });
        classIdForToken[token] = classId;
        IERC20(token).forceApprove(address(router), type(uint256).max);

        syndicate.markGraduated(classId, token, pair, liquidity);
        emit Graduated(classId, token, pair, usdcAmount, liquidity, msg.sender);
    }

    /// @notice Called synchronously by a class token after collecting sell tax.
    /// @dev maxTokenAmount is tied to the current sell, preventing a full-bank dump.
    function swapCollectedTax(uint256 maxTokenAmount) external nonReentrant returns (uint256 usdcOut) {
        uint256 classId = classIdForToken[msg.sender];
        if (classId == 0 || graduations[classId].token != msg.sender) revert NotClassToken();
        if (maxTokenAmount == 0) return 0;

        uint256 taxBal = IERC20(msg.sender).balanceOf(address(this));
        if (taxBal == 0) return 0;
        uint256 tokenAmount = taxBal < maxTokenAmount ? taxBal : maxTokenAmount;

        address[] memory path = new address[](2);
        path[0] = msg.sender;
        path[1] = address(usdc);
        uint256[] memory quoted = router.getAmountsOut(tokenAmount, path);
        uint256 quotedOut = quoted[quoted.length - 1];
        if (quotedOut == 0) return 0;
        uint256 amountOutMin = (quotedOut * TAX_SWAP_MIN_BPS) / BPS;
        if (amountOutMin == 0) amountOutMin = 1;

        uint256 beforeBal = usdc.balanceOf(address(this));
        router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
            tokenAmount, amountOutMin, path, address(this), block.timestamp + 600
        );
        usdcOut = usdc.balanceOf(address(this)) - beforeBal;
        require(usdcOut > 0, "zero out");

        treasury.depositFees(usdcOut);
        emit TaxHarvested(classId, tokenAmount, usdcOut, msg.sender);
    }

    function getGraduation(uint256 classId)
        external
        view
        returns (address token, address pair, uint256 liquidity, uint256 usdcSeeded, bool active)
    {
        Graduation memory g = graduations[classId];
        return (g.token, g.pair, g.liquidity, g.usdcSeeded, g.active);
    }
}
