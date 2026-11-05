/**
 * The signature transfer, against a line that misbehaves. The shapes here are the ones a serial link produces, starting with
 * the one a real board did: a reply with NUL bytes in it and part of it gone.
 */
import { keccak256, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { Device, DeviceRefused, type Transport } from "../src/device.ts";

const SIZE = 2337;
const PIECE = 128;
const blob = toHex(Uint8Array.from({ length: SIZE }, (_, i) => (i * 31 + 7) % 256));

/** Sees each answer on its way back, and returns what reaches the client: `null` loses it. */
type Line = (reply: string, command: string) => string | null;

/** Answers as the firmware does, down to `NothingSigned` before a signature exists. */
class Signer implements Transport {
  signs = 0;
  held = false;
  private handler: (line: string) => void = () => {};

  constructor(
    private line: Line = (reply) => reply,
    private refusal: string | null = null,
  ) {}

  /** The board restarts: what it was holding in memory is gone, and its saved state is not. */
  restart() {
    this.held = false;
  }

  /** Puts a line on the wire outside the order of question and answer. */
  deliver(line: string) {
    setTimeout(() => this.handler(line));
  }

  private answer(command: string): string {
    const [verb, argument] = command.split(" ");
    if (verb === "INFO") return "OK INFO kind=emulator";
    if (verb === "SIGN") {
      this.signs++;
      if (this.refusal) return `ERR ${this.refusal}`;
      this.held = true;
      return `OK SIGNED 0 ${SIZE} ${keccak256(blob).slice(2)}`;
    }
    if (!this.held) return "ERR NothingSigned";
    const offset = Number(argument);
    const end = Math.min(offset + PIECE, SIZE);
    return `OK PART ${offset} ${blob.slice(2 + offset * 2, 2 + end * 2)}`;
  }

  send(command: string) {
    const reply = this.line(this.answer(command), command);
    if (reply !== null) this.deliver(reply);
  }

  onLine(handler: (line: string) => void) {
    this.handler = handler;
  }

  close = async () => {};
}

/** Lets `damage` act on the first answer `when` selects, and on no other. */
const once = (when: (command: string) => boolean, damage: (reply: string) => string | null): Line => {
  let done = false;
  return (reply, command) => {
    if (done || !when(command)) return reply;
    done = true;
    return damage(reply);
  };
};

const part = (offset: number) => (command: string) => command === `PART ${offset}`;
const sign = (signer: Signer) => new Device(signer).sign("0x06aa");

describe("the signature transfer", () => {
  it("carries a signature over a good line, with one SIGN", async () => {
    const signer = new Signer();
    expect(await sign(signer)).toBe(blob);
    expect(signer.signs).toBe(1);
  });

  it("survives what a real board did: NUL bytes in a reply, and part of it missing", async () => {
    const signer = new Signer(once(part(256), (reply) => `${reply.slice(0, 100)}${"\0".repeat(32)}${reply.slice(180)}`));
    expect(await sign(signer)).toBe(blob);
    expect(signer.signs).toBe(1);
  });

  it("asks again for a piece that never arrived", async () => {
    const signer = new Signer(once(part(128), () => null));
    expect(await sign(signer)).toBe(blob);
    expect(signer.signs).toBe(1);
  });

  it("starts over when damage is invisible until the hash", async () => {
    const flip = (reply: string) => `${reply.slice(0, -1)}${reply.endsWith("0") ? "1" : "0"}`;
    const signer = new Signer(once(part(512), flip));
    expect(await sign(signer)).toBe(blob);
    expect(signer.signs).toBe(2);
  });

  it("repeats SIGN when the answer to SIGN is the part that was garbled", async () => {
    const signer = new Signer(once((command) => command.startsWith("SIGN"), (reply) => `${reply.slice(0, 30)}\0\0${reply.slice(40)}`));
    expect(await sign(signer)).toBe(blob);
    expect(signer.signs).toBe(2);
  });

  it("repeats SIGN when the board restarted part way through", async () => {
    const signer: Signer = new Signer((reply, command) => {
      if (command === "PART 1024" && signer.signs === 1) signer.restart();
      return reply;
    });
    expect(await sign(signer)).toBe(blob);
    expect(signer.signs).toBe(2);
  });

  it("does not mistake a late answer for the next piece", async () => {
    let late: string | null = null;
    const signer: Signer = new Signer((reply, command) => {
      if (command === "PART 128" && late === null) {
        late = reply;
        return null;
      }
      return reply;
    });
    const device = new Device(signer);
    const sent = signer.send.bind(signer);
    // The late answer lands while the client is already waiting on the piece after it.
    signer.send = (command) => {
      if (command === "PART 256" && late) {
        const held = late;
        late = "";
        signer.deliver(held);
      }
      sent(command);
    };
    expect(await device.sign("0x06aa")).toBe(blob);
    expect(signer.signs).toBe(1);
  });

  it("gives up by name rather than return something damaged", async () => {
    const signer = new Signer((reply, command) => (command.startsWith("PART") ? `${reply.slice(0, 20)}\0` : reply));
    await expect(sign(signer)).rejects.toThrow("the signature would not cross the line intact");
    expect(signer.signs).toBe(4);
  });

  it("never repeats a refusal: the owner said no", async () => {
    const signer = new Signer(undefined, "Declined");
    const refusal = await sign(signer).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(DeviceRefused);
    expect((refusal as Error).name).toBe("Declined");
    expect(signer.signs).toBe(1);
  });
});
