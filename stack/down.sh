#!/usr/bin/env bash
# Stops the local mirror. The chain lives in its container, so this also forgets it.
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/env.sh"
docker compose -f "$here/docker-compose.yml" down --remove-orphans
