#include "device.h"

#include <stdio.h>
#include <string.h>

#include <vector>

#include "keccak.h"
#include "txview.h"

namespace vajra {
namespace {

constexpr uint32_t STATE_MAGIC = 0x56414a31;  // "VAJ1"
constexpr int PROTOCOL_VERSION = 1;
constexpr size_t MAX_TX_BYTES = 2048;
/** A signature is 4,674 hex characters. It goes out in pieces, so a line error costs one short retry, not the signature. */
constexpr size_t PART_BYTES = 128;

constexpr uint64_t FRAME_VERIFY = 1;
constexpr uint64_t FRAME_SENDER = 2;
constexpr uint64_t SCOPE_EXECUTION_AND_PAYMENT = 3;
/** EIP-8141: this frame and the next stand or fall together. */
constexpr uint64_t FLAG_ATOMIC_BATCH = 4;
constexpr uint64_t SCHEME_ARBITRARY = 0;

/** A compromised host could otherwise set a fee that drains the account through gas: 0.02 ETH, in gwei. */
constexpr uint64_t MAX_COST_GWEI = 20000000;
constexpr uint64_t GWEI = 1000000000;
/** Room for intrinsic gas and the data floor, on top of what the frames declare. */
constexpr uint64_t OVERHEAD_GAS = 400000;

std::string toHex(const uint8_t* data, size_t length) {
  static const char digits[] = "0123456789abcdef";
  std::string out;
  out.reserve(length * 2);
  for (size_t i = 0; i < length; ++i) {
    out.push_back(digits[data[i] >> 4]);
    out.push_back(digits[data[i] & 0x0f]);
  }
  return out;
}

int nibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

bool fromHex(const std::string& hex, std::vector<uint8_t>& out) {
  size_t start = hex.rfind("0x", 0) == 0 ? 2 : 0;
  if ((hex.size() - start) % 2 != 0) return false;
  out.resize((hex.size() - start) / 2);
  for (size_t i = 0; i < out.size(); ++i) {
    int high = nibble(hex[start + 2 * i]);
    int low = nibble(hex[start + 2 * i + 1]);
    if (high < 0 || low < 0) return false;
    out[i] = (high << 4) | low;
  }
  return true;
}

bool fixedHex(const std::string& hex, uint8_t* out, size_t length) {
  std::vector<uint8_t> bytes;
  if (!fromHex(hex, bytes) || bytes.size() != length) return false;
  memcpy(out, bytes.data(), length);
  return true;
}

/** `0x1234…abcd`: what fits on a 21-column screen and still identifies an address. */
std::string shortHex(const uint8_t* data, size_t length) {
  return "0x" + toHex(data, 2) + ".." + toHex(data + length - 2, 2);
}

void selectorOf(const char* signature, uint8_t out[4]) {
  uint8_t hash[32];
  keccak256(reinterpret_cast<const uint8_t*>(signature), strlen(signature), hash);
  memcpy(out, hash, 4);
}

bool isSelector(const Bytes& data, const char* signature) {
  uint8_t selector[4];
  selectorOf(signature, selector);
  return data.length >= 4 && memcmp(data.data, selector, 4) == 0;
}

bool isZero(const uint8_t* data, size_t length) {
  for (size_t i = 0; i < length; ++i) {
    if (data[i] != 0) return false;
  }
  return true;
}

/** An ABI word holding an address: twelve zero bytes, then the address. */
bool wordIsAddress(const uint8_t* word) { return isZero(word, 12); }

std::string decimalWord(const uint8_t* word) {
  if (!isZero(word, 24)) return "huge id";
  uint64_t value = 0;
  for (int i = 24; i < 32; ++i) value = (value << 8) | word[i];
  char text[24];
  snprintf(text, sizeof(text), "%llu", static_cast<unsigned long long>(value));
  return text;
}

struct Operation {
  std::string title;
  std::string detail;
  bool rotation;
  const uint8_t* newRoot;
};

/** Names the call, or fails. Each shape is exact: trailing bytes would be data the screen does not show. */
bool decodeOperation(const Bytes& data, Operation& op) {
  op.rotation = false;
  op.newRoot = nullptr;
  const uint8_t* args = data.data + 4;
  size_t size = data.length >= 4 ? data.length - 4 : 0;

  if (isSelector(data, "freeze()") && size == 0) {
    op.title = "FREEZE";
    op.detail = "stop daily key";
    return true;
  }
  if (isSelector(data, "unfreeze()") && size == 0) {
    op.title = "UNFREEZE";
    op.detail = "allow daily key";
    return true;
  }
  if (isSelector(data, "veto(uint256)") && size == 32) {
    op.title = "VETO";
    op.detail = "item " + decimalWord(args);
    return true;
  }
  if (isSelector(data, "setHarbor(bytes32)") && size == 32) {
    op.title = "CHANGE HARBOR";
    op.detail = "new harbor";
    return true;
  }
  if (isSelector(data, "rotateRoot(bytes32)") && size == 32) {
    op.title = "ROTATE KEYS";
    op.detail = "new key tree";
    op.rotation = true;
    op.newRoot = args;
    return true;
  }
  if (isSelector(data, "setDailyKey(address)") && size == 32 && wordIsAddress(args)) {
    op.title = "NEW DAILY KEY";
    op.detail = shortHex(args + 12, 20);
    return true;
  }
  if (isSelector(data, "setRule(address,uint128,uint128)") && size == 96 && wordIsAddress(args)) {
    op.title = "CHANGE LIMIT";
    op.detail = isZero(args + 12, 20) ? "ETH rule" : "tok " + shortHex(args + 12, 20);
    return true;
  }
  if (isSelector(data, "escape(address,bytes32,address[])") && size >= 128 && wordIsAddress(args)) {
    // Head of three words, then the array: its offset has to be 0x60, and nothing may trail it.
    if (!isZero(args + 64, 31) || args[95] != 0x60) return false;
    if (!isZero(args + 96, 24)) return false;
    uint64_t count = 0;
    for (int i = 120; i < 128; ++i) count = (count << 8) | args[i];
    if (count > 16 || size != 128 + count * 32) return false;
    op.title = "ESCAPE";
    op.detail = "to " + shortHex(args + 12, 20);
    return true;
  }
  return false;
}

/** The master path's VERIFY frame, exactly as the client builds it. */
bool isMasterVerify(const FrameView& frame) {
  if (frame.mode != FRAME_VERIFY || frame.flags != SCOPE_EXECUTION_AND_PAYMENT) return false;
  if (frame.target.length != 0 || frame.value.length != 0 || frame.data.length != 36) return false;
  if (!isSelector(frame.data, "validateMaster(uint8)")) return false;
  return isZero(frame.data.data + 4, 31) && frame.data.data[35] == SCOPE_EXECUTION_AND_PAYMENT;
}

/** Only calls the account makes to itself. Anything else would be a call the screen cannot describe. */
bool isSelfCall(const FrameView& frame, const Bytes& sender) {
  if (frame.mode != FRAME_SENDER || frame.flags != 0 || frame.value.length != 0) return false;
  if (frame.target.length == 0) return true;
  return frame.target.length == 20 && memcmp(frame.target.data, sender.data, 20) == 0;
}

/** The first half of a release: the veto, tied to the payment, so that a failed veto cannot pay twice. */
bool isAtomicSelfCall(const FrameView& frame, const Bytes& sender) {
  if (frame.mode != FRAME_SENDER || frame.flags != FLAG_ATOMIC_BATCH || frame.value.length != 0) return false;
  if (frame.target.length == 0) return true;
  return frame.target.length == 20 && memcmp(frame.target.data, sender.data, 20) == 0;
}

/** The second half: plain ETH to someone else. A call with data would do something the screen cannot describe. */
bool isPlainPayment(const FrameView& frame, const Bytes& sender) {
  if (frame.mode != FRAME_SENDER || frame.flags != 0 || frame.data.length != 0) return false;
  if (frame.value.length == 0 || frame.target.length != 20) return false;
  return memcmp(frame.target.data, sender.data, 20) != 0;
}

/**
 * Wei as ETH, exactly, in at most five decimals, so that "PAY x ETH" fits the screen. An amount it cannot show exactly is refused
 * rather than rounded: a rounded number on this screen would be the device lying about what it signs.
 */
bool ethText(const Bytes& value, std::string& out) {
  if (value.length == 0 || value.length > 8) return false;
  uint64_t wei = 0;
  for (size_t i = 0; i < value.length; ++i) wei = (wei << 8) | value.data[i];
  const uint64_t unit = 1000000000000000000ULL;
  const uint64_t step = 10000000000000ULL;
  if (wei % step != 0) return false;
  char text[32];
  uint64_t fraction = (wei % unit) / step;
  snprintf(text, sizeof(text), "%llu.%05llu", static_cast<unsigned long long>(wei / unit), static_cast<unsigned long long>(fraction));
  out = text;
  while (out.back() == '0') out.pop_back();
  if (out.back() == '.') out.pop_back();
  return true;
}

bool feeWithinCap(const TxView& tx) {
  uint64_t gas = OVERHEAD_GAS;
  for (int i = 0; i < tx.frameCount; ++i) {
    if (tx.frames[i].executionLimit > (1ULL << 32) || tx.frames[i].stateLimit > (1ULL << 32)) return false;
    gas += tx.frames[i].executionLimit + tx.frames[i].stateLimit;
  }
  uint64_t gwei = (tx.maxFeePerGas + GWEI - 1) / GWEI;
  if (gwei > 100000) return false;
  return gwei * gas <= MAX_COST_GWEI;
}

void writeBe64(uint8_t out[32], uint64_t value) {
  memset(out, 0, 32);
  for (int i = 0; i < 8; ++i) out[31 - i] = value >> (8 * i);
}

}  // namespace

void Device::treeSeed(uint32_t tree, uint8_t out[32]) {
  static const char tag[] = "vajra-tree";
  uint8_t index[4] = {uint8_t(tree >> 24), uint8_t(tree >> 16), uint8_t(tree >> 8), uint8_t(tree)};
  Keccak256 hash;
  hash.update(state_.master, 32);
  hash.update(reinterpret_cast<const uint8_t*>(tag), sizeof(tag) - 1);
  hash.update(index, 4);
  hash.finish(out);
}

void Device::deriveTree(uint32_t tree, uint8_t leaves[TREE_LEAVES][32], uint8_t root[32]) {
  uint8_t seed[32];
  treeSeed(tree, seed);
  treeLeaves(seed, leaves);
  treeRoot(leaves, root);
}

void Device::idle() {
  char line[32];
  int left = ROTATION_LEAF - static_cast<int>(state_.nextLeaf);
  snprintf(line, sizeof(line), "leaves left: %d", left < 0 ? 0 : left);
  hal_.show("VAJRA", line);
}

void Device::boot() {
  if (!hal_.load(state_) || state_.magic != STATE_MAGIC) {
    memset(&state_, 0, sizeof(state_));
    state_.magic = STATE_MAGIC;
    hal_.show("VAJRA", "new master key");
    hal_.random(state_.master, 32);
    hal_.save(state_);
  }
  hal_.show("VAJRA", "loading keys");
  if (hal_.loadLeaves(state_.tree, leaves_)) {
    treeRoot(leaves_, root_);
  } else {
    deriveTree(state_.tree, leaves_, root_);
    hal_.saveLeaves(state_.tree, leaves_);
  }
  idle();
}

std::string Device::refuse(const char* reason, const char* detail) {
  hal_.show("REFUSED", *detail ? detail : reason);
  return std::string("ERR ") + reason;
}

std::string Device::info() {
  char text[96];
  int left = ROTATION_LEAF - static_cast<int>(state_.nextLeaf);
  snprintf(text, sizeof(text), " tree=%lu next=%lu left=%d chain=%llu", static_cast<unsigned long>(state_.tree),
           static_cast<unsigned long>(state_.nextLeaf), left < 0 ? 0 : left, static_cast<unsigned long long>(state_.chainId));
  std::string out = "OK INFO kind=" + std::string(hal_.kind()) + " version=" + std::to_string(PROTOCOL_VERSION);
  out += std::string(" screen=") + (hal_.hasScreen() ? "yes" : "no");
  out += " root=" + toHex(root_, 32) + text;
  out += " account=" + (state_.paired ? toHex(state_.account, 20) : std::string("none"));
  out += " epoch=" + (state_.paired ? toHex(state_.epochSalt, 32) : std::string("none"));
  return out;
}

std::string Device::pair(const std::string& args) {
  size_t first = args.find(' ');
  size_t second = first == std::string::npos ? first : args.find(' ', first + 1);
  if (second == std::string::npos) return refuse("Malformed");
  uint8_t account[20];
  uint8_t epoch[32];
  if (!fixedHex(args.substr(0, first), account, 20)) return refuse("Malformed");
  if (!fixedHex(args.substr(second + 1), epoch, 32)) return refuse("Malformed");
  std::string chainText = args.substr(first + 1, second - first - 1);
  uint64_t chainId = 0;
  for (char c : chainText) {
    if (c < '0' || c > '9') return refuse("Malformed");
    chainId = chainId * 10 + (c - '0');
  }

  std::string detail = shortHex(account, 20);
  if (!hal_.confirm(state_.paired ? "RE-PAIR ACCOUNT" : "PAIR ACCOUNT", detail.c_str())) {
    idle();
    return "ERR Declined";
  }
  memcpy(state_.account, account, 20);
  memcpy(state_.epochSalt, epoch, 32);
  state_.chainId = chainId;
  state_.paired = 1;
  hal_.save(state_);
  idle();
  return "OK PAIRED";
}

std::string Device::sign(const std::string& hex) {
  if (!state_.paired) return refuse("NotPaired");
  std::vector<uint8_t> raw;
  if (!fromHex(hex, raw) || raw.size() > MAX_TX_BYTES) return refuse("Malformed");
  TxView tx;
  if (!parseTx(raw.data(), raw.size(), tx)) return refuse("Malformed");

  if (tx.chainId != state_.chainId) return refuse("WrongChain");
  if (memcmp(tx.sender.data, state_.account, 20) != 0) return refuse("WrongAccount");
  // Two frames is one operation. Three is a release, and only ever a release: a veto tied to a plain payment.
  const bool release = tx.frameCount == 3;
  if (tx.signatureScheme != SCHEME_ARBITRARY || (tx.frameCount != 2 && !release)) return refuse("BadShape");
  if (!isMasterVerify(tx.frames[0])) return refuse("BadShape");
  if (release ? !(isAtomicSelfCall(tx.frames[1], tx.sender) && isPlainPayment(tx.frames[2], tx.sender)) : !isSelfCall(tx.frames[1], tx.sender)) {
    return refuse("BadShape");
  }
  if (tx.nonceSeq != 0) return refuse("LeafAlreadySpent");
  if (!feeWithinCap(tx)) return refuse("FeeTooHigh");

  Operation op;
  if (!decodeOperation(tx.frames[1].data, op)) return refuse("UnknownOperation");
  if (release) {
    if (op.title != "VETO") return refuse("UnknownOperation");
    std::string amount;
    if (!ethText(tx.frames[2].value, amount)) return refuse("AmountNotShowable");
    op.title = "PAY " + amount + " ETH";
    op.detail = "to " + shortHex(tx.frames[2].target.data, 20);
  }

  int leaf = -1;
  for (int candidate = 0; candidate < TREE_LEAVES && leaf < 0; ++candidate) {
    uint8_t preimage[33];
    uint8_t key[32];
    memcpy(preimage, root_, 32);
    preimage[32] = static_cast<uint8_t>(candidate);
    keccak256(preimage, sizeof(preimage), key);
    if (memcmp(key, tx.nonceKey, 32) == 0) leaf = candidate;
  }
  if (leaf < 0) return refuse("ChainStateUnknown", "not this tree");

  uint8_t sigHash[32];
  keccak256(raw.data(), raw.size(), sigHash);
  uint8_t digest[32];
  {
    uint8_t chain[32];
    writeBe64(chain, tx.chainId);
    Keccak256 hash;
    hash.update(chain, 32);
    hash.update(state_.epochSalt, 32);
    hash.update(state_.account, 20);
    hash.update(tx.nonceKey, 32);
    hash.update(sigHash, 32);
    hash.finish(digest);
  }

  bool revealed = (state_.revealedMask >> leaf) & 1;
  if (revealed && memcmp(state_.revealed[leaf], digest, 32) != 0) {
    char text[32];
    snprintf(text, sizeof(text), "leaf %d revealed", leaf);
    return refuse("LeafAlreadyRevealed", text);
  }

  if (!revealed) {
    if (leaf == ROTATION_LEAF && !op.rotation) return refuse("TreeExhausted", "rotate first");
    if (leaf != ROTATION_LEAF && static_cast<uint32_t>(leaf) != state_.nextLeaf) return refuse("LeafOutOfOrder");
    if (op.rotation) {
      static uint8_t nextLeaves[TREE_LEAVES][32];
      uint8_t nextRootValue[32];
      deriveTree(state_.tree + 1, nextLeaves, nextRootValue);
      if (memcmp(nextRootValue, op.newRoot, 32) != 0) return refuse("RotationRootUnknown", "not my next tree");
    }
    if (!hal_.confirm(op.title.c_str(), op.detail.c_str())) {
      idle();
      return "ERR Declined";
    }
    // Before a single chain value exists. A crash from here on loses a leaf; it can never reveal one twice.
    state_.revealedMask |= 1ULL << leaf;
    memcpy(state_.revealed[leaf], digest, 32);
    if (leaf != ROTATION_LEAF) state_.nextLeaf = leaf + 1;
    hal_.save(state_);
  }

  uint8_t seed[32];
  treeSeed(state_.tree, seed);
  signature_.assign(BLOB_BYTES, 0);
  signature_[0] = static_cast<uint8_t>(leaf);
  wotsSign(seed, leaf, digest, signature_.data() + 1);
  uint8_t path[TREE_DEPTH][32];
  treePath(leaves_, leaf, path);
  memcpy(signature_.data() + 1 + SIGNATURE_BYTES, path, sizeof(path));
  uint8_t hash[32];
  keccak256(signature_.data(), signature_.size(), hash);
  idle();
  return "OK SIGNED " + std::to_string(leaf) + " " + std::to_string(signature_.size()) + " " + toHex(hash, 32);
}

std::string Device::part(const std::string& offsetText) {
  if (signature_.empty()) return "ERR NothingSigned";
  if (offsetText.empty() || offsetText.size() > 6) return "ERR Malformed";
  size_t offset = 0;
  for (char c : offsetText) {
    if (c < '0' || c > '9') return "ERR Malformed";
    offset = offset * 10 + (c - '0');
  }
  if (offset >= signature_.size()) return "ERR Malformed";
  size_t length = signature_.size() - offset < PART_BYTES ? signature_.size() - offset : PART_BYTES;
  return "OK PART " + std::to_string(offset) + " " + toHex(signature_.data() + offset, length);
}

std::string Device::nextRoot() {
  static uint8_t nextLeaves[TREE_LEAVES][32];
  uint8_t root[32];
  hal_.show("VAJRA", "next tree...");
  deriveTree(state_.tree + 1, nextLeaves, root);
  idle();
  return "OK ROOT " + toHex(root, 32);
}

std::string Device::rotated(const std::string& hex) {
  uint8_t claimed[32];
  if (!fixedHex(hex, claimed, 32)) return refuse("Malformed");
  static uint8_t nextLeaves[TREE_LEAVES][32];
  uint8_t root[32];
  deriveTree(state_.tree + 1, nextLeaves, root);
  if (memcmp(root, claimed, 32) != 0) return refuse("RotationRootUnknown", "not my next tree");
  if (!hal_.confirm("SWITCH TREE", "only once mined")) {
    idle();
    return "ERR Declined";
  }
  state_.tree += 1;
  state_.nextLeaf = 0;
  state_.revealedMask = 0;
  memset(state_.revealed, 0, sizeof(state_.revealed));
  hal_.save(state_);
  memcpy(leaves_, nextLeaves, sizeof(leaves_));
  memcpy(root_, root, 32);
  hal_.saveLeaves(state_.tree, leaves_);
  idle();
  return "OK ROTATED";
}

std::string Device::wipe() {
  if (!hal_.confirm("WIPE MASTER KEY", "cannot be undone")) {
    idle();
    return "ERR Declined";
  }
  memset(&state_, 0, sizeof(state_));
  signature_.clear();
  hal_.save(state_);
  boot();
  return "OK WIPED";
}

std::string Device::handle(const std::string& line) {
  size_t space = line.find(' ');
  std::string command = line.substr(0, space);
  std::string rest = space == std::string::npos ? "" : line.substr(space + 1);
  if (command == "INFO") return info();
  if (command == "PAIR") return pair(rest);
  if (command == "SIGN") return sign(rest);
  if (command == "PART") return part(rest);
  if (command == "NEXTROOT") return nextRoot();
  if (command == "ROTATED") return rotated(rest);
  if (command == "WIPE") return wipe();
  if (command == "DIAG") return "OK DIAG " + hal_.diagnostics();
  if (command == "SHOW") {
    hal_.show("host says", rest.c_str());
    return "OK SHOWN";
  }
  return "ERR UnknownCommand";
}

}  // namespace vajra
