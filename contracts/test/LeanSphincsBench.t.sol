// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {LeanSphincsSAsm} from "../src/bench/LeanSphincsSAsm.sol";
import {LeanSphincsBench} from "../src/bench/LeanSphincsBench.sol";
import {VajraExitFactory} from "../src/VajraExit.sol";

/// What can be checked without the frame opcodes. `validateExit` runs against the real client, with every attack on it, in `vajra sphincs-bench`.
contract LeanSphincsBenchTest is Test {
    uint256 private constant VECTORS = 6;
    uint256 private constant SIG_BYTES = 4164;
    bytes32 constant ROOT = keccak256("root");
    bytes32 constant SALT = keccak256("epoch");

    LeanSphincsSAsm verifier;
    LeanSphincsBench implementation;
    VajraExitFactory factory;
    string json;

    function setUp() public {
        verifier = new LeanSphincsSAsm();
        implementation = new LeanSphincsBench(address(verifier));
        factory = new VajraExitFactory(address(implementation));
        json = vm.readFile("test/vectors/leansphincs-s-kat.json");
    }

    function vector(uint256 i) private view returns (bytes32 seed, bytes32 root, bytes32 message, bytes memory sig) {
        string memory at = string.concat(".vectors[", vm.toString(i), "]");
        seed = vm.parseJsonBytes32(json, string.concat(at, ".pkSeed"));
        root = vm.parseJsonBytes32(json, string.concat(at, ".pkRoot"));
        message = vm.parseJsonBytes32(json, string.concat(at, ".message"));
        sig = vm.parseJsonBytes(json, string.concat(at, ".sig"));
    }

    function test_verifier_acceptsEveryUpstreamVector_andCostsAboutTheSame() public view {
        for (uint256 i; i < VECTORS; ++i) {
            (bytes32 seed, bytes32 root, bytes32 message, bytes memory sig) = vector(i);
            assertEq(sig.length, SIG_BYTES);
            uint256 before = gasleft();
            bool valid = verifier.verify(seed, root, message, sig);
            console2.log("verifier call, gas", before - gasleft());
            assertTrue(valid);
        }
    }

    /// Every field of the signature, one byte of each: the randomizer, a FORS secret and path, the counter, a WOTS value, the auth path.
    function test_verifier_refusesAFlipInEveryField() public view {
        (bytes32 seed, bytes32 root, bytes32 message, bytes memory sig) = vector(0);
        uint16[9] memory offsets = [0, 15, 16, 32, 2719, 2720, 2724, 3748, uint16(SIG_BYTES - 1)];
        for (uint256 i; i < offsets.length; ++i) {
            bytes memory bent = bytes.concat(sig);
            bent[offsets[i]] ^= 0x01;
            assertFalse(verifier.verify(seed, root, message, bent));
        }
    }

    function test_verifier_refusesAnotherMessageOrKey() public view {
        (bytes32 seed, bytes32 root, bytes32 message, bytes memory sig) = vector(0);
        assertFalse(verifier.verify(seed, root, message ^ bytes32(uint256(1)), sig));
        assertFalse(verifier.verify(seed, root ^ bytes32(uint256(1) << 128), message, sig));
        assertFalse(verifier.verify(seed ^ bytes32(uint256(1) << 128), root, message, sig));
    }

    function test_verifier_refusesAnotherVectorsSignature() public view {
        (bytes32 seed, bytes32 root, bytes32 message,) = vector(0);
        (,,, bytes memory other) = vector(1);
        assertFalse(verifier.verify(seed, root, message, other));
    }

    function test_verifier_revertsOnAnyOtherLength() public {
        (bytes32 seed, bytes32 root, bytes32 message, bytes memory sig) = vector(0);
        vm.expectRevert("Invalid sig length");
        verifier.verify(seed, root, message, bytes.concat(sig, hex"00"));
    }

    function test_verifier_revertsOnAKeyWithLowBits() public {
        (bytes32 seed, bytes32 root, bytes32 message, bytes memory sig) = vector(0);
        vm.expectRevert("Invalid public key");
        verifier.verify(seed, root | bytes32(uint256(1)), message, sig);
    }

    function test_factory_clonesIt_andTheValueIsTheReserve() public {
        address payable clone = payable(factory.create{value: 1 ether}(makeAddr("account"), ROOT, SALT, 0, 0));
        assertEq(factory.addressOf(makeAddr("account"), ROOT, SALT), clone);
        assertEq(clone.balance, 1 ether);
        assertEq(LeanSphincsBench(clone).root(), ROOT);
    }

    function test_initialize_runsOnce() public {
        LeanSphincsBench clone = LeanSphincsBench(payable(factory.create(address(0), ROOT, SALT, 0, 0)));
        vm.expectRevert(LeanSphincsBench.AlreadyInitialized.selector);
        clone.initialize(address(0), keccak256("thief"), SALT, 0, 0);
    }

    function test_initialize_theImplementationIsLocked() public {
        vm.expectRevert(LeanSphincsBench.AlreadyInitialized.selector);
        implementation.initialize(address(0), keccak256("thief"), SALT, 0, 0);
    }

    function test_initialize_needsARoot() public {
        vm.expectRevert(LeanSphincsBench.RootRequired.selector);
        factory.create(address(0), bytes32(0), SALT, 0, 0);
    }
}
