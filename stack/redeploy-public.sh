#!/usr/bin/env bash
# Deploys the whole suite to the public devnet, after a reset: both implementations and factories, the paymaster, the announcer and
# the registry. Needs a funded .vajra/deployer.key, passed by hand: see HANDOFF.md section 2.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .vajra/deployer.key ] || { echo "no .vajra/deployer.key on this machine" >&2; exit 1; }
[ -z "${VAJRA_STACK:-}" ] || { echo "unset VAJRA_STACK: this is for the public devnet" >&2; exit 1; }
# `deploy` keeps the addresses it already has for the announcer and the registry, and after a reset those are empty.
node -e '
const fs = require("fs"), path = "packages/core/src/deployments/1337.json";
const d = JSON.parse(fs.readFileSync(path, "utf8"));
delete d.announcer; delete d.registry;
fs.writeFileSync(path, JSON.stringify(d, null, 1) + "\n");'
vajra="node packages/cli/src/main.ts"
$vajra deploy
$vajra e2e
$vajra pin
$vajra stealth
echo
echo "Deployed, and e2e, stealth and pin passed. Commit packages/core/src/deployments/1337.json and docs/evidence/."
echo "Then make new demo accounts: HANDOFF.md task 9."
