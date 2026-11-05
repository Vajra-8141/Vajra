// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {Wots} from "../src/Wots.sol";

/// Checks the verifier against signatures produced by the TypeScript reference (packages/core/scripts/gen-vectors.ts).
contract WotsTest is Test {
    uint256 private constant DEPTH = 6;
    string private json;

    function setUp() public {
        json = vm.readFile("test/vectors/wots.json");
    }

    struct Vector {
        uint256 logW;
        uint256 len2;
        uint256 leaf;
        bytes32 digest;
        bytes signature;
        bytes path;
        bytes32 leafKey;
        bytes32 root;
        uint256 hashes;
    }

    function load(string memory name) private view returns (Vector memory v) {
        string memory p = string.concat(".", name, ".");
        v.logW = vm.parseJsonUint(json, string.concat(p, "logW"));
        v.len2 = vm.parseJsonUint(json, string.concat(p, "len2"));
        v.leaf = vm.parseJsonUint(json, string.concat(p, "leaf"));
        v.digest = vm.parseJsonBytes32(json, string.concat(p, "digest"));
        v.signature = vm.parseJsonBytes(json, string.concat(p, "signature"));
        v.path = vm.parseJsonBytes(json, string.concat(p, "path"));
        v.leafKey = vm.parseJsonBytes32(json, string.concat(p, "leafKey"));
        v.root = vm.parseJsonBytes32(json, string.concat(p, "root"));
        v.hashes = vm.parseJsonUint(json, string.concat(p, "hashes"));
    }

    function recover(Vector memory v) private pure returns (bytes32 leaf, bytes32 root) {
        bytes memory sig = v.signature;
        bytes memory path = v.path;
        uint256 sigPtr;
        uint256 pathPtr;
        assembly ("memory-safe") {
            sigPtr := add(sig, 32)
            pathPtr := add(path, 32)
        }
        leaf = Wots.recoverLeaf(v.digest, sigPtr, v.logW, v.len2);
        root = Wots.merkleRoot(leaf, v.leaf, pathPtr, DEPTH);
    }

    function check(string memory name) private {
        Vector memory v = load(name);
        uint256 before = gasleft();
        (bytes32 leaf, bytes32 root) = recover(v);
        uint256 used = before - gasleft();
        assertEq(leaf, v.leafKey, "leaf key");
        assertEq(root, v.root, "root");
        console2.log(name, "verify gas", used);
        console2.log("  hashes", v.hashes, "signature bytes", v.signature.length);
    }

    function test_vector_w4() public { check("w4"); }
    function test_vector_w16() public { check("w16"); }
    function test_vector_w256() public { check("w256"); }
    function test_vector_lastLeaf() public { check("w16last"); }

    function test_flippedSignatureBitFails() public {
        Vector memory v = load("w16");
        v.signature[100] = bytes1(uint8(v.signature[100]) ^ 1);
        (, bytes32 root) = recover(v);
        assertTrue(root != v.root);
    }

    function test_otherDigestFails() public {
        Vector memory v = load("w16");
        v.digest = keccak256(abi.encode(v.digest));
        (, bytes32 root) = recover(v);
        assertTrue(root != v.root);
    }

    function test_wrongIndexFails() public {
        Vector memory v = load("w16");
        v.leaf = v.leaf ^ 1;
        (, bytes32 root) = recover(v);
        assertTrue(root != v.root);
    }

    function test_flippedPathBitFails() public {
        Vector memory v = load("w16");
        v.path[33] = bytes1(uint8(v.path[33]) ^ 1);
        (, bytes32 root) = recover(v);
        assertTrue(root != v.root);
    }

    /// Replaying a signature against a message whose digit is one higher is the classic Winternitz forgery; the
    /// checksum has to break it. Exercised by moving the first message digit up and hashing that chain value forward.
    function test_forgeryByHashingForwardFails() public {
        Vector memory v = load("w16");
        uint8 first = uint8(v.digest[0]);
        vm.assume(first >> 4 < 15);
        bytes32 chain0;
        bytes memory sig = v.signature;
        assembly ("memory-safe") {
            chain0 := mload(add(sig, 32))
        }
        bytes32 forward = keccak256(abi.encode(chain0));
        assembly ("memory-safe") {
            mstore(add(sig, 32), forward)
        }
        v.digest = bytes32(uint256(v.digest) + (uint256(1) << 252));
        (, bytes32 root) = recover(v);
        assertTrue(root != v.root);
    }
}
