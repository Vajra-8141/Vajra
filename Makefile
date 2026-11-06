# See JUDGES.md. Needs Docker, Node 22.18 or newer, and pnpm.
.PHONY: judge up down

judge:
	pnpm install --frozen-lockfile --filter @vajra/cli...
	./stack/up.sh
	VAJRA_STACK=local node packages/cli/src/main.ts judge

up:
	./stack/up.sh

down:
	./stack/down.sh
