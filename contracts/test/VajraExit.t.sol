// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VajraExit, VajraExitFactory} from "../src/VajraExit.sol";

contract StakeSink {
    uint256 public held;

    function addStake(uint32) external payable {
        held += msg.value;
    }
}

/// What can be checked without the frame opcodes. `validateExit` and `validateRecovery` run against the real client in `vajra exit-e2e`.
contract VajraExitTest is Test {
    bytes32 constant ROOT = keccak256("exit tree");
    bytes32 constant SALT = keccak256("epoch");
    address account = makeAddr("account");
    address thief = makeAddr("thief");
    StakeSink registry;
    VajraExit implementation;
    VajraExitFactory factory;
    VajraExit exit;

    function setUp() public {
        registry = new StakeSink();
        implementation = new VajraExit(4, 3, address(registry));
        factory = new VajraExitFactory(address(implementation));
        exit = VajraExit(payable(factory.create{value: 1 ether}(account, ROOT, SALT, 0, 0)));
    }

    function test_factory_predictsTheAddress() public view {
        assertEq(factory.addressOf(account, ROOT, SALT), address(exit));
    }

    function test_factory_theValueIsTheReserve() public view {
        assertEq(address(exit).balance, 1 ether);
    }

    function test_factory_aStakeComesOutOfTheValue() public {
        VajraExit staked = VajraExit(payable(factory.create{value: 1 ether}(account, keccak256("other"), SALT, 0.012 ether, 86_400)));
        assertEq(address(staked).balance, 0.988 ether);
        assertEq(registry.held(), 0.012 ether);
    }

    function test_initialize_runsOnce() public {
        vm.expectRevert(VajraExit.AlreadyInitialized.selector);
        exit.initialize(thief, keccak256("thief"), SALT, 0, 0);
    }

    function test_initialize_theImplementationIsLocked() public {
        vm.expectRevert(VajraExit.AlreadyInitialized.selector);
        implementation.initialize(thief, keccak256("thief"), SALT, 0, 0);
    }

    function test_initialize_needsARoot() public {
        vm.expectRevert(VajraExit.RootRequired.selector);
        factory.create(account, bytes32(0), SALT, 0, 0);
    }

    function test_setRoot_onlyTheAccount() public {
        vm.prank(thief);
        vm.expectRevert(VajraExit.NotAuthorized.selector);
        exit.setRoot(keccak256("thief"));
        vm.prank(account);
        exit.setRoot(keccak256("next tree"));
        assertEq(exit.root(), keccak256("next tree"));
    }

    function test_setRoot_refusesZero() public {
        vm.prank(account);
        vm.expectRevert(VajraExit.RootRequired.selector);
        exit.setRoot(bytes32(0));
    }

    function test_digest_namesThisAddress() public {
        VajraExit other = VajraExit(payable(factory.create(account, keccak256("other"), SALT, 0, 0)));
        assertTrue(exit.exitDigest(1, ROOT) != other.exitDigest(1, ROOT));
    }
}
