#!/usr/bin/env bash
set -euo pipefail

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "ERROR: sqlite3 CLI not found." >&2
  exit 1
fi

sqlite3_path="$(command -v sqlite3)"
sqlite3_version_output="$(sqlite3 --version)"
sqlite_version_select_output="$(sqlite3 ':memory:' 'select sqlite_version();')"

if [[ -z "$sqlite3_version_output" ]]; then
  echo "ERROR: sqlite3 --version returned empty output." >&2
  exit 1
fi

if [[ ! "$sqlite_version_select_output" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.][0-9]+)?$ ]]; then
  echo "ERROR: sqlite3 ':memory:' 'select sqlite_version();' returned unexpected output: $sqlite_version_select_output" >&2
  exit 1
fi

printf 'sqlite3 path: %s\n' "$sqlite3_path"
printf 'sqlite3 --version: %s\n' "$sqlite3_version_output"
printf "sqlite3 ':memory:' 'select sqlite_version();': %s\n" "$sqlite_version_select_output"
