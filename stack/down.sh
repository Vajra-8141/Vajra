#!/usr/bin/env bash
# Stops the local mirror. The chain lives in the container, so this also forgets it.
here="$(cd "$(dirname "$0")" && pwd)"
work="$(dirname "$here")/.stack"
for name in miner sidecar; do
  [ -f "$work/$name.pid" ] && kill "$(cat "$work/$name.pid")" 2>/dev/null
  rm -f "$work/$name.pid"
done
docker rm -f vajra-ethrex >/dev/null 2>&1
exit 0
