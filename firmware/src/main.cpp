// The VAJRA signer. The master key lives here, behind one USB cable and one button.
//
// The radio is never started: nothing in this firmware touches WiFi or Bluetooth, so the only way in is the serial line,
// and that line can only ask. Every signature needs a press of the BOOT button, with the operation on the screen.
//
// What this does not do: the seed sits in NVS, which is readable by anyone who holds the board. Production means flash
// encryption and secure boot, or a secure element, and a PIN.
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Arduino.h>
#include <Preferences.h>
#include <Wire.h>
#include <bootloader_random.h>
#include <esp_random.h>

#include <string>

#include "device.h"

namespace {

constexpr int BUTTON_PIN = 0;
constexpr int SDA_PIN = 21;
constexpr int SCL_PIN = 22;
constexpr int SCREEN_WIDTH = 128;
constexpr int SCREEN_HEIGHT = 64;
constexpr uint8_t SCREEN_ADDRESS = 0x3c;
constexpr uint32_t CONFIRM_TIMEOUT_MS = 60000;
constexpr uint32_t DEBOUNCE_MS = 30;
constexpr size_t MAX_LINE = 8192;

Adafruit_SSD1306 screen(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);
bool screenReady = false;

void render(const char* title, const char* detail, const char* footer) {
  if (!screenReady) return;
  screen.clearDisplay();
  screen.setTextColor(SSD1306_WHITE);
  screen.setCursor(0, 0);
  screen.setTextSize(strlen(title) <= 10 ? 2 : 1);
  screen.println(title);
  screen.setTextSize(1);
  screen.setCursor(0, 24);
  screen.println(detail);
  screen.setCursor(0, 56);
  screen.print(footer);
  screen.display();
}

bool buttonDown() { return digitalRead(BUTTON_PIN) == LOW; }

class Esp32Hal : public vajra::Hal {
 public:
  void begin() { prefs_.begin("vajra", false); }

  bool load(vajra::State& state) override {
    return prefs_.getBytesLength("state") == sizeof(state) && prefs_.getBytes("state", &state, sizeof(state)) == sizeof(state);
  }

  void save(const vajra::State& state) override {
    // The device is about to release a signature. If the record of that cannot be written, stopping is the only safe move.
    if (prefs_.putBytes("state", &state, sizeof(state)) != sizeof(state)) {
      render("HALTED", "cannot record state", "");
      while (true) delay(1000);
    }
  }

  void random(uint8_t* out, size_t length) override {
    // With the radio off, the ADC is what feeds the hardware RNG.
    bootloader_random_enable();
    esp_fill_random(out, length);
    bootloader_random_disable();
  }

  bool confirm(const char* title, const char* detail) override {
    // Without a screen the owner cannot see what they are approving, so nothing can be approved.
    if (!screenReady) return false;
    render(title, detail, "BOOT = approve");
    // A press has to begin after the operation is on screen. A button already held down does not count.
    while (buttonDown()) delay(5);
    uint32_t started = millis();
    while (millis() - started < CONFIRM_TIMEOUT_MS) {
      if (buttonDown()) {
        delay(DEBOUNCE_MS);
        if (buttonDown()) return true;
      }
      delay(5);
    }
    return false;
  }

  void show(const char* title, const char* detail) override { render(title, detail, ""); }

  const char* kind() const override { return "esp32"; }

 private:
  Preferences prefs_;
};

Esp32Hal hal;
vajra::Device device(hal);
std::string line;
bool overflowed = false;

}  // namespace

void setup() {
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  Serial.setRxBufferSize(4096);
  Serial.begin(115200);
  Wire.begin(SDA_PIN, SCL_PIN);
  screenReady = screen.begin(SSD1306_SWITCHCAPVCC, SCREEN_ADDRESS);
  hal.begin();
  device.boot();
  line.reserve(MAX_LINE);
  Serial.println("READY");
}

void loop() {
  while (Serial.available() > 0) {
    char c = static_cast<char>(Serial.read());
    if (c == '\r') continue;
    if (c != '\n') {
      if (line.size() < MAX_LINE) {
        line.push_back(c);
      } else {
        overflowed = true;
      }
      continue;
    }
    if (overflowed) {
      Serial.println("ERR Malformed");
    } else if (!line.empty()) {
      Serial.println(device.handle(line).c_str());
    }
    line.clear();
    overflowed = false;
  }
  delay(1);
}
