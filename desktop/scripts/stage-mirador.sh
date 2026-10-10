#!/bin/sh
# Stages the committed Mirador the host runs, with its production dependencies, in release/mirador for a release build.
set -eu
desktop="$(cd "$(dirname "$0")/.." && pwd)"
stage="$desktop/release/mirador"
rm -rf "$stage"
mkdir -p "$stage"
git -C "$desktop/.." archive HEAD host web shared bin scripts/mirador-message package.json bun.lock patches tsconfig.json | tar -x -C "$stage"
cd "$stage"
bun install --production --frozen-lockfile
# Mirador runs the Claude Code installed on the computer, so the copy claude-agent-acp's SDK bundles only takes room.
rm -rf node_modules/@anthropic-ai/claude-agent-sdk-*
bun "$desktop/scripts/prune-unused-modules.ts" "$stage"
