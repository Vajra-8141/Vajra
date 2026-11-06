/**
 * What the screens may ask of the wallet. The screens know nothing else: no key, no frame, no RPC.
 * Every chain action reports its steps through `onStep`, in plain words, so a screen can show real progress.
 * `null` anywhere in a snapshot means unknown, and unknown is never shown as zero.
 */
export type Address = `0x${string}`;
export type Hash = `0x${string}`;

export type OnStep = (line: string) => void;

export interface CreateOptions {
  passphrase: string;
  /** ETH a day the wallet key can spend alone, as a decimal string. */
  dailyLimit: string;
  /** Seconds a bigger payment waits in public. */
  delaySeconds: number;
  /** An address the person already owns, or null to have a safe made for them. */
  safe: Address | null;
}

/** Proof of what happened, shown after every action. */
export interface Done {
  hash: Hash;
  block: number;
  /** A link to the transaction on the public explorer. */
  explorer: string;
  /** Gas the VERIFY frame used. */
  verifyGas: number | null;
  /** Why the normal mempool would have refused this, in its own words, or null if it would have taken it. */
  canonicalRefusal: string | null;
}

export interface QueuedItem {
  id: string;
  to: Address;
  /** Decimal ETH. */
  amount: string;
  /** Unix seconds when it can go through. */
  executeAfter: number;
  /** true when this is a key recovery, not a payment. */
  isRecovery: boolean;
  /** true when this device did not ask for it, as far as it knows. */
  unknownToThisDevice: boolean;
}

export interface HistoryItem {
  kind: "sent" | "queued" | "cancelled" | "paid" | "frozen" | "unfreeze" | "escaped" | "rotated" | "received" | "shielded" | "unshielded" | "private-sent" | "private-claimed" | "recovery-set" | "exit-set" | "recovered" | "funded";
  at: number;
  text: string;
  hash: Hash | null;
  explorer: string | null;
}

export interface Note {
  id: string;
  /** Decimal ETH the note holds. */
  amount: string;
  /** Decimal ETH it pays out, after its fee. */
  payout: string;
  spent: boolean;
}

export interface PrivatePayment {
  id: string;
  account: Address;
  /** Decimal ETH. */
  amount: string;
  claimed: boolean;
}

export interface Snapshot {
  account: Address;
  /** Decimal ETH. */
  balance: string | null;
  frozen: boolean | null;
  escaped: boolean | null;
  dailyLimit: string | null;
  /** How much the wallet key can still send alone today. */
  dailyLeft: string | null;
  delaySeconds: number | null;
  queue: QueuedItem[] | null;
  /** One-time signatures left on the hash key. */
  hashKeyLeft: number | null;
  hashKeyTotal: number;
  /** Is the hash key on this device? false after it was moved to a phone. */
  hashKeyHere: boolean;
  safe: { address: Address; balance: string | null; keyHeld: boolean };
  recoverySet: boolean | null;
  exit: { address: Address; reserve: string | null } | null;
  notes: Note[];
  privatePayments: PrivatePayment[];
  alerts: { telegram: boolean; push: boolean };
  backedUp: boolean;
  history: HistoryItem[];
  /** Latest chain time in unix seconds, which countdowns must use instead of the device clock. */
  chainTime: number | null;
}

export type SendPreview =
  | { route: "instant"; left: string }
  | { route: "queued"; delaySeconds: number; reason: string }
  | { route: "blocked"; reason: string };

export type SendResult = ({ route: "instant" } & Done) | ({ route: "queued"; id: string; executeAfter: number } & Done);

export interface Engine {
  /** Is there a wallet in this browser, and is it open? */
  state(): "empty" | "locked" | "open";
  create(o: CreateOptions, onStep: OnStep): Promise<void>;
  unlock(passphrase: string): Promise<void>;
  lock(): void;
  /** Bring a wallet back from an encrypted backup file's text. */
  restore(backup: string, passphrase: string, onStep: OnStep): Promise<void>;
  /** The encrypted backup as text, for a file. Marks the wallet backed up. */
  backup(): Promise<string>;
  /** Removes the wallet from this browser. A screen must make sure there is a backup first. */
  forget(): void;

  snapshot(): Promise<Snapshot>;
  /** Test ETH from the sponsor. Limited per wallet. */
  topUp(onStep: OnStep): Promise<void>;

  previewSend(to: Address, amount: string): Promise<SendPreview>;
  send(to: Address, amount: string, onStep: OnStep): Promise<SendResult>;
  /** A real theft attempt against yourself: the wallet key tries to take more than the limit, to a fresh address. */
  drill(onStep: OnStep): Promise<SendResult>;

  /** Hash key actions. All need the hash key on this device. */
  notMe(id: string, onStep: OnStep): Promise<Done>;
  payNow(id: string, onStep: OnStep): Promise<Done>;
  freeze(onStep: OnStep): Promise<Done>;
  unfreeze(onStep: OnStep): Promise<Done>;
  escape(onStep: OnStep): Promise<Done>;
  rotate(onStep: OnStep): Promise<Done>;
  setLimit(dailyLimit: string, onStep: OnStep): Promise<Done>;
  /** A payment whose delay has passed: anyone may finish it. */
  finishQueued(id: string, onStep: OnStep): Promise<Done>;
  /** Moves money from the safe, which is a plain address with its key in this wallet. */
  sendFromSafe(to: Address, amount: string, onStep: OnStep): Promise<{ hash: Hash; explorer: string }>;

  /** Stealth. The code is what a person shares to get paid privately. */
  privateCode(): Promise<string>;
  sendPrivately(code: string, amount: string, onStep: OnStep): Promise<Done>;
  scanPrivate(onStep: OnStep): Promise<PrivatePayment[]>;
  claimPrivate(id: string, to: Address, onStep: OnStep): Promise<Done>;

  /** Recovery paper. Returns the words to write down; they are never stored. */
  setupRecovery(delaySeconds: number, onStep: OnStep): Promise<{ paper: string } & Done>;
  /** On a new device, with only the paper and the account address. A new passphrase protects the new key. */
  recover(paper: string, account: Address, passphrase: string, onStep: OnStep): Promise<Done>;

  /** Second way out: its own address, its own money. */
  setupExit(onStep: OnStep): Promise<Done>;
  exitEscape(onStep: OnStep): Promise<Done>;

  /** Private pool. */
  shield(onStep: OnStep): Promise<Done>;
  unshield(noteId: string, to: Address, onStep: OnStep): Promise<Done>;

  /** Alerts. The link opens the Telegram bot and ties it to this account. */
  telegramLink(): Promise<string>;
  enablePush(): Promise<void>;

  /** Moving the hash key to a phone: an encrypted link, valid once. After `confirmMoved`, this device can no longer use it. */
  moveHashKeyLink(): Promise<string>;
  confirmMoved(): Promise<void>;
  /** On the phone, from that link. */
  receiveHashKey(link: string, passphrase: string): Promise<void>;
}
