/**
 * The shielded pool as a user runs it. Every note comes from one seed, so a stolen or wiped machine does not take the notes with it:
 * the seed and the account are enough to find them all again on the chain. See note-seed.ts.
 *
 * notes.json is only a cache of what the seed and the chain already say, except for a note made before there was a seed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Address, type Hex, formatEther, getAddress, isAddress, parseAbiItem, toEventSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEVNET, type FrameTx, LEGACY_GAS_PRICE, RpcError, accountV2Abi, claimCall, deployments, framesSucceeded, noteCountOf, opsV2, poolMeter, poolWords, publicClient, readPoolFacts, refusalNameV2, submit, unshieldTx, waitForSuccess, walletFor } from "@vajra/core";
import { keyPath } from "./deploy.ts";
import { checkNoteSeed, installNoteSeed, localNoteSeed, noteSeed } from "./note-seed.ts";
import { type Note, SEED_GAP, noteCommitment, noteFromSeed, noteNullifier, notesInPool, proveUnshield } from "./proving.ts";
import { loadWallet, requireWallet, runCalls } from "./wallet.ts";

const notesPath = keyPath("notes.json");

export interface SavedNote {
  account: Address;
  secret: string;
  nullifierSeed: string;
  commitment: string;
  leaf: number;
  spent: boolean;
  /** Its number under the seed. A note made before there was a seed has none, and this file is its only copy. */
  index?: number;
}

export const loadNotes = (): SavedNote[] => (existsSync(notesPath) ? (JSON.parse(readFileSync(notesPath, "utf8")) as SavedNote[]) : []);
const saveNotes = (notes: SavedNote[]) => {
  mkdirSync(dirname(notesPath), { recursive: true });
  writeFileSync(notesPath, JSON.stringify(notes, null, 1) + "\n", { mode: 0o600 });
};

/** The pairing, and paying a fresh address. Unused gas comes back. */
export const CLAIM_GAS = 2_000_000n;

export const denomination = () => BigInt(deployments().v2!.denomination);
/** What a note gives up on the way out, to pay for its own transaction. */
export const noteFee = () => BigInt(deployments().v2!.noteFee);

const shieldedEvent = parseAbiItem("event Shielded(uint256 indexed commitment, uint256 leaf, uint256 root)");

/** Every leaf in the pool, in order. A leaf missing from the log would give a wrong root, so a gap is an error. */
export async function poolLeaves(account: Address): Promise<bigint[]> {
  const [logs, count] = await Promise.all([publicClient.getLogs({ address: account, event: shieldedEvent, fromBlock: 0n, toBlock: "latest" }), noteCountOf(account)]);
  // A node that drops the newest logs would otherwise give a short list with confidence, and a restore would miss notes and say nothing.
  if (count !== null && BigInt(logs.length) !== count) throw new Error("the pool's log does not match its count: chain state unknown");
  const leaves: bigint[] = [];
  for (const log of logs) {
    if (Number(log.args.leaf) !== leaves.length) throw new Error(`the pool's log has a gap at leaf ${leaves.length}: chain state unknown`);
    leaves.push(log.args.commitment!);
  }
  return leaves;
}

export const readPool = <T>(account: Address, functionName: string, args: unknown[] = []) =>
  publicClient.readContract({ address: account, abi: accountV2Abi as never, functionName, args } as never) as Promise<T>;

const toSaved = (account: Address, note: Note, commitment: bigint, leaf: number, index: number): SavedNote => ({
  account,
  secret: note.secret.toString(),
  nullifierSeed: note.nullifierSeed.toString(),
  commitment: commitment.toString(),
  leaf,
  spent: false,
  index,
});

/**
 * The seed's next unused note. A number already tried is never tried again, even if it seems to have failed: a deposit that lands late would
 * then be a second copy of one note, and the second copy could never be spent. The pool is read too, for a seed used on another machine.
 */
async function nextNote(seed: Hex, account: Address, notes: SavedNote[]) {
  const pool = new Set(await poolLeaves(account));
  let index = Math.max(-1, ...notes.filter((n) => n.account === account && n.index !== undefined).map((n) => n.index!)) + 1;
  for (;; index++) {
    const note = noteFromSeed(seed, account, DEVNET.chainId, index);
    const commitment = await noteCommitment(note);
    if (!pool.has(commitment)) return { note, commitment, index };
  }
}

/** One note, with the note saved before it is paid for. The account pays with the master key, or anyone pays from a key of their own. */
export async function shieldCommand(o: { account?: string; keyFile?: string } = {}) {
  const account = accountOr(o.account);
  const notes = loadNotes();
  const { note, commitment, index } = await nextNote(noteSeed(), account, notes);
  const saved = toSaved(account, note, commitment, -1, index);
  saveNotes([...notes, saved]);
  const hash = o.keyFile ? await depositFrom(o.keyFile, account, commitment) : (await runCalls([opsV2.shield(commitment, denomination())], "shield", console.log)).hash;
  const leaves = await poolLeaves(account);
  saved.leaf = leaves.indexOf(commitment);
  saveNotes([...notes, saved]);
  console.log(`mined ${hash}\nnote ${index} at leaf ${saved.leaf}, ${formatEther(denomination())} ETH, ${leaves.length} in the pool`);
  console.log(`the amount and this deposit are public. So is any later withdrawal: what stays hidden is which deposit paid for it`);
}

/** An outsider's deposit: an ordinary transaction, so the sender's address is on the chain beside the note. */
async function depositFrom(keyFile: string, account: Address, commitment: bigint): Promise<Hex> {
  const key = readFileSync(keyFile, "utf8").trim() as Hex;
  const from = privateKeyToAccount(key).address;
  if ((await publicClient.getBalance({ address: from })) <= denomination()) throw new Error(`${from} holds too little to pay ${formatEther(denomination())} ETH and its gas`);
  const hash = await walletFor(key).writeContract({ address: account, abi: accountV2Abi as never, functionName: "shield", args: [commitment], value: denomination(), gas: 8_000_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy", chain: undefined } as never);
  await waitForSuccess(hash, "the deposit");
  return hash;
}

/** What the chain says of a note, whatever this machine remembers. */
export type NoteStatus = "in the pool" | "spent" | "owed" | "swept to the harbor";

const UNSPENT = 0n;
const OWED = 2n;

export async function noteStatus(account: Address, note: Note): Promise<NoteStatus> {
  const nullifier = await noteNullifier(note);
  const [spent, closed] = await Promise.all([readPool<boolean>(account, "noteSpent", [nullifier]), readPool<boolean>(account, "poolClosed")]);
  // The V2 on the public devnet has no claims, and reverts here. Only a revert means that: a failed read must not pass for it.
  const state = spent ? await readPool<bigint>(account, "noteState", [nullifier]).catch((error: Error) => (/revert/i.test(error.message) ? 1n : Promise.reject(error))) : UNSPENT;
  if (state === OWED) return closed ? "swept to the harbor" : "owed";
  if (spent) return "spent";
  return closed ? "swept to the harbor" : "in the pool";
}

const asNote = (saved: SavedNote): Note => ({ secret: BigInt(saved.secret), nullifierSeed: BigInt(saved.nullifierSeed) });

const accountOr = (given?: string): Address => {
  if (given === undefined) return requireWallet().account;
  if (!isAddress(given, { strict: false })) throw new Error("--account is not an address");
  return getAddress(given);
};

/** What the pool hides. It needs no key, so it works on anyone's account. A failed read stops here, and prints no figure. */
export async function poolCommand(given?: string) {
  const account = accountOr(given);
  const facts = await readPoolFacts(account);
  if (!facts) return console.log(`${account} has no pool`);
  const words = poolWords(poolMeter(facts));
  const list = (title: string, lines: string[]) => lines.length && console.log(`\n${title}\n${lines.map((text) => `  ${text}`).join("\n")}`);
  console.log(words.headline);
  list("The chain shows", words.shows);
  list("This read could not find out", words.unknown);
  list("No chain can show", words.cannotShow);
}

/** Everything this machine knows about, with the chain's word on each. A failed read stops the command: it does not print as nothing. */
export async function notesCommand(o: { account?: string } = {}) {
  const account = accountOr(o.account);
  const notes = loadNotes().filter((n) => n.account === account);
  if (!notes.length) return console.log(`no notes on this machine for ${account}. That says nothing about the chain: \`vajra notes-restore\` looks there`);
  const leaves = await poolLeaves(account);
  for (const saved of notes) {
    const leaf = leaves.indexOf(BigInt(saved.commitment));
    // A note is saved before it is paid for, so one here may never have reached the pool, and must not read as money that did.
    console.log(`note ${saved.index ?? "without a seed"}, ${leaf < 0 ? "not in the pool: its deposit failed, or has not landed" : `leaf ${leaf}: ${await noteStatus(account, asNote(saved))}`}`);
  }
}

/**
 * Finds every note of a seed on the chain and writes it down. It only ever adds: a note already in the file stays, and that matters for a
 * note made before there was a seed, because nothing else holds it.
 */
export async function notesRestoreCommand(o: { seedFile?: string; account?: string; gap?: string }) {
  const account = o.account === undefined && !loadWallet() ? null : accountOr(o.account);
  if (!account) throw new Error("no account here: name it with --account <address>");
  const seed = (o.seedFile ? readFileSync(o.seedFile, "utf8").trim() : localNoteSeed()) as Hex | null;
  if (!seed) throw new Error("no note seed on this machine: name it with --seed-file <file>");
  checkNoteSeed(seed);

  const leaves = await poolLeaves(account);
  const gap = o.gap === undefined ? SEED_GAP : Number(o.gap);
  if (!Number.isInteger(gap) || gap < 1) throw new Error("--gap is a whole number");
  const found = await notesInPool(seed, account, DEVNET.chainId, leaves, gap);
  const notes = loadNotes();
  const counts = new Map<NoteStatus, number>();
  for (const f of found) {
    const status = await noteStatus(account, f.note);
    counts.set(status, (counts.get(status) ?? 0) + 1);
    console.log(`note ${f.index}, leaf ${f.leaf}: ${status}`);
    const known = notes.find((n) => n.account === account && n.commitment === f.commitment.toString());
    const saved = known ?? toSaved(account, f.note, f.commitment, f.leaf, f.index);
    saved.leaf = f.leaf;
    saved.spent = status === "spent";
    if (!known) notes.push(saved);
  }
  // A seed that found nothing may be a mistyped paper, and keeping it would refuse the right one.
  if (found.length) {
    installNoteSeed(seed);
    saveNotes(notes);
  }
  const summary = [...counts].map(([status, count]) => `${count} ${status}`).join(", ");
  console.log(`${found.length} notes found in ${leaves.length} deposits${found.length ? `: ${summary}` : ", so this seed was not kept"}`);
  console.log(`a run of ${gap} numbers with no deposit ended the search, so a note past a longer gap would not be found: raise --gap to look further`);
}

/** A key on this machine that can pay for a trial. This never makes one: a new key is empty, so it could not run the trial, and would only sit there looking like a key. */
async function trialFunder(value: bigint): Promise<Address | null> {
  for (const name of ["deployer.key", "daily.key"]) {
    if (!existsSync(keyPath(name))) continue;
    const { address } = privateKeyToAccount(readFileSync(keyPath(name), "utf8").trim() as Hex);
    if ((await publicClient.getBalance({ address })) >= value) return address;
  }
  return null;
}

/**
 * A plain address always takes a payment. A contract might not, so trial it, from an address with money: the node will not run a call
 * from the account, which has code, or one from an empty address. A check that could not run is not a pass, and stops the same way.
 */
async function checkRecipient(recipient: Address, from?: Address) {
  if (!(await publicClient.getCode({ address: recipient }))) return;
  const value = denomination() - noteFee();
  const funder = from ?? (await trialFunder(value));
  if (!funder) throw new Error(`could not check that ${recipient} takes a payment: no key here holds ${formatEther(value)} ETH to try it from. Fund the daily key, or send it anyway with --no-check`);
  const trial = await publicClient.call({ account: funder, to: recipient, value }).then(
    () => null,
    (error: Error) => error.message,
  );
  if (trial === null) return;
  throw new Error(/reverted/i.test(trial) ? `${recipient} refuses a plain payment, so the money would not arrive: pick another recipient` : `could not check that ${recipient} takes a payment, so nothing was sent: ${trial}`);
}

/** A note paid back to its own account leaves `poolHeld` and becomes plain balance, which a stolen daily key can spend. See docs/FINDINGS.md section 26. */
function refuseOwnAccount(recipient: Address, account: Address) {
  if (getAddress(recipient) === getAddress(account)) throw new Error("that is this account: paid back here, a note becomes plain balance, which a stolen daily key can spend. Pick another address");
}

const UNPAID = toEventSelector("UnshieldUnpaid(uint256,address)");

/** Spends the oldest unspent note. No key signs this. */
export async function unshieldCommand(recipient: Address, o: { account?: string; noCheck?: boolean } = {}) {
  const account = accountOr(o.account);
  refuseOwnAccount(recipient, account);
  const notes = loadNotes();
  // The chain decides, not the file: a process that stopped after the block and before the save would otherwise offer a spent note.
  let saved: SavedNote | undefined;
  for (const candidate of notes.filter((n) => n.account === account && !n.spent && n.leaf >= 0)) {
    if ((await noteStatus(account, asNote(candidate))) === "in the pool") {
      saved = candidate;
      break;
    }
  }
  if (!saved) throw new Error("no unspent note on this machine");
  const note = asNote(saved);

  // Said before the proof, because it is the last moment it can change what you do.
  const facts = await readPoolFacts(account);
  if (facts) console.log(poolWords(poolMeter(facts)).headline);

  // A note has one mined attempt, and it is spent whatever the recipient does. So ask first: a contract that refuses money costs the fee, and
  // then a claim. `--no-check` is for a contract that takes money only from this account, which a trial from elsewhere cannot show.
  if (!o.noCheck) await checkRecipient(recipient);

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
      console.log(`mined ${hash}, VERIFY ${Number(BigInt(receipt.frameReceipts[0]!.gasUsed))} gas`);
      // Read from what happened, and not from the note's state: the V2 on the public devnet has no owed state, and a refused note there just reads as spent.
      const refused = receipt.frameReceipts.some((frame) => (frame.logs as { topics?: Hex[] }[]).some((log) => log.topics?.[0] === UNPAID));
      if (refused && (await noteStatus(account, note)) === "owed") console.log(`${recipient} refused the money. The note is spent and its fee is gone, and ${formatEther(denomination() - noteFee())} ETH is still held for it: \`vajra claim <recipient> --key-file <file>\` pays it to any address`);
      else if (refused) console.log(`${recipient} refused the money. On this contract the note is spent, and nothing is held for it.`);
      else console.log(`${formatEther(denomination() - noteFee())} ETH to ${recipient}: a ${formatEther(denomination())} ETH note, less its ${formatEther(noteFee())} ETH fee`);
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

/**
 * Pays a note its recipient refused, to any address, with a new proof. An ordinary transaction, so a sender has to pay its gas, and that
 * sender is public beside the claim. The proof fixes the recipient, so someone else can send it for you, and cannot change where it goes.
 */
export async function claimCommand(recipient: Address, o: { account?: string; keyFile?: string }) {
  const account = accountOr(o.account);
  refuseOwnAccount(recipient, account);
  if (!o.keyFile) throw new Error("--key-file <file> is required: whoever sends a claim pays its gas, and their address is public beside it");
  const notes = loadNotes();
  let saved: SavedNote | undefined;
  for (const candidate of notes.filter((n) => n.account === account && n.leaf >= 0)) {
    if ((await noteStatus(account, asNote(candidate))) === "owed") {
      saved = candidate;
      break;
    }
  }
  if (!saved) throw new Error("nothing on this machine is owed: `vajra notes-restore` looks on the chain");
  const key = readFileSync(o.keyFile, "utf8").trim() as Hex;
  const sender = privateKeyToAccount(key).address;
  await checkRecipient(recipient, sender);
  const leaves = await poolLeaves(account);
  const proved = await proveUnshield({ note: asNote(saved), leaves, leaf: saved.leaf, recipient, denomination: denomination(), account, chainId: DEVNET.chainId });
  console.log(`proved in ${proved.ms} ms, against a tree of ${leaves.length}`);
  // Asked first, so that a claim that would fail stops here with its name, and costs its sender nothing.
  const args = [proved.proof, proved.root, proved.nullifierHash, recipient];
  await publicClient.simulateContract({ address: account, abi: accountV2Abi as never, functionName: "claim", args, account: sender } as never).catch((error: Error) => {
    throw new Error(/Error: (\w+)\(/.exec(error.message)?.[1] ?? error.message);
  });
  const data = claimCall({ proof: proved.proof, root: proved.root, nullifierHash: proved.nullifierHash, recipient });
  const hash = await walletFor(key).sendTransaction({ to: account, data, gas: CLAIM_GAS, gasPrice: LEGACY_GAS_PRICE, type: "legacy" });
  await waitForSuccess(hash, "the claim");
  saved.spent = true;
  saveNotes(notes);
  console.log(`mined ${hash}\n${formatEther(denomination() - noteFee())} ETH to ${recipient}. The chain shows that the same note tried another address first`);
}
