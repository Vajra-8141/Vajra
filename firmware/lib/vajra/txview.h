#pragma once

#include <stddef.h>
#include <stdint.h>

/**
 * Reads an unsigned frame transaction, so the device can see what it is signing.
 *
 * This parser decides what the owner is shown, and the node decides what actually runs. If the two ever read the same bytes
 * differently, the screen can lie. So it accepts only canonical RLP, and anything unusual is a refusal, never a best guess.
 */
namespace vajra {

struct Bytes {
  const uint8_t* data;
  size_t length;
};

struct FrameView {
  uint64_t mode;
  uint64_t flags;
  Bytes target;
  uint64_t executionLimit;
  uint64_t stateLimit;
  Bytes value;
  Bytes data;
};

constexpr int MAX_FRAMES = 3;

struct TxView {
  uint64_t chainId;
  /** The single nonce key, left-padded to 32 bytes. */
  uint8_t nonceKey[32];
  uint64_t nonceSeq;
  Bytes sender;
  FrameView frames[MAX_FRAMES];
  int frameCount;
  uint64_t signatureScheme;
  uint64_t maxFeePerGas;
};

/**
 * Parses `0x06 ‖ rlp(payload)`. Fails on anything but the one shape the master key signs: one nonce key, one empty signature
 * entry, at most three frames, no blobs, no recent roots.
 */
bool parseTx(const uint8_t* raw, size_t length, TxView& tx);

}  // namespace vajra
