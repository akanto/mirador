#!/bin/sh
# Stages the committed Mirador the host runs, with its production dependencies, in release/mirador for a release build.
set -eu
desktop="$(cd "$(dirname "$0")/.." && pwd)"
stage="$desktop/release/mirador"
rm -rf "$stage"
mkdir -p "$stage"
git -C "$desktop/.." archive HEAD host web shared bin scripts/mirador-message package.json bun.lock tsconfig.json | tar -x -C "$stage"
cd "$stage"
bun install --production --frozen-lockfile
