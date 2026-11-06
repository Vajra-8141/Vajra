#!/usr/bin/env bash
# Puts the nonce-key fix on the public devnet: a new w=16 implementation and factory, and a new paymaster, because it sponsors the
# implementation by code hash. w=256 is not redeployed. Needs .vajra/deployer.key, passed by hand: see HANDOFF.md section 2.
#
# An account is a clone of one implementation, so an existing account keeps the flaw. Only accounts created after this have the fix.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .vajra/deployer.key ] || { echo "no .vajra/deployer.key on this machine" >&2; exit 1; }
[ -z "${VAJRA_STACK:-}" ] || { echo "unset VAJRA_STACK: this is for the public devnet" >&2; exit 1; }
vajra="node packages/cli/src/main.ts"
$vajra deploy w16
$vajra deploy stealth
$vajra e2e
$vajra stealth
echo
echo "Deployed, and e2e and stealth passed. Commit packages/core/src/deployments/1337.json and docs/evidence/."
echo "Then make new demo accounts: HANDOFF.md task 9."
