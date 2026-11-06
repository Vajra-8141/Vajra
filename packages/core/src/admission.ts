/**
 * Would this transaction get in, on each mempool, and if not, what is the rule and what is the fix?
 *
 * The canonical answer is ethrex's own, from `ethrex_simulateFrameTransaction`.
 *
 * The sidecar has no dry run for a signed transaction: `eth_estimateFrameTransactionGas` rewrites the body frames' limits, which
 * breaks the signature. Its answer is still used for what it reaches first, the prefix and structure rules. For the rest, the
 * sidecar's rules from `validators/frameTx.ts` at 2e22ff0 are replayed here over ethrex's real ERC-7562 trace, on the patched rule
 * set the mirror runs, and `vajra paymaster-e2e` holds every verdict against what the live sidecar then did.
 *
 * Nothing is inferred. A rule this cannot evaluate is listed in `unverified`, and a verdict it cannot reach is `null`.
 */
import { toWire } from "@forshtat/hegota-support/rpc";
import { type Address, type Hex, encodeFunctionData, decodeFunctionResult, getAddress, keccak256, parseAbi, size } from "viem";
import { DEVNET, RpcError, isLocalStack, rpc } from "./devnet.ts";
import { type FrameReceipt, type FrameTx, type SimulationResult, encodeTx, receiptOf, simulateFrames } from "./frame.ts";
import { decodeRefusal, sponsorRefusal } from "./paymaster.ts";

export interface Verdict {
  /** `null` means unknown. It never means no. */
  admitted: boolean | null;
  /** The rule's own id, or `null` when none could be named. */
  rule: string | null;
  /** The contract's error name, when a revert was one of ours. */
  refusal: string | null;
  /** The node's own text. */
  reason: string | null;
  /** What to change, in plain English, or `null` when we have no advice. */
  fix: string | null;
  source: "ethrex" | "sidecar" | "trace" | "explorer" | "chain" | "none";
  /** Rules that could not be evaluated here. An `admitted: true` holds only for the rules that were. */
  unverified: string[];
}

export type Admission = SimulationResult & { canonical: Verdict; alt: Verdict };

const unknown = (reason: string, unverified: string[] = []): Verdict => ({ admitted: null, rule: null, refusal: null, reason, fix: null, source: "none", unverified });

/** By contract error name, then by rule id. Anything not here gets no advice rather than a guess. */
const FIXES: Record<string, string> = {
  OverQuota: "This account has used today's gas quota. Wait for the next window, lower the frames' gas limits (the quota is charged the maximum until settle), or ask the paymaster's owner to raise it.",
  NotEnrolled: "The paymaster's owner has not enrolled this account. Ask them to, or pay for gas another way.",
  FeeTooHigh: "Lower max_fee_per_gas to the paymaster's feeCap or below.",
  BlobsNotSponsored: "Send the blobs in a transaction that pays for itself.",
  ChargeFrameMissing: "Put the paymaster's charge frame directly before its pay frame. `sponsored` does this.",
  ChargeFrameStarved: "Raise the charge frame's limits to the paymaster's CHARGE_GAS and CHARGE_STATE_GAS.",
  ChargeFrameFailed: "The charge frame reverted. Read its frame in `vajra explain`.",
  SettleFrameMissing: "End the transaction with the paymaster's settle frame, pointing at the charge frame's index.",
  SettleFrameStarved: "Raise the settle frame's execution limit to SETTLE_GAS.",
  PriceChanged: "The owner changed the price since you signed. Read the new one, and sign again if you accept it.",
  InsufficientUsdc: "The account does not hold enough USDC for the transaction's maximum cost. Lower the gas limits or top it up.",
  InsufficientAllowance: "Have the master key approve the paymaster for at least the transaction's maximum cost in USDC.",
  AccountFrozen: "The account is frozen. The master key can unfreeze it.",
  NotDailyKey: "Sign with the account's current daily key.",
  BadMasterSignature: "Sign with the current key tree.",
  EscapeKeyOutranks: "Only the master key can do this.",
  FrameNotAllowed: "The daily key can only call spend and executeQueued on the account itself, with no value.",
  DailyTxCostExceeded: "Lower the fee or the gas limits, or use the master key.",
  DailyNonceKeyInvalid: "The daily key stays on the linear nonce.",
  SignatureNotBoundToTransaction: "Sign this exact transaction: any other signature is worthless here.",
  "gas-limit": "Lower the frames' gas limits: their sum is over what this node takes.",
  prefix: "Use a shape the mempools recognise: [pre_verify?, self_verify], or [pre_verify?, only_verify, pre_verify?, pay], with an optional deploy first.",
  structure: "Fix the prefix: only_verify must target the sender, no atomic flag in the prefix, and no VERIFY frame after it.",
  signature: "Sign this exact transaction, with the key its signature entry names.",
  "BUDGET-010": "Lower the frame's validation gas limit, or stake the entity for the 1,000,000 budget.",
  "OP-011": "Validation used an opcode the mempool bans. Move that read out of validation, into a SENDER or post-op frame.",
  "OP-061": "Validation may not send value. Move the transfer to a later frame.",
  "out-of-gas": "A call inside validation ran out of gas. Raise that frame's limit.",
  storage: "Validation touched storage that needs a stake. Stake the entity above the minimum, or stop reading that slot in validation.",
  "COD-010": "Validation called an address with no code. Deploy it first, or remove the call.",
  mempool: "The pool refused it. A pending transaction may hold this nonce: wait, or replace it with a higher fee.",
  "MAX_VERIFY_GAS": "The canonical mempool caps the whole prefix at 100,000 gas, stake or no stake. Lower the limits, or use the alt mempool.",
  StorageReadNonSender: "The canonical mempool lets validation read only the sender's storage. Anything that reads a paymaster's storage belongs in the alt mempool.",
  StateWriteOutsideDeploy: "The canonical mempool lets nothing write during validation. A pre_verify frame that writes belongs in the alt mempool.",
  CallToNonexistentOrDelegated: "Validation called an address with no code, or a delegated one. On the canonical mempool that is final.",
  BannedOpcode: "Validation used an opcode the mempool bans. Move that read out of validation.",
  "nonce-domain": "Another transaction from this sender is pending on the other kind of nonce. The canonical mempool will not hold both, and the alt mempool will.",
  nonce: "That nonce is spent or not reached yet. Read the current one and sign again.",
};

/** ethrex's own words for each canonical rule. */
const CANONICAL_RULES: [RegExp, string][] = [
  [/StorageReadNonSender/, "StorageReadNonSender"],
  [/StateWriteOutsideDeploy/, "StateWriteOutsideDeploy"],
  [/CallToNonexistentOrDelegated/, "CallToNonexistentOrDelegated"],
  [/BannedOpcode/, "BannedOpcode"],
  [/MAX_VERIFY_GAS/, "MAX_VERIFY_GAS"],
  [/other nonce-key domain/, "nonce-domain"],
  [/[Nn]once/, "nonce"],
  [/does not authenticate the sender/, "signature"],
];

const OUT_OF_GAS_FIX = "A frame ran out of gas. Raise its execution limit. Whichever frame approves payment needs 20,000 more on a keyed nonce.";

const verdict = (fields: Partial<Verdict> & Pick<Verdict, "admitted" | "source">): Verdict => {
  const v = { rule: null, refusal: null, reason: null, unverified: [], ...fields };
  const fix = (v.refusal && FIXES[v.refusal]) || (v.rule && FIXES[v.rule]) || (v.reason && /out of gas/i.test(v.reason) ? OUT_OF_GAS_FIX : v.reason && /nonce/i.test(v.reason) ? FIXES.nonce! : null);
  return { ...v, fix };
};

function revertOf(sim: SimulationResult): { data: Hex | null; refusal: string | null } {
  const data = (sim as SimulationResult & { revertData?: Hex }).revertData ?? null;
  return { data, refusal: data && data !== "0x" ? decodeRefusal(data) : null };
}

function canonicalVerdict(sim: SimulationResult): Verdict {
  if (sim.canonicalMempoolValid) return verdict({ admitted: true, source: "ethrex" });
  const reason = sim.canonicalMempoolViolation ?? "ethrex gave no reason";
  const { refusal } = revertOf(sim);
  return verdict({ admitted: false, source: "ethrex", reason, refusal, rule: CANONICAL_RULES.find(([pattern]) => pattern.test(reason))?.[1] ?? null });
}

// The trace ethrex returns with `{trace: true}`.
interface TraceCall {
  from: Address;
  to: Address | null;
  type: string;
  value: Hex;
  usedOpcodes: Record<string, number>;
  accessedSlots: { reads: Record<string, unknown>; writes: Record<string, number>; transientReads: Record<string, number>; transientWrites: Record<string, number> };
  contractSize: Record<string, { contractSize: number; opcode: number }>;
  extCodeAccessInfo: string[];
  outOfGas: boolean;
  keccak?: Hex[];
  calls?: TraceCall[];
}

type Traced = SimulationResult & { erc7562Trace: { frameIndex: number; root: TraceCall }[] | null; erc7562TraceError: string | null; failedFrameIndex?: number; haltReason?: string; haltDetail?: string };

const walk = (call: TraceCall): TraceCall[] => [call, ...(call.calls ?? []).flatMap(walk)];

const ENTRY_POINT = "0x00000000000000000000000000000000000000aa";
const MAX_VERIFY_STATE_GAS = 500_000n;
const BUDGET = 100_000n;
const STAKED_BUDGET = 1_000_000n;
const SIGNATURE_COST: Record<number, bigint> = { 0: 100n, 1: 2800n, 2: 6700n };
const STAKED_BALANCE_OPCODES = new Set([0x31, 0x47]);
const BANNED_OPCODES: Record<number, string> = {
  0x3a: "GASPRICE", 0x45: "GASLIMIT", 0x44: "PREVRANDAO", 0x42: "TIMESTAMP", 0x48: "BASEFEE", 0x40: "BLOCKHASH", 0x43: "NUMBER", 0x47: "SELFBALANCE",
  0x31: "BALANCE", 0x32: "ORIGIN", 0x5a: "GAS", 0x41: "COINBASE", 0xff: "SELFDESTRUCT", 0xfe: "INVALID", 0x49: "BLOBHASH", 0x4a: "BLOBBASEFEE",
};
/** What the patch sets, as CALLING-040 lists them: 0x01 to 0x11, and P256VERIFY. */
const PRECOMPILES = new Set([...Array.from({ length: 0x11 }, (_, i) => i + 1), 0x100].map((n) => `0x${n.toString(16).padStart(40, "0")}`));

type Role = "sender" | "payer" | "factory";
type PrefixFrame = { index: number; role: Role };
type Prefix = { payerIndex: number; frames: PrefixFrame[] };

type Kind = "self_verify" | "only_verify" | "pay" | "expiry_verify" | "default" | "user_op" | null;
function kindOf(frame: FrameTx["frames"][number]): Kind {
  const scope = frame.flags & 3;
  if (frame.mode === 1) return scope === 3 ? "self_verify" : scope === 2 ? "only_verify" : scope === 1 ? "pay" : "expiry_verify";
  return frame.mode === 0 ? "default" : frame.mode === 2 ? "user_op" : null;
}

const targetOf = (frame: FrameTx["frames"][number], sender: Address) => getAddress(frame.target ?? sender);

/** `recognizeValidationPrefix`. */
function skeleton(frames: FrameTx["frames"], start: number, sender: Address): Prefix | null {
  const preVerify = (at: number, role: Role): PrefixFrame | null => {
    const candidate = frames[at - 1];
    if (!candidate || kindOf(candidate) !== "default" || targetOf(candidate, sender) !== targetOf(frames[at]!, sender)) return null;
    return { index: at - 1, role };
  };
  for (const at of [start, start + 1]) {
    const frame = frames[at];
    if (!frame || kindOf(frame) !== "self_verify") continue;
    const before = at === start + 1 ? preVerify(at, "payer") : null;
    if (at === start + 1 && !before) continue;
    return { payerIndex: at, frames: [...(before ? [before] : []), { index: at, role: "payer" }] };
  }
  for (const at of [start, start + 1]) {
    const frame = frames[at];
    if (!frame || kindOf(frame) !== "only_verify") continue;
    const before = at === start + 1 ? preVerify(at, "sender") : null;
    if (at === start + 1 && !before) continue;
    const head: PrefixFrame[] = [...(before ? [before] : []), { index: at, role: "sender" }];
    for (const pay of [at + 1, at + 2]) {
      const payFrame = frames[pay];
      if (!payFrame || kindOf(payFrame) !== "pay") continue;
      const beforePay = pay === at + 2 ? preVerify(pay, "payer") : null;
      if (pay === at + 2 && !beforePay) continue;
      return { payerIndex: pay, frames: [...head, ...(beforePay ? [beforePay] : []), { index: pay, role: "payer" }] };
    }
  }
  return null;
}

function recognizePrefix(tx: FrameTx): Prefix | null {
  const offset = tx.frames[0] && kindOf(tx.frames[0]) === "expiry_verify" ? 1 : 0;
  const plain = skeleton(tx.frames, offset, tx.sender);
  if (plain) return plain;
  if (tx.frames[offset] && kindOf(tx.frames[offset]!) === "default") {
    const after = skeleton(tx.frames, offset + 1, tx.sender);
    if (after) {
      const deploy = targetOf(tx.frames[offset]!, tx.sender);
      const payer = targetOf(tx.frames[after.payerIndex]!, tx.sender);
      if (deploy !== getAddress(tx.sender) && deploy !== payer) return { ...after, frames: [{ index: offset, role: "factory" }, ...after.frames] };
    }
  }
  return null;
}

function structureFailure(tx: FrameTx, prefix: Prefix): string | null {
  const last = Math.max(...prefix.frames.map((f) => f.index));
  let state = 0n;
  for (let i = 0; i <= last; i++) {
    const frame = tx.frames[i]!;
    const kind = kindOf(frame);
    if ((kind === "self_verify" || kind === "only_verify") && frame.target !== null && frame.target !== tx.sender) return `frame ${i} (${kind}) targets ${frame.target}, expected tx.sender ${tx.sender} or null`;
    if ((frame.flags & 4) !== 0) return `frame ${i} in validation prefix has ATOMIC_BATCH_FLAG set`;
    state += frame.limits.state;
  }
  if (state > MAX_VERIFY_STATE_GAS) return `validation prefix state gas sum ${state} exceeds MAX_VERIFY_STATE_GAS ${MAX_VERIFY_STATE_GAS}`;
  for (let i = last + 1; i < tx.frames.length; i++) {
    if (tx.frames[i]!.mode === 1) return `frame ${i} is a VERIFY frame after the validation prefix (ends at index ${last})`;
  }
  return null;
}

const depositAbi = parseAbi(["function getDepositInfo(address) view returns (uint256 stake, uint32 unstakeDelaySec, uint64 withdrawTime)"]);

async function deposit(entity: Address) {
  const data = await rpc<Hex>(DEVNET.execution, "eth_call", [{ to: DEVNET.stakingRegistry, data: encodeFunctionData({ abi: depositAbi, functionName: "getDepositInfo", args: [entity] }) }, "latest"]);
  const [stake, delay, withdrawTime] = decodeFunctionResult({ abi: depositAbi, functionName: "getDepositInfo", data }) as readonly [bigint, number, bigint];
  return { stake, delay, withdrawTime };
}

/** `slots` is keccak(entity ‖ ...) for each keccak preimage the transaction computed. */
function associated(slot: string, entity: string, preimages: Hex[]): boolean {
  const padded = `0x${entity.slice(2).padStart(64, "0")}`.toLowerCase();
  if (slot === padded) return true;
  const value = BigInt(slot);
  return preimages.some((preimage) => {
    if (!preimage.toLowerCase().startsWith(padded)) return false;
    const base = BigInt(keccak256(preimage));
    return value >= base && value < base + 128n;
  });
}

const refuse = (rule: string, reason: string, unverified: string[] = []) => verdict({ admitted: false, source: "trace", rule, reason, refusal: /reverted with data/.test(reason) ? nameOrNull(reason) : null, unverified });
const nameOrNull = (reason: string) => {
  const name = sponsorRefusal(reason);
  return name === reason ? null : name;
};

/** `FrameTxValidationService.validate` and `checkEntityCompliance`, after the signature, over one traced simulation. */
async function replayRules(tx: FrameTx, prefix: Prefix, sim: Traced, config: SidecarConfig): Promise<Verdict> {
  const unverified = ["mempool", "reputation"];
  if (tx.recentRootReferences?.length) unverified.push("recent-root");

  if (!sim.erc7562Trace) {
    const reason = failureText(sim);
    return refuse(/EIP-8272/.test(reason) ? "recent-root" : "simulation", reason, unverified);
  }
  const last = Math.max(...prefix.frames.map((f) => f.index));
  const roots = sim.erc7562Trace.filter((entry) => entry.frameIndex <= last).sort((a, b) => a.frameIndex - b.frameIndex).map((entry) => entry.root);
  const preimages = sim.erc7562Trace[sim.erc7562Trace.length - 1]?.root.keccak ?? [];

  if (roots.some((root) => walk(root).slice(1).some((call) => BigInt(call.value) > 0n))) return refuse("OP-061", "nested CALL with value during validation", unverified);
  if (sim.executionError) return refuse("execution", sim.executionError, unverified);

  // Stake, as `ReputationService.checkStake` reads it, less the ban list.
  const entities = new Map<Role, { address: string; staked: boolean; stake: bigint }>();
  for (const { index, role } of prefix.frames) {
    const address = role === "sender" ? getAddress(tx.sender) : targetOf(tx.frames[index]!, tx.sender);
    const info = await deposit(address);
    entities.set(role, { address: address.toLowerCase(), stake: info.stake, staked: info.stake >= config.minStake && BigInt(info.delay) >= config.minUnstakeDelay && info.withdrawTime === 0n });
  }

  // BUDGET-010, as the patch has it.
  const stakedEntities = new Set([...entities.values()].filter((e) => e.staked).map((e) => e.address));
  const signatureCost = tx.signatures.reduce((sum, s) => sum + (SIGNATURE_COST[s.scheme] ?? 0n), 0n);
  const gas = new Map<string, bigint>([[tx.sender.toLowerCase(), signatureCost]]);
  const attributed = new Set(prefix.frames.map((f) => f.index));
  for (let i = 0; i <= last; i++) {
    const entity = attributed.has(i) ? targetOf(tx.frames[i]!, tx.sender).toLowerCase() : tx.sender.toLowerCase();
    gas.set(entity, (gas.get(entity) ?? 0n) + tx.frames[i]!.limits.execution);
  }
  for (const [entity, declared] of gas) {
    const staked = stakedEntities.has(entity);
    const budget = staked ? STAKED_BUDGET : BUDGET;
    if (declared > budget) return refuse("BUDGET-010", `entity ${getAddress(entity)} declares ${declared} validation gas, which exceeds ${staked ? "MAX_VERIFY_GAS_STAKED_ENTITY" : "MAX_VERIFY_GAS_PER_ENTITY"} ${budget}`, unverified);
  }

  const sender = tx.sender.toLowerCase();
  const factory = entities.get("factory");
  for (const { index, role } of prefix.frames) {
    const entity = entities.get(role)!;
    const root = roots[index];
    if (!root) return unknown(`no trace for frame ${index}`, unverified);
    const calls = walk(root);
    if (calls.some((call) => call.outOfGas)) return refuse("out-of-gas", `${role} internally reverts on oog`, unverified);

    for (const call of calls) {
      for (const opcode of Object.keys(call.usedOpcodes).map(Number)) {
        const name = BANNED_OPCODES[opcode];
        if (name && !(STAKED_BALANCE_OPCODES.has(opcode) && entity.stake > config.minStake)) return refuse("OP-011", `${role} uses banned opcode: ${name}`, unverified);
        if (role !== "factory" && (opcode === 0xf0 || opcode === 0xf5)) return refuse("create", `${role} uses banned opcode: ${opcode === 0xf0 ? "CREATE" : "CREATE2"}`, unverified);
      }
    }

    // Merged per address, by storage context, as `getAccessInfo` does.
    const access = new Map<string, { read: Set<string>; written: Set<string> }>();
    for (const call of calls) {
      const address = (call.type === "DELEGATECALL" || call.type === "CALLCODE" ? call.from : call.to)!.toLowerCase();
      const seen = access.get(address) ?? { read: new Set(), written: new Set() };
      access.set(address, seen);
      const { reads, writes, transientReads, transientWrites } = call.accessedSlots;
      for (const slot of [...Object.keys(reads), ...Object.keys(transientReads)]) seen.read.add(slot);
      for (const slot of [...Object.keys(writes), ...Object.keys(transientWrites)]) seen.written.add(slot);
    }
    for (const [address, { read, written }] of access) {
      if (address === sender || address === ENTRY_POINT) continue;
      let needsStake: string | undefined;
      for (const slot of [...written, ...read]) {
        if (associated(slot, sender, preimages)) {
          if (factory && !(entity.address === sender && factory.staked)) needsStake = slot;
        } else if (associated(slot, entity.address, preimages) || address === entity.address || !written.has(slot)) {
          needsStake = slot;
        } else {
          return refuse("storage", `${role} has forbidden access to ${address} slot ${slot}`, unverified);
        }
      }
      if (needsStake && !entity.staked) return refuse("storage", `unstaked ${role} accessed ${address} slot ${needsStake}`, unverified);
    }

    for (const call of calls) {
      for (const [address, { contractSize, opcode }] of Object.entries(call.contractSize)) {
        if (address.toLowerCase() !== sender && contractSize <= 2 && !PRECOMPILES.has(address.toLowerCase())) return refuse("COD-010", `${role} accesses un-deployed contract address ${address} with opcode ${opcode}`, unverified);
      }
      if (call.extCodeAccessInfo.some((address) => address.toLowerCase() === ENTRY_POINT)) return refuse("entrypoint-access", `${role} accesses EntryPoint contract address`, unverified);
    }
  }
  return verdict({ admitted: true, source: "trace", unverified });
}

/** The sidecar's `describeStructuredFailure`, or ethrex's words when it gave none. */
function failureText(sim: Traced): string {
  const { data } = revertOf(sim);
  const at = sim.failedFrameIndex === undefined ? null : `validation frame ${sim.failedFrameIndex}`;
  // A bare revert here can be the simulator halting on `FRAMEPARAM STATUS`. The full run's error is the one that says what happened.
  if (at && sim.haltReason === "revert") return data && data !== "0x" ? `${at}: reverted with data ${data}` : `${at}: reverted. ${sim.executionError ?? ""}`.trim();
  if (at && sim.haltReason === "out_of_gas") return `${at}: ran out of gas${sim.haltDetail ? ` (${sim.haltDetail})` : ""}`;
  if (at && sim.haltDetail) return `${at}: ${sim.haltDetail}`;
  // The sidecar reports the first canonical violation here, even when the full run failed for another reason: a replay over the
  // 100,000 cap is refused for its budget, and only the full run says nonce. So both are given.
  const said = sim.canonicalMempoolViolation ?? sim.erc7562TraceError;
  if (said && sim.executionError && said !== sim.executionError) return `${said}. The full run says: ${sim.executionError}`;
  return said ?? sim.executionError ?? "frame transaction simulation failed";
}

interface SidecarConfig {
  minStake: bigint;
  minUnstakeDelay: bigint;
}

async function sidecarConfig(): Promise<SidecarConfig> {
  const config = await rpc<{ minStake: string; minUnstakeDelay: number }>(DEVNET.mempool, "skandha_config");
  return { minStake: BigInt(config.minStake), minUnstakeDelay: BigInt(config.minUnstakeDelay) };
}

/** What the sidecar itself says about the shape. Its later rules are not usable here: see the top of this file. */
async function sidecarShapeRefusal(tx: FrameTx): Promise<Verdict | null> {
  try {
    await rpc(DEVNET.mempool, "eth_estimateFrameTransactionGas", [toWire(tx)]);
    return null;
  } catch (error) {
    if (!(error instanceof RpcError)) throw error;
    if (/prefix not recognized/.test(error.message)) return verdict({ admitted: false, source: "sidecar", rule: "prefix", reason: error.message });
    if (/expected tx\.sender|ATOMIC_BATCH_FLAG|MAX_VERIFY_STATE_GAS|VERIFY frame after/.test(error.message)) return verdict({ admitted: false, source: "sidecar", rule: "structure", reason: error.message });
    return null;
  }
}

async function altVerdict(tx: FrameTx, sim: Traced | null, simError: string | null): Promise<Verdict> {
  const shape = await sidecarShapeRefusal(tx);
  if (shape) return shape;
  if (!isLocalStack) return unknown("The sidecar has no dry run for a signed transaction, and these rules are only checked against the mirror's.", ["all rules after structure"]);

  const declared = tx.frames.reduce((sum, f) => sum + f.limits.execution + f.limits.state, 0n);
  if (declared > 25_000_000n) return refuse("gas-limit", "Frame transaction's gas limit is too high");
  const prefix = recognizePrefix(tx);
  if (!prefix) return refuse("prefix", "frame transaction validation prefix not recognized");
  const structure = structureFailure(tx, prefix);
  if (structure) return refuse("structure", structure);

  if (simError !== null) return refuse("simulation", simError, ["mempool", "reputation"]);
  if (!sim) return unknown("ethrex did not answer");
  if (sim.canonicalMempoolViolation?.includes("does not authenticate the sender")) return refuse("signature", "Invalid frame transaction signature");
  return replayRules(tx, prefix, sim, await sidecarConfig());
}

/**
 * Both verdicts for a transaction, without sending it. Every field `simulateFrames` returns is here too.
 *
 * A node that cannot be reached is unknown, and a node's refusal is an answer.
 */
export async function simulate(tx: FrameTx, block: string = "latest"): Promise<Admission> {
  let sim: Traced | null = null;
  let simError: string | null = null;
  let unreachable: string | null = null;
  try {
    sim = (await simulateFrames(tx, block, isLocalStack)) as Traced;
  } catch (error) {
    if (error instanceof RpcError && error.code < 0) simError = error.message;
    else unreachable = (error as Error).message;
  }

  const canonical: Verdict = sim
    ? canonicalVerdict(sim)
    : simError !== null
      ? verdict({ admitted: false, source: "ethrex", reason: simError, rule: CANONICAL_RULES.find(([pattern]) => pattern.test(simError!))?.[1] ?? null })
      : unknown(unreachable ?? "ethrex did not answer");
  const alt = unreachable !== null ? unknown(unreachable) : await altVerdict(tx, sim, simError).catch((error: Error) => unknown(error.message));
  return { ...(sim as SimulationResult), canonical, alt };
}

export interface ExplainedFrame {
  index: number;
  mode: "DEFAULT" | "VERIFY" | "SENDER" | "UNKNOWN";
  target: Address | "sender";
  status: "success" | "reverted" | "skipped" | "not-run" | "unknown";
  /** `null` when no receipt says. */
  gasUsed: number | null;
  stateGasUsed: number | null;
}

export interface RuleResult {
  rule: string;
  frameIndex?: number;
  entity?: string;
  verdict: string;
  detail?: string;
}

export interface Explanation {
  hash: Hex;
  state: "mined" | "pending" | "rejected" | "dropped" | "replaced" | "unknown";
  block: number | null;
  sender: Address | null;
  payer: Address | null;
  gasUsed: bigint | null;
  frames: ExplainedFrame[];
  canonical: Verdict;
  alt: Verdict;
  /** The sidecar's own rule-by-rule record, when it still has one. */
  checks: RuleResult[] | null;
  /** The sidecar keeps this in memory: a restart or an evicted record is `false` here. */
  explorer: boolean;
}

interface ExplorerDetail {
  entry: { sender: Address; payer: Address; status: string; revertReason?: string } | null;
  admission: {
    outcome: string;
    sender: Address;
    checks: RuleResult[];
    frames: { mode: number; target: Address | null }[];
    frameStatuses: string[];
  } | null;
}

interface MinedTx {
  blockNumber: Hex | null;
  from?: Address;
  sender?: Address;
  chainId: Hex;
  nonceKeys?: Hex[];
  nonceSeq?: Hex;
  frames?: { mode: Hex; flags: Hex; to: Address | null; gasLimit: Hex; stateLimit: Hex; value: Hex; data: Hex }[];
  signatures?: { scheme: Hex | number; signer: Hex | null; msg: Hex; signature: Hex }[];
  maxFeePerGas?: Hex;
  maxPriorityFeePerGas?: Hex;
  maxFeePerBlobGas?: Hex;
  blobVersionedHashes?: Hex[];
}

const MODES = ["DEFAULT", "VERIFY", "SENDER"] as const;

function framesFrom(receipt: FrameReceipt | null, detail: ExplorerDetail | null, mined: MinedTx | null): ExplainedFrame[] {
  const declared = detail?.admission?.frames.map((f) => ({ mode: f.mode, target: f.target })) ?? mined?.frames?.map((f) => ({ mode: Number(BigInt(f.mode)), target: f.to })) ?? [];
  return declared.map((frame, index) => {
    const mined = receipt?.frameReceipts[index];
    const status = mined
      ? mined.status === "0x1" ? "success" : mined.status === "0x2" ? "skipped" : "reverted"
      : ((detail?.admission?.frameStatuses[index] ?? "unknown") as ExplainedFrame["status"]);
    return {
      index,
      mode: MODES[frame.mode] ?? "UNKNOWN",
      target: frame.target ?? "sender",
      status,
      gasUsed: mined ? Number(BigInt(mined.gasUsed)) : null,
      stateGasUsed: mined ? Number(BigInt(mined.stateGasUsed)) : null,
    };
  });
}

/** The first rule the sidecar recorded as failed. */
function altFromRecord(detail: ExplorerDetail, mined: boolean): Verdict {
  const admission = detail.admission!;
  const failed = admission.checks.find((check) => check.verdict === "fail");
  if (failed) {
    const reason = failed.detail ?? null;
    return verdict({ admitted: false, source: "explorer", rule: failed.rule, reason, refusal: reason ? nameOrNull(reason) : null });
  }
  return verdict({ admitted: mined || admission.outcome !== "rejected", source: "explorer" });
}

/** A mined transaction, back into the bytes that were sent, so that it can be asked about on the state it met. */
function rebuild(mined: MinedTx): FrameTx | null {
  if (!mined.frames || !mined.signatures) return null;
  const sender = mined.sender ?? mined.from;
  if (!sender) return null;
  return {
    chainId: BigInt(mined.chainId),
    sender,
    nonceKeys: (mined.nonceKeys ?? ["0x0"]).map(BigInt),
    nonceSeq: BigInt(mined.nonceSeq ?? "0x0"),
    frames: mined.frames.map((f) => ({
      mode: Number(BigInt(f.mode)),
      flags: Number(BigInt(f.flags)),
      target: f.to,
      limits: { execution: BigInt(f.gasLimit), state: BigInt(f.stateLimit) },
      value: BigInt(f.value),
      data: f.data,
    })),
    signatures: mined.signatures.map((s) => ({ scheme: Number(s.scheme), signer: s.signer ?? "0x", msg: s.msg, signature: s.signature })),
    fees: { maxFeePerGas: BigInt(mined.maxFeePerGas ?? "0x0"), maxPriorityFeePerGas: BigInt(mined.maxPriorityFeePerGas ?? "0x0"), maxFeePerBlobGas: BigInt(mined.maxFeePerBlobGas ?? "0x0") },
    blobVersionedHashes: mined.blobVersionedHashes ?? [],
    recentRootReferences: [],
  } as unknown as FrameTx;
}

/**
 * The same questions for a transaction that already happened, mined, pending or refused. The explorer's record is used where the
 * node still has it. The canonical verdict is asked again on the state just before the transaction's block, and only if the
 * transaction can be rebuilt: a refused one never reached the chain, so its canonical verdict is unknown.
 */
export async function explain(hash: Hex): Promise<Explanation> {
  const [receipt, mined, detail] = await Promise.all([
    receiptOf(hash).catch(() => null),
    rpc<MinedTx | null>(DEVNET.execution, "eth_getTransactionByHash", [hash]).catch(() => null),
    rpc<ExplorerDetail | null>(DEVNET.mempool, "skandha_explorer_getTransaction", [hash]).catch(() => null),
  ]);
  const hasRecord = !!detail?.admission;
  const outcome = detail?.admission?.outcome;
  const state: Explanation["state"] = receipt
    ? "mined"
    : outcome === "rejected" ? "rejected" : outcome === "dropped" ? "dropped" : outcome === "replaced" ? "replaced" : outcome === "accepted" || mined ? "pending" : "unknown";

  const alt: Verdict = hasRecord
    ? altFromRecord(detail!, !!receipt)
    : receipt ? verdict({ admitted: true, source: "chain", unverified: ["which rules passed: the sidecar has no record of this"] }) : unknown("The sidecar has no record of this transaction, and the chain does not have it.");

  let canonical = unknown(state === "rejected" ? "The sidecar refused this, so the bytes are gone, and ethrex was never asked." : "The transaction could not be rebuilt from what the node returned.");
  const rebuilt = mined ? rebuild(mined) : null;
  if (rebuilt) {
    const block = receipt ? `0x${(BigInt(receipt.blockNumber) - 1n).toString(16)}` : "latest";
    const then = await simulateFrames(rebuilt, block, false).catch(() => null);
    if (then) canonical = canonicalVerdict(then);
  }
  return {
    hash,
    state,
    block: receipt ? Number(BigInt(receipt.blockNumber)) : null,
    sender: detail?.entry?.sender ?? detail?.admission?.sender ?? mined?.sender ?? mined?.from ?? null,
    payer: detail?.entry?.payer ?? null,
    gasUsed: receipt ? BigInt(receipt.gasUsed) : null,
    frames: framesFrom(receipt, detail ?? null, mined),
    canonical,
    alt,
    checks: detail?.admission?.checks ?? null,
    explorer: hasRecord,
  };
}

/** Says how many bytes, for the CLI's one-line summary. */
export const encodedSize = (tx: FrameTx) => size(encodeTx(tx));
