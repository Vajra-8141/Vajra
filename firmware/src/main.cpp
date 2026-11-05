// The VAJRA signer. The master key lives here, behind one USB cable and one button.
//
// The radio is never started: nothing in this firmware touches WiFi or Bluetooth, so the only way in is the serial line,
// and that line can only ask. Every signature needs a press of the BOOT button, with the operation on the screen.
//
// The screen is whichever answers on the I2C bus: a 16x2 character LCD on a PCF8574 backpack, or an SSD1306 OLED.
//
// What this does not do: the seed sits in NVS, which is readable by anyone who holds the board. Production means flash
// encryption and secure boot, or a secure element, and a PIN.
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Arduino.h>
#include <LiquidCrystal_I2C.h>
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
constexpr uint8_t OLED_ADDRESSES[] = {0x3c, 0x3d};
constexpr uint8_t LCD_ADDRESSES[] = {0x27, 0x3f};
constexpr uint8_t LCD_COLUMNS = 16;
constexpr uint8_t LCD_ROWS = 2;
constexpr uint32_t HINT_PERIOD_MS = 1500;
constexpr uint32_t CONFIRM_TIMEOUT_MS = 60000;
constexpr uint32_t DEBOUNCE_MS = 30;
constexpr size_t MAX_LINE = 8192;

Adafruit_SSD1306 oled(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);
LiquidCrystal_I2C* lcd = nullptr;
bool screenReady = false;

void renderOled(const char* title, const char* detail, const char* footer) {
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  oled.setCursor(0, 0);
  oled.setTextSize(strlen(title) <= 10 ? 2 : 1);
  oled.println(title);
  oled.setTextSize(1);
  oled.setCursor(0, 24);
  oled.println(detail);
  oled.setCursor(0, 56);
  oled.print(footer);
  oled.display();
}

/** Each row is padded to full width, so a shorter line never leaves the end of a longer one behind. */
void lcdRow(uint8_t row, const char* text) {
  char line[LCD_COLUMNS + 1];
  snprintf(line, sizeof(line), "%-16.16s", text);
  lcd->setCursor(0, row);
  lcd->print(line);
}

void render(const char* title, const char* detail, const char* footer) {
  if (!screenReady) return;
  if (lcd == nullptr) return renderOled(title, detail, footer);
  lcdRow(0, title);
  lcdRow(1, detail);
}

uint8_t lcdAddress = 0;

/** One half-byte back from the LCD controller. On the PCF8574: P0 RS, P1 RW, P2 EN, P3 backlight, P4 to P7 data. */
uint8_t lcdReadNibble(bool data) {
  uint8_t base = 0xf0 | 0x08 | 0x02 | (data ? 0x01 : 0x00);
  auto put = [](uint8_t value) {
    Wire.beginTransmission(lcdAddress);
    Wire.write(value);
    Wire.endTransmission();
  };
  put(base);
  put(base | 0x04);
  Wire.requestFrom(lcdAddress, static_cast<uint8_t>(1));
  uint8_t value = Wire.available() ? Wire.read() : 0;
  put(base);
  return value >> 4;
}

uint8_t lcdReadByte(bool data) {
  uint8_t high = lcdReadNibble(data);
  return (high << 4) | lcdReadNibble(data);
}

bool answers(uint8_t address) {
  Wire.beginTransmission(address);
  return Wire.endTransmission() == 0;
}

/**
 * Asks the bus whether a display is really there. A library's own `begin` cannot be trusted for this: Adafruit's only
 * allocates a buffer and succeeds with nothing connected, and a device that believes it has a screen would sign what nobody
 * can see.
 */
bool startScreen() {
  for (uint8_t address : LCD_ADDRESSES) {
    if (!answers(address)) continue;
    lcdAddress = address;
    lcd = new LiquidCrystal_I2C(address, LCD_COLUMNS, LCD_ROWS);
    lcd->init();
    lcd->backlight();
    return true;
  }
  for (uint8_t address : OLED_ADDRESSES) {
    if (answers(address)) return oled.begin(SSD1306_SWITCHCAPVCC, address);
  }
  return false;
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
      render("HALTED", "cannot save", "");
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
    bool hint = false;
    uint32_t flipped = started;
    while (millis() - started < CONFIRM_TIMEOUT_MS) {
      if (buttonDown()) {
        delay(DEBOUNCE_MS);
        if (buttonDown()) return true;
      }
      // Two rows leave no room for the prompt, so it takes turns with the detail. The title never moves.
      if (lcd != nullptr && millis() - flipped >= HINT_PERIOD_MS) {
        hint = !hint;
        flipped = millis();
        lcdRow(1, hint ? "BOOT = approve" : detail);
      }
      delay(5);
    }
    return false;
  }

  void show(const char* title, const char* detail) override { render(title, detail, ""); }

  const char* kind() const override { return "esp32"; }

  bool hasScreen() const override { return screenReady; }

  /** Every address that answers on the I2C bus, which is what identifies the attached display. */
  std::string diagnostics() override {
    std::string found = "i2c=";
    char text[8];
    int count = 0;
    for (uint8_t address = 0x08; address < 0x78; ++address) {
      Wire.beginTransmission(address);
      if (Wire.endTransmission() != 0) continue;
      snprintf(text, sizeof(text), "%s0x%02x", count++ ? "," : "", address);
      found += text;
    }
    if (count == 0) found += "none";
    if (lcd != nullptr) {
      // Reads the controller's own memory back: 'V' (0x56) here means our writes reached it and it understood them.
      lcd->setCursor(0, 0);
      char text2[48];
      uint8_t first = lcdReadByte(true);
      uint8_t second = lcdReadByte(true);
      uint8_t status = lcdReadByte(false);
      snprintf(text2, sizeof(text2), " lcd_chars=0x%02x,0x%02x lcd_status=0x%02x", first, second, status);
      found += text2;
      lcd->setCursor(0, 0);
    }
    return found;
  }

  bool loadLeaves(uint32_t tree, uint8_t leaves[vajra::TREE_LEAVES][32]) override {
    constexpr size_t size = vajra::TREE_LEAVES * 32;
    return prefs_.getUInt("leavesTree", UINT32_MAX) == tree && prefs_.getBytesLength("leaves") == size && prefs_.getBytes("leaves", leaves, size) == size;
  }

  void saveLeaves(uint32_t tree, const uint8_t leaves[vajra::TREE_LEAVES][32]) override {
    prefs_.putBytes("leaves", leaves, vajra::TREE_LEAVES * 32);
    prefs_.putUInt("leavesTree", tree);
  }

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
  screenReady = startScreen();
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
