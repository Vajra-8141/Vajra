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

# The dashboard, against the mirror, at http://localhost:3000, with no wallet needed. Run `make judge` first. With a bot in .env, the phone watcher starts too.
dashboard:
	pnpm install --frozen-lockfile --filter @vajra/dashboard...
	(VAJRA_STACK=local node packages/cli/src/main.ts bridge & echo $$! > .stack/bridge.pid)
	if grep -q '^TELEGRAM_BOT_TOKEN=.' .env 2>/dev/null; then (VAJRA_STACK=local node packages/cli/src/main.ts watch --allow-software-pay > .stack/watch.log 2>&1 & echo $$! > .stack/watch.pid); fi
	VAJRA_STACK=local pnpm --filter @vajra/dashboard dev -p $$((3000 + $${VAJRA_LANE:-0} * 100)); kill `cat .stack/bridge.pid` `cat .stack/watch.pid 2>/dev/null` 2>/dev/null
