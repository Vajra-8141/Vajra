// The device's logic on a computer, speaking the same line protocol over stdin and stdout.
//
// This is a test harness, not a signer. Its seed sits in a file and its "button" is an environment variable, so it has
// none of the properties the hardware exists for. It reports `kind=emulator`, and the client labels it as such.
#include <fstream>
#include <iostream>
#include <random>
#include <string>

#include "device.h"

class Emulator : public vajra::Hal {
 public:
  Emulator(std::string path, bool approve) : path_(std::move(path)), approve_(approve) {}

  bool load(vajra::State& state) override {
    std::ifstream file(path_, std::ios::binary);
    return file.read(reinterpret_cast<char*>(&state), sizeof(state)) && file.gcount() == sizeof(state);
  }

  void save(const vajra::State& state) override {
    std::string temporary = path_ + ".tmp";
    {
      std::ofstream file(temporary, std::ios::binary | std::ios::trunc);
      file.write(reinterpret_cast<const char*>(&state), sizeof(state));
    }
    std::rename(temporary.c_str(), path_.c_str());
  }

  void random(uint8_t* out, size_t length) override {
    std::random_device source;
    for (size_t i = 0; i < length; ++i) out[i] = static_cast<uint8_t>(source());
  }

  bool confirm(const char* title, const char* detail) override {
    std::cerr << "[screen] " << title << " | " << detail << " | " << (approve_ ? "button pressed" : "not pressed") << std::endl;
    return approve_;
  }

  void show(const char* title, const char* detail) override { std::cerr << "[screen] " << title << " | " << detail << std::endl; }

  const char* kind() const override { return "emulator"; }

 private:
  std::string path_;
  bool approve_;
};

int main(int argc, char** argv) {
  if (argc < 2) {
    std::cerr << "usage: emulator <state file>" << std::endl;
    return 2;
  }
  const char* confirm = std::getenv("VAJRA_CONFIRM");
  Emulator hal(argv[1], !confirm || std::string(confirm) != "no");
  static vajra::Device device(hal);
  device.boot();
  std::cout << "READY" << std::endl;
  std::string line;
  while (std::getline(std::cin, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (!line.empty()) std::cout << device.handle(line) << std::endl;
  }
  return 0;
}
