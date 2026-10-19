import { describe, expect, test } from "bun:test";
import type * as acp from "@agentclientprotocol/sdk";
import { currentActivity, OpenToolCalls } from "../host/activity.ts";

const started = (toolCallId: string, title: string): acp.SessionUpdate => ({ sessionUpdate: "tool_call", toolCallId, title, status: "in_progress" });
const updated = (toolCallId: string, change: Partial<acp.ToolCallUpdate>): acp.SessionUpdate => ({ sessionUpdate: "tool_call_update", toolCallId, ...change });

describe("OpenToolCalls", () => {
  test("knows the kind of tool each open call is, from its start or a later update, until it finishes", () => {
    const open = new OpenToolCalls();
    open.follow({ sessionUpdate: "tool_call", toolCallId: "edit", title: "Edit a.ts", kind: "edit", status: "pending" });
    open.follow(started("fetch", "Fetch"));
    open.follow(updated("fetch", { kind: "fetch" }));
    expect(open.kindOf("edit")).toBe("edit");
    expect(open.kindOf("fetch")).toBe("fetch");
    expect(open.kindOf("never-started")).toBeNull();
    open.follow(updated("edit", { status: "completed" }));
    expect(open.kindOf("edit")).toBeNull();
    open.follow(updated("unknown", { kind: "read" }));
    expect(open.kindOf("unknown")).toBeNull();
  });

  test("keeps the tool calls that have not finished, and says when an update finishes a tool call", () => {
    const open = new OpenToolCalls();
    expect(open.follow(started("read", "Read src/checkout.ts"))).toBe(false);
    expect(open.follow(started("run", "sleep 120"))).toBe(false);
    expect(open.latest()).toBe("sleep 120");
    expect(open.follow(updated("run", { status: "completed" }))).toBe(true);
    expect(open.latest()).toBe("Read src/checkout.ts");
    expect(open.follow(updated("read", { status: "in_progress" }))).toBe(false);
    expect(open.follow(updated("read", { status: "failed" }))).toBe(true);
    expect(open.size).toBe(0);
    expect(open.latest()).toBeNull();
  });

  test("takes the title a later update gives, and ignores tool calls that start already finished", () => {
    const open = new OpenToolCalls();
    open.follow(started("run", "Terminal"));
    open.follow(updated("run", { title: "bun test", status: "in_progress" }));
    expect(open.latest()).toBe("bun test");
    open.follow({ sessionUpdate: "tool_call", toolCallId: "done", title: "Read README.md", status: "completed" });
    expect(open.latest()).toBe("bun test");
    open.follow(updated("unknown", { title: "Never started" }));
    expect(open.latest()).toBe("bun test");
  });

  test("tells the agent's own open calls from its subagents', also once a subagent's call updates without the subagent's mark", () => {
    const open = new OpenToolCalls();
    open.follow(started("launch", "Review the diff"));
    open.follow(started("subagent-run", "sleep 45"), true);
    open.follow(updated("subagent-run", { status: "in_progress" }));
    expect([open.size, open.mainAgentSize]).toEqual([2, 1]);
    open.follow(updated("launch", { status: "completed" }));
    expect([open.size, open.mainAgentSize]).toEqual([1, 0]);
    open.follow(updated("subagent-run", { status: "completed" }));
    open.follow(started("subagent-run", "sleep 45 again"));
    expect([open.size, open.mainAgentSize]).toEqual([1, 1]);
    open.clear();
    open.follow(started("subagent-read", "Read a.ts"), true);
    open.clear();
    open.follow(started("subagent-read", "Read a.ts"));
    expect(open.mainAgentSize).toBe(1);
  });
});

describe("currentActivity", () => {
  test("a tool waiting for permission comes first, then the tool call started last, and nothing once all have finished", () => {
    const open = new OpenToolCalls();
    expect(currentActivity(open, [])).toBeNull();
    open.follow(started("run", "sleep 120"));
    expect(currentActivity(open, [])).toEqual({ kind: "tool", title: "sleep 120" });
    expect(currentActivity(open, ["rm -rf build", "git push"])).toEqual({ kind: "permission", title: "git push" });
  });
});
