// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

interface IArenaHatch {
    function hatch(uint256 runwayAmount) external returns (uint256 agentId);
    function replenishRunway(uint256 agentId, uint256 amount) external;
}

contract ReentrantHatcher is IERC721Receiver {
    IERC20 public immutable usdc;
    IArenaHatch public immutable arena;
    uint256 public reentryAmount;
    bool public reentryBlocked;

    constructor(address usdc_, address arena_) {
        usdc = IERC20(usdc_);
        arena = IArenaHatch(arena_);
    }

    function hatch(uint256 runwayAmount, uint256 replenishAmount) external returns (uint256 agentId) {
        reentryAmount = replenishAmount;
        reentryBlocked = false;
        usdc.approve(address(arena), type(uint256).max);
        return arena.hatch(runwayAmount);
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata)
        external
        override
        returns (bytes4)
    {
        try arena.replenishRunway(tokenId, reentryAmount) {
            reentryBlocked = false;
        } catch {
            reentryBlocked = true;
        }
        return IERC721Receiver.onERC721Received.selector;
    }
}
