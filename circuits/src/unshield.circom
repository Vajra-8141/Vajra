pragma circom 2.1.9;

include "circomlib/circuits/poseidon.circom";

// Withdraw from the shielded pool, spec 04 section 10, v1: fixed denomination, one note in, nothing shielded out.
//
// The statement: I know a note in this tree, and this is its nullifier. Which leaf stays private. What the chain sees is
// that some note in the pool paid this recipient. Groth16 is pairing-based, so this is NOT post-quantum. See docs/ZK.md.
template Unshield(levels) {
    signal input secret;
    signal input nullifierSeed;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    signal input root;
    signal input nullifierHash;
    signal input recipient;
    signal input denomination;
    signal input accountAddr;
    signal input chainId;

    component note = Poseidon(2);
    note.inputs[0] <== secret;
    note.inputs[1] <== nullifierSeed;

    component serial = Poseidon(1);
    serial.inputs[0] <== nullifierSeed;
    nullifierHash === serial.out;

    component hashers[levels];
    signal left[levels];
    signal right[levels];
    signal level[levels + 1];
    level[0] <== note.out;
    for (var i = 0; i < levels; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;
        // Index 0: this node is the left child. Index 1: the right one.
        left[i] <== level[i] + pathIndices[i] * (pathElements[i] - level[i]);
        right[i] <== pathElements[i] + pathIndices[i] * (level[i] - pathElements[i]);
        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== left[i];
        hashers[i].inputs[1] <== right[i];
        level[i + 1] <== hashers[i].out;
    }
    root === level[levels];

    // A public input in no constraint has a zero point in the verifying key, and any value would pass. These squares are
    // what stop a seen proof being moved to another recipient.
    signal bindRecipient <== recipient * recipient;
    signal bindDenomination <== denomination * denomination;
    signal bindAccount <== accountAddr * accountAddr;
    signal bindChain <== chainId * chainId;
}

component main {public [root, nullifierHash, recipient, denomination, accountAddr, chainId]} = Unshield(20);
