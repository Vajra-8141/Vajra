/**
 * The attacks a stolen daily key or an outsider can try, as signed transactions. `vajra e2e` and the dashboard's break-in panel
 * both build them here, so the buttons send exactly what the test suite sends.
 */
import { type Address, type Hex, encodeFunctionData, keccak256, parseEther, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount, sign } from "viem/accounts";
import { ETH, type FrameTx, accountAbi, dailyTx, leafNonceKey, ops, publicClient, signDaily, signDailyTx, walletMessage, withWalletSignature } from "@vajra/core";

export interface AttackContext {
  account: Address;
  dailyPrivate: Hex;
  daily: Address;
  harborSalt: Hex;
  /** The account's current key tree. */
  root: Hex;
  friend: Address;
  thief: Address;
}

export type AttackGroup = "rank" | "shape" | "outsider";

export interface Attack {
  id: string;
  group: AttackGroup;
  /** The name `vajra e2e` records it under. */
  title: string;
  /** What the attacker is trying, for someone who has not read the contract. */
  plain: string;
  expected: string;
  build: (c: AttackContext) => Promise<FrameTx>;
}

const nonceOf = async (account: Address) => BigInt(await publicClient.getTransactionCount({ address: account }));
const signedBy = (c: AttackContext, calls: Parameters<typeof signDaily>[0]["calls"]) => signDaily({ key: c.dailyPrivate, dailyKey: c.daily, account: c.account, calls });

export const attacks: Attack[] = [
  {
    id: "escape",
    group: "rank",
    title: "daily key calls escape",
    plain: "Sends everything to the thief with the escape call.",
    expected: "EscapeKeyOutranks",
    build: (c) => signedBy(c, [ops.escape(c.thief, c.harborSalt)]),
  },
  {
    id: "harbor",
    group: "rank",
    title: "daily key changes the harbor",
    plain: "Points the harbor at an address the thief controls.",
    expected: "HarborImmutable",
    build: (c) => signedBy(c, [ops.setHarbor(keccak256("0x01"))]),
  },
  {
    id: "rotate",
    group: "rank",
    title: "daily key rotates the master tree",
    plain: "Replaces your hash key with one the thief made.",
    expected: "EscapeKeyOutranks",
    build: (c) => signedBy(c, [ops.rotateRoot(keccak256("0x02"))]),
  },
  {
    id: "raise-limit",
    group: "rank",
    title: "daily key raises its own limit",
    plain: "Sets the daily limit to 100 ETH.",
    expected: "EscapeKeyOutranks",
    build: (c) => signedBy(c, [ops.setRule(ETH, parseEther("100"), parseEther("100"))]),
  },
  {
    id: "replace-daily",
    group: "rank",
    title: "daily key replaces itself",
    plain: "Locks you out by installing a new daily key.",
    expected: "EscapeKeyOutranks",
    build: (c) => signedBy(c, [ops.setDailyKey(c.thief)]),
  },
  {
    id: "veto",
    group: "rank",
    title: "daily key vetoes",
    plain: "Cancels a queued item, as only the hash key may.",
    expected: "EscapeKeyOutranks",
    build: (c) => signedBy(c, [ops.veto(0n)]),
  },
  {
    id: "burn-leaf",
    group: "shape",
    title: "daily key burns a master leaf's nonce key",
    plain: "Uses up one of your one-time keys, so it can never sign.",
    expected: "DailyNonceKeyInvalid",
    build: (c) =>
      signDailyTx({ ...dailyTx({ account: c.account, dailyKey: c.daily, nonce: 0n, calls: [ops.spend(ETH, c.daily, 0n)], verifyGas: 97_000n }), nonceSeq: 0n, nonceKeys: [leafNonceKey(c.root, 63)] }, c.dailyPrivate),
  },
  {
    id: "second-frame",
    group: "shape",
    title: "daily key adds a second SENDER frame straight to the thief",
    plain: "Hides a direct payment in an extra frame, past the rules.",
    expected: "FrameNotAllowed",
    build: (c) => signedBy(c, [ops.spend(ETH, c.friend, 1n), { target: c.thief, data: "0x", value: parseEther("0.003"), execution: 50_000n, state: 200_000n }]),
  },
  {
    id: "attach-value",
    group: "shape",
    title: "daily key attaches value to its call to the account",
    plain: "Sends value along with an allowed call.",
    expected: "FrameNotAllowed",
    build: (c) => signedBy(c, [{ ...ops.spend(ETH, c.friend, 1n), value: parseEther("0.003") }]),
  },
  {
    id: "fee-burn",
    group: "shape",
    title: "daily key burns the balance through fees",
    plain: "Sets an enormous gas price, so the fee itself drains the account.",
    expected: "DailyTxCostExceeded",
    build: async (c) => {
      const tx = dailyTx({ account: c.account, dailyKey: c.daily, nonce: await nonceOf(c.account), calls: [ops.spend(ETH, c.thief, 1n)] });
      return signDailyTx({ ...tx, fees: { ...tx.fees, maxFeePerGas: 1_000_000_000_000n, maxPriorityFeePerGas: 1_000_000_000_000n } }, c.dailyPrivate);
    },
  },
  {
    id: "split-approval",
    group: "shape",
    title: "daily key splits approval across two frames to dodge the fee cap",
    plain: "Approves payment in a separate frame, so no single frame shows the whole fee.",
    expected: "DailyTxCostExceeded",
    build: async (c) => {
      const tx = dailyTx({ account: c.account, dailyKey: c.daily, nonce: await nonceOf(c.account), calls: [ops.spend(ETH, c.thief, 1n)] });
      const verify = (scope: number, flags: number) => ({
        ...tx.frames[0]!,
        flags,
        // Small enough that the mempool's cap lets this through to the account's own check.
        limits: { execution: 45_000n, state: 0n },
        data: encodeFunctionData({ abi: accountAbi, functionName: "validateDaily", args: [scope] }),
      });
      return signDailyTx({ ...tx, fees: { ...tx.fees, maxFeePerGas: 1_000_000_000_000n, maxPriorityFeePerGas: 1_000_000_000_000n }, frames: [verify(2, 2), verify(1, 1), tx.frames[1]!] }, c.dailyPrivate);
    },
  },
  {
    id: "stranger",
    group: "outsider",
    title: "a stranger signs as the daily key",
    plain: "Someone with no key at all signs a payment.",
    expected: "NotDailyKey",
    build: async (c) => {
      const stranger = generatePrivateKey();
      return signDailyTx(dailyTx({ account: c.account, dailyKey: privateKeyToAccount(stranger).address, nonce: await nonceOf(c.account), calls: [ops.spend(ETH, c.thief, 1n)] }), stranger);
    },
  },
  {
    id: "old-signature",
    group: "outsider",
    title: "an old signature over an unrelated message",
    plain: "Reuses a signature the owner once gave some website.",
    expected: "SignatureNotBoundToTransaction",
    build: async (c) => {
      // Any signature the key ever made must be worthless here, even one for a message that has nothing to do with this.
      const old = keccak256(toHex("a message the owner once signed on some website"));
      const s = await sign({ hash: old, privateKey: c.dailyPrivate });
      const packed = `0x${(s.yParity ?? 0).toString(16).padStart(2, "0")}${s.r.slice(2)}${s.s.slice(2)}` as Hex;
      const tx = dailyTx({ account: c.account, dailyKey: c.daily, nonce: await nonceOf(c.account), calls: [ops.spend(ETH, c.thief, parseEther("0.0001"))] });
      return { ...tx, signatures: [{ ...tx.signatures[0]!, msg: old, signature: packed }] };
    },
  },
  {
    id: "moved-signature",
    group: "outsider",
    title: "a wallet signature moved onto a different recipient",
    plain: "Takes a signature you gave for one payment and points it at the thief.",
    expected: "SignatureNotBoundToTransaction",
    build: async (c) => {
      const nonce = await nonceOf(c.account);
      const honest = dailyTx({ account: c.account, dailyKey: c.daily, nonce, calls: [ops.spend(ETH, c.friend, 1n)] });
      const approved = await privateKeyToAccount(c.dailyPrivate).signMessage({ message: { raw: walletMessage(honest) } });
      return { ...withWalletSignature(honest, approved), frames: dailyTx({ account: c.account, dailyKey: c.daily, nonce, calls: [ops.spend(ETH, c.thief, 1n)] }).frames };
    },
  },
];

export const attack = (id: string) => attacks.find((a) => a.id === id)!;
