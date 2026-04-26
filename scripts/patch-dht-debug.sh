#!/usr/bin/env bash
# Patch discord-html-transcripts 3.3.0 — inject `debug` as a local dep.
# The package imports `debug` from its downloader/images.js but doesn't
# declare it, so Bun's isolated linker can't resolve it at runtime.
#
# Idempotent: safe to re-run after every `bun install`.
# Run via:  cd apps/rpb-bot && bun run patch:dht   (see package.json)
set -e

ROOT_NM="/home/ubuntu/vps/node_modules/.bun"
DHT="$(find "$ROOT_NM" -maxdepth 1 -name 'discord-html-transcripts@*' -type d | head -1)"
DEBUG_PKG="$(find "$ROOT_NM" -maxdepth 1 -name 'debug@4*' -type d | sort | tail -1)"

[[ -z "$DHT" || -z "$DEBUG_PKG" ]] && {
  echo "[patch-dht] packages not found — skip"
  exit 0
}

TARGET="$DHT/node_modules/debug"
SRC="$DEBUG_PKG/node_modules/debug"

if [[ ! -d "$SRC" ]]; then
  echo "[patch-dht] source debug not found at $SRC"
  exit 0
fi

ln -sfn "$SRC" "$TARGET"
echo "[patch-dht] linked $TARGET → $SRC"
