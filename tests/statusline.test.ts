import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { chosenModel } from "../shared/config-options.ts";
import type { Conversation } from "../shared/model.ts";
import { claudeTranscriptPath, runStatusLineCommand, statusLineCommandIn, statuslineInput } from "../host/statusline.ts";

const modelOption: SessionConfigOption = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "opus",
  options: [{ group: "anthropic", name: "Anthropic", options: [{ value: "opus", name: "Opus 5.5" }] }],
};

const conversation: Conversation = {
  id: "c1",
  workspaceId: "w1",
  harness: "claude",
  profileId: null,
  title: "t",
  titleSetByUser: false,
  acpSessionId: "s1",
  askMode: "wait",
  bypassPermissions: false,
  status: "idle",
  statusDetail: null,
  openInTerminal: null,
  contextUsage: { used: 86_000, size: 200_000, cost: { amount: 0.25, currency: "USD" } },
  queuedMessages: [],
  usageLimit: null,
  waitingFor: null,
  configOptions: [modelOption],
  position: 0,
  createdAt: 1_000,
  updatedAt: 1_000,
};

const configDirWith = (settings: unknown) => {
  const directory = mkdtempSync(join(tmpdir(), "mirador-statusline-"));
  writeFileSync(join(directory, "settings.json"), JSON.stringify(settings));
  return directory;
};

const run = (command: string) => runStatusLineCommand(command, { input: { hello: "world" }, directory: tmpdir(), environment: { PATH: process.env.PATH! }, columns: 42 });

describe("statusline", () => {
  test("the command comes from Claude Code's statusLine setting", async () => {
    expect(await statusLineCommandIn(configDirWith({ statusLine: { type: "command", command: "~/.claude/statusline.sh" } }))).toBe("~/.claude/statusline.sh");
    expect(await statusLineCommandIn(configDirWith({ statusLine: { type: "static" } }))).toBeNull();
    expect(await statusLineCommandIn(configDirWith({}))).toBeNull();
    expect(await statusLineCommandIn(join(tmpdir(), "no-such-claude-config"))).toBeNull();
  });

  test("the transcript lives in a directory named after the project path", () => {
    expect(claudeTranscriptPath("/home/me/.claude", "/Users/me/.dotfiles/my_app", "s1")).toBe(
      "/home/me/.claude/projects/-Users-me--dotfiles-my-app/s1.jsonl",
    );
  });

  test("the input carries what Claude Code's statusline scripts read", () => {
    const input = statuslineInput(conversation, "/work", "/t.jsonl", 61_000);
    expect(input).toMatchObject({
      session_id: "s1",
      transcript_path: "/t.jsonl",
      cwd: "/work",
      model: { id: "opus", display_name: "Opus 5.5" },
      cost: { total_cost_usd: 0.25, total_duration_ms: 60_000 },
      context_window: {
        context_window_size: 200_000,
        used_percentage: 43,
        remaining_percentage: 57,
        current_usage: { input_tokens: 86_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
    expect(statuslineInput({ ...conversation, contextUsage: null }, "/work", null, 0).context_window.current_usage).toBeNull();
  });

  test("the command reads the input on stdin and sees the width in COLUMNS", async () => {
    expect(await run(`printf '\\033[1m%s\\033[0m %s\\n\\n' "$(cat)" "$COLUMNS"`)).toEqual({ output: '\x1b[1m{"hello":"world"}\x1b[0m 42' });
  });

  test("a failing command reports its exit code and first error line", async () => {
    expect(await run("echo 'no jq here' >&2; exit 3")).toEqual({ error: "The statusline command exited with 3: no jq here" });
  });

  test("a background job left holding the output does not hold up the statusline", async () => {
    const started = Date.now();
    expect(await run("(sleep 3) & echo ready")).toEqual({ output: "ready" });
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  test("the model shown is the chosen option's name", () => {
    expect(chosenModel([modelOption])).toEqual({ id: "opus", name: "Opus 5.5" });
    expect(chosenModel([])).toBeNull();
  });
});
