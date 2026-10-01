import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { CanvasItem, Conversation, Profile } from "../shared/model.ts";
import { Store } from "../host/store.ts";

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
    configOptions: [],
    createdAt: 1,
    updatedAt: 1,
  };
  store.insertConversation(conversation);
  return { store, conversation };
}

const canvasItem: CanvasItem = { id: "i1", conversationId: "c1", kind: "show", title: "x", html: "<p>", status: "shown", createdAt: 1 };

describe("Store", () => {
  test("numbers events per conversation from 1 in append order", () => {
    const { store } = seededStore();
    store.appendEvent("c1", { type: "user-message", text: "a" });
    store.appendEvent("c1", { type: "user-message", text: "b" });
    expect(store.listEvents("c1").map(({ seq }) => seq)).toEqual([1, 2]);
  });

  test("updates a conversation's persisted fields but always loads it idle", () => {
    const { store, conversation } = seededStore();
    store.saveProfile({ id: "p1", name: "work", harness: "claude", environment: "", prelaunch: "", createdAt: 1 });
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
    const profile: Profile = { id: "p1", name: "work", harness: "opencode", environment: "A=1", prelaunch: "", createdAt: 1 };
    store.saveProfile(profile);
    store.saveProfile({ ...profile, environment: "A=2" });
    store.setWorkspaceDefaultLaunch("w1", { harness: "opencode", profileId: "p1" });
    expect(store.listProfiles()).toEqual([{ ...profile, environment: "A=2" }]);
    expect(store.findWorkspace("w1")?.defaultLaunch).toEqual({ harness: "opencode", profileId: "p1" });
    store.deleteProfile("p1");
    expect(store.findWorkspace("w1")?.defaultLaunch).toEqual({ harness: "opencode", profileId: null });
  });

  test("remembers that the user named a conversation", () => {
    const { store, conversation } = seededStore();
    store.updateConversation({ ...conversation, title: "Login bug", titleSetByUser: true });
    expect(store.findConversation("c1")).toMatchObject({ title: "Login bug", titleSetByUser: true });
  });

  test("keeps a profile's agent when it is saved again", () => {
    const { store } = seededStore();
    const profile: Profile = { id: "p1", name: "work", harness: "claude", environment: "", prelaunch: "", createdAt: 1 };
    store.saveProfile(profile);
    store.saveProfile({ ...profile, harness: "opencode" });
    expect(store.findProfile("p1")?.harness).toBe("claude");
  });

  test("adds the profile and agent columns to a database created before they existed", () => {
    const path = join(mkdtempSync(join(tmpdir(), "vcs-store-")), "state.sqlite");
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
    expect(store.findConversation("c1")).toMatchObject({ titleSetByUser: false, bypassPermissions: false });
    store.close();
  });
});
