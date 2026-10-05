import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastTurnRequest } from "../host/conversations.ts";
import { hostCommandLine, takeTurnsStoppedForRestart } from "../host/restart.ts";
import type { ConversationEvent } from "../shared/model.ts";
import { SourceWatcher } from "../host/source-watcher.ts";

describe("hostCommandLine", () => {
  test("restarts with the command line the host was started with, which the desktop app recognises its host by", () => {
    expect(hostCommandLine("bun", "/repo/host/main.ts", "/repo", [])).toEqual(["bun", "host/main.ts"]);
    expect(hostCommandLine("/opt/bun", "/repo/host/main.ts", "/repo", ["--flag"])).toEqual(["/opt/bun", "host/main.ts", "--flag"]);
  });
});

describe("takeTurnsStoppedForRestart", () => {
  test("tells the next host which turns the previous one stopped, once", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mirador-restart-"));
    const file = join(dataDir, "turns-stopped-for-restart.json");
    expect(takeTurnsStoppedForRestart(dataDir)).toEqual([]);
    writeFileSync(file, JSON.stringify(["c1", "c2"]));
    expect(takeTurnsStoppedForRestart(dataDir)).toEqual(["c1", "c2"]);
    expect(existsSync(file)).toBe(false);
    expect(takeTurnsStoppedForRestart(dataDir)).toEqual([]);
  });
});

describe("lastTurnRequest", () => {
  const stored = (events: ConversationEvent[]) => events.map((event, index) => ({ seq: index + 1, at: index, event }));
  const said = (text: string, imageIds?: string[]): ConversationEvent => ({ type: "user-message", text, ...(imageIds && { imageIds }) });
  const cancelled: ConversationEvent = { type: "turn-end", stopReason: "cancelled" };

  test("is what the user asked in the turn a restart stopped: the message that started it and those that joined it", () => {
    const events = stored([said("first"), { type: "turn-end", stopReason: "end_turn" }, said("Fix the build", ["img-1"]), said("and the docs"), cancelled]);
    expect(lastTurnRequest(events)).toEqual({ text: "Fix the build\n\nand the docs", firstText: "Fix the build", imageIds: ["img-1"] });
  });

  test("counts a turn that failed as ended, and finds nothing in a turn without a message", () => {
    expect(lastTurnRequest(stored([said("lost"), { type: "error", message: "boom" }, said("Try again"), cancelled]))?.firstText).toBe("Try again");
    expect(lastTurnRequest(stored([said("done"), { type: "turn-end", stopReason: "end_turn" }, cancelled]))).toBeNull();
    expect(lastTurnRequest([])).toBeNull();
  });
});

describe("SourceWatcher", () => {
  test("an edit in web/ makes the UI stale, in host/ the host, and in shared/ both", async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "mirador-source-"));
    ["web", "shared", "host/acp"].forEach((directory) => mkdirSync(join(sourceDir, directory), { recursive: true }));
    // macOS reports writes from the last few milliseconds before a watch starts.
    await Bun.sleep(200);
    const edited: string[] = [];
    const watcher = new SourceWatcher(sourceDir, { uiEdited: () => edited.push("ui"), hostEdited: () => edited.push("host") });
    watcher.start();
    const editAndCollect = async (file: string) => {
      edited.length = 0;
      writeFileSync(join(sourceDir, file), "export {};\n");
      await Bun.sleep(300);
      return [...new Set(edited)].sort();
    };
    try {
      expect(await editAndCollect("web/App.tsx")).toEqual(["ui"]);
      expect(await editAndCollect("host/acp/harness.ts")).toEqual(["host"]);
      expect(await editAndCollect("shared/model.ts")).toEqual(["host", "ui"]);
    } finally {
      watcher.stop();
    }
  });
});
