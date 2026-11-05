#pragma once

#include <stddef.h>
#include <stdint.h>

#include <string>

#include "wots.h"

/**
 * The master key's behaviour, separate from any hardware, so the same logic runs on the ESP32 and under test.
 *
 * The host is not trusted. It can ask, and it can lie, so nothing is taken from it on faith: the device hashes the raw
 * transaction itself, works out which operation it is, and signs only after the owner has seen that operation on the
 * device's own screen and pressed the button.
 */
namespace vajra {

struct State {
  uint32_t magic;
  uint8_t master[32];
  uint32_t tree;
  uint32_t nextLeaf;
  uint8_t paired;
  uint8_t account[20];
  uint64_t chainId;
  uint8_t epochSalt[32];
  /** Bit N set: leaf N has revealed a signature over `revealed[N]`. */
  uint64_t revealedMask;
  uint8_t revealed[TREE_LEAVES][32];
};

class Hal {
 public:
  virtual ~Hal() = default;
  virtual bool load(State& state) = 0;
  /** Has to be durable when it returns: the signature is released right after. */
  virtual void save(const State& state) = 0;
  virtual void random(uint8_t* out, size_t length) = 0;
  /** Shows the operation and waits for the owner. False on timeout. */
  virtual bool confirm(const char* title, const char* detail) = 0;
  virtual void show(const char* title, const char* detail) = 0;
  virtual const char* kind() const = 0;
  /** Without a screen the owner cannot see what they are approving, so `confirm` has to fail. */
  virtual bool hasScreen() const { return true; }
  /** The leaf public keys are public, and slow to derive, so a device may keep them. */
  virtual bool loadLeaves(uint32_t tree, uint8_t leaves[TREE_LEAVES][32]) { return false; }
  virtual void saveLeaves(uint32_t tree, const uint8_t leaves[TREE_LEAVES][32]) {}
};

class Device {
 public:
  explicit Device(Hal& hal) : hal_(hal) {}

  /** Loads state, generating a master seed on first boot, and derives the current tree. */
  void boot();

  /** One command in, one line out: `OK ...` or `ERR <Refusal>`. */
  std::string handle(const std::string& line);

 private:
  std::string info();
  std::string pair(const std::string& args);
  std::string sign(const std::string& hex);
  std::string nextRoot();
  std::string rotated(const std::string& hex);
  std::string wipe();
  std::string refuse(const char* reason, const char* detail = "");

  void deriveTree(uint32_t tree, uint8_t leaves[TREE_LEAVES][32], uint8_t root[32]);
  void treeSeed(uint32_t tree, uint8_t out[32]);
  void idle();

  Hal& hal_;
  State state_;
  uint8_t leaves_[TREE_LEAVES][32];
  uint8_t root_[32];
};

}  // namespace vajra
