#!/usr/bin/env bash
# Compiles a circuit, runs its Groth16 setup, and exports the Solidity verifier. Usage: build.sh <name> <VerifierName>
#
# The phase 2 setup here has one contributor, whoever ran this. That person could forge proofs if they kept the entropy.
# It is fine for a demo and it is not fine for anything else. See docs/ZK.md.
set -euo pipefail
cd "$(dirname "$0")/.."

name="$1"
contract="$2"
ptau="ptau/ppot_0080_15.ptau"
want="$(cut -d' ' -f1 ptau/SHA256)"
url="https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_15.ptau"
snarkjs="node node_modules/snarkjs/build/cli.cjs"

[ -f "$ptau" ] || curl -sSL -o "$ptau" "$url"
[ "$(sha256sum "$ptau" | cut -d' ' -f1)" = "$want" ] || { echo "ptau hash mismatch" >&2; exit 1; }

mkdir -p "build/$name"
circom "src/$name.circom" --r1cs --wasm --sym -l node_modules -o "build/$name"
$snarkjs r1cs info "build/$name/$name.r1cs"
$snarkjs groth16 setup "build/$name/$name.r1cs" "$ptau" "build/$name/0.zkey"
head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n' > "build/$name/.entropy"
$snarkjs zkey contribute "build/$name/0.zkey" "build/$name/$name.zkey" --name="vajra" -e="$(cat "build/$name/.entropy")"
rm -f "build/$name/.entropy" "build/$name/0.zkey"
$snarkjs zkey export verificationkey "build/$name/$name.zkey" "build/$name/vkey.json"
$snarkjs zkey export solidityverifier "build/$name/$name.zkey" "build/$name/verifier.sol"

# snarkjs names every verifier Groth16Verifier, and subtracts from gas() before its calls. ERC-7562 only allows GAS when
# a call follows it directly, and these run in a VERIFY frame.
sed -e "s/contract Groth16Verifier/contract $contract/" \
    -e 's/sub(gas(), 2000)/gas()/g' \
    -e 's/pragma solidity >=0.7.0 <0.9.0;/pragma solidity 0.8.28;/' \
    "build/$name/verifier.sol" > "../contracts/src/verifiers/$contract.sol"
rm "build/$name/verifier.sol"
echo "built $name"
