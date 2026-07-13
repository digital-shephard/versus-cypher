// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

interface IArenaReferralHatch {
    function hatch(uint256 runwayAmount, uint256 referrerAgentId) external returns (uint256 agentId);
}

/// @notice Transfers a freshly minted Cypher to `recipient` inside onERC721Received.
contract ReferralTransferHatcher is IERC721Receiver {
    IERC20 public immutable usdc;
    IArenaReferralHatch public immutable arena;
    IERC721 public immutable agents;
    address public immutable recipient;

    constructor(address usdc_, address arena_, address agents_, address recipient_) {
        usdc = IERC20(usdc_);
        arena = IArenaReferralHatch(arena_);
        agents = IERC721(agents_);
        recipient = recipient_;
    }

    function hatch(uint256 runwayAmount, uint256 referrerAgentId) external returns (uint256 agentId) {
        usdc.approve(address(arena), type(uint256).max);
        return arena.hatch(runwayAmount, referrerAgentId);
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata)
        external
        override
        returns (bytes4)
    {
        agents.transferFrom(address(this), recipient, tokenId);
        return IERC721Receiver.onERC721Received.selector;
    }
}
