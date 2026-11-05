# The hardware signer

An ESP32 that holds the master key, reachable only over a USB cable, that signs nothing without a press of its button.

**Status: the firmware compiles for the ESP32, and its logic has signed real transactions on the devnet through a native
build. It has not yet run on a board.** Everything below marked unverified is waiting on that.

## Why it exists

The two keys only outrank each other if one attacker cannot get both. With the software signer, the master seed is a file on
the same machine as the wallet, so malware there gets both. The hardware moves the master key to a separate device with its
own screen, which also means the computer does not have to be trusted.

| Attack | Software signer | Hardware signer |
|---|---|---|
| Phished seed phrase | Protected | Protected |
| Malware on the computer | Both keys lost | Master key safe |
| Compromised dashboard or bridge | Can request any master operation | Owner reads the operation on the device |
| One-time key reused after restoring a backup | Possible | Less likely: one device holds the only counter |
| Physical theft of the signer | Not applicable | **Key lost**: see the limits below |

## What the device checks

The host is not trusted. It sends the whole unsigned transaction, and the device:

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
| Device logic against the TypeScript implementation | Byte-identical signatures, 108 checks: `make -C firmware test` |
| Negative controls | Removing the write-ahead, the reuse check, the button or the account check each fails the tests |
| Signatures accepted by the deployed account | 7 mined transactions through the native build: `docs/evidence/device-emulator-latest.json` |
| A compromised host, on the live devnet | Six attacks refused before reaching the button, no leaf burned |
| The serial client | Exercised through a pseudo-terminal |
| ESP32 cross-compile | Succeeds: 401 KB flash, 38 KB RAM |
| **Flashing and running on a board** | **Unverified** |
| **OLED, BOOT button, NVS persistence, hardware RNG** | **Unverified** |
| **Time to derive keys at boot** | **Unverified**, and the client waits 30 seconds |

## Setting it up

Wiring: OLED SDA to GPIO 21, SCL to GPIO 22. BOOT is GPIO 0.

Serial access on Arch needs the `uucp` group, then a fresh login:

    sudo usermod -aG uucp $USER

Flash and check it:

    cd firmware && pio run -e esp32 -t upload
    node packages/cli/src/main.ts device                    # should report kind: 'esp32'

The real test, which needs about ten button presses:

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
| `SIGN <raw unsigned tx>` | `OK SIG <leaf ‖ signature ‖ path>` | yes, unless repeating the same digest |
| `NEXTROOT` | `OK ROOT <root>` | no |
| `ROTATED <root>` | `OK ROTATED` | yes |
| `SHOW <text>` | `OK SHOWN` | no |
| `WIPE` | `OK WIPED` | yes |

Refusals: `NotPaired` `Malformed` `WrongChain` `WrongAccount` `BadShape` `FeeTooHigh` `UnknownOperation` `LeafAlreadySpent`
`LeafAlreadyRevealed` `LeafOutOfOrder` `TreeExhausted` `ChainStateUnknown` `RotationRootUnknown` `Declined`.

## What this does not protect

- **The ESP32 is not a secure element.** The seed sits in NVS, readable by whoever holds the board. There is no PIN. Production
  needs flash encryption and secure boot at least, and really a WOTS app on Ledger-class hardware. A phone would also do: what
  the design needs is a separate device with a screen.
- **There is no backup.** The seed never leaves the device, so losing it loses the master key. The account stays usable under
  the daily key's rules, but nothing can veto or escape. STARK recovery is the designed answer, and it is not built.
- **The screen shows an abbreviated address,** the first and last two bytes. Comparing the full address needs a better display.
- **A single button can only approve.** Declining means waiting 60 seconds.
