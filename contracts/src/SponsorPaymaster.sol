// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport, Devnet, Scope, TxParam} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";

/// Pays gas for VAJRA accounts, so a stealth address holding only tokens can spend without ever holding ETH.
///
/// It sponsors any clone of one implementation, identified by code hash. That is the whole policy, which is fine for a
/// devnet and nowhere near enough for production: anyone can deploy a clone, so anyone can spend this contract's balance
/// on gas. A real one takes its fee out of the token transfer it sponsors, which needs state, and so a `pre_verify`
/// frame and a stake.
contract SponsorPaymaster is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    bytes32 public immutable SPONSORED_CODEHASH;

    error NotSponsored(address sender);

    constructor(bytes32 sponsoredCodehash) payable {
        SPONSORED_CODEHASH = sponsoredCodehash;
    }

    receive() external payable {}

    /// The `pay` frame.
    function sponsor() external {
        address sender = address(uint160(txparam(TxParam.SENDER)));
        if (sender.codehash != SPONSORED_CODEHASH) revert NotSponsored(sender);
        approve(Scope.PAYMENT);
    }
}
