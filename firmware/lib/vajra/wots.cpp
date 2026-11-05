#include "wots.h"

#include <string.h>

#include "keccak.h"

namespace vajra {
namespace {

void writeU32(uint8_t out[4], uint32_t value) {
  out[0] = value >> 24;
  out[1] = value >> 16;
  out[2] = value >> 8;
  out[3] = value;
}

void chainSeed(const uint8_t seed[32], uint32_t leaf, uint32_t chain, uint8_t out[32]) {
  uint8_t input[40];
  memcpy(input, seed, 32);
  writeU32(input + 32, leaf);
  writeU32(input + 36, chain);
  keccak256(input, sizeof(input), out);
}

void advance(uint8_t value[32], int steps) {
  for (int i = 0; i < steps; ++i) keccak256(value, 32, value);
}

/** Message digits, most significant first, then the checksum's. */
void digits(const uint8_t digest[32], uint8_t out[CHAINS]) {
  uint32_t checksum = 0;
  for (int i = 0; i < LEN1; ++i) {
    uint8_t byte = digest[i / 2];
    uint8_t digit = (i % 2 == 0) ? byte >> 4 : byte & 0x0f;
    checksum += (W - 1) - digit;
    out[i] = digit;
  }
  for (int i = 0; i < LEN2; ++i) out[LEN1 + i] = (checksum >> (LOG_W * (LEN2 - 1 - i))) & (W - 1);
}

}  // namespace

void leafPublicKey(const uint8_t seed[32], uint32_t leaf, uint8_t out[32]) {
  Keccak256 hash;
  for (int chain = 0; chain < CHAINS; ++chain) {
    uint8_t value[32];
    chainSeed(seed, leaf, chain, value);
    advance(value, W - 1);
    hash.update(value, 32);
  }
  hash.finish(out);
}

void wotsSign(const uint8_t seed[32], uint32_t leaf, const uint8_t digest[32], uint8_t signature[SIGNATURE_BYTES]) {
  uint8_t ds[CHAINS];
  digits(digest, ds);
  for (int chain = 0; chain < CHAINS; ++chain) {
    uint8_t* value = signature + chain * 32;
    chainSeed(seed, leaf, chain, value);
    advance(value, ds[chain]);
  }
}

void treeLeaves(const uint8_t seed[32], uint8_t leaves[TREE_LEAVES][32]) {
  for (int leaf = 0; leaf < TREE_LEAVES; ++leaf) leafPublicKey(seed, leaf, leaves[leaf]);
}

namespace {

/** One level up, in place: `nodes[i]` becomes the parent of `nodes[2i]` and `nodes[2i + 1]`. */
void climb(uint8_t nodes[TREE_LEAVES][32], int count) {
  for (int i = 0; i < count / 2; ++i) {
    uint8_t pair[64];
    memcpy(pair, nodes[2 * i], 32);
    memcpy(pair + 32, nodes[2 * i + 1], 32);
    keccak256(pair, 64, nodes[i]);
  }
}

}  // namespace

void treeRoot(const uint8_t leaves[TREE_LEAVES][32], uint8_t root[32]) {
  static uint8_t nodes[TREE_LEAVES][32];
  memcpy(nodes, leaves, sizeof(nodes));
  for (int count = TREE_LEAVES; count > 1; count /= 2) climb(nodes, count);
  memcpy(root, nodes[0], 32);
}

void treePath(const uint8_t leaves[TREE_LEAVES][32], uint32_t leaf, uint8_t path[TREE_DEPTH][32]) {
  static uint8_t nodes[TREE_LEAVES][32];
  memcpy(nodes, leaves, sizeof(nodes));
  uint32_t index = leaf;
  int count = TREE_LEAVES;
  for (int level = 0; level < TREE_DEPTH; ++level) {
    memcpy(path[level], nodes[index ^ 1], 32);
    climb(nodes, count);
    count /= 2;
    index >>= 1;
  }
}

}  // namespace vajra
