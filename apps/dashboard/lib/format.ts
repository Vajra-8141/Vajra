import { formatEther } from "viem";
import { refusalName } from "@vajra/core";

export const REFUSALS: Record<string, string> = {
  AccountFrozen: "The account is frozen. Only the hash key can unfreeze it.",
  EscapeKeyOutranks: "That needs the hash key. The daily key cannot do it.",
  HarborImmutable: "Only the hash key can change the harbor.",
  NotDailyKey: "This signer is not the account's daily key.",
  ChainStateUnknown: "The chain's key tree does not match this signer, so it will not sign.",
  TreeExhausted: "No one-time keys left. Rotate to a new tree.",
  DailyNonceKeyInvalid: "The daily key may only use the linear nonce. One-time keys stay out of its reach.",
  FrameNotAllowed: "A daily transaction has one shape: validate, then call the account. Anything else is refused.",
  DailyTxCostExceeded: "The most this transaction could cost in fees is over the account's cap.",
  SignatureNotBoundToTransaction: "The signature does not cover this exact transaction.",
  QueuedPendingTimelock: "The delay has not passed. The item cannot run yet.",
};

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const eth = (wei: bigint) => `${Number(formatEther(wei)).toLocaleString(undefined, { maximumFractionDigits: 6 })} ETH`;
export const gas = (value: string | number | bigint) => BigInt(value).toLocaleString();

export const explain = (error: unknown) => {
  const name = refusalName((error as Error).message);
  return REFUSALS[name] ? `${name}: ${REFUSALS[name]}` : name;
};

export function countdown(seconds: number) {
  if (seconds <= 0) return "matured";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${seconds % 60}s` : `${seconds}s`;
}
