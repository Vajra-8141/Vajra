# Builds and tests the device logic on this computer. The ESP32 build itself is `pio run`.
CXX ?= g++
CXXFLAGS ?= -std=c++17 -O2 -Wall -Wextra -Wno-unused-parameter
CORE := lib/vajra/keccak.cpp lib/vajra/wots.cpp lib/vajra/txview.cpp lib/vajra/device.cpp
OUT := .build

all: test emulator

$(OUT):
	mkdir -p $(OUT)

emulator: $(OUT) native/emulator.cpp $(CORE)
	$(CXX) $(CXXFLAGS) -Ilib/vajra native/emulator.cpp $(CORE) -o $(OUT)/emulator

test: $(OUT) test/test_core.cpp test/vectors.h $(CORE)
	$(CXX) $(CXXFLAGS) -Ilib/vajra -Itest test/test_core.cpp $(CORE) -o $(OUT)/test_core
	$(OUT)/test_core

clean:
	rm -rf $(OUT)

.PHONY: all test emulator clean
