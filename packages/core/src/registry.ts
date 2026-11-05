/**
 * The public record of which one-time keys are spent, on Arkiv.
 *
 * A leaf must sign once. The signer's counter and the account's keyed nonce both guard that, and each has a gap: a counter
 * restored from a backup is stale, and a nonce only moves when a transaction is mined, so a signature that was revealed and
 * never mined is invisible to the chain. A second copy of the key would then reveal the same leaf again, and two signatures
 * from one leaf are enough to forge.
 *
 * Anyone can write an entity that a query matches, so nothing here is believed because of who wrote it:
 *
 * - A usage record carries the signature itself, and a reader verifies it against the root. Only the key's owner can make one,
 *   so a forged record is ignored, and a thief cannot use this registry to block an escape.
 * - A reservation is written before any signature exists, so it cannot prove itself. It only counts from a wallet the reader
 *   trusts, and it can only ever cost a leaf, never refuse an operation.
 *
 * This is a third layer. If Arkiv cannot be reached, operations go on under the other two: an exit must not depend on it.
 */
import { createPublicClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { and, asc, eq, gte } from "@arkiv-network/sdk/query";
import { addr, bytes, defineSchema, i32, key, str, u64 } from "@arkiv-network/sdk/schema";
import { type Address, type Hex, hexToBytes, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { withTimeout } from "./devnet.ts";
import { ROTATION_LEAF, WOTS_W16, verifyMasterSignature } from "./wots.ts";

export const ARKIV_EXPLORER = "https://rabdi.explorer.arkiv.network";
export const arkivChain = (accessKey: string) => rabdi({ accessKey });
export { ExpirationTime };

/** Just under the longest the chain allows, about 182 days, so a record outlives any tree it describes. */
const USE_LIFETIME = ExpirationTime.fromDays(180);
/** Covers one operation, including a person reaching the button. It then vanishes on its own, with nobody to clean up. */
const RESERVATION_LIFETIME = ExpirationTime.fromMinutes(5);
const PAGE = 100;
/** Someone can write more records than any reader should fetch. Past this, the snapshot says it is incomplete. */
const MAX_PAGES = 5;
const READ_TIMEOUT_MS = 6_000;
const WRITE_TIMEOUT_MS = 15_000;

export const LeafUseSchema = defineSchema("vajra-leaf-use", {
  root: key().indexed(),
  leaf: i32().indexed(),
  account: addr(),
  digest: key(),
  signature: bytes(),
  txHash: key().optional(),
  op: str(),
  at: u64(),
});

export const LeafReservationSchema = defineSchema("vajra-leaf-reservation", {
  root: key().indexed(),
  leaf: i32().indexed(),
  account: addr(),
  holder: key(),
});

export interface LeafUse {
  entity: Hex;
  owner: Address;
  root: Hex;
  leaf: number;
  account: Address;
  digest: Hex;
  signature: Hex;
  txHash: Hex | null;
  op: string;
  at: number;
}

export interface LeafReservation {
  entity: Hex;
  owner: Address;
  root: Hex;
  leaf: number;
  account: Address;
  holder: Hex;
  expiresAt: bigint;
}

export interface LeafSnapshot {
  /** Every record whose signature verified. */
  uses: LeafUse[];
  /** Records that claimed this root and did not verify: forged, or damaged. */
  rejected: number;
  /** Live reservations from wallets this reader trusts. */
  reservations: LeafReservation[];
  /** Reservations from anyone else, which count for nothing. */
  ignored: number;
  /** False when more was written than this reader will page through. */
  complete: boolean;
  /** The block the reservations were read at, so a page can say how long they have left. */
  block: bigint;
}

/**
 * True exactly when a record proves its leaf was spent: the signature is real, and it is for that leaf. It never throws, because
 * anyone can write these rows, and one malformed row must not take the rest of the answer down with it.
 */
export function proves(use: Pick<LeafUse, "root" | "leaf" | "digest" | "signature">): boolean {
  try {
    const blob = hexToBytes(use.signature);
    return blob[0] === use.leaf && verifyMasterSignature(WOTS_W16, hexToBytes(use.digest), blob, hexToBytes(use.root));
  } catch {
    return false;
  }
}

export function leafState(snapshot: LeafSnapshot, leaf: number, holder: Hex): "free" | "used" | "reserved" {
  if (snapshot.uses.some((use) => use.leaf === leaf)) return "used";
  if (snapshot.reservations.some((held) => held.leaf === leaf && held.holder !== holder)) return "reserved";
  return "free";
}

/**
 * The first ordinary leaf at or after `from` that is safe to use. A reservation is passed over if there is anywhere else to go,
 * and only then, so a flood of them can burn leaves but cannot stop an operation. A verified use is never passed through.
 */
export function firstFreeLeaf(snapshot: LeafSnapshot, from: number, holder: Hex): number | null {
  const unused: number[] = [];
  for (let leaf = from; leaf < ROTATION_LEAF; leaf++) {
    const state = leafState(snapshot, leaf, holder);
    if (state === "free") return leaf;
    if (state === "reserved") unused.push(leaf);
  }
  return unused[0] ?? null;
}

async function allPages<T>(read: (offset: number) => Promise<{ entities: readonly T[]; skipped: number; blockNumber: bigint }>) {
  const rows: T[] = [];
  let offset = 0;
  let block = 0n;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { entities, skipped, blockNumber } = await read(offset);
    block = blockNumber;
    rows.push(...entities);
    const covered = entities.length + skipped;
    if (covered < PAGE) return { rows, complete: true, block };
    offset += covered;
  }
  return { rows, complete: false, block };
}

export interface RegistryConfig {
  accessKey: string;
  /** The wallets whose reservations count. Usage records need no such list: they prove themselves. */
  writers: Address[];
  /** How a browser keeps these reads on its private route. */
  fetchFn?: typeof fetch;
  /** Replaces the Arkiv endpoint. Only for showing what happens when it cannot be reached. */
  rpcUrl?: string;
}

/**
 * No retries on reads. Past its budget the public endpoint answers 429 with a `Retry-After` of twenty minutes, and the transport
 * would sit that out in silence while something waits to sign.
 */
const clientOptions = (config: RegistryConfig, retryCount?: number) => ({
  chain: rabdi({ accessKey: config.accessKey }),
  transport: http(config.rpcUrl, { ...(config.fetchFn ? { fetchFn: config.fetchFn } : {}), ...(retryCount === undefined ? {} : { retryCount }) }),
});

export class LeafRegistry {
  /** Why the last snapshot came back empty. */
  lastFailure: string | null = null;
  protected readonly config: RegistryConfig;
  private readonly client: ReturnType<typeof publicClient>;
  private readonly writers: Set<string>;

  constructor(config: RegistryConfig) {
    this.config = config;
    this.client = publicClient(config);
    this.writers = new Set(config.writers.map((writer) => writer.toLowerCase()));
  }

  private async readUses(root: Hex, from: number) {
    const { rows, complete } = await allPages((offset) =>
      this.client
        .select({ $key: true, $owner: true, root: true, leaf: true, account: true, digest: true, signature: true, txHash: true, op: true, at: true })
        .from(LeafUseSchema)
        .where(and(eq("root", key(root)), gte("leaf", i32(from))))
        .orderBy(asc("$key"))
        .limit(PAGE)
        .offset(offset)
        .fetch(),
    );
    const claimed: LeafUse[] = rows.map((row) => ({
      entity: row.$key,
      owner: row.$owner,
      root: row.root.value,
      leaf: row.leaf.value,
      account: row.account.value,
      digest: row.digest.value,
      signature: row.signature.value,
      txHash: row.txHash?.value ?? null,
      op: row.op.value,
      at: Number(row.at.value),
    }));
    const uses = claimed.filter(proves);
    return { uses, rejected: claimed.length - uses.length, complete };
  }

  private async readReservations(root: Hex, from: number) {
    const { rows, complete, block } = await allPages((offset) =>
      this.client
        .select({ $key: true, $owner: true, $expiresAt: true, root: true, leaf: true, account: true, holder: true })
        .from(LeafReservationSchema)
        .where(and(eq("root", key(root)), gte("leaf", i32(from))))
        .orderBy(asc("$key"))
        .limit(PAGE)
        .offset(offset)
        .fetch(),
    );
    const held: LeafReservation[] = rows.map((row) => ({
      entity: row.$key,
      owner: row.$owner,
      root: row.root.value,
      leaf: row.leaf.value,
      account: row.account.value,
      holder: row.holder.value,
      expiresAt: row.$expiresAt,
    }));
    const reservations = held.filter((reservation) => this.writers.has(reservation.owner.toLowerCase()));
    return { reservations, ignored: held.length - reservations.length, complete, block };
  }

  private async read(root: Hex, from: number): Promise<LeafSnapshot> {
    // One after the other: the public endpoint throttles a burst, and a throttled read can outlast the timeout.
    const uses = await this.readUses(root, from);
    const held = await this.readReservations(root, from);
    return { uses: uses.uses, rejected: uses.rejected, reservations: held.reservations, ignored: held.ignored, complete: uses.complete && held.complete, block: held.block };
  }

  /**
   * What Arkiv knows about a key tree, or null if it cannot say in time. A null is not a refusal.
   *
   * A signer passes `from`, its own counter, because leaves below that cannot change what it does: in steady state this read
   * returns nothing, and it only grows when a copy of the key really is behind. The default `patience` is short because something
   * is waiting to sign; a person who only wants to look can afford more.
   */
  async snapshot(root: Hex, { from = 0, patience = READ_TIMEOUT_MS }: { from?: number; patience?: number } = {}): Promise<LeafSnapshot | null> {
    try {
      const snapshot = await withTimeout(this.read(root, from), patience, "the registry");
      this.lastFailure = null;
      return snapshot;
    } catch (error) {
      // The transport's first line says only that the request failed. The server's own words are in `details`.
      const { details, message } = error as Error & { details?: string };
      this.lastFailure = (details ?? message).split("\n")[0]!.slice(0, 200);
      return null;
    }
  }
}

const publicClient = (config: RegistryConfig) => createPublicClient(clientOptions(config, 0));
const walletClient = (config: RegistryConfig, privateKey: Hex) => createWalletClient({ ...clientOptions(config), account: privateKeyToAccount(privateKey) });

export interface UseRecord {
  root: Hex;
  leaf: number;
  account: Address;
  digest: Hex;
  signature: Hex;
  txHash?: Hex | undefined;
  op: string;
}

export class LeafRegistryWriter extends LeafRegistry {
  readonly holder: Hex;
  readonly address: Address;
  private readonly wallet: ReturnType<typeof walletClient>;

  constructor(config: RegistryConfig & { privateKey: Hex; holder: Hex }) {
    const address = privateKeyToAccount(config.privateKey).address;
    super({ ...config, writers: [address, ...config.writers] });
    this.holder = config.holder;
    this.address = address;
    this.wallet = walletClient(config, config.privateKey);
  }

  /** Claims a leaf before anything is revealed. `lifetime` is only shorter when proving that reservations expire. */
  async reserve(root: Hex, leaf: number, account: Address, lifetime: ReturnType<typeof ExpirationTime.fromMinutes> = RESERVATION_LIFETIME): Promise<Hex> {
    const { entityKey } = await withTimeout(
      this.wallet.createEntity(LeafReservationSchema, { root: key(root), leaf: i32(leaf), account: addr(account), holder: key(this.holder) }, { expiration: lifetime }),
      WRITE_TIMEOUT_MS,
      "the reservation",
    );
    return entityKey;
  }

  /** Publishes a revealed signature. This reveals nothing new: the transaction it belongs to carries the same bytes. */
  async recordUse(use: UseRecord): Promise<Hex> {
    const { entityKey } = await withTimeout(
      this.wallet.createEntity(
        LeafUseSchema,
        {
          root: key(use.root),
          leaf: i32(use.leaf),
          account: addr(use.account),
          digest: key(use.digest),
          signature: bytes(hexToBytes(use.signature)),
          ...(use.txHash ? { txHash: key(use.txHash) } : {}),
          op: str(use.op),
          at: u64(BigInt(Math.floor(Date.now() / 1000))),
        },
        { expiration: USE_LIFETIME },
      ),
      WRITE_TIMEOUT_MS,
      "the usage record",
    );
    return entityKey;
  }
}
