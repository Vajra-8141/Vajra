import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import {
  FIELD,
  POOL_DEPTH,
  flatten,
  limbs,
  newNote,
  noteCommitment,
  noteNullifier,
  poolPath,
  poseidon,
  prove,
  proveRecovery,
  proveUnshield,
  randomFieldElement,
  recoveryCommitment,
  recoveryNullifier,
  stopProver,
} from "../src/proving.ts";

const vectors = JSON.parse(readFileSync(new URL("../../../contracts/test/vectors/zk.json", import.meta.url), "utf8"));
const zeros = (JSON.parse(readFileSync(new URL("../../core/src/pool-zeros.json", import.meta.url), "utf8")) as string[]).map(BigInt);
const account = "0x00c0ffee0000000000000000000000000000c0ff" as Address;
const salt = `0x${"ab".repeat(32)}` as Hex;
const root = `0x${"cd".repeat(32)}` as Hex;

afterAll(stopProver);

describe("field and limbs", () => {
  it("rebuilds a 256-bit value from its limbs", () => {
    const [hi, lo] = limbs(root);
    expect((hi << 128n) + lo).toBe(BigInt(root));
  });

  it("keeps each limb inside the field, which the whole value is not", () => {
    const top = `0x${"ff".repeat(32)}` as Hex;
    expect(BigInt(top) >= FIELD).toBe(true);
    for (const limb of limbs(top)) expect(limb < FIELD).toBe(true);
  });

  it("draws secrets inside the field", () => {
    for (let i = 0; i < 200; i++) {
      const s = randomFieldElement();
      expect(s > 0n && s < FIELD).toBe(true);
    }
  });
});

describe("Poseidon matches the circuit and the contract", () => {
  it("gives the commitment in the vectors", async () => {
    expect(await recoveryCommitment(123456789n)).toBe(BigInt(vectors.commitment));
  });

  it("scopes a nullifier to its account", async () => {
    const a = await recoveryNullifier(5n, "0x1111111111111111111111111111111111111111");
    const b = await recoveryNullifier(5n, "0x2222222222222222222222222222222222222222");
    expect(a).not.toBe(b);
  });

  it("keeps a commitment from doubling as a nullifier", async () => {
    expect(await recoveryCommitment(5n)).not.toBe(await poseidon(5n, 0n));
  });
});

describe("the pool's tree", () => {
  const first = BigInt(vectors.firstNote);
  const second = BigInt(vectors.secondNote);

  it("gets the root Foundry checks the contract against", async () => {
    expect((await poolPath([first, second], 1)).root).toBe(BigInt(vectors.poolRoot));
  });

  it("gives the same root from either leaf", async () => {
    expect((await poolPath([first, second], 0)).root).toBe((await poolPath([first, second], 1)).root);
  });

  it("uses a zero for a missing sibling", async () => {
    const { pathElements } = await poolPath([first], 0);
    expect(pathElements).toEqual(zeros.slice(0, POOL_DEPTH));
  });

  it("gives a path of the tree's depth, in the leaf's bits", async () => {
    const leaves = [1n, 2n, 3n, 4n, 5n, 6n];
    const { pathElements, pathIndices } = await poolPath(leaves, 5);
    expect(pathElements).toHaveLength(POOL_DEPTH);
    expect(pathIndices.slice(0, 3)).toEqual([1, 0, 1]);
  });

  it("refuses a leaf the tree does not have, rather than proving against an empty one", async () => {
    await expect(poolPath([first], 1)).rejects.toThrow("not in a tree");
  });
});

describe("proofs", () => {
  it("swaps G2 coordinates for the precompile", () => {
    const flat = flatten({ pi_a: ["1", "2", "1"], pi_b: [["3", "4"], ["5", "6"], ["1", "0"]], pi_c: ["7", "8", "1"] });
    expect(flat).toEqual([1n, 2n, 4n, 3n, 6n, 5n, 7n, 8n]);
  });

  it("proves recovery, with the public signals in the contract's order", async () => {
    const proved = await proveRecovery({ secret: 123456789n, newRoot: root, account, epochSalt: salt, chainId: 13370 });
    const [hi, lo] = limbs(root);
    expect(proved.publicSignals.map(BigInt)).toEqual([
      await recoveryCommitment(123456789n),
      hi,
      lo,
      BigInt(account),
      ...limbs(salt),
      13370n,
      proved.nullifier,
    ]);
  });

  it("refuses to prove a commitment the secret does not open", async () => {
    await expect(
      prove("recovery", {
        s: 1n,
        recoveryCommitment: 2n,
        newWotsRootHi: 0n,
        newWotsRootLo: 0n,
        accountAddr: 0n,
        epochSaltHi: 0n,
        epochSaltLo: 0n,
        chainId: 0n,
        nullifier: await recoveryNullifier(1n, "0x0000000000000000000000000000000000000000"),
      }),
    ).rejects.toThrow();
  });

  it("proves an unshield, with the public signals in the contract's order", async () => {
    const note = newNote();
    const leaves = [await noteCommitment(newNote()), await noteCommitment(note)];
    const recipient = "0x000000000000000000000000000000000000bEEF" as Address;
    const proved = await proveUnshield({ note, leaves, leaf: 1, recipient, denomination: 10n ** 16n, account, chainId: 13370 });
    expect(proved.publicSignals.map(BigInt)).toEqual([proved.root, await noteNullifier(note), BigInt(recipient), 10n ** 16n, BigInt(account), 13370n]);
  });

  it("refuses to prove a note at someone else's leaf", async () => {
    const note = newNote();
    const leaves = [await noteCommitment(newNote()), await noteCommitment(note)];
    await expect(proveUnshield({ note, leaves, leaf: 0, recipient: account, denomination: 1n, account, chainId: 1 })).rejects.toThrow();
  });

  it("gives one note one nullifier, whatever its position or recipient", async () => {
    const note = newNote();
    expect(await noteNullifier(note)).toBe(await poseidon(note.nullifierSeed));
  });
});
