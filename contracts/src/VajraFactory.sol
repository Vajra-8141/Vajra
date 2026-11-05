// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VajraAccount} from "./VajraAccount.sol";

/// Deploys accounts as EIP-1167 clones of one implementation.
///
/// A clone costs a small fraction of a full deployment, and a clone is the only way an account can be created inside a
/// `deploy` frame: the mempool rules allow one CREATE there, and the implementation's constructor needs seven.
contract VajraFactory {
    address public immutable implementation;

    event AccountCreated(address indexed account, bytes32 indexed salt);

    constructor(address implementation_) {
        implementation = implementation_;
    }

    /// The address a configuration will live at, whether or not it exists yet.
    function addressOf(VajraAccount.Config calldata config) external view returns (address) {
        return _predict(saltOf(config));
    }

    function saltOf(VajraAccount.Config calldata config) public pure returns (bytes32) {
        return keccak256(abi.encode(config));
    }

    /// Clones and initializes in one step, so nobody can initialize a clone first. Value funds the new account.
    function create(VajraAccount.Config calldata config) external payable returns (address account) {
        bytes32 salt = saltOf(config);
        account = _clone(salt);
        VajraAccount(payable(account)).initialize{value: msg.value}(config);
        emit AccountCreated(account, salt);
    }

    function _clone(bytes32 salt) private returns (address account) {
        bytes memory code = _initCode();
        assembly ("memory-safe") {
            account := create2(0, add(code, 32), mload(code), salt)
        }
        require(account != address(0), "clone failed");
    }

    function _predict(bytes32 salt) private view returns (address) {
        bytes32 hash = keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(_initCode())));
        return address(uint160(uint256(hash)));
    }

    function _initCode() private view returns (bytes memory) {
        return abi.encodePacked(
            hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", implementation, hex"5af43d82803e903d91602b57fd5bf3"
        );
    }
}
