import { describe, expect, test } from "bun:test";
import type { Conversation } from "../shared/model.ts";
import { assertLaunchable, moveProfilelessOntoProfiles } from "../host/profiles.ts";
import { Store } from "../host/store.ts";

describe("moveProfilelessOntoProfiles", () => {
  function storeFromBeforeProfilesWereRequired() {
    const store = new Store(":memory:");
    store.saveProfile({ id: "p1", name: "work", harness: "claude", environment: "ANTHROPIC_MODEL=opus", prelaunch: "", mode: "plan", bypassPermissions: true, askMode: "next-message", createdAt: 1 });
    store.insertWorkspace({ id: "w1", name: "project", path: "/tmp/project", defaultLaunch: { harness: "claude", profileId: null }, createdAt: 1 });
    store.insertWorkspace({ id: "w2", name: "other", path: "/tmp/other", defaultLaunch: { harness: "claude", profileId: "p1" }, createdAt: 2 });
    const conversation = (id: string, change: Partial<Conversation>): Conversation => ({
      id,
      workspaceId: "w1",
      harness: "claude",
      profileId: null,
      title: id,
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
      activity: null,
      configOptions: [],
      position: 0,
      createdAt: 1,
      updatedAt: 1,
      ...change,
    });
    store.insertConversation(conversation("bare-claude", {}));
    store.insertConversation(conversation("bare-opencode", { harness: "opencode" }));
    store.insertConversation(conversation("on-work", { profileId: "p1" }));
    return store;
  }

  test("moves each installed agent's profile-less workspaces and conversations onto a profile of its own name that adds nothing", () => {
    const store = storeFromBeforeProfilesWereRequired();

    moveProfilelessOntoProfiles(store, ["claude"]);

    const created = store.listProfiles().find(({ name }) => name === "Claude Code")!;
    expect(created).toMatchObject({ harness: "claude", environment: "", prelaunch: "", mode: null, bypassPermissions: false, askMode: "wait" });
    expect(store.findWorkspace("w1")!.defaultLaunch).toEqual({ harness: "claude", profileId: created.id });
    expect(store.findWorkspace("w2")!.defaultLaunch.profileId).toBe("p1");
    expect(store.findConversation("bare-claude")!.profileId).toBe(created.id);
    expect(store.findConversation("on-work")!.profileId).toBe("p1");
    expect(store.findConversation("bare-opencode")!.profileId).toBeNull();
    expect(store.listProfiles().map(({ name }) => name)).toEqual(["Claude Code", "work"]);
  });

  test("creates nothing the second time, nor for an agent nothing ran on without a profile", () => {
    const store = storeFromBeforeProfilesWereRequired();
    moveProfilelessOntoProfiles(store, ["claude", "opencode"]);

    moveProfilelessOntoProfiles(store, ["claude", "opencode"]);

    expect(store.listProfiles().map(({ name }) => name)).toEqual(["Claude Code", "opencode", "work"]);
    expect(store.profilelessHarnesses()).toEqual([]);
    const fresh = new Store(":memory:");
    moveProfilelessOntoProfiles(fresh, ["claude", "opencode"]);
    expect(fresh.listProfiles()).toEqual([]);
  });
});

describe("assertLaunchable", () => {
  const store = new Store(":memory:");
  store.saveProfile({ id: "p1", name: "home llama", harness: "opencode", environment: "", prelaunch: "", mode: null, bypassPermissions: false, askMode: "wait", createdAt: 1 });

  test("accepts an agent on its own and a profile on its own agent", () => {
    expect(() => assertLaunchable(store, { harness: "claude", profileId: null })).not.toThrow();
    expect(() => assertLaunchable(store, { harness: "opencode", profileId: "p1" })).not.toThrow();
  });

  test("refuses a profile on another agent, a deleted profile and an unknown agent", () => {
    expect(() => assertLaunchable(store, { harness: "claude", profileId: "p1" })).toThrow('Profile "home llama" is for opencode, not Claude Code.');
    expect(() => assertLaunchable(store, { harness: "opencode", profileId: "gone" })).toThrow("That profile no longer exists.");
    expect(() => assertLaunchable(store, { harness: "pi" as never, profileId: null })).toThrow("Unknown agent pi.");
  });
});
