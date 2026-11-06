pragma circom 2.1.9;

include "circomlib/circuits/poseidon.circom";

// Recovery by proof, spec 04 section 9, Groth16 v1.
//
// The statement: I know s, where Poseidon(s) is this account's recovery commitment, and I am installing this root, on
// this account, under this salt, on this chain. The secret never leaves the prover, and everything else in the
// statement is public, so a proof seen in a mempool is useless for installing any other root.
//
// A 256-bit value does not fit in the BN254 scalar field, and the verifier refuses an input that does not fit. So the
// root and the salt arrive as two 128-bit limbs each, which the contract derives from the bytes32 itself.
//
// Groth16 is pairing-based. This proof system is NOT post-quantum. See docs/ZK.md.
template Recovery() {
    signal input s;

    signal input recoveryCommitment;
    signal input newWotsRootHi;
    signal input newWotsRootLo;
    signal input accountAddr;
    signal input epochSaltHi;
    signal input epochSaltLo;
    signal input chainId;
    signal input nullifier;

    // Poseidon has a different round constant set at each width, so these two cannot be confused for each other.
    component commitment = Poseidon(1);
    commitment.inputs[0] <== s;
    recoveryCommitment === commitment.out;

    component spent = Poseidon(2);
    spent.inputs[0] <== s;
    spent.inputs[1] <== accountAddr;
    nullifier === spent.out;

    // A public input that appears in no constraint has a zero point in the verifying key, so any value would pass. These
    // squares are what make the proof commit to the five values the hashes above do not use.
    signal bindRootHi <== newWotsRootHi * newWotsRootHi;
    signal bindRootLo <== newWotsRootLo * newWotsRootLo;
    signal bindSaltHi <== epochSaltHi * epochSaltHi;
    signal bindSaltLo <== epochSaltLo * epochSaltLo;
    signal bindChain <== chainId * chainId;
}

component main {public [recoveryCommitment, newWotsRootHi, newWotsRootLo, accountAddr, epochSaltHi, epochSaltLo, chainId, nullifier]} = Recovery();
