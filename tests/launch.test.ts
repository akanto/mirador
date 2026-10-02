import { describe, expect, test } from "bun:test";
import { assertLaunchable } from "../host/profiles.ts";
import { Store } from "../host/store.ts";

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
