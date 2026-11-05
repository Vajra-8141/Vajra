#pragma once

#include <stddef.h>
#include <stdint.h>

namespace vajra {

/** Ethereum's Keccak-256: the original padding, not SHA3-256's. */
class Keccak256 {
 public:
  Keccak256();
  void update(const uint8_t* data, size_t length);
  void finish(uint8_t out[32]);

 private:
  uint64_t state_[25];
  size_t offset_;
};

void keccak256(const uint8_t* data, size_t length, uint8_t out[32]);

/** The hash of exactly 32 bytes, which is one step of a hash chain. `out` may be `in`. */
void keccak256Word(const uint8_t in[32], uint8_t out[32]);

}  // namespace vajra
