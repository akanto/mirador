# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

## Commits

- **You may commit and push at any time without asking**: whenever a change is finished and its checks pass. This overrides the conservative git policy in the beads block above.
- **Author and committer:** the owner only, `perdos <erdos.peter.bme@gmail.com>`, as set in the local git config.
- **No AI attribution:** no `Co-Authored-By` or "Generated with" trailers, and no agent name anywhere in the message.
- **Beads hook:** the beads `prepare-commit-msg` hook, which adds agent trailers, was removed on purpose. Never reinstall it.
- **One commit per finished change**, with only that change's files. Other work in the tree stays uncommitted. Include `.beads/interactions.jsonl` when it changed.
- **Messages:** one plain sentence saying what the user gets, as in "Reorder queued messages by dragging them".

## Build & Test

```bash
bun install
bun start                  # host on 127.0.0.1:4600, canvas assets on :4601
bun run dev                # the same, with UI hot reload
bunx tsc --noEmit -p .     # type check
bun test tests/            # unit tests
bunx playwright test       # e2e, one worker; never two native runs at once
scripts/linux-test.sh      # type check, unit and e2e tests in Ubuntu via Docker
scripts/test-spec.sh e2e/<spec>.spec.ts   # just those specs, in Docker; parallel-safe
```

- **E2E ports:** each e2e spec starts its own host with `new TestHost(<port>)`, which also takes port+1 for canvas assets, and port+2 and +3 when it serves the network. Pick N in 4720–5499 so that none of these is another host's. `tests/e2e-ports.test.ts` checks it, counting the network ports of hosts started with `MIRADOR_NETWORK`; a host switched onto the network in Settings and restarted (`network.spec.ts`, 5196) needs its +2 and +3 kept free by hand. mirador-mobile's e2e uses 5800 and up.
- **Serial specs:** run the whole file, not `-g`.
- **Don't edit `web/` or `host/` while e2e runs:** native test hosts rebuild from the working tree. Both native rules (one run at a time, no edits during a run) apply only to `bunx playwright` in this checkout; agents run their specs with `scripts/test-spec.sh` instead — it snapshots the tree into a container, and each run has its own ports and result files, so container runs never collide with edits or each other. Specs waiting on a real Claude reply need `ANTHROPIC_API_KEY` exported; two `linux-test.sh` full-suite runs still can't overlap (shared results dir).

## Architecture Overview

Mirador is a localhost web app that drives coding agents (Claude Code through `claude-agent-acp`, and opencode) over ACP, and gives them a canvas with the `show`, `ask` and `review` tools.

- **`host/`** is the Bun server:
  - the ACP client, with one agent process per profile and many sessions on it;
  - the canvas MCP server, which each session gets through `session/new`;
  - terminals;
  - the SQLite store in `~/.mirador`;
  - device invites for remote machines.
- **`web/`** is the React UI, bundled by Bun. It talks to the host over one WebSocket. Messages are typed in `shared/protocol.ts`.
- **`shared/`** holds the types and logic both sides use.
- **`desktop/`** is the Electrobun tray app that wraps it.
- **`e2e/`** holds the Playwright specs. Their helper hosts are in `e2e/test-host.ts`. **`tests/`** holds the unit tests.

## Conventions & Patterns

- **Names over comments.** Keep comments for a genuine "why" that a name cannot carry.
- **Tests come with every change.** Every user-visible change gets e2e coverage, and logic gets unit tests.
- **Tooltip text** lives in `web/hints.ts`.
- **UI wording:** plain words and sentence case.
- **Secrets:** never print the `/auth?token=…` link, tokens or profile environment values. Host logs contain them, so filter `auth?token` out of anything you show.
- **The owner's own Mirador runs from this checkout.**
  - Host changes take effect after a restart (`⌘⇧R`). Leave the restart to the owner: it stops the turn that triggered it.
  - The real database `~/.mirador/state.sqlite` is read-only for agents. Work on a copy.
