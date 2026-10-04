import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { CanvasItem, Conversation, JobWait, Profile } from "../shared/model.ts";
import { Store } from "../host/store.ts";
import { defaultPromptTemplates } from "../shared/prompt-templates.ts";

function seededStore() {
  const store = new Store(":memory:");
  store.insertWorkspace({ id: "w1", name: "project", path: "/tmp/project", defaultLaunch: { harness: "claude", profileId: null }, createdAt: 1 });
  const conversation: Conversation = {
    id: "c1",
    workspaceId: "w1",
    harness: "claude",
    profileId: null,
    title: "t",
    titleSetByUser: false,
    acpSessionId: null,
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
    configOptions: [],
    position: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  store.insertConversation(conversation);
  return { store, conversation };
}

const canvasItem: CanvasItem = { id: "i1", conversationId: "c1", kind: "show", title: "x", html: "<p>", status: "shown", createdAt: 1 };

describe("Store", () => {
  test("new workspaces and conversations go last, and keep the order they are given", () => {
    const { store, conversation } = seededStore();
    const second = store.insertWorkspace({ id: "w2", name: "second", path: "/tmp/second", defaultLaunch: { harness: "claude", profileId: null }, createdAt: 2 });
    const later = store.insertConversation({ ...conversation, id: "c2", createdAt: 2 });
    const elsewhere = store.insertConversation({ ...conversation, id: "c3", workspaceId: "w2", createdAt: 3 });
    expect([second.position, later.position, elsewhere.position]).toEqual([1, 1, 0]);

    store.setWorkspaceOrder(["w2", "w1"]);
    store.setConversationOrder(["c2", "c1"]);
    expect(store.listWorkspaces().map(({ id }) => id)).toEqual(["w2", "w1"]);
    expect(store.findConversation("c2")?.position).toBe(0);
    expect(store.findConversation("c1")?.position).toBe(1);
  });

  test("numbers events per conversation from 1 in append order", () => {
    const { store } = seededStore();
    store.appendEvent("c1", { type: "user-message", text: "a" });
    store.appendEvent("c1", { type: "user-message", text: "b" });
    expect(store.listEvents("c1").map(({ seq }) => seq)).toEqual([1, 2]);
  });

  test("the latest turns start at a user message, and the first turn takes along what came before it", () => {
    const { store } = seededStore();
    const reply = { type: "acp", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } as const;
    store.appendEvent("c1", { type: "acp", update: { sessionUpdate: "available_commands_update", availableCommands: [] } });
    ["first", "second", "third"].forEach((text) => {
      store.appendEvent("c1", { type: "user-message", text });
      store.appendEvent("c1", reply);
    });
    expect(store.latestTurns("c1", 2)).toEqual({ fromSeq: 4, hasEarlier: true });
    expect(store.latestTurns("c1", 3)).toEqual({ fromSeq: 0, hasEarlier: false });
    expect(store.latestTurns("c1", 10)).toEqual({ fromSeq: 0, hasEarlier: false });
    expect(store.turnsBefore("c1", 4, 1)).toEqual({ fromSeq: 0, hasEarlier: false });
    expect(store.listEventsBetween("c1", 4, 6).map(({ seq }) => seq)).toEqual([4, 5]);
    expect(store.findEvent("c1", 6)?.event).toEqual({ type: "user-message", text: "third" });
    expect(store.findEvent("c1", 99)).toBeNull();
  });

  test("updates a conversation's persisted fields but always loads it idle", () => {
    const { store, conversation } = seededStore();
    store.saveProfile({ id: "p1", name: "work", harness: "claude", environment: "", prelaunch: "", mode: null, bypassPermissions: false, askMode: "wait", createdAt: 1 });
    store.updateConversation({ ...conversation, profileId: "p1", title: "renamed", askMode: "next-message", bypassPermissions: true, acpSessionId: "s1", status: "running" });
    expect(store.findConversation("c1")).toMatchObject({ profileId: "p1", title: "renamed", askMode: "next-message", bypassPermissions: true, acpSessionId: "s1", status: "idle" });
  });

  test("upserts canvas items by id", () => {
    const { store } = seededStore();
    store.saveCanvasItem(canvasItem);
    store.saveCanvasItem({ ...canvasItem, title: "y" });
    expect(store.listCanvasItems("c1").map(({ title }) => title)).toEqual(["y"]);
  });

  test("deleting a workspace removes its conversations, events and canvas items", () => {
    const { store } = seededStore();
    store.appendEvent("c1", { type: "user-message", text: "a" });
    store.saveCanvasItem(canvasItem);
    store.deleteWorkspace("w1");
    expect(store.listConversations()).toEqual([]);
    expect(store.listEvents("c1")).toEqual([]);
    expect(store.listCanvasItems("c1")).toEqual([]);
  });

  test("saves profiles and forgets a deleted one as a workspace default, keeping its agent", () => {
    const { store } = seededStore();
    const profile: Profile = { id: "p1", name: "work", harness: "opencode", environment: "A=1", prelaunch: "", mode: null, bypassPermissions: false, askMode: "wait", createdAt: 1 };
    store.saveProfile(profile);
    const changed = { ...profile, environment: "A=2", mode: "plan", bypassPermissions: true, askMode: "next-message" as const };
    store.saveProfile(changed);
    store.setWorkspaceDefaultLaunch("w1", { harness: "opencode", profileId: "p1" });
    expect(store.listProfiles()).toEqual([changed]);
    expect(store.findWorkspace("w1")?.defaultLaunch).toEqual({ harness: "opencode", profileId: "p1" });
    store.deleteProfile("p1");
    expect(store.findWorkspace("w1")?.defaultLaunch).toEqual({ harness: "opencode", profileId: null });
  });

  test("remembers a workspace's colour until the user takes it away", () => {
    const { store } = seededStore();
    expect(store.findWorkspace("w1")?.color).toBeNull();
    store.setWorkspaceColor("w1", "sky");
    expect(store.findWorkspace("w1")?.color).toBe("sky");
    store.setWorkspaceColor("w1", null);
    expect(store.listWorkspaces()[0]?.color).toBeNull();
  });

  test("remembers a machine's colour until the user takes it away", () => {
    const store = new Store(":memory:");
    store.insertMachine({ id: "m1", name: "Home server", origin: "https://home-server.example", createdAt: 1 });
    expect(store.findMachine("m1")?.color).toBeNull();
    store.setMachineColor("m1", "teal");
    expect(store.findMachine("m1")?.color).toBe("teal");
    store.setMachineColor("m1", null);
    expect(store.listMachines()[0]?.color).toBeNull();
  });

  test("keeps job waits until they end, and drops them with their conversation", () => {
    const { store, conversation } = seededStore();
    store.insertConversation({ ...conversation, id: "c2" });
    const build: JobWait = { id: "j1", job: { kind: "container", name: "build" }, sshHost: "me@fedora", message: "Build done", resume: false, since: 5 };
    const sleep: JobWait = { id: "j2", job: { kind: "process", pid: 42 }, sshHost: null, message: "Slept", resume: true, since: 7 };
    store.addJobWait("c1", build);
    store.addJobWait("c2", sleep);
    expect(store.listJobWaits()).toEqual([
      { conversationId: "c1", wait: build },
      { conversationId: "c2", wait: sleep },
    ]);
    store.deleteJobWait("j1");
    store.deleteConversation("c2");
    expect(store.listJobWaits()).toEqual([]);
  });

  test("remembers that the user named a conversation", () => {
    const { store, conversation } = seededStore();
    store.updateConversation({ ...conversation, title: "Login bug", titleSetByUser: true });
    expect(store.findConversation("c1")).toMatchObject({ title: "Login bug", titleSetByUser: true });
  });

  test("keeps a profile's agent when it is saved again", () => {
    const { store } = seededStore();
    const profile: Profile = { id: "p1", name: "work", harness: "claude", environment: "", prelaunch: "", mode: null, bypassPermissions: false, askMode: "wait", createdAt: 1 };
    store.saveProfile(profile);
    store.saveProfile({ ...profile, harness: "opencode" });
    expect(store.findProfile("p1")?.harness).toBe("claude");
  });

  test("keeps queued messages and unseen turn ends across reopening the database", () => {
    const path = join(mkdtempSync(join(tmpdir(), "mirador-store-")), "state.sqlite");
    const store = new Store(path);
    store.insertWorkspace({ id: "w1", name: "project", path: "/tmp/project", defaultLaunch: { harness: "claude", profileId: null }, createdAt: 1 });
    store.insertConversation({ ...seededStore().conversation, id: "c1" });
    store.insertConversation({ ...seededStore().conversation, id: "c2" });
    const queued = [{ id: "q1", text: "after this turn", imageIds: ["img1"], fromScript: true as const }];
    store.saveQueuedMessages("c1", queued);
    store.setUnseenTurnEnd("c1", "finished");
    store.setUnseenTurnEnd("c2", "error");
    store.setUnseenTurnEnd("c2", null);
    store.close();
    const reopened = new Store(path);
    expect(reopened.findConversation("c1")?.queuedMessages).toEqual(queued);
    expect(reopened.findConversation("c2")?.queuedMessages).toEqual([]);
    expect(reopened.listUnseenTurnEnds()).toEqual([["c1", "finished"]]);
    reopened.close();
  });

  test("starts with the default prompt templates once: one the user deletes stays deleted after reopening", () => {
    const path = join(mkdtempSync(join(tmpdir(), "mirador-store-")), "state.sqlite");
    const store = new Store(path);
    expect(store.listPromptTemplates().map(({ id }) => id)).toEqual(defaultPromptTemplates.map(({ id }) => id));
    store.savePromptTemplate({ id: "t1", name: "a mine", text: "Review {{Pull request}}", createdAt: 5 });
    store.savePromptTemplate({ id: "t1", name: "Mine", text: "Explain {{Path}}", createdAt: 9 });
    store.deletePromptTemplate(defaultPromptTemplates[0]!.id);
    store.close();
    const reopened = new Store(path);
    expect(reopened.listPromptTemplates()).toEqual([{ id: "t1", name: "Mine", text: "Explain {{Path}}", createdAt: 5 }]);
    reopened.close();
  });

  test("tells Claude Code to use the canvas often until Settings say otherwise, also after reopening", () => {
    const path = join(mkdtempSync(join(tmpdir(), "mirador-store-")), "state.sqlite");
    const store = new Store(path);
    expect(store.canvasUse()).toBe("often");
    store.setCanvasUse("as-needed");
    store.close();
    const reopened = new Store(path);
    expect(reopened.canvasUse()).toBe("as-needed");
    reopened.setCanvasUse("often");
    expect(reopened.canvasUse()).toBe("often");
    reopened.close();
  });

  test("adds the profile and agent columns to a database created before they existed", () => {
    const path = join(mkdtempSync(join(tmpdir(), "mirador-store-")), "state.sqlite");
    const old = new Database(path);
    old.run("CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)");
    old.run(`CREATE TABLE conversations (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, harness TEXT NOT NULL, title TEXT NOT NULL,
      acp_session_id TEXT, ask_mode TEXT NOT NULL, config_options TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    old.run("INSERT INTO workspaces VALUES ('w1', 'p', '/tmp/p', 1)");
    old.run("INSERT INTO conversations (id, workspace_id, harness, title, ask_mode, created_at, updated_at) VALUES ('c1', 'w1', 'claude', 't', 'wait', 1, 1)");
    old.run("CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, environment TEXT NOT NULL, prelaunch TEXT NOT NULL, created_at INTEGER NOT NULL)");
    old.run("INSERT INTO profiles VALUES ('p1', 'work', 'A=1', '', 1)");
    old.close();
    const store = new Store(path);
    expect(store.findWorkspace("w1")?.defaultLaunch).toEqual({ harness: "claude", profileId: null });
    expect(store.findConversation("c1")?.profileId).toBeNull();
    expect(store.findProfile("p1")?.harness).toBe("claude");
    expect(store.findConversation("c1")).toMatchObject({ titleSetByUser: false, bypassPermissions: false, queuedMessages: [], position: 0 });
    expect(store.findWorkspace("w1")).toMatchObject({ position: 0, color: null });
    expect(store.listUnseenTurnEnds()).toEqual([]);
    expect(store.listPromptTemplates()).toHaveLength(defaultPromptTemplates.length);
    store.close();
  });

  test("a conversation's slash commands are its agent's last list, else the latest of another with its agent and profile, its workspace first", () => {
    const { store, conversation } = seededStore();
    store.insertWorkspace({ id: "w2", name: "other", path: "/tmp/other", defaultLaunch: { harness: "claude", profileId: null }, createdAt: 1 });
    const listing = (...names: string[]) => ({
      type: "acp" as const,
      update: { sessionUpdate: "available_commands_update" as const, availableCommands: names.map((name) => ({ name, description: name })) },
    });
    const names = (id: string) => store.latestAvailableCommands({ ...conversation, id }).map(({ name }) => name);
    store.insertConversation({ ...conversation, id: "same-workspace" });
    store.insertConversation({ ...conversation, id: "other-workspace", workspaceId: "w2" });
    store.insertConversation({ ...conversation, id: "opencode", harness: "opencode" });
    store.insertConversation({ ...conversation, id: "fresh" });

    expect(names("fresh")).toEqual([]);
    store.appendEvent("other-workspace", listing("elsewhere"));
    store.appendEvent("opencode", listing("opencode-only"));
    expect(names("fresh")).toEqual(["elsewhere"]);
    store.appendEvent("same-workspace", listing("here"));
    expect(names("fresh")).toEqual(["here"]);
    store.appendEvent("c1", listing("own-old"));
    store.appendEvent("c1", listing("own"));
    store.appendEvent("same-workspace", listing("here-newer"));
    expect(names("c1")).toEqual(["own"]);
    store.close();
  });

  test("what was typed in a workspace's other conversations comes newest first, without other events or workspaces", () => {
    const { store, conversation } = seededStore();
    store.insertWorkspace({ id: "w2", name: "other", path: "/tmp/other", defaultLaunch: { harness: "claude", profileId: null }, createdAt: 1 });
    store.insertConversation({ ...conversation, id: "c2" });
    store.insertConversation({ ...conversation, id: "other-workspace", workspaceId: "w2" });
    store.appendEvent("c2", { type: "user-message", text: "older" });
    store.appendEvent("c2", { type: "turn-end", stopReason: "end_turn" });
    store.appendEvent("c1", { type: "user-message", text: "own" });
    store.appendEvent("other-workspace", { type: "user-message", text: "elsewhere" });
    store.appendEvent("c2", { type: "user-command", commandId: "u1", command: "ls" });

    expect(store.typedInWorkspace("w1", "c1")).toEqual([
      { type: "user-command", commandId: "u1", command: "ls" },
      { type: "user-message", text: "older" },
    ]);
    store.close();
  });
});
