/**
 * Moving an ordinary wallet into a VAJRA account, in one frame transaction.
 *
 * An EOA can be the sender of a frame transaction: the protocol checks its signature in a VERIFY frame with no code to run. So the
 * old address sends `[VERIFY, SENDER(factory.create), SENDER(token.transfer)...]`. The account comes into being and receives the ETH in
 * the first SENDER frame, and each token follows. Every frame is tied to the next, so if any transfer fails the account is not
 * created and nothing moves. The EOA stays on as the daily key: you keep your wallet, and it gets a limit.
 *
 * The one thing it cannot move is the refund of its own unused gas, which arrives after the last frame.
 */
import { type Address, type Hex, decodeFunctionResult, encodeFunctionData, parseAbi, parseEther, zeroAddress } from "viem";
import * as lib from "@forshtat/hegota-support/tx";
import { type AccountConfig, ETH } from "@vajra/core/account";
import { DEVNET, rpcBatch } from "@vajra/core/devnet";
import { ATOMIC_BATCH_FLAG, type Fees, type FrameTx, profile } from "@vajra/core/frame";

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address, uint256) returns (bool)"]);
const factoryAbi = parseAbi([
  "struct Config { address dailyKey; bytes32 wotsRoot; bytes32 epochSalt; bytes32 harborCommitment; uint64 queueDelay; uint64 coolingPeriod; uint128 maxDailyTxCost; address[] assets; uint128[] dailyLimits; uint128[] coolingAllowances; address coSigner; uint128 stake; uint32 unstakeDelay; }",
  "function create(Config config) payable returns (address)",
]);

/** The base fee sits at 7 wei, so this still clears it many times over, and it is what decides how much gas refund stays behind. */
export const MOVE_FEES: Fees = { maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000n };

// Limits for each frame. `initialize` writes about 20 new slots at 97,920 state gas each, and each listed token adds a rule.
const VERIFY_GAS = 60_000n;
const CREATE = { execution: 2_000_000n, state: 3_500_000n };
const PER_RULE_STATE = 500_000n;
const TRANSFER = { execution: 400_000n, state: 300_000n };

export interface MoveOptions {
  eoa: Address;
  wotsRoot: Hex;
  epochSalt: Hex;
  harborCommitment: Hex;
  dailyLimit: string;
  coolingAllowance: string;
  queueDelay: number;
  coolingPeriod: number;
  tokens: Address[];
  stake: bigint;
  unstakeDelay: number;
}

/** A listed token starts with a limit of zero: every spend of it queues, until the master key sets a rule. */
export const moveConfig = (o: MoveOptions): AccountConfig => ({
  dailyKey: o.eoa,
  wotsRoot: o.wotsRoot,
  epochSalt: o.epochSalt,
  harborCommitment: o.harborCommitment,
  queueDelay: BigInt(o.queueDelay),
  coolingPeriod: BigInt(o.coolingPeriod),
  maxDailyTxCost: parseEther("0.01"),
  assets: [ETH, ...o.tokens],
  dailyLimits: [parseEther(o.dailyLimit), ...o.tokens.map(() => 0n)],
  coolingAllowances: [parseEther(o.coolingAllowance), ...o.tokens.map(() => 0n)],
  ...(o.stake ? { stake: o.stake, unstakeDelay: o.unstakeDelay } : {}),
});

const complete = (config: AccountConfig) => ({ coSigner: zeroAddress, stake: 0n, unstakeDelay: 0, ...config });

export interface MoveHoldings {
  nonce: bigint;
  ether: bigint;
  tokens: { address: Address; balance: bigint }[];
}

/** Throws if anything cannot be read: moving "everything" on a balance that failed to load would leave money behind. */
export async function readHoldings(eoa: Address, tokens: Address[]): Promise<MoveHoldings> {
  const [nonce, ether, code, ...balances] = await rpcBatch<Hex>(DEVNET.execution, [
    { method: "eth_getTransactionCount", params: [eoa, "latest"] },
    { method: "eth_getBalance", params: [eoa, "latest"] },
    { method: "eth_getCode", params: [eoa, "latest"] },
    ...tokens.map((token) => ({ method: "eth_call", params: [{ to: token, data: encodeFunctionData({ abi: erc20, functionName: "balanceOf", args: [eoa] }) }, "latest"] })),
  ]);
  if (code !== "0x") throw new Error(`${eoa} is a contract, not a key`);
  return {
    nonce: BigInt(nonce!),
    ether: BigInt(ether!),
    tokens: tokens.map((address, i) => ({ address, balance: decodeFunctionResult({ abi: erc20, functionName: "balanceOf", data: balances[i]! }) })),
  };
}

export interface MovePlan {
  tx: FrameTx;
  account: Address;
  /** ETH that goes to the account, before its stake is taken. */
  ether: bigint;
  /** The most the transaction can cost. Whatever it does not use comes back to the EOA. */
  maxCost: bigint;
  tokens: { address: Address; balance: bigint }[];
}

/**
 * The whole transaction, unsigned. A token with no balance still gets a rule, and no transfer frame: a transfer of nothing could
 * only fail the batch for no gain.
 */
export function planMove(a: { factory: Address; account: Address; config: AccountConfig; eoa: Address; holdings: MoveHoldings; fees?: Fees }): MovePlan {
  const fees = a.fees ?? MOVE_FEES;
  const tokens = a.holdings.tokens.filter((token) => token.balance > 0n);
  const create = { execution: CREATE.execution, state: CREATE.state + PER_RULE_STATE * BigInt(a.config.assets.length) };
  const gas = VERIFY_GAS + create.execution + create.state + BigInt(tokens.length) * (TRANSFER.execution + TRANSFER.state);
  // Intrinsic gas sits on top of the frame limits. This over-reserves, and the difference is refunded.
  const maxCost = (gas + 200_000n) * fees.maxFeePerGas;
  const ether = a.holdings.ether - maxCost;
  if (ether <= (a.config.stake ?? 0n)) throw new Error(`${a.eoa} holds too little ETH to pay for the move and the account's stake`);

  const frames = [
    lib.frame(profile, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", execution: VERIFY_GAS, data: "0x" }),
    lib.frame(profile, "SENDER", {
      target: a.factory,
      execution: create.execution,
      state: create.state,
      value: ether,
      data: encodeFunctionData({ abi: factoryAbi, functionName: "create", args: [complete(a.config)] }),
      flags: tokens.length ? ATOMIC_BATCH_FLAG : 0,
    }),
    ...tokens.map((token, i) =>
      lib.frame(profile, "SENDER", {
        target: token.address,
        execution: TRANSFER.execution,
        state: TRANSFER.state,
        value: 0n,
        data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [a.account, token.balance] }),
        flags: i < tokens.length - 1 ? ATOMIC_BATCH_FLAG : 0,
      }),
    ),
  ];
  const tx = lib.newTx({
    chainId: DEVNET.chainId,
    sender: a.eoa,
    nonceSeq: a.holdings.nonce,
    fees: { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? fees.maxFeePerGas },
    signatures: [lib.secp256k1Placeholder(profile, a.eoa)],
    frames,
  });
  return { tx, account: a.account, ether, maxCost, tokens };
}
