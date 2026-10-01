# Mirador

A localhost web app that drives coding agents (Claude Code and opencode today; pi next) over ACP and gives them a **canvas**: a browser panel where they render HTML, diagrams, mockups and 3D scenes (`show`), and ask you to choose between options with visual previews (`ask`).

## Run

```bash
bun install
bun start
```

Open the `http://127.0.0.1:4600/auth?token=…` link the host prints (once per browser; it sets a cookie). Stop with Ctrl+C, which also stops the agent processes.

- **Workspaces** are project directories (sidebar `+`; Tab completes paths). The picker next to *New conversation* chooses the agent (Claude Code, opencode, or a profile, which belongs to one of them); each workspace remembers it. Agents run in that directory with your normal settings: Claude Code with `~/.claude` (settings, hooks, MCP servers; claude-notifier is muted for app sessions), opencode with `~/.config/opencode` (providers, agents, plugins, MCP servers, **and its permission settings**: the app forces nothing, so with opencode's defaults most tools run without asking). Approvals the agent asks for appear in the browser.
- **opencode** is found on `PATH`, else in `/opt/homebrew/bin`, `/usr/local/bin` or `~/.opencode/bin`. The chat header lists all its models and modes (build, plan, your agents).
- **Profiles** (sidebar, *Profiles…*): an agent plus the environment it starts with, e.g. Claude Code through a work gateway or a local llama.cpp server, or opencode with another config (`OPENCODE_CONFIG=…` or inline `OPENCODE_CONFIG_CONTENT='{…}'`). A profile's agent is fixed once created. Environment lines are `KEY=value`, `-u KEY` and `# comment`, so the lines of an existing `claude_env=( … )` alias paste as they are; an optional pre-launch command (your shell) can start a proxy first. Each profile runs its own agent process; its log is `logs/<agent>-<name>-<id>.log`. A conversation can move to another profile of its agent (*Profile* at the top of the conversation, also after its profile was deleted): the new profile's agent process resumes the same session, with that profile's model. If the profile keeps sessions elsewhere (another `CLAUDE_CONFIG_DIR`, or opencode's `XDG_DATA_HOME`), the session cannot be resumed and a fresh one starts. Profiles, including their tokens, are stored in the app's SQLite database in the data directory (owner-only permissions).
- **Continue a session…** (under each workspace) lists the sessions the workspace's chosen agent recorded for that directory, including ones started in a terminal, and replays the chosen one into a new conversation. *Continue* keeps the same session (close it in the terminal first: nothing stops two writers); *Fork* copies it. While a Claude Code session is still open in a terminal, its conversation says so (header badge, sidebar dot, a note above the message box) along with what it is doing there: working, waiting for you, or idle. The app reads this from Claude Code's session registry (`~/.claude/sessions`, or the profile's `CLAUDE_CONFIG_DIR`); it does not show the terminal's new messages. opencode has no such registry.
- **Keyboard**: `⌘K` opens a palette (go to any conversation; new conversation, continue a session, profiles, add workspace, canvas). `⌥↑/⌥↓` previous/next conversation, `⌥⇧↑/⌥⇧↓` previous/next workspace, `⌥1…⌥9` the n-th conversation of the current workspace, `⌥T` new conversation in it, `⌘\` shows/hides the canvas, `⌘⇧←/⌘⇧→` focus the message box / the canvas, `?` lists them all (Ctrl instead of ⌘ off macOS). They work while a canvas page has focus too, except `⌥T`: a page the agent wrote cannot start conversations. The ⌥ bindings go by physical key, so they also work on layouts where ⌥ types characters, but they then shadow those characters in the app (e.g. ⌥1…9 on the Hungarian layout).
- **Renaming**: click a conversation's title in the chat header, double-click it in the sidebar, or use *Rename conversation…* in the palette (Enter saves, Esc cancels). A name you choose sticks; otherwise the title is your first message until the agent names the session (Claude Code does after the first turn).
- **Theme** (sidebar footer): Light (the default, whatever the system uses), Dark, or Match system; remembered per browser.
- **YOLO** (top of a conversation, off by default): the app approves every permission request of that conversation without asking (allow once; switching it on also approves requests already waiting). Works the same for Claude Code and opencode. Claude Code's own *Bypass permissions* mode, in its *Mode* list, is separate.
- **Timestamps**: lines are grouped by author, and each group's header shows who wrote it and when. Point at a later line in the group to see its time (hover the time for the full date); *Show timestamps* in the sidebar footer shows them on every line. Remembered per browser. History loaded from a session started elsewhere carries the time it was loaded, not when it was written.
- **Questions** (chat header): *Agent waits for my answer* returns your choice as the `ask` tool result. *My answer is sent as the next message* lets the agent end its turn, and your choice arrives as your next message.
- State lives in `~/.mirador` (SQLite, browser token, agent logs under `logs/`).

Environment: `MIRADOR_PORT` (default 4600; canvas assets use the next port), `MIRADOR_DATA_DIR`. `bun run dev` enables hot reload of the UI (only for working on `web/`; open pages swap code mid-session).

## Develop

```bash
bun run typecheck
bun test tests          # unit tests
bunx playwright test    # e2e: a real Claude Code on haiku, opencode against a scripted fake model (installed Google Chrome)
MIRADOR_E2E_MINIMAL_ENV=1 bunx playwright test e2e/agent-flow.spec.ts   # host started with a bare environment
MIRADOR_EXPERIMENT=1 MIRADOR_TEST_MODEL=default MIRADOR_TEST_EFFORT=default bunx playwright test e2e/experiment-unprompted.spec.ts
```

Layout: `host/` (Bun server, ACP client, canvas MCP server, SQLite store), `web/` (React UI bundled by Bun), `shared/` (types and the canvas document builder), `spike/` (throwaway feasibility spike, see `spike/FINDINGS.md`). Work is tracked in beads (`bd ready`).
