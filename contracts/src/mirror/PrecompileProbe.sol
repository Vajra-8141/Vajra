// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport, Devnet, Scope} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";

/// The smallest payer that calls a precompile during validation: an `ecAdd` of two zero points, at `0x06`. It exists to show what
/// docs/upstream/prs/precompiles-calling-040.md says, on the sidecar as deployed and as patched. It moves no funds of anyone's
/// but its own, and nothing else uses it.
contract PrecompileProbe is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    receive() external payable {}

    function pay() external {
        (bool ok,) = address(0x06).staticcall(new bytes(128));
        require(ok);
        approve(Scope.PAYMENT);
    }
}
