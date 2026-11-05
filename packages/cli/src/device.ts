/**
 * The client for the hardware signer, over a USB serial line.
 *
 * One command per line, and one line back: `OK ...` or `ERR <Refusal>`. The device does not trust this side, and this side
 * adds nothing to what it says: a signature is whatever comes back, and the account is what checks it.
 *
 * `VAJRA_DEVICE=emulator:<path>` runs the same logic as a local process for testing. It reports `kind=emulator`, has none of
 * the hardware's properties, and must never hold anything that matters.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { ReadlineParser } from "@serialport/parser-readline";
import { SerialPort } from "serialport";
import type { Address, Hex } from "viem";

const BAUD = 115_200;
/** Long enough for the owner to read the screen and press the button. The device itself gives up at 60 seconds. */
const CONFIRM_TIMEOUT_MS = 75_000;
const COMMAND_TIMEOUT_MS = 20_000;
/** Opening the port can reset the board, and a boot derives the whole key tree before it answers. */
const BOOT_TIMEOUT_MS = 30_000;

export class DeviceRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = reason;
  }
}

export interface DeviceInfo {
  kind: "esp32" | "emulator";
  root: Hex;
  tree: number;
  next: number;
  left: number;
  chain: number;
  account: Address | null;
  epoch: Hex | null;
}

interface Transport {
  send(line: string): void;
  onLine(handler: (line: string) => void): void;
  close(): Promise<void>;
}

function emulatorTransport(path: string): Transport {
  const binary = new URL("../../../firmware/.build/emulator", import.meta.url).pathname;
  if (!existsSync(binary)) throw new Error("build the emulator first: make -C firmware emulator");
  const child: ChildProcessWithoutNullStreams = spawn(binary, [path], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
  child.stderr.on("data", (chunk: Buffer) => process.env.VAJRA_DEVICE_LOG && process.stderr.write(chunk));
  const lines = createInterface({ input: child.stdout });
  return {
    send: (line) => void child.stdin.write(`${line}\n`),
    onLine: (handler) => void lines.on("line", handler),
    close: async () => void child.kill(),
  };
}

function findSerialPath(): string {
  const candidates = readdirSync("/dev").filter((name) => /^tty(USB|ACM)\d+$/.test(name));
  if (candidates.length === 0) throw new Error("no signer found: is the board plugged in?");
  return `/dev/${candidates[0]}`;
}

async function serialTransport(path: string): Promise<Transport> {
  const port = new SerialPort({ path, baudRate: BAUD, autoOpen: false });
  await new Promise<void>((resolve, reject) => port.open((error) => (error ? reject(error) : resolve())));
  const parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));
  return {
    send: (line) => void port.write(`${line}\n`),
    onLine: (handler) => void parser.on("data", (line: string) => handler(line.trim())),
    close: () => new Promise((resolve) => port.close(() => resolve())),
  };
}

function parseInfo(reply: string): DeviceInfo {
  const fields = Object.fromEntries(reply.split(" ").slice(2).map((pair) => pair.split("=") as [string, string]));
  const optional = (value: string | undefined) => (!value || value === "none" ? null : `0x${value}`);
  return {
    kind: fields.kind as DeviceInfo["kind"],
    root: `0x${fields.root}` as Hex,
    tree: Number(fields.tree),
    next: Number(fields.next),
    left: Number(fields.left),
    chain: Number(fields.chain),
    account: optional(fields.account) as Address | null,
    epoch: optional(fields.epoch) as Hex | null,
  };
}

export class Device {
  private transport: Transport;
  private waiting: ((line: string) => void) | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** True while a command is with the device, so a status push never waits behind a button press. */
  busy = false;

  private constructor(transport: Transport) {
    this.transport = transport;
    // Anything else on the line is boot chatter, which a reset prints at another baud rate.
    transport.onLine((line) => {
      if (this.waiting && /^(OK|ERR)\b/.test(line)) {
        const waiting = this.waiting;
        this.waiting = null;
        waiting(line);
      }
    });
  }

  static async open(): Promise<Device> {
    const target = process.env.VAJRA_DEVICE;
    const transport = target?.startsWith("emulator:") ? emulatorTransport(target.slice("emulator:".length)) : await serialTransport(target ?? findSerialPath());
    const device = new Device(transport);
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        await device.command("INFO", 2_000);
        return device;
      } catch {
        // Still booting.
      }
    }
    await transport.close();
    throw new Error("the signer did not answer: is the firmware flashed?");
  }

  private command(line: string, timeoutMs: number = COMMAND_TIMEOUT_MS): Promise<string> {
    const run = () =>
      new Promise<string>((resolve, reject) => {
        this.busy = true;
        const timer = setTimeout(() => {
          this.waiting = null;
          this.busy = false;
          reject(new Error(`the signer did not answer ${line.split(" ")[0]}`));
        }, timeoutMs);
        this.waiting = (reply) => {
          clearTimeout(timer);
          this.busy = false;
          if (reply.startsWith("ERR ")) reject(new DeviceRefused(reply.slice(4)));
          else resolve(reply);
        };
        this.transport.send(line);
      });
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  info = async () => parseInfo(await this.command("INFO"));

  /** Binds the signer to one account. Needs the button. */
  pair = (account: Address, chainId: number, epochSalt: Hex) => this.command(`PAIR ${account.slice(2)} ${chainId} ${epochSalt.slice(2)}`, CONFIRM_TIMEOUT_MS);

  /** Hands over the raw unsigned transaction. The device hashes it, shows it, and waits for the button. */
  async sign(raw: Hex): Promise<Hex> {
    const reply = await this.command(`SIGN ${raw.slice(2)}`, CONFIRM_TIMEOUT_MS);
    return `0x${reply.slice("OK SIG ".length)}`;
  }

  async nextRoot(): Promise<Hex> {
    const reply = await this.command("NEXTROOT", 30_000);
    return `0x${reply.slice("OK ROOT ".length)}`;
  }

  /** Moves to the next tree, once a rotation is on chain. Needs the button. */
  rotated = (root: Hex) => this.command(`ROTATED ${root.slice(2)}`, CONFIRM_TIMEOUT_MS);

  show = (text: string) => this.command(`SHOW ${text}`);

  wipe = () => this.command("WIPE", CONFIRM_TIMEOUT_MS);

  close = () => this.transport.close();
}
