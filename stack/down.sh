#!/usr/bin/env bash
# Stops the local mirror. The chain lives in the container, so this also forgets it.
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/env.sh"
work="$(dirname "$here")/.stack"
for name in miner sidecar; do
  [ -f "$work/$name.pid" ] && kill "$(cat "$work/$name.pid")" 2>/dev/null
  rm -f "$work/$name.pid"
done
docker rm -f vajra-ethrex >/dev/null 2>&1
# bun does not always leave on SIGTERM, and a sidecar left behind would answer for the new one with an old chain's state.
for _ in 1 2 3 4 5 6; do
  held="$(ss -ltnp 2>/dev/null | grep ":$SIDECAR_PORT " | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u)"
  [ -z "$held" ] && exit 0
  kill -9 $held 2>/dev/null
  sleep 0.5
done
echo "port $SIDECAR_PORT is still held" >&2
exit 1
