#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../../.."
ts-node src/sql/runtime-check.ts --managed "$@"
