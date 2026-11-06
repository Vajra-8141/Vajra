# See JUDGES.md. Needs Docker, Node 22.18 or newer, and pnpm.
.PHONY: judge up down unpatched dashboard

judge:
	pnpm install --frozen-lockfile --filter @vajra/cli...
	./stack/up.sh
	VAJRA_STACK=local node packages/cli/src/main.ts judge

up:
	./stack/up.sh

down:
	./stack/down.sh

# The sidecar as deployed, beside the patched one, for `vajra compare`. Adds about 90 seconds, once.
unpatched:
	./stack/unpatched.sh

# The dashboard, against the mirror, at http://localhost:3000. Run `make judge` first.
dashboard:
	(VAJRA_STACK=local node packages/cli/src/main.ts bridge & echo $$! > .stack/bridge.pid)
	VAJRA_STACK=local pnpm --filter @vajra/dashboard dev; kill `cat .stack/bridge.pid` 2>/dev/null
