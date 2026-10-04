#!/usr/bin/env bash
# Builds the desktop app's Linux installer, installs it in a container the way a user would, and checks it there on a
# virtual display: it opens its window and host, registers itself to open at login, keeps running when its window is
# closed, and a second launch hands over to it and quits, bringing its window back.
# Usage: [MIRADOR_LINUX_ARCH=x64|arm64] [MIRADOR_LINUX_RELEASE=1] scripts/linux-desktop.sh
# MIRADOR_LINUX_RELEASE=1 builds the release installer instead, the one to hand out: from the committed files only (run
# it from the main checkout or a clone, as the container clones it), carrying Mirador and Linux production dependencies,
# with no path from the container baked in; the checks then also see the host run the copy inside the app.
# The installer, screenshots and logs are saved to $results.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
source "$repo/scripts/linux-common.sh"
release=${MIRADOR_LINUX_RELEASE:-0}
results="${TMPDIR:-/tmp}/mirador-linux-desktop-$arch$([ "$release" = 1 ] && echo -release)"
rm -rf "$results" && mkdir -p "$results"

build_image linux-test
build_image linux-desktop

run_in_container --volume "$results:/results" --env "RELEASE=$release" "mirador-linux-desktop-$arch" bash -c '
    set -uo pipefail
    if [ "$RELEASE" = 1 ]; then
      git -c safe.directory="*" clone --quiet /src /tmp/mirador || { echo "clone failed: run it from the main checkout or a clone"; exit 1; }
      echo "== release of $(git -C /tmp/mirador describe --tags --always)"
    else
      mkdir /tmp/mirador && tar -X /src/scripts/linux-copy.exclude -C /src -cf - . | tar -xf - -C /tmp/mirador
    fi
    cd /tmp/mirador && bun install --frozen-lockfile >/dev/null
    cd desktop && bun install --frozen-lockfile >/dev/null

    echo "== $(uname -m): build the installer"
    if [ "$RELEASE" = 1 ]; then build=(bun run build:release); else build=(bunx electrobun build --env=stable); fi
    "${build[@]}" > /results/build.log 2>&1 || { echo "build failed"; tail -30 /results/build.log; exit 1; }
    cp artifacts/*-Setup.tar.gz /results/
    ls /results/*-Setup.tar.gz

    echo "== install"
    mkdir /tmp/setup && tar -xzf artifacts/*-Setup.tar.gz -C /tmp/setup
    /tmp/setup/installer > /results/install.log 2>&1 || { echo "install failed"; tail -30 /results/install.log; exit 1; }
    launcher=$(find ~/.local/share -path "*/app/bin/launcher" | head -1)
    echo "installed: $launcher"

    failed=()
    check() {
      local what=$1; shift
      if "$@"; then echo "ok: $what"; else echo "FAILED: $what"; failed+=("$what"); fi
    }
    until_true() { for _ in $(seq 120); do "$@" && return 0; sleep 1; done; return 1; }
    display_up() { xdpyinfo >/dev/null 2>&1; }
    host_answers() { curl -fs -o /dev/null http://127.0.0.1:4600/; }
    window_shown() { xdotool search --name "^Mirador$" >/dev/null 2>&1; }
    window_gone() { ! window_shown; }
    app_running() { kill -0 "$app" 2>/dev/null; }

    echo "== start on a virtual display"
    export DISPLAY=:99
    Xvfb :99 -screen 0 1600x1000x24 -nolisten tcp >/dev/null 2>&1 &
    until_true display_up
    openbox >/dev/null 2>&1 &
    "$launcher" > /results/app.log 2>&1 &
    app=$!
    check "the host answers" until_true host_answers
    if [ "$RELEASE" = 1 ]; then
      host_folder=$(readlink "/proc/$(pgrep -f " host/main.ts$" | head -1)/cwd")
      check "it runs the Mirador inside the app ($host_folder)" test "${host_folder#"$HOME"/.local/share/com.sodre90.mirador/}" != "$host_folder"
    fi
    check "the window opens" until_true window_shown
    sleep 10
    import -window root /results/window.png
    check "it opens at login" test -f ~/.config/autostart/mirador-4600.desktop

    wmctrl -c Mirador
    check "closing the window closes it" until_true window_gone
    check "and keeps the app running" app_running

    start=$(date +%s)
    timeout 30 "$launcher" > /results/second-launch.log 2>&1
    second_launch_exit=$?
    check "a second launch hands over and quits ($(( $(date +%s) - start ))s)" test "$second_launch_exit" = 0
    check "and the running app brings its window back" until_true window_shown
    sleep 5
    import -window root /results/window-reopened.png

    kill "$app" 2>/dev/null
    if (( ${#failed[@]} )); then echo "FAILED: ${failed[*]}"; exit 1; fi
    echo "ALL PASSED"
  '
