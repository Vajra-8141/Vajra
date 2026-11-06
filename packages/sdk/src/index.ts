/**
 * viem-style actions for a VAJRA account. Each one takes a client first and works on its own, and `vajraActions` puts them all on
 * a client with `.extend()`.
 *
 * The network comes from the environment, as everywhere in this repo: `VAJRA_STACK=local` is the mirror, and anything else is the
 * public devnet. The client has to agree with it, or the action refuses: a signature for one chain is no use on another.
 */
import {
  type Admission,
  DEVNET,
  ETH,
  type Explanation,
  type FrameReceipt,
  type FrameTx,
  type MasterSigner,
  type Sponsor,
  accountAbi,
  accountState,
  chain,
  explain as coreExplain,
  framesSucceeded,
  ops,
  signDaily,
  signMasterTx,
  signSponsoredDaily,
  signSponsoredMaster,
  simulate as coreSimulate,
  submit,
  useDeployments,
} from "@vajra/core";
import { type Address, type Chain, type Client, type Hex, type Transport, parseAbiItem } from "viem";
import { getBalance, getLogs, readContract } from "viem/actions";

export { chain as vajraChain, useDeployments };
export type { Admission, Explanation, FrameTx, MasterSigner, Sponsor };
export type { Verdict } from "@vajra/core";

export class ChainMismatch extends Error {
  constructor(expected: number, got: number | undefined) {
    super(`this client is on chain ${got ?? "unknown"}, and this process is set up for ${expected}: check VAJRA_STACK`);
    this.name = "ChainMismatch";
  }
}

type VajraClient = Client<Transport, Chain | undefined>;

function requireChain(client: VajraClient) {
  if (client.chain?.id !== DEVNET.chainId) throw new ChainMismatch(DEVNET.chainId, client.chain?.id);
}

export interface Sent {
  hash: Hex;
  block: bigint;
  gasUsed: bigint;
  /** Mined with every frame succeeding. A frame that fails does not fail the transaction. */
  succeeded: boolean;
  receipt: FrameReceipt;
}

/** Whether each mempool would take this, which rule decides, and what to change. `admitted: null` means nobody can say. */
export function simulate(client: VajraClient, a: { tx: FrameTx; block?: string }): Promise<Admission> {
  requireChain(client);
  return coreSimulate(a.tx, a.block);
}

/** Into the alt mempool, and back when mined. The same signed bytes are rebroadcast if the node gives up on them. */
export async function send(client: VajraClient, a: { tx: FrameTx; timeoutMs?: number }): Promise<Sent> {
  requireChain(client);
  const { hash, receipt } = await submit(a.tx, { timeoutMs: a.timeoutMs });
  return { hash, block: BigInt(receipt.blockNumber), gasUsed: BigInt(receipt.gasUsed), succeeded: framesSucceeded(receipt), receipt };
}

/** What happened to a transaction, mined, pending or refused, and what is not known. */
export function explain(client: VajraClient, a: { hash: Hex }): Promise<Explanation> {
  requireChain(client);
  return coreExplain(a.hash);
}

export interface SpendArgs {
  account: Address;
  /** The daily key. It stays in this process. */
  key: Hex;
  dailyKey: Address;
  to: Address;
  amount: bigint;
  /** Omitted: ETH. */
  asset?: Address;
  /** Omitted: the account pays its own gas. */
  sponsor?: Sponsor;
}

/** A daily-key spend. Under the limit it pays at once, and over it, it queues in public. */
export async function spend(client: VajraClient, a: SpendArgs): Promise<Sent> {
  requireChain(client);
  const calls = [ops.spend(a.asset ?? ETH, a.to, a.amount)];
  const tx = a.sponsor
    ? await signSponsoredDaily({ key: a.key, dailyKey: a.dailyKey, account: a.account, calls, sponsor: a.sponsor })
    : await signDaily({ key: a.key, dailyKey: a.dailyKey, account: a.account, calls });
  return send(client, { tx });
}

export interface VetoArgs {
  account: Address;
  signer: MasterSigner;
  id: bigint;
  sponsor?: Sponsor;
}

/** Cancels a queued item with the master key. This spends a one-time leaf, whether or not the veto lands. */
export async function veto(client: VajraClient, a: VetoArgs): Promise<Sent> {
  requireChain(client);
  const { epochSalt } = await accountState(a.account);
  const calls = [ops.veto(a.id)];
  const { tx } = a.sponsor
    ? signSponsoredMaster({ signer: a.signer, account: a.account, epochSalt, calls, sponsor: a.sponsor })
    : signMasterTx({ signer: a.signer, account: a.account, epochSalt, calls, maxHashes: 660 });
  return send(client, { tx });
}

export interface EscapeStatus {
  frozen: boolean;
  /** The harbor stays a commitment until it is used, so this is `null` until then. */
  harbor: Address | null;
  /** `null` when the node would not answer the log query. Unknown is not the same as no. */
  escaped: boolean | null;
  balance: bigint;
}

const ESCAPED = parseAbiItem("event Escaped(address indexed harbor)");

/** Has this account escaped, and to where? */
export async function escapeStatus(client: VajraClient, a: { account: Address }): Promise<EscapeStatus> {
  requireChain(client);
  const [frozen, balance, logs] = await Promise.all([
    readContract(client, { address: a.account, abi: accountAbi as never, functionName: "frozen" as never }) as Promise<boolean>,
    getBalance(client, { address: a.account }),
    getLogs(client, { address: a.account, event: ESCAPED, fromBlock: 0n }).catch(() => null),
  ]);
  const last = logs?.at(-1);
  return { frozen, harbor: last?.args.harbor ?? null, escaped: logs ? logs.length > 0 : null, balance };
}

export function vajraActions() {
  return (client: VajraClient) => ({
    simulate: (a: Parameters<typeof simulate>[1]) => simulate(client, a),
    send: (a: Parameters<typeof send>[1]) => send(client, a),
    explain: (a: Parameters<typeof explain>[1]) => explain(client, a),
    spend: (a: SpendArgs) => spend(client, a),
    veto: (a: VetoArgs) => veto(client, a),
    escapeStatus: (a: Parameters<typeof escapeStatus>[1]) => escapeStatus(client, a),
  });
}
