#!/usr/bin/env bash
# macOS / Linux: start the failover proxy in the background.
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$DIR/logs"
nohup node "$DIR/src/index.mjs" > "$DIR/logs/failover-proxy.out" 2>&1 &
echo "Started (pid $!). Config: $DIR/failover-proxy.json (copy from config.example.json first)"
