#!/usr/bin/env sh
# Launcher for macOS / Linux.
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  EmuSteam needs Node.js 20 or newer."
  echo "  Install it from https://nodejs.org  then run this script again."
  echo
  exit 1
fi

exec node src/main.mjs "$@"
