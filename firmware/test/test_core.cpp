// The device logic against vectors from the TypeScript implementation, which the live chain accepts.
#include <stdio.h>
#include <string.h>

#include <stdexcept>
#include <string>
#include <vector>

#include "device.h"
#include "keccak.h"
#include "txview.h"
#include "vectors.h"
#include "wots.h"

using namespace vajra;

static int failures = 0;
static int checks = 0;

#define CHECK(condition, what)                                  \
  do {                                                          \
    ++checks;                                                   \
    if (!(condition)) {                                         \
      ++failures;                                               \
      printf("FAIL %s:%d %s\n", __FILE__, __LINE__, what);      \
    }                                                           \
  } while (0)

static std::vector<uint8_t> bytes(const std::string& hex) {
  std::vector<uint8_t> out(hex.size() / 2);
  for (size_t i = 0; i < out.size(); ++i) out[i] = std::stoi(hex.substr(2 * i, 2), nullptr, 16);
  return out;
}

static std::string hexOf(const uint8_t* data, size_t length) {
  std::string out;
  char pair[3];
  for (size_t i = 0; i < length; ++i) {
    snprintf(pair, sizeof(pair), "%02x", data[i]);
    out += pair;
  }
  return out;
}

class FakeHal : public Hal {
 public:
  State stored;
  bool hasState = false;
  bool approve = true;
  bool failSave = false;
  int confirms = 0;
  int saves = 0;
  std::string lastTitle;
  std::string lastDetail;

  bool load(State& state) override {
    if (hasState) state = stored;
    return hasState;
  }
  void save(const State& state) override {
    if (failSave) throw std::runtime_error("power lost");
    stored = state;
    hasState = true;
    ++saves;
  }
  void random(uint8_t* out, size_t length) override {
    std::vector<uint8_t> master = bytes(V_MASTER);
    memcpy(out, master.data(), length);
  }
  bool confirm(const char* title, const char* detail) override {
    ++confirms;
    lastTitle = title;
    lastDetail = detail;
    return approve;
  }
  void show(const char*, const char*) override {}
  const char* kind() const override { return "test"; }
};

struct Rig {
  FakeHal hal;
  Device device{hal};
  Rig(bool paired = true) {
    device.boot();
    if (paired) device.handle(std::string("PAIR ") + V_ACCOUNT + " 1337 " + V_EPOCH);
    hal.confirms = 0;
  }
  std::string sign(const char* tx) { return device.handle(std::string("SIGN ") + tx); }
};

static bool signedOk(const std::string& reply) { return reply.rfind("OK SIG ", 0) == 0; }

static void testKeccak() {
  uint8_t out[32];
  keccak256(nullptr, 0, out);
  CHECK(hexOf(out, 32) == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470", "keccak of nothing");
  keccak256(reinterpret_cast<const uint8_t*>("abc"), 3, out);
  CHECK(hexOf(out, 32) == "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45", "keccak of abc");
  std::vector<uint8_t> long_input(500, 0x61);
  uint8_t whole[32];
  keccak256(long_input.data(), long_input.size(), whole);
  Keccak256 parts;
  parts.update(long_input.data(), 135);
  parts.update(long_input.data() + 135, 2);
  parts.update(long_input.data() + 137, 363);
  parts.finish(out);
  CHECK(memcmp(out, whole, 32) == 0, "keccak across the rate boundary");
}

static void testWordHash() {
  uint8_t word[32];
  for (int i = 0; i < 32; ++i) word[i] = static_cast<uint8_t>(i * 7 + 1);
  uint8_t general[32];
  uint8_t fast[32];
  keccak256(word, 32, general);
  keccak256Word(word, fast);
  CHECK(memcmp(general, fast, 32) == 0, "the chain step equals keccak of 32 bytes");
  keccak256Word(word, word);
  CHECK(memcmp(general, word, 32) == 0, "and works in place");
}

static void testCachedLeaves() {
  class CachingHal : public FakeHal {
   public:
    uint8_t cached[TREE_LEAVES][32];
    uint32_t cachedTree = 0;
    bool hasCache = false;
    int derivations = 0;
    bool loadLeaves(uint32_t tree, uint8_t leaves[TREE_LEAVES][32]) override {
      if (!hasCache || tree != cachedTree) return false;
      memcpy(leaves, cached, sizeof(cached));
      return true;
    }
    void saveLeaves(uint32_t tree, const uint8_t leaves[TREE_LEAVES][32]) override {
      memcpy(cached, leaves, sizeof(cached));
      cachedTree = tree;
      hasCache = true;
      ++derivations;
    }
  };
  CachingHal hal;
  static Device first(hal);
  first.boot();
  CHECK(hal.derivations == 1, "the first boot derives the tree");
  static Device second(hal);
  second.boot();
  CHECK(hal.derivations == 1, "a later boot reads it back");
  CHECK(second.handle("INFO").find(std::string("root=") + V_ROOT) != std::string::npos, "and gets the same root");
  second.handle(std::string("PAIR ") + V_ACCOUNT + " 1337 " + V_EPOCH);
  CHECK(second.handle(std::string("SIGN ") + V_TX_FREEZE) == std::string("OK SIG ") + V_BLOB_FREEZE, "and the same signature");
}

static void testParser() {
  std::vector<uint8_t> raw = bytes(V_TX_FREEZE);
  TxView tx;
  CHECK(parseTx(raw.data(), raw.size(), tx), "parses a real transaction");
  CHECK(tx.chainId == 1337, "chain id");
  CHECK(tx.frameCount == 2, "two frames");
  CHECK(tx.frames[0].mode == 1 && tx.frames[0].flags == 3, "verify frame");
  CHECK(tx.frames[1].mode == 2, "sender frame");
  CHECK(tx.frames[0].executionLimit == 99900, "verify limit");
  uint8_t hash[32];
  keccak256(raw.data(), raw.size(), hash);
  CHECK(hexOf(hash, 32) == V_SIGHASH_FREEZE, "the hash of the raw bytes is the signature hash");

  std::vector<uint8_t> bad = raw;
  bad.push_back(0x00);
  CHECK(!parseTx(bad.data(), bad.size(), tx), "refuses trailing bytes");
  bad = raw;
  bad[0] = 0x02;
  CHECK(!parseTx(bad.data(), bad.size(), tx), "refuses another transaction type");
  CHECK(!parseTx(raw.data(), raw.size() - 1, tx), "refuses a truncated transaction");
  for (size_t cut = 1; cut < raw.size(); ++cut) {
    bool parsed = parseTx(raw.data(), cut, tx);
    if (parsed) CHECK(false, "a truncated prefix parsed");
  }

  // A single byte below 0x80 wrapped in a string header is a second encoding of the same value.
  const uint8_t wrapped[] = {0x06, 0xc2, 0x81, 0x05};
  CHECK(!parseTx(wrapped, sizeof(wrapped), tx), "refuses a wrapped single byte");
  // A long-form length for something short is a second encoding too.
  const uint8_t longForm[] = {0x06, 0xf8, 0x01, 0x80};
  CHECK(!parseTx(longForm, sizeof(longForm), tx), "refuses a non-minimal length");
  const uint8_t leadingZero[] = {0x06, 0xb9, 0x00, 0x38};
  CHECK(!parseTx(leadingZero, sizeof(leadingZero), tx), "refuses a leading zero in a length");
}

static void testByteIdenticalToTheChainsImplementation() {
  Rig rig;
  std::string info = rig.device.handle("INFO");
  CHECK(info.find(std::string("root=") + V_ROOT) != std::string::npos, "the root matches TypeScript");
  CHECK(info.find("next=0") != std::string::npos, "starts at leaf 0");

  std::string reply = rig.sign(V_TX_FREEZE);
  CHECK(reply == std::string("OK SIG ") + V_BLOB_FREEZE, "the signature is byte-identical to TypeScript");
  CHECK(rig.hal.lastTitle == "FREEZE", "the screen showed the operation");

  reply = rig.sign(V_TX_VETO_LEAF1);
  CHECK(reply == std::string("OK SIG ") + V_BLOB_VETO_LEAF1, "the next leaf matches too");
  CHECK(rig.hal.lastTitle == "VETO" && rig.hal.lastDetail == "queued item 7", "the screen named the item");
}

static void testTheScreenShowsWhatIsSigned() {
  struct Case {
    const char* tx;
    const char* title;
    const char* detail;
  } cases[] = {
      {V_TX_ESCAPE_LEAF1, "ESCAPE", "to 0x2222..2222"},
      {V_TX_ESCAPE_EXTRA_LEAF1, "ESCAPE", "to 0x2222..2222"},
      {V_TX_DAILY_KEY_LEAF1, "NEW DAILY KEY", "0x2222..2222"},
      {V_TX_RULE_LEAF1, "CHANGE LIMIT", "ETH rule"},
      {V_TX_ROTATE_LEAF1, "ROTATE KEYS", "install a new tree"},
  };
  for (const Case& c : cases) {
    Rig rig;
    rig.sign(V_TX_FREEZE);
    CHECK(signedOk(rig.sign(c.tx)), c.title);
    CHECK(rig.hal.lastTitle == c.title, "title");
    CHECK(rig.hal.lastDetail == c.detail, "detail");
  }
}

static void testRefusals() {
  struct Case {
    const char* tx;
    const char* expected;
  } cases[] = {
      {V_TX_WRONG_ACCOUNT, "ERR WrongAccount"},
      {V_TX_WRONG_CHAIN, "ERR WrongChain"},
      {V_TX_UNKNOWN_OP, "ERR UnknownOperation"},
      {V_TX_TRAILING_DATA, "ERR UnknownOperation"},
      {V_TX_EXTERNAL_TARGET, "ERR BadShape"},
      {V_TX_WITH_VALUE, "ERR BadShape"},
      {V_TX_DAILY_VERIFY, "ERR BadShape"},
      {V_TX_HIGH_FEE, "ERR FeeTooHigh"},
      {V_TX_NEXT_SEQUENCE, "ERR LeafAlreadySpent"},
      {V_TX_FOREIGN_TREE, "ERR ChainStateUnknown"},
      {V_TX_THREE_FRAMES, "ERR Malformed"},
      {V_TX_SIGNED_ENTRY, "ERR Malformed"},
      {V_TX_LEAF2, "ERR LeafOutOfOrder"},
      {V_TX_FREEZE_ROTATION_LEAF, "ERR TreeExhausted"},
      {"zz", "ERR Malformed"},
  };
  for (const Case& c : cases) {
    Rig rig;
    std::string reply = rig.sign(c.tx);
    CHECK(reply == c.expected, (std::string(c.expected) + " got " + reply.substr(0, 40)).c_str());
    CHECK(rig.hal.confirms == 0, "a refused transaction never reaches the screen");
    CHECK(rig.device.handle("INFO").find("next=0") != std::string::npos, "and burns no leaf");
  }
}

static void testOneTimeDiscipline() {
  Rig rig;
  std::string first = rig.sign(V_TX_FREEZE);
  CHECK(signedOk(first), "the first signature");

  CHECK(rig.sign(V_TX_UNFREEZE_LEAF0) == "ERR LeafAlreadyRevealed", "a second digest on a revealed leaf");

  int confirms = rig.hal.confirms;
  CHECK(rig.sign(V_TX_FREEZE) == first, "the same digest repeats the same signature, for a rebroadcast");
  CHECK(rig.hal.confirms == confirms, "and reveals nothing new, so it needs no press");
}

static void testDecliningCostsNothing() {
  Rig rig;
  rig.hal.approve = false;
  CHECK(rig.sign(V_TX_FREEZE) == "ERR Declined", "an unconfirmed transaction is not signed");
  CHECK(!(rig.hal.stored.revealedMask & 1), "and no leaf was burned");
  rig.hal.approve = true;
  CHECK(rig.sign(V_TX_UNFREEZE_LEAF0).rfind("OK SIG ", 0) == 0, "so the leaf can sign something else");
}

static void testWriteAhead() {
  Rig rig;
  rig.hal.failSave = true;
  bool released = false;
  try {
    released = signedOk(rig.sign(V_TX_FREEZE));
  } catch (const std::exception&) {
  }
  CHECK(!released, "if the leaf cannot be recorded, no signature leaves");
}

static void testSurvivesARestart() {
  FakeHal hal;
  {
    static Device first(hal);
    first.boot();
    first.handle(std::string("PAIR ") + V_ACCOUNT + " 1337 " + V_EPOCH);
    CHECK(signedOk(first.handle(std::string("SIGN ") + V_TX_FREEZE)), "signs before the restart");
  }
  static Device second(hal);
  second.boot();
  CHECK(second.handle("INFO").find(std::string("root=") + V_ROOT) != std::string::npos, "the same master seed comes back");
  CHECK(second.handle(std::string("SIGN ") + V_TX_UNFREEZE_LEAF0) == "ERR LeafAlreadyRevealed", "and so does the leaf record");
}

static void testPairing() {
  Rig rig(false);
  CHECK(rig.sign(V_TX_FREEZE) == "ERR NotPaired", "an unpaired device signs nothing");
  rig.hal.approve = false;
  CHECK(rig.device.handle(std::string("PAIR ") + V_ACCOUNT + " 1337 " + V_EPOCH) == "ERR Declined", "pairing needs the button");
  CHECK(rig.sign(V_TX_FREEZE) == "ERR NotPaired", "so a declined pairing changes nothing");
  CHECK(rig.device.handle("PAIR nonsense") == "ERR Malformed", "a malformed pairing");
}

static void testRotation() {
  Rig rig;
  CHECK(rig.device.handle("NEXTROOT") == std::string("OK ROOT ") + V_NEXT_ROOT, "the next root matches TypeScript");
  rig.sign(V_TX_FREEZE);
  CHECK(rig.sign(V_TX_ROTATE_WRONG_ROOT_LEAF1) == "ERR RotationRootUnknown", "refuses to install a tree it does not hold");
  CHECK(signedOk(rig.sign(V_TX_ROTATE_LEAF1)), "signs a rotation to its own next tree");

  CHECK(rig.device.handle(std::string("ROTATED ") + V_ROOT) == "ERR RotationRootUnknown", "will not switch to a root it did not derive");
  CHECK(rig.device.handle(std::string("ROTATED ") + V_NEXT_ROOT) == "OK ROTATED", "switches once told");
  std::string info = rig.device.handle("INFO");
  CHECK(info.find(std::string("root=") + V_NEXT_ROOT) != std::string::npos, "the new root is live");
  CHECK(info.find("tree=1") != std::string::npos && info.find("next=0") != std::string::npos, "with a fresh tree");
  CHECK(rig.sign(V_TX_FREEZE) == "ERR ChainStateUnknown", "and the old tree is gone");
}

static void testTheReservedLeaf() {
  Rig rig;
  CHECK(signedOk(rig.sign(V_TX_ROTATE_ROTATION_LEAF)), "the reserved leaf can rotate");
  CHECK(rig.device.handle("INFO").find("next=0") != std::string::npos, "without moving the ordinary leaves");
}

static void testUnknownCommand() {
  Rig rig;
  CHECK(rig.device.handle("DUMP SEED") == "ERR UnknownCommand", "there is no command that exports the seed");
}

int main() {
  testKeccak();
  testWordHash();
  testCachedLeaves();
  testParser();
  testByteIdenticalToTheChainsImplementation();
  testTheScreenShowsWhatIsSigned();
  testRefusals();
  testOneTimeDiscipline();
  testDecliningCostsNothing();
  testWriteAhead();
  testSurvivesARestart();
  testPairing();
  testRotation();
  testTheReservedLeaf();
  testUnknownCommand();
  printf("%d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
