import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../host/config.ts";
import { ConversationService, lastTurnRequest, openTurnTheAgentWorkedOn } from "../host/conversations.ts";
import { Hub } from "../host/hub.ts";
import { HostRestart, hostCommandLine, stoppedWithinTimeout, takeTurnsStoppedForRestart } from "../host/restart.ts";
import { Store } from "../host/store.ts";
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

/** A conversation that ran a turn before, so it has a session, on a profile whose pre-launch command runs until `releasePrelaunch`. */
function conversationWithSlowStartingAgent() {
  const scratch = mkdtempSync(join(tmpdir(), "mirador-restart-start-"));
  const prelaunchStarted = join(scratch, "prelaunch-started");
  const prelaunchReleased = join(scratch, "prelaunch-released");
  const workspacePath = join(scratch, "project");
  mkdirSync(workspacePath);
  const store = new Store(":memory:");
  const prelaunch = `touch '${prelaunchStarted}'; while [ ! -e '${prelaunchReleased}' ]; do sleep 0.05; done; exit 3`;
  store.saveProfile({ id: "p1", name: "slow start", harness: "claude", environment: "CLAUDE_CODE_EXECUTABLE=/usr/bin/false", prelaunch, mode: null, bypassPermissions: false, askMode: "wait", createdAt: 1 });
  store.insertWorkspace({ id: "w1", name: "project", path: workspacePath, defaultLaunch: { harness: "claude", profileId: "p1" }, createdAt: 1 });
  store.insertConversation({
    id: "c1",
    workspaceId: "w1",
    harness: "claude",
    profileId: "p1",
    title: "t",
    titleSetByUser: false,
    acpSessionId: "session-of-an-earlier-turn",
    askMode: "wait",
    bypassPermissions: false,
    status: "idle",
    statusDetail: null,
    openInTerminal: null,
    contextUsage: null,
    queuedMessages: [],
    usageLimit: null,
    jobWaits: [],
    waitingFor: null,
    pendingRequest: null,
    activity: null,
    configOptions: [],
    createdAt: 1,
    updatedAt: 1,
  });
  const config = loadConfig({ MIRADOR_DATA_DIR: join(scratch, "data") });
  const conversations = new ConversationService(store, new Hub(), config, {} as never, {} as never, {} as never, {} as never);
  return {
    conversations,
    prelaunchHasStarted: () => existsSync(prelaunchStarted),
    releasePrelaunch: () => writeFileSync(prelaunchReleased, ""),
  };
}

describe("prepareForRestart", () => {
  test("stops a turn whose agent is still starting, and names it for the next host to continue", async () => {
    const { conversations, prelaunchHasStarted, releasePrelaunch } = conversationWithSlowStartingAgent();
    conversations.send("c1", "Fix the build").catch(() => {});
    while (!prelaunchHasStarted()) await Bun.sleep(20);

    const prepared = conversations.prepareForRestart();
    setTimeout(releasePrelaunch, 200);
    expect(await prepared).toEqual(["c1"]);
    expect(conversations.runningTurnsCount()).toBe(0);
  });
});

describe("HostRestart", () => {
  test("goes through with a restart whose turns could not be stopped, rather than leave the host holding every queue", async () => {
    const conversations = { prepareForRestart: () => Promise.reject(new Error("The agent is not running")) } as unknown as ConversationService;
    const hub = { broadcast: () => {} } as unknown as Hub;
    let servicesStopped = false;
    const reexecutions: string[][] = [];
    const reexecute = ((_file: string, args: string[]) => void reexecutions.push(args)) as unknown as typeof process.execve;
    const restart = new HostRestart(hub, conversations, mkdtempSync(join(tmpdir(), "mirador-restart-")), async () => void (servicesStopped = true), reexecute);

    await restart.restart();
    expect(servicesStopped).toBe(true);
    expect(reexecutions).toHaveLength(1);
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

describe("openTurnTheAgentWorkedOn", () => {
  const stored = (events: ConversationEvent[]) => events.map((event, index) => ({ seq: index + 1, at: index, event }));
  const said = (text: string): ConversationEvent => ({ type: "user-message", text });
  const worked: ConversationEvent = { type: "acp", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "on it" } } };
  const stopped: ConversationEvent = { type: "turn-end", stopReason: "cancelled" };

  test("is a turn the agent worked on that nothing ended, since the host died in the middle of it", () => {
    expect(openTurnTheAgentWorkedOn(stored([said("go"), worked]))).toBe(true);
    expect(openTurnTheAgentWorkedOn(stored([said("Fix it"), worked, worked]))).toBe(true);
    expect(openTurnTheAgentWorkedOn(stored([said("first"), worked, { type: "turn-end", stopReason: "end_turn" }, said("go"), worked]))).toBe(true);
  });

  test("is none the log ends, whether the agent finished, was stopped or failed", () => {
    expect(openTurnTheAgentWorkedOn(stored([said("go"), worked, { type: "turn-end", stopReason: "end_turn" }]))).toBe(false);
    expect(openTurnTheAgentWorkedOn(stored([said("go"), worked, stopped]))).toBe(false);
    expect(openTurnTheAgentWorkedOn(stored([said("go"), worked, { type: "error", message: "ACP connection closed" }]))).toBe(false);
    expect(openTurnTheAgentWorkedOn(stored([]))).toBe(false);
  });

  test("is none the agent never worked on, which has no session a resume could continue", () => {
    expect(openTurnTheAgentWorkedOn(stored([said("go")]))).toBe(false);
    expect(openTurnTheAgentWorkedOn(stored([said("first"), worked, stopped, said("go")]))).toBe(false);
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

describe("stoppedWithinTimeout", () => {
  test("settles as soon as the services have stopped, not after the timeout", async () => {
    const startedAt = Date.now();
    await stoppedWithinTimeout(() => Bun.sleep(20), 5_000);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("settles after the timeout when a service never stops", async () => {
    const startedAt = Date.now();
    await stoppedWithinTimeout(() => new Promise(() => {}), 100);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(90);
  });

  test("starts stopping the services", async () => {
    let started = false;
    await stoppedWithinTimeout(async () => void (started = true), 100);
    expect(started).toBe(true);
  });
});
