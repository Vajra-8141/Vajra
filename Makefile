# See JUDGES.md. Needs Docker, Node 22.18 or newer, and pnpm.
.PHONY: judge up down unpatched

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
