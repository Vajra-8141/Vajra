/**
 * The shielded pool as a user runs it. Notes live in a file on this machine, and whoever has that file can spend them, so it
 * is as sensitive as a key. A note is not derived from the master seed yet: viewing keys and note delivery are designed only.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { type Address, formatEther, parseAbiItem } from "viem";
import { DEVNET, type FrameTx, RpcError, accountV2Abi, deployments, framesSucceeded, opsV2, publicClient, refusalNameV2, submit, unshieldTx } from "@vajra/core";
import { keyPath } from "./deploy.ts";
import { type Note, newNote, noteCommitment, proveUnshield } from "./proving.ts";
import { requireWallet, runCalls } from "./wallet.ts";

const notesPath = keyPath("notes.json");

interface SavedNote {
  account: Address;
  secret: string;
  nullifierSeed: string;
  commitment: string;
  leaf: number;
  spent: boolean;
}

const loadNotes = (): SavedNote[] => (existsSync(notesPath) ? (JSON.parse(readFileSync(notesPath, "utf8")) as SavedNote[]) : []);
const saveNotes = (notes: SavedNote[]) => writeFileSync(notesPath, JSON.stringify(notes, null, 1) + "\n", { mode: 0o600 });

export const denomination = () => BigInt(deployments().v2!.denomination);
/** What a note gives up on the way out, to pay for its own transaction. */
export const noteFee = () => BigInt(deployments().v2!.noteFee);

const shieldedEvent = parseAbiItem("event Shielded(uint256 indexed commitment, uint256 leaf, uint256 root)");

/** Every leaf in the pool, in order. A leaf missing from the log would give a wrong root, so a gap is an error. */
export async function poolLeaves(account: Address): Promise<bigint[]> {
  const logs = await publicClient.getLogs({ address: account, event: shieldedEvent, fromBlock: 0n, toBlock: "latest" });
  const leaves: bigint[] = [];
  for (const log of logs) {
    if (Number(log.args.leaf) !== leaves.length) throw new Error(`the pool's log has a gap at leaf ${leaves.length}: chain state unknown`);
    leaves.push(log.args.commitment!);
  }
  return leaves;
}

export const readPool = <T>(account: Address, functionName: string, args: unknown[] = []) =>
  publicClient.readContract({ address: account, abi: accountV2Abi as never, functionName, args } as never) as Promise<T>;

/** One note, paid for by the account, with the master key. The note is saved before it is paid for. */
export async function shieldCommand() {
  const { account } = requireWallet();
  const note = newNote();
  const commitment = await noteCommitment(note);
  const notes = loadNotes();
  const saved: SavedNote = { account, secret: note.secret.toString(), nullifierSeed: note.nullifierSeed.toString(), commitment: commitment.toString(), leaf: -1, spent: false };
  saveNotes([...notes, saved]);
  const result = await runCalls([opsV2.shield(commitment, denomination())], "shield", console.log);
  const leaves = await poolLeaves(account);
  saved.leaf = leaves.indexOf(commitment);
  saveNotes([...notes, saved]);
  console.log(`mined ${result.hash}\nnote at leaf ${saved.leaf}, ${formatEther(denomination())} ETH, ${leaves.length} in the pool`);
  console.log(`the amount and this deposit are public. So is any later withdrawal: what stays hidden is which deposit paid for it`);
}

/** Spends the oldest unspent note. No key signs this. */
export async function unshieldCommand(recipient: Address) {
  const { account } = requireWallet();
  const notes = loadNotes();
  const saved = notes.find((n) => n.account === account && !n.spent && n.leaf >= 0);
  if (!saved) throw new Error("no unspent note on this machine");
  const note: Note = { secret: BigInt(saved.secret), nullifierSeed: BigInt(saved.nullifierSeed) };

  // A note has one mined attempt, and it is spent whatever the recipient does. So ask first: a contract that refuses money costs the note.
  await publicClient.call({ account, to: recipient, value: denomination() - noteFee() }).catch(() => {
    throw new Error(`${recipient} refuses a plain payment, and the note would be lost: pick another recipient`);
  });

  // A stale root is a tier, not an error: the note is fine, and a fresh proof against a newer root will do. Retrying the same
  // proof is always the same bytes, which `submit` does on its own.
  for (let attempt = 1; ; attempt++) {
    const leaves = await poolLeaves(account);
    const proved = await proveUnshield({ note, leaves, leaf: saved.leaf, recipient, denomination: denomination(), account, chainId: DEVNET.chainId });
    console.log(`proved in ${proved.ms} ms, against a tree of ${leaves.length}`);
    const tx: FrameTx = unshieldTx({ account, root: proved.root, nullifierHash: proved.nullifierHash, recipient, proof: proved.proof });
    try {
      const { hash, receipt } = await submit(tx, { log: console.log });
      if (!framesSucceeded(receipt)) throw new Error(`${hash} was mined but a frame failed`);
      saved.spent = true;
      saveNotes(notes);
      console.log(`mined ${hash}, VERIFY ${Number(BigInt(receipt.frameReceipts[0]!.gasUsed))} gas\n${formatEther(denomination() - noteFee())} ETH to ${recipient}: a ${formatEther(denomination())} ETH note, less its ${formatEther(noteFee())} ETH fee`);
      return;
    } catch (error) {
      const name = error instanceof RpcError ? refusalNameV2(error.message) : "";
      if (name === "RootUnknown" && attempt < 3) {
        console.log("that root has left the window: proving again against a newer one");
        continue;
      }
      throw error instanceof RpcError ? new Error(name || error.message) : error;
    }
  }
}
