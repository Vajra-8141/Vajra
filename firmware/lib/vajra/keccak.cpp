#include "keccak.h"

#include <string.h>

namespace vajra {
namespace {

constexpr size_t RATE = 136;

constexpr uint64_t ROUND_CONSTANTS[24] = {
    0x0000000000000001ULL, 0x0000000000008082ULL, 0x800000000000808aULL, 0x8000000080008000ULL,
    0x000000000000808bULL, 0x0000000080000001ULL, 0x8000000080008081ULL, 0x8000000000008009ULL,
    0x000000000000008aULL, 0x0000000000000088ULL, 0x0000000080008009ULL, 0x000000008000000aULL,
    0x000000008000808bULL, 0x800000000000008bULL, 0x8000000000008089ULL, 0x8000000000008003ULL,
    0x8000000000008002ULL, 0x8000000000000080ULL, 0x000000000000800aULL, 0x800000008000000aULL,
    0x8000000080008081ULL, 0x8000000000008080ULL, 0x0000000080000001ULL, 0x8000000080008008ULL};

constexpr uint8_t ROTATIONS[24] = {1,  3,  6,  10, 15, 21, 28, 36, 45, 55, 2,  14,
                                   27, 41, 56, 8,  25, 43, 62, 18, 39, 61, 20, 44};

constexpr uint8_t LANES[24] = {10, 7,  11, 17, 18, 3, 5,  16, 8,  21, 24, 4,
                               15, 23, 19, 13, 12, 2, 20, 14, 22, 9,  6,  1};

inline uint64_t rotl(uint64_t x, unsigned n) { return (x << n) | (x >> (64 - n)); }

void permute(uint64_t a[25]) {
  for (int round = 0; round < 24; ++round) {
    uint64_t c[5];
    for (int i = 0; i < 5; ++i) c[i] = a[i] ^ a[i + 5] ^ a[i + 10] ^ a[i + 15] ^ a[i + 20];
    for (int i = 0; i < 5; ++i) {
      uint64_t d = c[(i + 4) % 5] ^ rotl(c[(i + 1) % 5], 1);
      for (int j = 0; j < 25; j += 5) a[j + i] ^= d;
    }
    uint64_t carry = a[1];
    for (int i = 0; i < 24; ++i) {
      uint8_t lane = LANES[i];
      uint64_t next = a[lane];
      a[lane] = rotl(carry, ROTATIONS[i]);
      carry = next;
    }
    for (int j = 0; j < 25; j += 5) {
      uint64_t row[5];
      for (int i = 0; i < 5; ++i) row[i] = a[j + i];
      for (int i = 0; i < 5; ++i) a[j + i] = row[i] ^ (~row[(i + 1) % 5] & row[(i + 2) % 5]);
    }
    a[0] ^= ROUND_CONSTANTS[round];
  }
}

inline void absorbByte(uint64_t state[25], size_t index, uint8_t byte) {
  state[index / 8] ^= static_cast<uint64_t>(byte) << (8 * (index % 8));
}

}  // namespace

Keccak256::Keccak256() : offset_(0) { memset(state_, 0, sizeof(state_)); }

void Keccak256::update(const uint8_t* data, size_t length) {
  for (size_t i = 0; i < length; ++i) {
    absorbByte(state_, offset_++, data[i]);
    if (offset_ == RATE) {
      permute(state_);
      offset_ = 0;
    }
  }
}

void Keccak256::finish(uint8_t out[32]) {
  absorbByte(state_, offset_, 0x01);
  absorbByte(state_, RATE - 1, 0x80);
  permute(state_);
  for (size_t i = 0; i < 32; ++i) out[i] = static_cast<uint8_t>(state_[i / 8] >> (8 * (i % 8)));
}

void keccak256(const uint8_t* data, size_t length, uint8_t out[32]) {
  Keccak256 hash;
  hash.update(data, length);
  hash.finish(out);
}

}  // namespace vajra
