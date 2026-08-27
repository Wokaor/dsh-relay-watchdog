#!/bin/bash
# Build helper for dsh-relay-watchdog.
# If a real DSH source checkout (packages/) is available, compile src -> lib with its tsc.
# Otherwise the plugin ships a prebuilt lib/, so just validate it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CHECKOUT="${DSH_CHECKOUT:-}"
if [ -z "$CHECKOUT" ]; then
  for c in "$HOME/dsh-harness" "$HOME/dsh" "$HOME/.dsh/dsh-harness"; do
    if [ -d "$c/packages" ]; then CHECKOUT="$c"; break; fi
  done
fi

if [ -n "$CHECKOUT" ] && [ -d "$CHECKOUT/packages" ]; then
  TSC="$CHECKOUT/node_modules/.bin/tsc"
  if [ -x "$TSC" ] || [ -f "$TSC.cmd" ]; then
    echo "=== compile src -> lib (checkout: $CHECKOUT) ==="
    "$TSC" -p tsconfig.json
    exit 0
  fi
fi

echo "=== no dsh checkout/tsc found; validating shipped lib/ ==="
node --check lib/index.js
echo "=== build ok (prebuilt lib) ==="