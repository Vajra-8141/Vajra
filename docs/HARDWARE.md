# The hardware signer

An ESP32 that holds the master key on its own device, and shows each operation on its screen before signing it.

**Do not plug it into a computer you do not trust.** Any program on that computer can copy the master key in half a second, and
can press the button for it. Both are measured below, under [What a computer can do to this board](#what-a-computer-can-do-to-this-board).

**Status: a real ESP32 has signed 7 transactions that were mined on the live devnet, with a person pressing BOOT for each one,
including a veto, a rotation and an escape.** The evidence is in `docs/evidence/device-esp32-latest.json`. Through the bridge and
the dashboard it has signed a veto, a freeze and an unfreeze, in `docs/evidence/device-dashboard-latest.json`. That run used a
scripted wallet, not the MetaMask extension.

## Why it exists

The two keys only outrank each other if one attacker cannot get both. With the software signer, the master seed is a file on
the same machine as the wallet, so malware there gets both. The hardware moves the master key off the computer, onto a device
with its own screen that is only connected when it is needed. That narrows the risk to the time it is plugged in. It does not
remove it: on this board, the computer has to be trusted while it is connected.

| Attack | Software signer | Hardware signer |
|---|---|---|
| Phished seed phrase | Protected | Protected |
| Malware on the computer, signer unplugged | Both keys lost | Master key safe |
| Malware on the computer, signer plugged in | Both keys lost | **Both keys lost** |
| Compromised dashboard | Can request any master operation | Owner reads the operation on the device |
| Compromised bridge | Can request any master operation | **Key lost**: the bridge runs on the computer |
| One-time key reused after restoring a backup | Possible | Less likely: one device holds the only counter |
| Physical theft of the signer | Not applicable | **Key lost**: see the limits below |

## What the device checks

The protocol does not trust the host. These checks hold against a host that only speaks it; one that goes around it is covered
[below](#what-a-computer-can-do-to-this-board). The host sends the whole unsigned transaction, and the device:

1. parses it with a strict RLP reader, since a parser that disagreed with the node's would let the screen lie
2. checks the chain and the paired account
3. checks the exact shape: the master VERIFY frame, and one call the account makes to itself, carrying no value
4. caps the fee, so a compromised host cannot drain the account through gas
5. works out which leaf the nonce key belongs to, and refuses a leaf out of order or already revealed
6. decodes the operation, and refuses anything it cannot describe
7. hashes the raw bytes itself, shows the operation on its own screen, and waits for BOOT
8. records the leaf durably, and only then produces the signature

A rotation is only signed to the device's own next tree, so a compromised host cannot install an attacker's root.

Nothing exports the seed. The firmware contains no code that starts the radio: `esp_wifi_init` and `esp_bt_controller_init` are
not in the binary, and the one Bluetooth symbol present is the Arduino core releasing that memory at boot. This is why the
device talks over USB, not WiFi as spec 04 §6 planned. The queue countdown arrives over the cable instead, and is labeled on
screen as coming from the host, because it is only a convenience.

## Evidence

| Check | Result |
|---|---|
| Device logic against the TypeScript implementation | Byte-identical signatures: `make -C firmware test` |
| Negative controls | Removing the write-ahead, the reuse check, the button or the account check each fails the tests |
| Signatures accepted by the deployed account | 7 mined transactions through the native build: `docs/evidence/device-emulator-latest.json` |
| A compromised host speaking the protocol, on the live devnet | Six attacks refused before reaching the button, no leaf burned, on the native build and the board |
| The serial client | 25 transfers on one open port with no retries, and every fault in `packages/cli/test/device.test.ts` |
| ESP32 cross-compile | Succeeds: 401 KB flash, 38 KB RAM |
| Flashing and running on a real ESP32 | **Works**: ESP32-D0WD-V3 |
| Hardware RNG seed, NVS persistence across resets and reflashes | **Works**: the root survived both |
| Boot time on the chip | 10 seconds deriving a tree, 0.4 seconds from the cache |
| Screen detection | **Works**: reports `screen=no` with no display attached |
| Display on the bus | **Works**: a 16x2 LCD at `0x27`, and its controller reads back the text written to it |
| Text readable on the LCD | **Works**, once the contrast trimmer is set |
| BOOT button, signing from the board | **Works**: 7 mined transactions, `docs/evidence/device-esp32-latest.json` |
| The dashboard driving the board, reads over Nym | **Works**: 3 mined transactions, `docs/evidence/device-dashboard-latest.json` |
| **A press proves a person was there** | **False on this board**: the computer can press it |
| **The key stays on the device** | **False on this board**: the computer can read it |

## Setting it up

Wiring, with the USB cable unplugged. The firmware finds either display on its own: a 16x2 character LCD on a PCF8574 I2C
backpack (address `0x27` or `0x3f`), or an SSD1306 OLED (`0x3c` or `0x3d`).

| Display | ESP32 |
|---|---|
| GND | GND |
| VCC | VIN (5V) for an LCD; 3V3 for an OLED |
| SCL | GPIO 22 |
| SDA | GPIO 21 |

Go by the labels on the display: modules differ on whether GND or VCC comes first. BOOT is the board's own button on GPIO 0.

No external resistors are needed: an LCD backpack carries its own I2C pull-ups. If an LCD's backlight is on but the text is
invisible, turn the blue trimmer on the backpack, which sets the contrast. The LCD this was built with only became readable on
VIN. That also pulls SDA and SCL up to 5V, and the ESP32's pins are rated for 3.3V, so it works but is out of spec. A level
shifter is the proper fix.

`vajra device` shows whether a screen was found. `DIAG` over the serial line lists every address on the bus, and on an LCD
reads the controller's memory back: `lcd_chars=0x56,0x41` is the `V` and `A` of `VAJRA`, which proves the text arrived even if
the glass is not showing it. Solid blocks with that reading are a contrast problem, not a firmware one.

Without a display the device reports `screen=no` and refuses to approve anything, because nobody could see what they were
signing. It probes the I2C bus for this: the OLED library's `begin` succeeds with nothing connected. Every message fits 16
columns, enforced by a test, because text cut off on a signer is text hidden from its owner. On the LCD, the prompt takes
turns with the detail on the second row.

Serial access on Arch needs the `uucp` group, then a fresh login:

    sudo usermod -aG uucp $USER

Flash and check it:

    cd firmware && pio run -e esp32 -t upload
    node packages/cli/src/main.ts device                    # should report kind: 'esp32'

The real test, which needs nine button presses:

    VAJRA_SIGNER=device node packages/cli/src/main.ts device-e2e

To use it day to day, set `VAJRA_SIGNER=device` for `vajra create` and `vajra bridge`. On first boot the device generates its
master seed from the hardware RNG.

Without a board, the same logic runs as a test harness. It holds its seed in a file and presses its own button, so it has
none of the properties above:

    make -C firmware test emulator
    VAJRA_DEVICE=emulator:/tmp/state.bin node packages/cli/src/main.ts device-e2e

## Protocol

One command per line, at 115200 baud. One line back: `OK ...` or `ERR <Refusal>`.

| Command | Reply | Button |
|---|---|---|
| `INFO` | `OK INFO kind= version= root= tree= next= left= chain= account= epoch=` | no |
| `PAIR <account> <chainId> <epochSalt>` | `OK PAIRED` | yes |
| `SIGN <raw unsigned tx>` | `OK SIGNED <leaf> <size> <keccak of the signature>` | yes, unless repeating the same digest |
| `PART <offset>` | `OK PART <offset> <hex>`, up to 128 bytes of the signature | no |
| `NEXTROOT` | `OK ROOT <root>` | no |
| `ROTATED <root>` | `OK ROTATED` | yes |
| `SHOW <text>` | `OK SHOWN` | no |
| `WIPE` | `OK WIPED` | yes |
| `DIAG` | `OK DIAG i2c=<addresses> lcd_chars=<first two characters> lcd_status=<busy flag and address>` | no |

The signature crosses the line in 128-byte pieces, is checked against its hash, and is verified against the root before anything
is broadcast. A piece can be asked for again, and repeating `SIGN` for the same digest costs no press and reveals nothing new.

It used to be one 4,681-character line, and the first signature from a real board arrived damaged: 4,064 good bytes, 32 NUL
bytes, then only the last 73. Two things combined. On Node 26 with serialport 13, after the first read, data on the port does not
wake the event loop, so nothing was reading while the reply arrived. And an unread port holds only about 4 KB. Not reading during
a 4,949-byte burst reproduces the same 4,064 good bytes and the same 32 NUL bytes, three times out of three.

Why the loop is not woken is not known, so the client wakes it every 10 ms. With that, 25 transfers on one open port took exactly
25 `SIGN` and 475 `PART` commands, with no retries.

Refusals: `NotPaired` `Malformed` `WrongChain` `WrongAccount` `BadShape` `FeeTooHigh` `UnknownOperation` `LeafAlreadySpent`
`LeafAlreadyRevealed` `LeafOutOfOrder` `TreeExhausted` `ChainStateUnknown` `RotationRootUnknown` `Declined` `NothingSigned`.

## What a computer can do to this board

Like most ESP32 development boards, this one wires the USB chip's DTR and RTS lines to GPIO0 and EN, so that flashing needs no
buttons. GPIO0 is also the BOOT button. Measured on the real board, with nobody touching it:

| What the computer did | What happened |
|---|---|
| Sent `PAIR`, then pulsed DTR with RTS released, at 0.5, 3 and 1.5 seconds | `OK PAIRED` 0.17 seconds after each pulse, and silence until then |
| Ran the stock tool: `esptool read-flash 0x9000 0x5000` | 20,480 bytes in 0.5 seconds, no press. The key tree rebuilt from that dump matches the board's root |

So a press proves nothing against a program on the computer, and that program does not need a signature at all: it can take the
key. It can also reflash the board. Until this is closed, plug the signer in only to use it, only into a computer you trust, and
unplug it afterwards.

Closing it takes two changes together, and neither is done:

1. A confirm button on a pin the USB chip cannot reach, because GPIO0 cannot be told apart from a real press.
2. Burning the `UART_DOWNLOAD_DIS` eFuse, which this chip has, so the ROM bootloader cannot read or write the flash. This is
   permanent: the board could never be reflashed over USB again, and the firmware has no other update path.

Either one alone leaves the key exposed. Both together still leave the flash chip readable by someone holding the board.

## What this does not protect

- **The ESP32 is not a secure element.** The seed sits in plain text in NVS, readable over USB as above and by whoever holds the
  board. There is no PIN. Production needs flash encryption and secure boot at least, and really a WOTS app on Ledger-class
  hardware. A phone would also do: what the design needs is a separate device with a screen.
- **There is no backup.** The seed never leaves the device, so losing it loses the master key. The account stays usable under
  the daily key's rules, but nothing can veto or escape. STARK recovery is the designed answer, and it is not built.
- **The screen shows an abbreviated address,** the first and last two bytes. Comparing the full address needs a better display.
  This is the real cost of a 16x2 LCD: an attacker could grind an address that matches those four bytes.
- **A single button can only approve.** Declining means waiting 60 seconds.
