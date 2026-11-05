#include "txview.h"

#include <string.h>

namespace vajra {
namespace {

constexpr uint8_t TX_TYPE = 0x06;
constexpr int PAYLOAD_FIELDS = 9;

struct Item {
  bool isList;
  Bytes payload;
};

/** Reads one big-endian length of `count` bytes. Canonical RLP has no leading zero, and uses this form only above 55. */
bool readLength(const uint8_t* data, size_t count, size_t& out) {
  if (count == 0 || count > 4 || data[0] == 0) return false;
  size_t value = 0;
  for (size_t i = 0; i < count; ++i) value = (value << 8) | data[i];
  if (value < 56) return false;
  out = value;
  return true;
}

/** Takes the next item off the front of `cursor`. */
bool next(Bytes& cursor, Item& item) {
  if (cursor.length == 0) return false;
  uint8_t prefix = cursor.data[0];
  size_t header = 1;
  size_t length = 0;
  bool isList = false;

  if (prefix < 0x80) {
    item.isList = false;
    item.payload = {cursor.data, 1};
    cursor.data += 1;
    cursor.length -= 1;
    return true;
  }
  if (prefix <= 0xb7) {
    length = prefix - 0x80;
  } else if (prefix <= 0xbf) {
    size_t count = prefix - 0xb7;
    if (cursor.length < 1 + count || !readLength(cursor.data + 1, count, length)) return false;
    header += count;
  } else if (prefix <= 0xf7) {
    isList = true;
    length = prefix - 0xc0;
  } else {
    isList = true;
    size_t count = prefix - 0xf7;
    if (cursor.length < 1 + count || !readLength(cursor.data + 1, count, length)) return false;
    header += count;
  }

  if (cursor.length < header + length) return false;
  // A single byte below 0x80 has to stand for itself: wrapping it would be a second encoding of the same value.
  if (!isList && prefix == 0x81 && cursor.data[1] < 0x80) return false;

  item.isList = isList;
  item.payload = {cursor.data + header, length};
  cursor.data += header + length;
  cursor.length -= header + length;
  return true;
}

bool nextString(Bytes& cursor, Bytes& out) {
  Item item;
  if (!next(cursor, item) || item.isList) return false;
  out = item.payload;
  return true;
}

bool nextList(Bytes& cursor, Bytes& out) {
  Item item;
  if (!next(cursor, item) || !item.isList) return false;
  out = item.payload;
  return true;
}

/** RLP integers: zero is empty, and there are no leading zeros. */
bool nextUint(Bytes& cursor, uint64_t& out) {
  Bytes value;
  if (!nextString(cursor, value) || value.length > 8) return false;
  if (value.length > 0 && value.data[0] == 0) return false;
  out = 0;
  for (size_t i = 0; i < value.length; ++i) out = (out << 8) | value.data[i];
  return true;
}

bool parseFrame(Bytes body, FrameView& frame) {
  Bytes limits;
  if (!nextUint(body, frame.mode) || !nextUint(body, frame.flags) || !nextString(body, frame.target)) return false;
  if (!nextList(body, limits)) return false;
  if (!nextUint(limits, frame.executionLimit) || !nextUint(limits, frame.stateLimit) || limits.length != 0) return false;
  if (!nextString(body, frame.value) || !nextString(body, frame.data)) return false;
  return body.length == 0;
}

}  // namespace

bool parseTx(const uint8_t* raw, size_t length, TxView& tx) {
  if (length < 2 || raw[0] != TX_TYPE) return false;
  Bytes outer = {raw + 1, length - 1};
  Bytes payload;
  if (!nextList(outer, payload) || outer.length != 0) return false;

  if (!nextUint(payload, tx.chainId)) return false;

  Bytes keys;
  Bytes key;
  if (!nextList(payload, keys) || !nextString(keys, key) || keys.length != 0) return false;
  if (key.length == 0 || key.length > 32 || key.data[0] == 0) return false;
  memset(tx.nonceKey, 0, 32);
  memcpy(tx.nonceKey + 32 - key.length, key.data, key.length);

  if (!nextUint(payload, tx.nonceSeq)) return false;
  if (!nextString(payload, tx.sender) || tx.sender.length != 20) return false;

  Bytes frames;
  if (!nextList(payload, frames)) return false;
  tx.frameCount = 0;
  while (frames.length != 0) {
    Bytes frame;
    if (tx.frameCount == MAX_FRAMES || !nextList(frames, frame)) return false;
    if (!parseFrame(frame, tx.frames[tx.frameCount++])) return false;
  }

  Bytes signatures;
  Bytes entry;
  Bytes field;
  if (!nextList(payload, signatures) || !nextList(signatures, entry) || signatures.length != 0) return false;
  if (!nextUint(entry, tx.signatureScheme)) return false;
  for (int i = 0; i < 3; ++i) {
    if (!nextString(entry, field) || field.length != 0) return false;
  }
  if (entry.length != 0) return false;

  Bytes fees;
  uint64_t priority;
  uint64_t blobFee;
  if (!nextList(payload, fees)) return false;
  if (!nextUint(fees, priority) || !nextUint(fees, tx.maxFeePerGas) || !nextUint(fees, blobFee) || fees.length != 0) return false;
  if (blobFee != 0 || priority > tx.maxFeePerGas) return false;

  Bytes blobs;
  Bytes roots;
  if (!nextList(payload, blobs) || blobs.length != 0) return false;
  if (!nextList(payload, roots) || roots.length != 0) return false;
  return payload.length == 0;
}

}  // namespace vajra
