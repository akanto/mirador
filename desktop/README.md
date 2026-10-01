# Mirador for macOS

A native shell around the localhost host, built with [Electrobun](https://electrobun.dev) 2.0.2 (pinned).
It is a menu bar app that opens the UI in its own window. Closing the window leaves the app in the menu bar; the Dock icon is hidden while no window is open and comes back when you reopen it (menu bar item, or a Dock/app reopen).

The app adds no server of its own. The UI and the host are the existing `bun host/main.ts`.

## Build

Requires Bun on your `PATH` at build time (its absolute path is baked in as the default, see settings).

```bash
cd desktop
bun install
bun run typecheck
bun run build:dev      # build/dev-macos-arm64/Mirador-dev.app
bun run build          # build/stable-macos-arm64/Mirador.app (self-expanding, about 20 MB)
bun run dev            # run from source with Electrobun's dev runner
```

Icons: `assets/app-icon.svg` (app icon) and `assets/tray-icon.svg` (menu bar, drawn black and shown by macOS as a template image) are the sources. `scripts/render-icons.sh` renders `icon.iconset/` and `assets/tray-icon.png` from them; rerun it after editing either SVG. The page's favicon is `web/favicon.svg`.

The stable build is a small stub. The first launch expands it in place and writes Electrobun's uninstall manifest to `~/Library/Application Support/com.sodre90.mirador/stable/`.

## Install

```bash
ditto "<repo>/desktop/build/stable-macos-arm64/Mirador.app" "/Applications/Mirador.app"
open "/Applications/Mirador.app"
```

Launch it once from its installed location. "Open at login" (on by default) registers the path it was launched from, so launch it from where it will stay. Launch it by explicit path, not `open -a "Mirador"`: several bundles share this identifier (the dev and stable build folders), and launching the wrong one would register the wrong path for login. The app is not signed or notarised; built locally and copied with `ditto` it carries no quarantine flag, so no Gatekeeper prompt is expected.

## Settings

`<data dir>/desktop.json` (default `~/.mirador/desktop.json`), written with defaults on first launch:

```json
{
  "hostDirectory": "<repo path at build time>",
  "bun": "<absolute bun path at build time>",
  "hostRunsInBackground": false,
  "openAtLogin": true
}
```

- `hostDirectory`: the checkout the host runs from (`bun host/main.ts`, working directory).
- `bun`: absolute path of the Bun that runs the host.
- `hostRunsInBackground` and `openAtLogin` are toggled from the menu bar item; edit the file only while the app is quit.

The data directory, port and canvas port follow the host's own environment variables (`MIRADOR_DATA_DIR`, `MIRADOR_PORT`, `MIRADOR_CANVAS_PORT`; defaults `~/.mirador`, 4600, port + 1).

## How the host is handled

On launch the app checks whether something already answers on the port.

| Situation | What the app does |
| --- | --- |
| A host answers that the app did not start | Uses it. Never stops it. "Restart host" is disabled with an explanation. |
| A host it started earlier is still running (pid in `<data dir>/desktop-host.pid`, command line verified) | Adopts it as owned. |
| Nothing answers | Starts `bun host/main.ts` detached through your login shell (`$SHELL -ilc`), so the host sees the same environment as a Terminal session. Output is appended to `<data dir>/logs/host.log`. The pid goes into `desktop-host.pid`. |
| "Run host in the background" is on | The host runs from a LaunchAgent (`com.sodre90.mirador.host.<port>`, RunAtLoad and KeepAlive). The app only talks to it through `launchctl`. |

The LaunchAgent plists carry no environment values (the login shell supplies the environment). A non-default port or data directory is passed as plain `MIRADOR_*=value` arguments, so a default install has none of them.

## What Quit does

- Closing the window: nothing is stopped. The host and the menu bar item stay.
- Quit (menu bar, or Cmd+Q while the window is focused): sends SIGTERM to the host only if this app started it. A host started by `bun host/main.ts` in a terminal, or a background-mode LaunchAgent host, keeps running.

"Run host in the background" refuses to turn on, with a reason, while a host the app does not own is answering. When you turn it on, an app-owned host is stopped first so the LaunchAgent can take the port.

## Notes and known limits

- macOS attributes file access to the app, not to Terminal. Because the host is started through your interactive login shell, anything your `~/.zshrc` touches under `~/Downloads`, `~/Documents` or `~/Desktop` triggers a one-time permission prompt for Mirador. Until it is answered, host startup waits on it. Approve it once.
- `host.log` contains the tokenised URL the host prints at startup. Treat the file as sensitive.
- The window loads `/auth?token=…` from `<data dir>/browser-token`; the token is never logged by the app. The window is sandboxed, and links to other origins open in your default browser.
- There is no app icon yet; Electrobun warns about it during the build.
- No Dock badge (Electrobun 2.0.2 has no API for it), and no native notification yet (it needs a websocket client of the host).

## Tests

The logic lives in `src/core` with no Electrobun imports and is covered from the repository root:

```bash
bun run typecheck
bun run test            # includes tests/desktop-*.test.ts
```

## Uninstall

```bash
UID_=$(id -u)
launchctl bootout gui/$UID_/com.sodre90.mirador.host.4600 2>/dev/null
launchctl bootout gui/$UID_/com.sodre90.mirador.open-at-login.4600 2>/dev/null
rm -f ~/Library/LaunchAgents/com.sodre90.mirador.host.4600.plist \
      ~/Library/LaunchAgents/com.sodre90.mirador.open-at-login.4600.plist
```

Replace `4600` with your port if you changed it. Then quit the app from the menu bar and delete it:

```bash
rm -rf "/Applications/Mirador.app"
rm -rf ~/Library/Application\ Support/com.sodre90.mirador
rm -f ~/.mirador/desktop.json ~/.mirador/desktop-host.pid ~/.mirador/logs/host.log
```

Your sessions and canvases in `~/.mirador` are not touched by the app beyond those files.
