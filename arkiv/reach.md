# Reach

## Who it is for

- **People holding a stateful hash-based key.** A VAJRA owner who restores a backup or uses a second device is the first case, and
  it is the failure these keys cannot survive.
- **Other wallets.** The registry is not tied to us. Anything using a WOTS tree can read it and verify the records with no account,
  no API and no permission from us, which is the point of putting it on Arkiv rather than on our server.
- **Later, any stateful signature scheme.** LMS and XMSS have the same problem, and production wallets would use those. The schema
  only needs a root, a leaf index and a way to verify.

## Can they try it now?

Yes, on testnets. Both the EIP-8141 devnet and Rabdi are test networks, so there is no real money involved.

**Read it, with nothing installed:** the query in the [README](../README.md#leaf-registry-on-arkiv) runs with plain `curl`.

**Run it:** the [README](../README.md#run-it) gets the dashboard going locally, with a free access key and tGLM from
[hub.arkiv.network](https://hub.arkiv.network) in `.env`. `vajra arkiv` then runs the whole two-copies scenario against the live
networks in about five minutes.

What is not there yet: no hosted dashboard, so a user runs it themselves. The dashboard has been driven with a scripted wallet, not
the MetaMask extension.

## Does development continue after Mumbai?

**TEAM TO ANSWER BEFORE SUBMITTING.** This is a commitment only the team can make, so it has not been written for you. If you do plan
to continue, the honest next steps are below.

- A reservation signed by the key's own holder, so a reader needs no list of trusted wallets.
- A hardware signer that can move past a spent leaf instead of only refusing.
- Retrying a usage record that failed to write.
- LMS or XMSS in place of plain WOTS.
