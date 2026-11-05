// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Winternitz one-time signature verification over keccak256, plus the Merkle step that ties a one-time key to the
/// account's root. Pure functions over memory: no storage, no external calls, nothing that depends on the chain.
///
/// `packages/core/src/wots.ts` is the reference; test/Wots.t.sol checks this library against vectors generated there.
///
/// A signature is `chains` 32-byte values. Value i sits `digit[i]` hash steps along chain i, so hashing it the
/// remaining `w - 1 - digit[i]` steps must land on the chain's top. Hashing all the tops together gives the leaf
/// public key.
library Wots {
    /// Carries every chain to its top and returns the leaf public key the signature implies.
    ///
    /// @param digest The signed 32-byte message.
    /// @param sig Memory pointer to the signature. The chain tops overwrite it in place.
    /// @param logW Bits per digit: 2, 4 or 8.
    /// @param len2 Checksum digits.
    function recoverLeaf(bytes32 digest, uint256 sig, uint256 logW, uint256 len2) internal pure returns (bytes32 leaf) {
        assembly ("memory-safe") {
            let top := sub(shl(logW, 1), 1) // w - 1, the highest digit and the length of a chain
            let len1 := div(256, logW)
            let checksum := 0

            for { let i := 0 } lt(i, len1) { i := add(i, 1) } {
                let digit := and(shr(sub(256, mul(add(i, 1), logW)), digest), top)
                checksum := add(checksum, sub(top, digit))
                let slot := add(sig, shl(5, i))
                mstore(0, mload(slot))
                let steps := sub(top, digit)
                for {} gt(steps, 3) { steps := sub(steps, 4) } {
                    mstore(0, keccak256(0, 32))
                    mstore(0, keccak256(0, 32))
                    mstore(0, keccak256(0, 32))
                    mstore(0, keccak256(0, 32))
                }
                for {} steps { steps := sub(steps, 1) } { mstore(0, keccak256(0, 32)) }
                mstore(slot, mload(0))
            }

            // The checksum's digits, most significant first, each with a chain of its own.
            for { let i := 0 } lt(i, len2) { i := add(i, 1) } {
                let digit := and(shr(mul(sub(sub(len2, i), 1), logW), checksum), top)
                let slot := add(sig, shl(5, add(len1, i)))
                mstore(0, mload(slot))
                let steps := sub(top, digit)
                for {} gt(steps, 3) { steps := sub(steps, 4) } {
                    mstore(0, keccak256(0, 32))
                    mstore(0, keccak256(0, 32))
                    mstore(0, keccak256(0, 32))
                    mstore(0, keccak256(0, 32))
                }
                for {} steps { steps := sub(steps, 1) } { mstore(0, keccak256(0, 32)) }
                mstore(slot, mload(0))
            }

            leaf := keccak256(sig, shl(5, add(len1, len2)))
        }
    }

    /// Walks a Merkle path from a leaf to the root it implies.
    ///
    /// @param leaf The leaf public key.
    /// @param index The leaf's position, which decides the side at each level.
    /// @param path Memory pointer to `depth` sibling hashes, leaf level first.
    /// @param depth Levels in the tree.
    function merkleRoot(bytes32 leaf, uint256 index, uint256 path, uint256 depth) internal pure returns (bytes32 root) {
        assembly ("memory-safe") {
            root := leaf
            for { let i := 0 } lt(i, depth) { i := add(i, 1) } {
                let sibling := mload(add(path, shl(5, i)))
                switch and(index, 1)
                case 0 {
                    mstore(0, root)
                    mstore(32, sibling)
                }
                default {
                    mstore(0, sibling)
                    mstore(32, root)
                }
                root := keccak256(0, 64)
                index := shr(1, index)
            }
        }
    }
}
