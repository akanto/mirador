#!/usr/bin/env bash
# Runs the Playwright specs you name, or all of them, on this machine against a copy of this working tree: the checkout
# can keep being edited while a run is in flight, and runs started at the same time, by you or by agents, share
# nothing but the machine. The copy holds the files git tracks or would add; node_modules is the checkout's own.
# Usage: scripts/e2e.sh [Playwright arguments, e.g. e2e/review.spec.ts --workers=2]
# The copy goes once every test passed; otherwise its test-results keep the failures' traces and screenshots.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
copy=$(mktemp -d "${TMPDIR:-/tmp}/mirador-e2e-run-XXXXXX")
echo "running from $copy"

existing() { while IFS= read -r -d '' file; do [[ -e $file ]] && printf '%s\0' "$file"; done; }
# A node_modules that is a symlink isn't ignored as a folder would be; copied, it would take ln below into its target.
(cd "$repo" && git ls-files -z --cached --others --exclude-standard -- ':(exclude)node_modules' | existing | tar --null -T - -cf -) | tar -xf - -C "$copy"
ln -s "$repo/node_modules" "$copy/node_modules"

cd "$copy"
status=0
bunx playwright test "$@" || status=$?
if (( status == 0 )); then rm -rf "$copy"; else echo "failure artifacts: $copy/test-results"; fi
exit $status
