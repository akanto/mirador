# Mirador desktop app

A native shell around the localhost host, built with [Electrobun](https://electrobun.dev) 2.0.2 (pinned), for macOS and Linux.
On macOS it is a menu bar app that opens the UI in its own window. Closing the window leaves the app in the menu bar; the Dock icon is hidden while no window is open and comes back when you reopen it (menu bar item, or a Dock/app reopen).

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

## Notifications

The app listens to the host for the notifications a browser tab would show (a question, a permission request, a finished turn or an error, in a conversation not on screen in a focused window) and shows them natively, also while its window is closed; it reconnects whenever the host restarts. While it listens, browser tabs show none, so nothing arrives twice. macOS asks once whether Mirador may send notifications; change it later in System Settings → Notifications. Clicking one does not open the conversation: Electrobun 2.0.2 does not report clicks.

## Notes and known limits

- macOS attributes file access to the app, not to Terminal. Because the host is started through your interactive login shell, anything your `~/.zshrc` touches under `~/Downloads`, `~/Documents` or `~/Desktop` triggers a one-time permission prompt for Mirador. Until it is answered, host startup waits on it. Approve it once.
- `host.log` contains the tokenised URL the host prints at startup. Treat the file as sensitive.
- The window loads `/auth?token=…` from `<data dir>/browser-token`; the token is never logged by the app. The window is sandboxed, and links to other origins open in your default browser.
- There is no app icon yet; Electrobun warns about it during the build.
- No Dock badge (Electrobun 2.0.2 has no API for it).

## Linux

The same app, built and installed on the Linux machine itself (x64 or arm64; Electrobun does not cross-compile, and as on macOS the checkout's path and Bun's are baked in as defaults). It needs GTK 3, WebKitGTK 4.1 and the Ayatana AppIndicator library at run time; Electrobun links the last one directly, so the app does not start without it, even on a desktop with no tray:

```bash
sudo apt install libgtk-3-0 libwebkit2gtk-4.1-0 libayatana-appindicator3-1 librsvg2-2   # Debian, Ubuntu
sudo dnf install gtk3 webkit2gtk4.1 libayatana-appindicator-gtk3 librsvg2              # Fedora
cd desktop && bun install && bun run build
tar -xzf artifacts/linux-*-Mirador-Setup.tar.gz -C /tmp && /tmp/installer
```

The installer puts the app in `~/.local/share/com.sodre90.mirador/stable/app/` and adds *Mirador* to your applications menu (`~/.local/share/applications/Mirador.desktop`). Launch it from there once, so "Open at login" registers the installed copy.

Where it differs from macOS:

- **Tray**: an AppIndicator status icon with the same menu as the macOS menu bar item. Desktops without a tray (stock GNOME, until you add the AppIndicator extension: `gnome-shell-extension-appindicator` on Fedora) show no icon, so the window has the menu too: *Desktop app…* at the bottom of the sidebar.
- **Window**: there is no Dock and no app menu bar. Closing the window leaves the app running; *Open* in the tray, or launching the app again, brings the window back. A second launch hands over to the running app through `<data dir>/desktop-<port>.sock` and quits.
- **Run host in the background**: a systemd user service, `~/.config/systemd/user/mirador-host-<port>.service` (`Restart=always`, enabled so it also starts at login), driven with `systemctl --user`. Without a systemd user session it refuses to turn on and says why.
- **Open at login**: an XDG autostart entry, `~/.config/autostart/mirador-<port>.desktop`.
- **Quit**: from the tray menu or *Desktop app…*; there is no keyboard shortcut.
- **Notifications**: shown through `notify-send` (`libnotify-bin` on Debian and Ubuntu, `libnotify` on Fedora); without it there are none, and the app's output says `notify-send failed`.

`scripts/linux-desktop.sh` (repository root, needs Docker) builds the installer in an Ubuntu 24.04 container, installs it there and checks the above on a virtual display; `MIRADOR_LINUX_ARCH=x64` or `arm64` picks the architecture. Its installer has the container's paths baked in, so it is a test artifact rather than one to hand out. Checked so far only under X11 (Xvfb with openbox); the tray icon and Wayland sessions are untested.

## Tests

The logic lives in `src/core` with no Electrobun imports and is covered from the repository root:

```bash
bun run typecheck
bun run test            # includes tests/desktop-*.test.ts
```

## Uninstall

On macOS:

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

On Linux, quit the app first, then:

```bash
systemctl --user disable --now mirador-host-4600.service 2>/dev/null
rm -f ~/.config/systemd/user/mirador-host-4600.service ~/.config/autostart/mirador-4600.desktop
systemctl --user daemon-reload
~/.local/share/com.sodre90.mirador/stable/uninstall --quiet   # Electrobun's uninstaller: the app and its menu entry
rm -f ~/.mirador/desktop.json ~/.mirador/desktop-host.pid ~/.mirador/desktop-4600.sock ~/.mirador/logs/host.log
```
