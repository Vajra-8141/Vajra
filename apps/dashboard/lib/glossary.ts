/** Every term the demo leans on, in the words a person new to this would use. */
export const GLOSSARY = {
  wallet: { term: "Wallet", text: "The app you already use to sign, such as MetaMask. VAJRA keeps it. Its key becomes the daily key." },
  "daily-key": { term: "Daily key", text: "Your ordinary wallet key. It can spend up to the daily limit and nothing more, so a thief who steals it inherits the same limit." },
  "hash-key": { term: "Hash key", text: "The master key, built only from hashes, with no curve for a quantum computer to break. It outranks the daily key: it can cancel, freeze and escape. Each signature uses up one one-time key." },
  "daily-limit": { term: "Daily limit", text: "The most the daily key can send in 24 hours without waiting. Anything over it is queued, not refused." },
  cooling: { term: "New-payee cooling", text: "A first payment to an address nobody has paid before is capped at a small allowance until the address has cooled." },
  queue: { term: "Public queue", text: "Where an over-limit payment waits, on chain, where anyone can see it. It leaves when the delay ends, unless the hash key cancels it." },
  veto: { term: "Veto", text: "Cancelling a queued payment. Only the hash key can do it." },
  freeze: { term: "Freeze", text: "Stops every daily-key transaction until the hash key unfreezes the account." },
  harbor: { term: "Harbor", text: "One address, chosen when the account was made, that an escape can send funds to. The chain holds only a hash of it until the escape." },
  escape: { term: "Escape", text: "The hash key sends the whole balance to the harbor and freezes the account for good. A stolen daily key cannot stop it or redirect it." },
  "one-time-key": { term: "One-time key", text: "A hash signature reveals part of its secret, so each one can sign once. The account holds a tree of them." },
  "frame-transaction": { term: "Frame transaction", text: "EIP-8141's transaction type. It is a list of frames, so an account can check its own signature in code instead of relying on one built-in curve." },
  "verify-frame": { term: "VERIFY frame", text: "The frame in which an account decides whether a transaction is valid. Mempools run it before they accept anything, so they limit its gas." },
  "sender-frame": { term: "SENDER frame", text: "The frame that does the work: the payment, or the call to the account." },
  "canonical-mempool": { term: "Canonical mempool", text: "The node's own waiting room for transactions. It refuses a validation prefix over 100,000 gas, and holds one kind of nonce per sender at a time." },
  "alt-mempool": { term: "Alt mempool", text: "A separate waiting room for frame transactions, run by a sidecar next to the node, under the ERC-8421 rules. This track is about it." },
  sidecar: { term: "Sidecar", text: "The process that runs the alt mempool beside the node. Here it is the upstream commit with a small patch that keeps per-entity gas budgets." },
  nonce: { term: "Nonce", text: "A counter that stops a transaction being used twice. A one-time key has its own nonce, separate from the daily key's." },
  stake: { term: "Stake", text: "ETH locked in a registry. A staked sender gets a larger validation budget, because it has something to lose." },
  reputation: { term: "Reputation", text: "The sidecar's count of how many transactions it saw from an address and how many landed. An address with too few landing is throttled, then banned." },
  mirror: { term: "Mirror", text: "A full copy of the devnet on this machine: the same two upstream commits, its own chain id, 13370, so a result here cannot pass for a public one." },
  "demo-signer": { term: "Demo signer", text: "On the mirror only, the bridge signs as the daily key with a throwaway key from a local file, so no wallet import is needed. It is not offered on the public chain." },
  bridge: { term: "Bridge", text: "A small local process that holds the hash key. This page asks it for operations by name and never sees the secret." },
} as const;

export type GlossaryId = keyof typeof GLOSSARY;
