#include "keccak.h"

#include <string.h>

// The hash chains are nearly all of the device's work: a key tree is about 64,000 of these. On a 32-bit core, a loop with
// variable 64-bit rotations spends most of its time in library calls, so the round is unrolled and every rotation is a
// compile-time constant. This took deriving a tree from 86 seconds to a few.
#pragma GCC optimize("O3")

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

#define ROTL(x, n) (((x) << (n)) | ((x) >> (64 - (n))))

void permute(uint64_t a[25]) {
  uint64_t b[25];
  for (int round = 0; round < 24; ++round) {
    // Theta
    uint64_t c0 = a[0] ^ a[5] ^ a[10] ^ a[15] ^ a[20];
    uint64_t c1 = a[1] ^ a[6] ^ a[11] ^ a[16] ^ a[21];
    uint64_t c2 = a[2] ^ a[7] ^ a[12] ^ a[17] ^ a[22];
    uint64_t c3 = a[3] ^ a[8] ^ a[13] ^ a[18] ^ a[23];
    uint64_t c4 = a[4] ^ a[9] ^ a[14] ^ a[19] ^ a[24];
    uint64_t d0 = c4 ^ ROTL(c1, 1);
    uint64_t d1 = c0 ^ ROTL(c2, 1);
    uint64_t d2 = c1 ^ ROTL(c3, 1);
    uint64_t d3 = c2 ^ ROTL(c4, 1);
    uint64_t d4 = c3 ^ ROTL(c0, 1);
    // Rho and pi
    b[0] = a[0] ^ d0;
    b[1] = ROTL(a[6] ^ d1, 44);
    b[2] = ROTL(a[12] ^ d2, 43);
    b[3] = ROTL(a[18] ^ d3, 21);
    b[4] = ROTL(a[24] ^ d4, 14);
    b[5] = ROTL(a[3] ^ d3, 28);
    b[6] = ROTL(a[9] ^ d4, 20);
    b[7] = ROTL(a[10] ^ d0, 3);
    b[8] = ROTL(a[16] ^ d1, 45);
    b[9] = ROTL(a[22] ^ d2, 61);
    b[10] = ROTL(a[1] ^ d1, 1);
    b[11] = ROTL(a[7] ^ d2, 6);
    b[12] = ROTL(a[13] ^ d3, 25);
    b[13] = ROTL(a[19] ^ d4, 8);
    b[14] = ROTL(a[20] ^ d0, 18);
    b[15] = ROTL(a[4] ^ d4, 27);
    b[16] = ROTL(a[5] ^ d0, 36);
    b[17] = ROTL(a[11] ^ d1, 10);
    b[18] = ROTL(a[17] ^ d2, 15);
    b[19] = ROTL(a[23] ^ d3, 56);
    b[20] = ROTL(a[2] ^ d2, 62);
    b[21] = ROTL(a[8] ^ d3, 55);
    b[22] = ROTL(a[14] ^ d4, 39);
    b[23] = ROTL(a[15] ^ d0, 41);
    b[24] = ROTL(a[21] ^ d1, 2);
    // Chi
    for (int j = 0; j < 25; j += 5) {
      uint64_t b0 = b[j], b1 = b[j + 1], b2 = b[j + 2], b3 = b[j + 3], b4 = b[j + 4];
      a[j] = b0 ^ (~b1 & b2);
      a[j + 1] = b1 ^ (~b2 & b3);
      a[j + 2] = b2 ^ (~b3 & b4);
      a[j + 3] = b3 ^ (~b4 & b0);
      a[j + 4] = b4 ^ (~b0 & b1);
    }
    // Iota
    a[0] ^= ROUND_CONSTANTS[round];
  }
}

#undef ROTL

inline void absorbByte(uint64_t state[25], size_t index, uint8_t byte) {
  state[index / 8] ^= static_cast<uint64_t>(byte) << (8 * (index % 8));
}

inline uint64_t loadLane(const uint8_t* p) {
  uint64_t lane = 0;
  for (int i = 7; i >= 0; --i) lane = (lane << 8) | p[i];
  return lane;
}

inline void storeLane(uint8_t* p, uint64_t lane) {
  for (int i = 0; i < 8; ++i) p[i] = static_cast<uint8_t>(lane >> (8 * i));
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
  for (int i = 0; i < 4; ++i) storeLane(out + 8 * i, state_[i]);
}

void keccak256(const uint8_t* data, size_t length, uint8_t out[32]) {
  Keccak256 hash;
  hash.update(data, length);
  hash.finish(out);
}

void keccak256Word(const uint8_t in[32], uint8_t out[32]) {
  uint64_t state[25] = {0};
  for (int i = 0; i < 4; ++i) state[i] = loadLane(in + 8 * i);
  state[4] = 0x01;
  state[16] = 0x8000000000000000ULL;
  permute(state);
  for (int i = 0; i < 4; ++i) storeLane(out + 8 * i, state[i]);
}

}  // namespace vajra
