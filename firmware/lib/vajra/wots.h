#pragma once

#include <stddef.h>
#include <stdint.h>

/**
 * Winternitz one-time signatures at w=16, and the Merkle tree of one-time keys. Mirrors packages/core/src/wots.ts, and the
 * test suite holds the two to the same bytes.
 */
namespace vajra {

constexpr int LOG_W = 4;
constexpr int W = 16;
constexpr int LEN1 = 64;
constexpr int LEN2 = 3;
constexpr int CHAINS = LEN1 + LEN2;
constexpr int TREE_DEPTH = 6;
constexpr int TREE_LEAVES = 1 << TREE_DEPTH;
/** The last leaf can only install a new tree. */
constexpr int ROTATION_LEAF = TREE_LEAVES - 1;
constexpr size_t SIGNATURE_BYTES = CHAINS * 32;
/** What rides in the transaction: `leaf (1 byte) ‖ signature ‖ Merkle path`. */
constexpr size_t BLOB_BYTES = 1 + SIGNATURE_BYTES + TREE_DEPTH * 32;

void leafPublicKey(const uint8_t seed[32], uint32_t leaf, uint8_t out[32]);
void wotsSign(const uint8_t seed[32], uint32_t leaf, const uint8_t digest[32], uint8_t signature[SIGNATURE_BYTES]);

/** Every leaf's public key, and the root over them. */
void treeLeaves(const uint8_t seed[32], uint8_t leaves[TREE_LEAVES][32]);
void treeRoot(const uint8_t leaves[TREE_LEAVES][32], uint8_t root[32]);
void treePath(const uint8_t leaves[TREE_LEAVES][32], uint32_t leaf, uint8_t path[TREE_DEPTH][32]);

}  // namespace vajra
